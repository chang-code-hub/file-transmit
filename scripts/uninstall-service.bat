@echo off
chcp 65001 >nul
title 卸载文件传输服务

echo ============================================
echo   卸载文件传输 Windows 服务
echo ============================================
echo.

:: Must run as Administrator
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 请以管理员身份运行此脚本！
    pause
    exit /b 1
)

echo [停止] 正在停止服务...
sc stop FileTransmitService >nul 2>&1

echo [删除] 正在删除服务...
sc delete FileTransmitService

if %errorlevel% equ 0 (
    echo.
    echo 服务已成功卸载！
) else (
    echo.
    echo 服务可能未安装或已被删除
)

pause
