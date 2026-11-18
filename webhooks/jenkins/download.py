#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
文件传输工具 · Jenkins 下载任务

被 webhook 触发后（或手动/定时调用），按文件 ID 把文件下载到指定路径，
路径结构：<base_dir>/<fileId>/<原文件名>，即**用 ID 建一个文件夹，文件放进去**。

设计说明：
  - 标准库实现（urllib + json），Jenkins 节点上只需 Python 3.7+，不用 pip。
  - 认证用 config.json 里的 downloadToken，请求头 `x-download-token`
    （由 file-transmit 服务端校验；这个令牌只能读文件，改不了设置）。
  - 支持三种模式：
      1) --id ABCD1234            只下这一个 ID
      2) --ids AB,CD,EF            批量
      3) --since <epoch|ISO>      下「该时间之后创建」的全部文件（webhook 推荐用法）
  - 已存在的同名文件默认跳过（--overwrite 覆盖），断点/重跑安全。
  - 返回 JSON 结果，Jenkins 里用 jq 或 Python 都能解析；失败时退出码非 0。

用法：
  python download.py --id ABCD1234
  python download.py --since 1h
  python download.py --ids AB12CD34,EF56GH78 --base-dir /data/incoming
  python download.py --since 24h --dry-run      # 只打印将要下载什么
"""

import argparse
import datetime as dt
import json
import logging
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CONFIG = os.path.join(BASE_DIR, "config.json")

LOG = logging.getLogger("jenkins-download")

FILE_ID_RE = re.compile(r"^[A-Z0-9]{8}$")
# 过期时长写法：数字 + s/m/h/d，或 epoch 秒，或 ISO 时间
SINCE_RE = re.compile(r"^(\d+(?:\.\d+)?)\s*([smhd])$", re.I)
UNIT_SECONDS = {"s": 1, "m": 60, "h": 3600, "d": 86400}


def load_config(path):
    if not os.path.exists(path):
        sys.exit("[FATAL] 配置文件不存在: %s\n        复制 config.example.json -> config.json 后填写"
                 % path)
    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    if not cfg.get("base_url"):
        sys.exit("[FATAL] 配置缺少 base_url（文件传输工具的对外地址，例如 http://192.168.1.10:3000）")
    if not cfg.get("download_token"):
        sys.exit("[FATAL] 配置缺少 download_token\n"
                 "        在 file-transmit 管理页「安全设置」里生成，或读 config.json 的 downloadToken")
    if not cfg.get("base_dir"):
        sys.exit("[FATAL] 配置缺少 base_dir（下载根目录）")
    return cfg


def parse_since(value):
    """'1h' / '30m' / '2d' / epoch 秒 / ISO 字符串 -> epoch 秒（毫秒时间戳）"""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    m = SINCE_RE.match(text)
    if m:
        secs = float(m.group(1)) * UNIT_SECONDS[m.group(2).lower()]
        return int((time.time() - secs) * 1000)
    if text.isdigit():
        n = int(text)
        # 10 位当秒，13 位当毫秒
        return n * 1000 if n < 10 ** 12 else n
    try:
        parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
        return int(parsed.timestamp() * 1000)
    except ValueError:
        sys.exit("[FATAL] --since 无法解析: %s（支持 1h/30m/2d、epoch 秒、ISO 时间）" % text)


class Api:
    def __init__(self, cfg, timeout=30):
        self.base = cfg["base_url"].rstrip("/")
        self.token = cfg["download_token"]
        self.timeout = timeout

    def _request(self, path, stream=False):
        url = self.base + path
        req = urllib.request.Request(url, headers={"x-download-token": self.token})
        return urllib.request.urlopen(req, timeout=self.timeout)  # 可能抛 HTTPError

    def get_json(self, path):
        with self._request(path) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def download_to(self, path, dest):
        """流式下载到 dest（先写临时文件再改名，避免半截文件被下游当成成品）"""
        tmp = dest + ".part"
        with self._request(path) as resp, open(tmp, "wb") as f:
            shutil.copyfileobj(resp, f, length=1024 * 256)
        os.replace(tmp, dest)
        return os.path.getsize(dest)


def safe_name(name):
    """原文件名可能含路径分隔符或 Windows 非法字符，落盘前统一清洗"""
    name = str(name or "").strip()
    name = name.replace("\\", "_").replace("/", "_")
    name = re.sub(r'[<>:"|?*\x00-\x1f]', "_", name)
    name = name.strip(" .")
    return name or "unnamed"


def list_all_files(api, since_ms=None, page_size=200, max_items=2000):
    """分页拉取 /api/files；since_ms 存在时服务端就已过滤，这里只是兜底。

    注意用 /api/files 而不是 /api/upload/history：后者按 cookie 的用户 ID 过滤，
    服务端脚本没有那个 cookie，拿到的会是空列表。
    """
    collected = []
    offset = 0
    while len(collected) < max_items:
        qs = urllib.parse.urlencode({
            "limit": page_size,
            "offset": offset,
            "since": int(since_ms) if since_ms else 0,
        })
        batch = api.get_json("/api/files?" + qs)
        items = batch.get("files") or [] if isinstance(batch, dict) else (batch or [])
        if not items:
            break
        collected.extend(items)
        if len(items) < page_size:
            break
        offset += len(items)
    if since_ms:  # 服务端已过滤，这里再筛一次防参数被忽略
        collected = [f for f in collected if int(f.get("createdAt") or 0) >= since_ms]
    return collected


def download_one(api, file_id, base_dir, overwrite=False, dry_run=False):
    """下载单个 ID：先取详情，再把每个附件放进 <base_dir>/<fileId>/"""
    detail = api.get_json("/api/download/" + urllib.parse.quote(file_id))
    files = detail.get("files") or []
    if not files:
        return {"fileId": file_id, "status": "empty", "downloaded": [], "skipped": []}

    target_dir = os.path.join(base_dir, file_id)
    if not dry_run:
        os.makedirs(target_dir, exist_ok=True)

    downloaded, skipped, failed = [], [], []
    for item in files:
        original = item.get("originalName") or item.get("storedName") or "unnamed"
        stored = item.get("storedName") or original
        dest = os.path.join(target_dir, safe_name(original))
        if os.path.exists(dest) and not overwrite:
            skipped.append(original)
            LOG.info("已存在，跳过: %s", dest)
            continue
        if dry_run:
            LOG.info("[DRY-RUN] 将下载 %s -> %s", stored, dest)
            downloaded.append(original)
            continue
        try:
            size = api.download_to("/api/download/%s/%s" % (
                urllib.parse.quote(file_id), urllib.parse.quote(stored)), dest)
            downloaded.append(original)
            LOG.info("已下载: %s (%d bytes)", dest, size)
        except Exception as exc:  # noqa: BLE001 - 单个文件失败不阻断同批次其余文件
            failed.append({"name": original, "error": str(exc)})
            LOG.error("下载失败 %s/%s: %s", file_id, original, exc)

    return {
        "fileId": file_id,
        "status": "failed" if failed else "ok",
        "dir": target_dir,
        "description": detail.get("description", ""),
        "downloaded": downloaded,
        "skipped": skipped,
        "failed": failed,
    }


def main():
    ap = argparse.ArgumentParser(description="文件传输工具 -> Jenkins 下载任务")
    ap.add_argument("--config", default=DEFAULT_CONFIG, help="配置文件路径")
    ap.add_argument("--id", dest="one_id", help="单个文件 ID（8 位）")
    ap.add_argument("--ids", help="多个文件 ID，逗号分隔")
    ap.add_argument("--since", help="只处理该时间之后创建的文件，如 1h / 30m / 2d / epoch / ISO")
    ap.add_argument("--all", action="store_true", help="处理历史里的全部文件（谨慎）")
    ap.add_argument("--base-dir", help="覆盖配置里的 base_dir")
    ap.add_argument("--overwrite", action="store_true", help="同名文件覆盖（默认跳过）")
    ap.add_argument("--dry-run", action="store_true", help="只打印计划，不落盘")
    ap.add_argument("--json", action="store_true", help="结果以 JSON 打到 stdout（供 Jenkins 解析）")
    args = ap.parse_args()

    # Windows 下 stdout 接管道是块缓冲的，日志与 dry-run 内容会攒到进程结束才出来。
    # 改为行缓冲，交互式 / 管道 / Jenkins 里都能实时看到输出。
    try:
        sys.stdout.reconfigure(line_buffering=True)
        sys.stderr.reconfigure(line_buffering=True)
    except (AttributeError, ValueError, OSError):  # 旧 Python / 已关闭的流
        pass

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        # 日志走 stderr（Windows 上无缓冲，管道里实时可见），stdout 只留给 --json 结果
        stream=sys.stderr,
    )

    cfg = load_config(args.config)
    base_dir = args.base_dir or cfg["base_dir"]
    api = Api(cfg, timeout=int(cfg.get("timeout_seconds", 60)))
    since = parse_since(args.since)

    # 1) 确定要下载哪些 ID
    targets = []
    if args.one_id:
        fid = args.one_id.strip().upper()
        if not FILE_ID_RE.match(fid):
            sys.exit("[FATAL] 非法文件 ID: %s（应为 8 位大写字母数字）" % args.one_id)
        targets = [fid]
    if args.ids:
        for piece in args.ids.split(","):
            fid = piece.strip().upper()
            if fid:
                if not FILE_ID_RE.match(fid):
                    sys.exit("[FATAL] 非法文件 ID: %s" % piece)
                targets.append(fid)
    if not targets:
        if args.since or args.all:
            try:
                items = list_all_files(api, since_ms=since)
            except urllib.error.HTTPError as exc:
                sys.exit("[FATAL] 拉取历史失败: HTTP %s %s" % (exc.code, exc.reason))
            except Exception as exc:  # noqa: BLE001
                sys.exit("[FATAL] 拉取历史失败: %s" % exc)
            targets = [f["id"] for f in items if FILE_ID_RE.match(str(f.get("id", "")))]
            LOG.info("按条件匹配到 %d 个文件（since=%s）", len(targets), args.since or "-")
        else:
            ap.error("需要 --id / --ids / --since / --all 之一")

    if not targets:
        LOG.info("没有需要下载的文件")
        print(json.dumps({"ok": True, "count": 0, "results": []}, ensure_ascii=False), flush=True)
        return 0

    LOG.info("准备下载 %d 个 ID 到 %s", len(targets), base_dir)

    # 2) 逐个下载
    results = []
    has_failure = False
    for fid in targets:
        try:
            r = download_one(api, fid, base_dir, overwrite=args.overwrite, dry_run=args.dry_run)
        except urllib.error.HTTPError as exc:
            body = ""
            try:
                body = exc.read().decode("utf-8", "replace")[:200]
            except Exception:  # noqa: BLE001
                pass
            r = {"fileId": fid, "status": "error", "error": "HTTP %s %s %s" % (exc.code, exc.reason, body)}
            LOG.error("%s: HTTP %s %s", fid, exc.code, body)
        except Exception as exc:  # noqa: BLE001
            r = {"fileId": fid, "status": "error", "error": str(exc)}
            LOG.error("%s: %s", fid, exc)
        if r.get("status") not in ("ok", "empty"):
            has_failure = True
        results.append(r)

    summary = {
        "ok": not has_failure,
        "count": len(results),
        "baseDir": base_dir,
        "dryRun": bool(args.dry_run),
        "results": results,
    }
    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    else:
        ok_n = sum(1 for r in results if r.get("status") == "ok")
        LOG.info("完成: %d/%d 成功 -> %s", ok_n, len(results), base_dir)

    return 1 if has_failure else 0


if __name__ == "__main__":
    sys.exit(main())
