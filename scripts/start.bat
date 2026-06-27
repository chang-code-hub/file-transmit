@echo off
chcp 65001 >nul
title 文件传输工具

echo ============================================
echo   文件传输工具 - File Transmission Tool
echo ============================================
echo.

cd /d "%~dp0\.."

:: Check if node_modules exists
if not exist "node_modules" (
    echo [安装] 正在安装依赖...
    call npm install
    echo.
)

:: Check if client is built
if not exist "client\dist" (
    echo [构建] 正在构建前端...
    call npm run build
    echo.
)

echo [启动] 正在启动服务...
echo.
node server/index.js
pause
