#!/usr/bin/env bash
#
# 文件传输工具 - Linux 启动
# 用法：scripts/start.sh [--foreground|--background] [--service-name NAME]
#
# 默认行为：已安装 systemd 服务则启动服务，否则前台启动。
#
set -euo pipefail

SERVICE_NAME="file-transmit"
MODE="auto"

while [ $# -gt 0 ]; do
  case "$1" in
    --service-name) SERVICE_NAME="${2:?--service-name 需要参数}"; shift 2 ;;
    -f|--foreground) MODE="foreground"; shift ;;
    -b|--background) MODE="background"; shift ;;
    -h|--help)
      sed -n '2,10p' "$0"; exit 0 ;;
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
  err "此脚本仅用于 Linux。Windows 请使用 scripts\\start.bat"
  exit 1
fi

cd "$APP_DIR"

# ============================================
# 读取 config.json 中的端口
# ============================================
PORT=3000
if [ -f config.json ] && command -v node >/dev/null 2>&1; then
  PORT="$(node -e 'try{const c=require("./config.json");process.stdout.write(String(c.port||3000))}catch(e){process.stdout.write("3000")}')"
fi

service_installed() {
  command -v systemctl >/dev/null 2>&1 || return 1
  [ -f "/etc/systemd/system/${SERVICE_NAME}.service" ] && return 0
  systemctl list-unit-files "${SERVICE_NAME}.service" 2>/dev/null | grep -q "${SERVICE_NAME}.service"
}

port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -qE "[:.]${1}[[:space:]]"
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | grep -qE "[:.]${1}[[:space:]]"
  else
    return 1
  fi
}

# ============================================
# systemd 服务模式
# ============================================
if service_installed && [ "$MODE" = "auto" ]; then
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    log "服务已在运行（$SERVICE_NAME），端口 $PORT"
    log "浏览器访问：http://localhost:$PORT"
    log "如需前台调试，请用：scripts/start.sh --foreground"
    exit 0
  fi

  log "检测到 systemd 服务，正在启动..."
  if systemctl start "$SERVICE_NAME"; then
    sleep 1
    if systemctl is-active --quiet "$SERVICE_NAME"; then
      log "服务已启动，浏览器访问：http://localhost:$PORT"
      log "查看日志：journalctl -u $SERVICE_NAME -f"
      exit 0
    fi
  fi

  warn "服务启动失败，回退到前台启动（详细日志见下方）"
  journalctl -u "$SERVICE_NAME" -n 20 --no-pager 2>/dev/null || true
  echo
  MODE="foreground"
fi

# ============================================
# 依赖与构建
# ============================================
if [ ! -d node_modules ]; then
  log "正在安装依赖..."
  npm install
  echo
fi

if [ ! -d client/dist ]; then
  log "正在构建前端..."
  npm run build
  echo
fi

mkdir -p logs

# ============================================
# 端口冲突检查
# ============================================
if port_in_use "$PORT"; then
  warn "端口 $PORT 已被占用，可能有另一个实例或 systemd 服务正在运行。"
  if service_installed; then
    warn "可执行：sudo scripts/stop.sh   停止服务后重试"
  fi
  warn "或修改 config.json 中的 port 配置。"
  exit 1
fi

# ============================================
# 启动
# ============================================
if [ "$MODE" = "background" ]; then
  log "后台启动服务（PID 记录在 $PID_FILE）..."
  nohup node server/index.js >> "logs/app.out" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 1
  if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    log "已启动，浏览器访问：http://localhost:$PORT"
    log "查看日志：tail -f logs/app.out logs/app-*.log"
    log "停止服务：scripts/stop.sh"
  else
    err "启动失败，请查看 logs/app.out"
    rm -f "$PID_FILE"
    exit 1
  fi
  exit 0
fi

log "前台启动服务，按 Ctrl+C 停止"
log "浏览器访问：http://localhost:$PORT"
echo
exec node server/index.js
