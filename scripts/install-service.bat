@echo off
chcp 65001 >nul
title 安装文件传输服务

echo ============================================
echo   安装文件传输 Windows 服务
echo ============================================
echo.

:: Must run as Administrator
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 请以管理员身份运行此脚本！
    echo 右键点击脚本，选择"以管理员身份运行"
    pause
    exit /b 1
)

cd /d "%~dp0\.."

:: Check node
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 Node.js，请先安装 Node.js
    pause
    exit /b 1
)

:: Get node path
for /f "delims=" %%i in ('where node') do set NODE_PATH=%%i

:: Get current directory
set APP_DIR=%cd%

echo [信息] Node.js 路径: %NODE_PATH%
echo [信息] 应用路径: %APP_DIR%
echo.

:: Install dependencies if needed
if not exist "node_modules" (
    echo [安装] 正在安装依赖...
    call npm install
)

:: Build frontend if needed
if not exist "client\dist" (
    echo [构建] 正在构建前端...
    call npm run build
)

echo [安装] 正在创建 Windows 服务...

:: Create the service using sc.exe
:: binPath: node executable + server script
set BIN_PATH="%NODE_PATH%" "%APP_DIR%\server\index.js"

sc create FileTransmitService ^
    binPath= "%BIN_PATH%" ^
    DisplayName= "文件传输服务" ^
    start= auto ^
    obj= LocalSystem

if %errorlevel% equ 0 (
    echo.
    echo ============================================
    echo   服务安装成功！
    echo ============================================
    echo.
    echo 启动服务: sc start FileTransmitService
    echo 停止服务: sc stop FileTransmitService
    echo 删除服务: sc delete FileTransmitService
    echo.
    echo 或使用 Windows 服务管理器 (services.msc) 管理
    echo.
    sc start FileTransmitService
) else (
    echo [错误] 服务安装失败，请检查是否已安装
    echo 如需重新安装，先运行: sc delete FileTransmitService
)

pause
