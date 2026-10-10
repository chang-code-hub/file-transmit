#!/usr/bin/env bash
#
# 文件传输工具 - Linux 停止
# 用法：scripts/stop.sh [--service-name NAME] [--all]
#
# 默认停止 systemd 服务；若无服务则停止由 scripts/start.sh --background 启动的进程。
#
set -euo pipefail

SERVICE_NAME="file-transmit"
STOP_ALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --service-name) SERVICE_NAME="${2:?--service-name 需要参数}"; shift 2 ;;
    --all)          STOP_ALL=1; shift ;;
    -h|--help)
      sed -n '2,9p' "$0"; exit 0 ;;
    *)
      echo "[错误] 未知参数: $1"; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$APP_DIR/logs/app.pid"

log()  { echo "[信息] $*"; }
warn() { echo "[警告] $*" >&2; }
err()  { echo "[错误] $*" >&2; }

if [ "$(uname -s)" != "Linux" ]; then
  err "此脚本仅用于 Linux。Windows 请直接关闭窗口或使用服务管理器"
  exit 1
fi

echo "============================================"
echo "  停止文件传输工具服务"
echo "============================================"

STOPPED=0

# ============================================
# 1. 停止 systemd 服务
# ============================================
if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    log "停止 systemd 服务 $SERVICE_NAME ..."
    if systemctl stop "$SERVICE_NAME"; then
      log "服务已停止。"
      STOPPED=1
    else
      err "停止服务失败，查看：journalctl -u $SERVICE_NAME -n 20"
      exit 1
    fi
  fi
fi

# ============================================
# 2. 停止后台启动的进程
# ============================================
if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    log "停止后台进程 PID=$PID ..."
    kill "$PID" 2>/dev/null || true

    # 等待优雅退出
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.5
    done

    if kill -0 "$PID" 2>/dev/null; then
      warn "进程未响应，强制结束..."
      kill -9 "$PID" 2>/dev/null || true
    fi
    log "后台进程已停止。"
    STOPPED=1
  else
    warn "PID 文件中的进程已不存在，清理 PID 文件。"
  fi
  rm -f "$PID_FILE"
fi

# ============================================
# 3. 兜底：清理遗留的 node server/index.js
# ============================================
if [ "$STOP_ALL" -eq 1 ]; then
  PIDS="$(pgrep -f "node .*server/index.js" 2>/dev/null || true)"
  if [ -n "$PIDS" ]; then
    warn "发现遗留进程: $PIDS"
    # shellcheck disable=SC2086
    kill $PIDS 2>/dev/null || true
    sleep 1
    PIDS="$(pgrep -f "node .*server/index.js" 2>/dev/null || true)"
    [ -n "$PIDS" ] && kill -9 $PIDS 2>/dev/null || true
    log "遗留进程已清理。"
    STOPPED=1
  fi
fi

if [ "$STOPPED" -eq 0 ]; then
  log "当前没有正在运行的服务进程。"
  log "若服务由 systemd 管理，可用：sudo systemctl stop $SERVICE_NAME"
fi

echo
