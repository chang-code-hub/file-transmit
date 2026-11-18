#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
文件传输工具 · 上传完成 webhook -> 通知邮件

监听一个 HTTP 端口，接收 file-transmit 发来的 upload.completed 回调，
按配置把「文件 ID + 附件清单 + 下载链接」发给指定收件人。
按需求：邮件里只列文件名和链接，**不附带文件本身**。

设计说明：
  - 标准库实现（http.server + smtplib + email.message），无需 pip install。
  - 签名校验可选：管理页给某个 webhook 配了「签名密钥」，这里必须填同一个值；
    校验失败直接拒绝（401），防止别人伪造上传通知骚扰收件人。
  - 幂等：同一个 fileId 在冷却窗口内只发一次，避免重放/重复上传刷屏。
  - 发信失败不影响 file-transmit（对方是异步发送的），但这里要记日志。

启动：
  python send_mail.py                  # 用 config.json
  python send_mail.py --config my.json
  python send_mail.py --port 8090 --dry-run    # 打印邮件内容，不真正发信

config.json 见同目录 config.example.json
"""

import argparse
import hashlib
import hmac
import json
import logging
import os
import re
import smtplib
import ssl
import sys
import threading
import time
from email.message import EmailMessage
from email.headerregistry import Address
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CONFIG = os.path.join(BASE_DIR, "config.json")

LOG = logging.getLogger("mail-webhook")

# fileId 格式：8 位大写字母数字（不含易混淆的 I O 0 1）
FILE_ID_RE = re.compile(r"^[A-Z0-9]{8}$")
MAX_BODY = 1 * 1024 * 1024  # 请求体上限 1MB，超了直接拒绝


# --------------------------------------------------------------------------- #
# 配置
# --------------------------------------------------------------------------- #
def load_config(path):
    if not os.path.exists(path):
        sys.exit(f"[FATAL] 配置文件不存在: {path}\n"
                 f"        复制 config.example.json -> config.json 后按需修改")
    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)

    # 必填项检查，缺了启动就报错，别等到收不到邮件才发现
    for key in ("listen", "smtp"):
        if key not in cfg:
            sys.exit(f"[FATAL] 配置缺少字段: {key}")
    for key in ("host", "port", "user", "from_addr", "to"):
        if key not in cfg["smtp"]:
            sys.exit(f"[FATAL] 配置缺少 smtp.{key}")
    if not cfg["smtp"]["to"]:
        sys.exit("[FATAL] smtp.to 不能为空（收件人列表）")
    return cfg


# --------------------------------------------------------------------------- #
# 邮件正文
# --------------------------------------------------------------------------- #
def fmt_size(n):
    try:
        n = float(n)
    except (TypeError, ValueError):
        return "0 B"
    units = ["B", "KB", "MB", "GB", "TB"]
    i = 0
    while n >= 1024 and i < len(units) - 1:
        n /= 1024
        i += 1
    return f"{int(n)} {units[i]}" if i == 0 else f"{n:.1f} {units[i]}"


def fmt_time(ms):
    try:
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(int(ms) / 1000))
    except (TypeError, ValueError, OSError):
        return "-"


def build_subject(payload, cfg):
    """主题可由 config.subject_template 覆盖，占位符见 README"""
    tpl = cfg.get("subject_template")
    if tpl:
        try:
            return tpl.format(
                fileId=payload.get("fileId", ""),
                fileCount=payload.get("fileCount", 0),
                description=(payload.get("description") or "").strip(),
                totalSize=payload.get("totalSizeText", ""),
            )
        except (KeyError, IndexError):
            LOG.warning("主题模板占位符有误，回退默认主题")
    desc = (payload.get("description") or "").strip()
    head = f"【{desc}】" if desc else ""
    return f"{head}新文件已上传 {payload.get('fileId', '?')}"


def build_text_body(payload, cfg):
    """纯文本正文：只列文件名与下载链接，不附文件"""
    lines = []
    lines.append("文件传输工具：有新的文件上传完成。")
    lines.append("")
    lines.append(f"文件 ID : {payload.get('fileId', '-')}")
    desc = (payload.get("description") or "").strip()
    if desc:
        lines.append(f"描述    : {desc}")
    lines.append(f"文件数  : {payload.get('fileCount', 0)}")
    lines.append(f"总大小  : {payload.get('totalSizeText', '-')}")
    lines.append(f"上传时间: {fmt_time(payload.get('createdAt'))}")
    lines.append(f"过期时间: {fmt_time(payload.get('expiresAt'))}")
    ip = (payload.get("uploaderIp") or "").strip()
    if ip:
        lines.append(f"上传 IP : {ip}")
    lines.append("")
    lines.append("附件列表（点击链接直接下载，不附带文件本身）：")
    lines.append("-" * 60)

    attachments = payload.get("attachments") or []
    for i, item in enumerate(attachments, 1):
        name = item.get("fileName") or item.get("storedName") or "(未命名)"
        size = item.get("sizeText") or fmt_size(item.get("size"))
        url = item.get("downloadUrl") or ""
        lines.append(f"{i}. {name}  ({size})")
        lines.append(f"   {url}")

    if not attachments:
        lines.append("（本次没有附件明细）")

    lines.append("-" * 60)
    share = payload.get("shareUrl")
    zip_url = payload.get("zipUrl")
    if share:
        lines.append(f"文件详情页: {share}")
    if zip_url:
        lines.append(f"整包下载  : {zip_url}")
    failed = payload.get("failedFiles") or []
    if failed:
        names = ", ".join(f.get("name", "?") if isinstance(f, dict) else str(f) for f in failed)
        lines.append(f"注意：以下文件未成功上传 -> {names}")
    lines.append("")
    lines.append("此邮件由文件传输工具自动发送。")
    return "\n".join(lines)


def build_html_body(payload, cfg):
    rows = []
    for item in payload.get("attachments") or []:
        name = item.get("fileName") or item.get("storedName") or "(未命名)"
        size = item.get("sizeText") or fmt_size(item.get("size"))
        url = item.get("downloadUrl") or ""
        safe_name = (name.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
        rows.append(
            f'<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">{safe_name}</td>'
            f'<td style="padding:6px 10px;border-bottom:1px solid #eee;color:#666;white-space:nowrap">{size}</td>'
            f'<td style="padding:6px 10px;border-bottom:1px solid #eee">'
            f'<a href="{url}">下载</a></td></tr>'
        )
    table = (
        '<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;'
        'max-width:720px;font-size:14px;margin:12px 0">'
        '<tr style="background:#f7f7f7">'
        '<th style="padding:8px 10px;text-align:left">文件名</th>'
        '<th style="padding:8px 10px;text-align:left">大小</th>'
        '<th style="padding:8px 10px;text-align:left">下载</th></tr>'
        + "".join(rows) + "</table>"
    ) if rows else "<p>（本次没有附件明细）</p>"

    desc = (payload.get("description") or "").strip()
    share = payload.get("shareUrl") or ""
    zip_url = payload.get("zipUrl") or ""
    link_parts = []
    if share:
        link_parts.append(f'<a href="{share}">打开文件详情页</a>')
    if zip_url:
        link_parts.append(f'<a href="{zip_url}">整包下载 (zip)</a>')

    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,'Segoe UI','Microsoft YaHei',Arial,sans-serif;
             color:#1a1a1a;line-height:1.6;margin:0;padding:16px">
  <div style="max-width:760px;margin:0 auto;border:1px solid #e5e5e5;border-radius:8px;
             padding:20px;background:#fff">
    <h2 style="margin:0 0 4px;font-size:18px">新文件已上传 <code>{payload.get('fileId','')}</code></h2>
    <p style="color:#666;margin:0 0 16px">文件传输工具自动通知{(' · ' + desc) if desc else ''}</p>
    <p style="margin:0 0 4px">文件数 <b>{payload.get('fileCount',0)}</b> ·
       总大小 <b>{payload.get('totalSizeText','-')}</b> ·
       过期时间 <b>{fmt_time(payload.get('expiresAt'))}</b></p>
    <p style="color:#888;font-size:13px;margin:0 0 4px">
      以下为附件清单与下载链接，<b>本邮件不附带文件</b>。
    </p>
    {table}
    <p style="font-size:13px">{' · '.join(link_parts)}</p>
    <p style="color:#aaa;font-size:12px;margin:16px 0 0">此邮件由文件传输工具自动发送。</p>
  </div>
</body></html>"""


# --------------------------------------------------------------------------- #
# 发信
# --------------------------------------------------------------------------- #
def send_mail(cfg, payload, dry_run=False):
    subject = build_subject(payload, cfg)
    text = build_text_body(payload, cfg)
    html = build_html_body(payload, cfg)
    smtp = cfg["smtp"]

    if dry_run:
        print("=" * 70, flush=True)
        print("To     :", ", ".join(smtp["to"]), flush=True)
        print("Subject:", subject, flush=True)
        print("-" * 70, flush=True)
        print(text, flush=True)
        print("=" * 70)
        return True

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = smtp["from_addr"]
    msg["To"] = ", ".join(smtp["to"])
    if smtp.get("reply_to"):
        msg["Reply-To"] = smtp["reply_to"]
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")

    use_ssl = bool(smtp.get("ssl", False))
    starttls = bool(smtp.get("starttls", True))
    context = ssl.create_default_context()

    if use_ssl:
        with smtplib.SMTP_SSL(smtp["host"], int(smtp["port"]), context=context, timeout=30) as s:
            if smtp.get("user"):
                s.login(smtp["user"], smtp.get("password", ""))
            s.send_message(msg)
    else:
        with smtplib.SMTP(smtp["host"], int(smtp["port"]), timeout=30) as s:
            if starttls:
                s.starttls(context=context)
            if smtp.get("user"):
                s.login(smtp["user"], smtp.get("password", ""))
            s.send_message(msg)
    return True


# --------------------------------------------------------------------------- #
# 幂等：同一 fileId 在冷却窗口内只发一次
# --------------------------------------------------------------------------- #
class Dedupe:
    def __init__(self, ttl_sec):
        self.ttl = max(1, int(ttl_sec))
        self.seen = {}
        self.lock = threading.Lock()

    def first_time(self, key):
        now = time.time()
        with self.lock:
            # 顺手清掉过期项，避免长期运行内存膨胀
            expired = [k for k, t in self.seen.items() if now - t > self.ttl]
            for k in expired:
                self.seen.pop(k, None)
            if key in self.seen:
                return False
            self.seen[key] = now
            return True


# --------------------------------------------------------------------------- #
# HTTP 服务
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    server_version = "MailWebhook/1.0"
    cfg = None
    dedupe = None
    dry_run = False

    def _reply(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # 接入标准 logging
        LOG.info("%s - %s", self.address_string(), fmt % args)

    def do_GET(self):
        # 健康检查：部署后 curl 一下就知道服务在不在
        if self.path.rstrip("/") in ("", "/health"):
            self._reply(200, {"ok": True, "service": "mail-webhook"})
        else:
            self._reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0].rstrip("/") not in ("", "/hook", "/"):
            self._reply(404, {"error": "not found"})
            return

        cfg = self.cfg
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            self._reply(400, {"error": "empty body"})
            return
        if length > MAX_BODY:
            self._reply(413, {"error": "body too large"})
            return

        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._reply(400, {"error": "invalid json"})
            return

        # 事件类型：只处理上传完成，其它事件收下但不发信
        event = self.headers.get("X-Webhook-Event") or payload.get("event") or ""
        if event and event != "upload.completed":
            LOG.info("忽略非上传完成事件: %s", event)
            self._reply(200, {"ok": True, "ignored": event})
            return

        file_id = str(payload.get("fileId") or "")
        if not FILE_ID_RE.match(file_id):
            self._reply(400, {"error": "invalid fileId"})
            return

        # 签名校验（配置了才校验）
        secret = cfg.get("secret") or ""
        if secret:
            given = self.headers.get("X-Webhook-Signature") or ""
            expect = "sha256=" + hmac.new(
                secret.encode("utf-8"), raw, hashlib.sha256
            ).hexdigest()
            if not hmac.compare_digest(given, expect):
                LOG.warning("签名不匹配，拒绝 fileId=%s", file_id)
                self._reply(401, {"error": "signature mismatch"})
                return

        # 幂等：同一 fileId 冷却期内只发一次
        if not self.dedupe.first_time(file_id):
            LOG.info("重复通知已忽略: fileId=%s", file_id)
            self._reply(200, {"ok": True, "duplicate": True})
            return

        try:
            send_mail(cfg, payload, dry_run=self.dry_run)
        except Exception as exc:  # noqa: BLE001 - 单次发信失败不能拖垮服务
            LOG.error("发送邮件失败 fileId=%s: %s", file_id, exc)
            self._reply(500, {"error": "send failed", "detail": str(exc)})
            return

        LOG.info("邮件已发送: fileId=%s 附件=%d 收件人=%s",
                 file_id, len(payload.get("attachments") or []), ", ".join(cfg["smtp"]["to"]))
        self._reply(200, {"ok": True, "fileId": file_id})


def main():
    ap = argparse.ArgumentParser(description="文件传输工具 上传完成 webhook -> 邮件通知")
    ap.add_argument("--config", default=DEFAULT_CONFIG, help="配置文件路径")
    ap.add_argument("--port", type=int, default=None, help="覆盖 listen.port")
    ap.add_argument("--dry-run", action="store_true", help="只打印邮件内容，不真正发信")
    args = ap.parse_args()

    # Windows 下 stdout 接管道是块缓冲的，日志与 dry-run 内容会攒到进程结束才出来。
    # 改为行缓冲，交互式 / 管道 / Jenkins 里都能实时看到输出。
    try:
        sys.stdout.reconfigure(line_buffering=True)
        sys.stderr.reconfigure(line_buffering=True)
    except (AttributeError, ValueError, OSError):  # 旧 Python / 已关闭的流
        pass

    # 日志走 stderr：stderr 在 Windows 上无缓冲，Jenkins / 管道里能实时看到；
    # stdout（dry-run 的邮件正文）保持行缓冲。
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        stream=sys.stderr,
    )

    cfg = load_config(args.config)
    port = args.port or int(cfg["listen"].get("port", 8090))
    host = cfg["listen"].get("host", "0.0.0.0")

    Handler.cfg = cfg
    Handler.dry_run = args.dry_run
    Handler.dedupe = Dedupe(cfg.get("dedupe_seconds", 300))

    srv = ThreadingHTTPServer((host, port), Handler)
    LOG.info("邮件 webhook 已启动 http://%s:%d/hook", host, port)
    LOG.info("收件人: %s", ", ".join(cfg["smtp"]["to"]))
    LOG.info("签名校验: %s", "已启用" if cfg.get("secret") else "未启用（管理页该 webhook 也没填密钥）")
    if args.dry_run:
        LOG.warning("DRY-RUN 模式：不会真正发信，只打印内容")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        LOG.info("收到 Ctrl+C，退出")
        srv.shutdown()


if __name__ == "__main__":
    main()
