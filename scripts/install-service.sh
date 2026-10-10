#!/usr/bin/env bash
#
# 文件传输工具 - Linux systemd 服务管理
# 用法：scripts/install-service.sh [--no-start] [--service-name NAME] [--user USER]
#
set -euo pipefail

APP_NAME="FileTransmitService"
SERVICE_NAME="file-transmit"
SERVICE_USER=""
NO_START=0
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --no-start)     NO_START=1; shift ;;
    --force)        FORCE=1; shift ;;
    --service-name) SERVICE_NAME="${2:?--service-name 需要参数}"; shift 2 ;;
    --user)         SERVICE_USER="${2:?--user 需要参数}"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0"; exit 0 ;;
    *)
      echo "[错误] 未知参数: $1"; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

log()  { echo "[信息] $*"; }
warn() { echo "[警告] $*" >&2; }
err()  { echo "[错误] $*" >&2; }

# ============================================
# 环境检查
# ============================================
if [ "$(uname -s)" != "Linux" ]; then
  err "此脚本仅用于 Linux。Windows 请使用 scripts\\install-service.bat"
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  err "请以 root 运行（sudo scripts/install-service.sh）"
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  err "未找到 systemctl。此脚本依赖 systemd，请确认系统使用 systemd 作为 init。"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  err "未找到 Node.js，请先安装 Node.js（建议 18+）"
  exit 1
fi

NODE_PATH="$(command -v node)"
NODE_VERSION="$(node -v)"

# 运行用户：默认取调用 sudo 的用户，避免服务以 root 运行
if [ -z "$SERVICE_USER" ]; then
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    SERVICE_USER="$SUDO_USER"
  else
    SERVICE_USER="root"
  fi
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  err "用户不存在: $SERVICE_USER"
  exit 1
fi

echo "============================================"
echo "  安装文件传输工具 systemd 服务"
echo "============================================"
log "Node.js   : $NODE_PATH ($NODE_VERSION)"
log "应用目录  : $APP_DIR"
log "服务名    : $SERVICE_NAME"
log "运行用户  : $SERVICE_USER"
echo

# ============================================
# 准备应用
# ============================================
cd "$APP_DIR"

if [ ! -d "node_modules" ]; then
  log "安装依赖..."
  npm install
  echo
fi

if [ ! -d "client/dist" ]; then
  log "构建前端..."
  npm run build
  echo
fi

# logs 目录需要可写
mkdir -p logs
if [ "$SERVICE_USER" != "root" ]; then
  chown -R "$SERVICE_USER":"$(id -gn "$SERVICE_USER")" "$APP_DIR/logs" || true
fi

# ============================================
# 处理旧的服务安装
# ============================================
if [ -f "$UNIT_FILE" ]; then
  if [ "$FORCE" -eq 0 ]; then
    warn "服务已存在：$UNIT_FILE"
    warn "继续执行将覆盖旧配置。加 --force 跳过该确认，或先运行 scripts/uninstall-service.sh"
    read -r -p "是否覆盖？[y/N] " ans
    case "$ans" in
      y|Y|yes|YES) ;;
      *) log "已取消。"; exit 0 ;;
    esac
  fi
  log "停止旧服务..."
  systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
fi

# ============================================
# 生成 systemd unit
# ============================================
log "写入 $UNIT_FILE"

cat > "$UNIT_FILE" <<EOF
[Unit]
Description=File Transmission Service (文件传输工具)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_PATH} ${APP_DIR}/server/index.js
Restart=always
RestartSec=5
# 日志由应用自身写入 logs/app-YYYY-MM-DD.log（按日轮转，保留 30 天）
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}
# 端口切换时进程会自行重启监听，崩溃后自动拉起
KillSignal=SIGTERM
TimeoutStopSec=20

# 基础加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=${APP_DIR}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload

# ============================================
# 启动
# ============================================
systemctl enable "$SERVICE_NAME"

if [ "$NO_START" -eq 1 ]; then
  log "已安装并设置开机自启（--no-start，未启动）"
else
  log "启动服务..."
  systemctl start "$SERVICE_NAME"
  sleep 2

  if systemctl is-active --quiet "$SERVICE_NAME"; then
    echo
    echo "============================================"
    echo "  服务安装完成并已启动！"
    echo "============================================"
  else
    warn "服务可能未正常启动，请查看日志："
    warn "  journalctl -u $SERVICE_NAME -n 50"
    warn "  tail -f logs/app-*.log"
  fi
fi

echo
echo "常用命令："
echo "  sudo scripts/start.sh              前台启动（调试用）"
echo "  sudo scripts/stop.sh               停止服务"
echo "  systemctl status  $SERVICE_NAME"
echo "  systemctl restart $SERVICE_NAME"
echo "  journalctl -u     $SERVICE_NAME -f"
echo "  sudo scripts/uninstall-service.sh  卸载服务"
echo
