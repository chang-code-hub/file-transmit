#!/usr/bin/env bash
#
# 文件传输工具 - 卸载 Linux systemd 服务
# 用法：scripts/uninstall-service.sh [--service-name NAME] [--yes]
#
set -euo pipefail

SERVICE_NAME="file-transmit"
ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y)       ASSUME_YES=1; shift ;;
    --service-name) SERVICE_NAME="${2:?--service-name 需要参数}"; shift 2 ;;
    -h|--help)
      sed -n '2,8p' "$0"; exit 0 ;;
    *)
      echo "[错误] 未知参数: $1"; exit 1 ;;
  esac
done

UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

log()  { echo "[信息] $*"; }
warn() { echo "[警告] $*" >&2; }
err()  { echo "[错误] $*" >&2; }

if [ "$(uname -s)" != "Linux" ]; then
  err "此脚本仅用于 Linux。Windows 请使用 scripts\\uninstall-service.bat"
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  err "请以 root 运行（sudo scripts/uninstall-service.sh）"
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  err "未找到 systemctl。"
  exit 1
fi

echo "============================================"
echo "  卸载文件传输工具 systemd 服务"
echo "============================================"

if [ ! -f "$UNIT_FILE" ] && ! systemctl list-unit-files "${SERVICE_NAME}.service" >/dev/null 2>&1; then
  log "服务未安装，无需卸载。"
  exit 0
fi

if [ "$ASSUME_YES" -eq 0 ]; then
  warn "将停止并删除服务 ${SERVICE_NAME}（应用文件与数据不会删除）"
  read -r -p "确认卸载？[y/N] " ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) log "已取消。"; exit 0 ;;
  esac
fi

# ============================================
# 停止并禁用
# ============================================
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  log "停止服务..."
  systemctl stop "$SERVICE_NAME" || true
fi

if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
  log "取消开机自启..."
  systemctl disable "$SERVICE_NAME" >/dev/null 2>&1 || true
fi

# ============================================
# 删除 unit 文件
# ============================================
if [ -f "$UNIT_FILE" ]; then
  log "删除 $UNIT_FILE"
  rm -f "$UNIT_FILE"
fi

# 兼容异常路径：确认没有残留 unit
for p in /etc/systemd/system /run/systemd/system /usr/lib/systemd/system /lib/systemd/system; do
  [ -f "${p}/${SERVICE_NAME}.service" ] && rm -f "${p}/${SERVICE_NAME}.service" && log "删除 ${p}/${SERVICE_NAME}.service"
done

systemctl daemon-reload
systemctl reset-failed "$SERVICE_NAME" >/dev/null 2>&1 || true

echo
log "服务卸载完成。"
log "应用数据（config.json、data.db、files/）已保留，如需彻底清理请手动删除。"
echo
