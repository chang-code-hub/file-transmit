#!/bin/bash
echo "============================================"
echo "  文件传输工具 - File Transmission Tool"
echo "============================================"
echo ""

cd "$(dirname "$0")/.."

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "[安装] 正在安装依赖..."
    npm install
    echo ""
fi

# Check if client is built
if [ ! -d "client/dist" ]; then
    echo "[构建] 正在构建前端..."
    npm run build
    echo ""
fi

echo "[启动] 正在启动服务..."
echo ""
node server/index.js
