#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从 Generic Webhook Trigger 传来的 JSON 里取出 fileId。

Jenkins 的 Generic Webhook Trigger 插件会把 POST body 逐层展开成环境变量，
取法是 content.<键路径>。但 body 结构不同（本项目是扁平的 {fileId, ...}，
有的接收方包一层 {data: {...}} 或 {payload: {...}}），手写表达式容易漏，
所以这里统一收口：既支持环境变量，也支持 --payload-file，两种都取不到就报错退出。

用法（Jenkins 里）：
  python extract_file_id.py --env           # 只看环境变量
  python extract_file_id.py --payload-file body.json
  python extract_file_id.py --env --payload-file body.json   # 任一命中即返回
成功：stdout 打印 fileId，退出码 0；失败：退出码 1。
"""

import argparse
import json
import os
import re
import sys

# 与 file-transmit 生成规则一致：8 位大写字母数字（去掉了易混淆的 I O 0 1）
FILE_ID_RE = re.compile(r"^[A-Z0-9]{8}$")

# 环境变量可能的几种来源，按优先级排
ENV_KEYS = (
    "fileId", "FILE_ID", "FILEID",
    "content_fileId", "content.fileId",
    "content_data_fileId", "content_payload_fileId",
)


def normalize(value):
    """去空白、转大写，返回 None 表示没取到"""
    if value is None:
        return None
    text = str(value).strip().strip('"').strip("'").strip()
    return text.upper() if text else None


def from_env(environ):
    for key in ENV_KEYS:
        if key in environ:
            v = normalize(environ[key])
            if v:
                return v, key
    # 兜底：扫一遍所有环境变量，找 value 本身长得像 fileId 的
    for k, v in environ.items():
        cand = normalize(v)
        if cand and FILE_ID_RE.match(cand) and len(cand) == 8:
            return cand, k
    return None, None


def deep_find(obj, depth=0):
    """递归找第一个像 fileId 的字符串（限制深度防止畸形数据导致栈溢出）"""
    if depth > 6:
        return None
    if isinstance(obj, str):
        cand = normalize(obj)
        if cand and FILE_ID_RE.match(cand):
            return cand
        return None
    if isinstance(obj, dict):
        # 优先看明确的键名
        for key in ("fileId", "file_id", "FILE_ID", "id"):
            if key in obj:
                cand = normalize(obj[key])
                if cand and FILE_ID_RE.match(cand):
                    return cand
        for v in obj.values():
            found = deep_find(v, depth + 1)
            if found:
                return found
        return None
    if isinstance(obj, list):
        for v in obj:
            found = deep_find(v, depth + 1)
            if found:
                return found
        return None
    return None


def from_payload_file(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read().strip()
    except OSError as exc:
        print("[extract] 读取 payload 文件失败: %s" % exc, file=sys.stderr)
        return None
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        # 有的插件把 body 塞成字符串，再试一次
        try:
            data = json.loads(json.loads('"%s"' % raw))
        except (ValueError, json.JSONDecodeError):
            print("[extract] payload 不是合法 JSON", file=sys.stderr)
            return None
    return deep_find(data)


def main():
    ap = argparse.ArgumentParser(description="从 webhook payload 里提取 fileId")
    ap.add_argument("--env", action="store_true", help="从环境变量取")
    ap.add_argument("--payload-file", help="从 JSON 文件取")
    ap.add_argument("--required", action="store_true", default=True,
                    help="取不到就以退出码 1 结束（默认）")
    ap.add_argument("--allow-empty", action="store_true",
                    help="取不到时打空行并退出 0（供可选触发的 job 用）")
    args = ap.parse_args()

    file_id, source = None, None
    if args.env or not args.payload_file:
        file_id, source = from_env(os.environ)
        if file_id:
            print("[extract] fileId=%s（来源: 环境变量 %s）" % (file_id, source), file=sys.stderr)
    if not file_id and args.payload_file:
        file_id = from_payload_file(args.payload_file)
        if file_id:
            print("[extract] fileId=%s（来源: %s）" % (file_id, args.payload_file), file=sys.stderr)

    if file_id and FILE_ID_RE.match(file_id):
        print(file_id)
        return 0

    if args.allow_empty:
        print("[extract] 未取到 fileId，按 --allow-empty 放行", file=sys.stderr)
        print("")
        return 0

    print("[extract] 未取到有效 fileId。检查 Generic Webhook Trigger 的 "
          "Post content parameters 是否配了 fileId，或改用 --payload-file。",
          file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
