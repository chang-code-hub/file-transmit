@echo off
title File Transmission Tool

echo ============================================
echo   File Transmission Tool
echo ============================================
echo.

cd /d "%~dp0\.."

:: Read port from config.json
set "PORT=3000"
if exist "config.json" (
    for /f "tokens=2 delims=:, " %%a in ('findstr /c:"\"port\":" config.json 2^>nul') do set "PORT=%%~a"
)

:: Check if the Windows service is running (would cause port conflict)
sc query FileTransmitService >nul 2>&1
if %errorlevel% equ 0 (
    sc query FileTransmitService | findstr /i "RUNNING" >nul
    if %errorlevel% equ 0 (
        echo [Warning] FileTransmitService is already running as a Windows service!
        echo Running both will cause a port conflict (port %PORT%).
        echo.
        echo Options:
        echo   1. Stop the service first: sc stop FileTransmitService
        echo      Then run this script again.
        echo   2. Or access the running service at http://localhost:%PORT%
        echo.
        choice /c 12 /m "Choose [1] to stop service and continue, [2] to exit"
        if errorlevel 2 exit /b 0
        echo Stopping service...
        sc stop FileTransmitService >nul 2>&1
        timeout /t 2 /nobreak >nul
        echo Service stopped.
        echo.
    )
)

:: Check if node_modules exists
if not exist "node_modules" (
    echo [Setup] Installing dependencies...
    call npm install
    echo.
)

:: Check if client is built
if not exist "client\dist" (
    echo [Build] Building frontend...
    call npm run build
    echo.
)

echo [Start] Starting server in foreground...
echo Press Ctrl+C to stop.
echo.
node server/index.js
pause
