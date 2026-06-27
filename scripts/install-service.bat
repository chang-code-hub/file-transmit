@echo off
title Install File Transmission Service

echo ============================================
echo   Install File Transmission Windows Service
echo ============================================
echo.

:: Must run as Administrator
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [Error] Please run this script as Administrator!
    echo Right-click the script and select "Run as administrator"
    pause
    exit /b 1
)

cd /d "%~dp0\.."

:: Check node
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [Error] Node.js not found. Please install Node.js first.
    pause
    exit /b 1
)

:: ============================================
:: Find or download nssm (Non-Sucking Service Manager)
:: ============================================
set "NSSM_PATH="

:: 1. Check if nssm is in PATH
where nssm >nul 2>&1
if %errorlevel% equ 0 (
    for /f "delims=" %%i in ('where nssm') do set "NSSM_PATH=%%i"
    echo [Info] Found nssm in PATH: %NSSM_PATH%
    goto :nssm_found
)

:: 2. Check if bundled in scripts folder
if exist "%~dp0nssm.exe" (
    set "NSSM_PATH=%~dp0nssm.exe"
    echo [Info] Found bundled nssm: %NSSM_PATH%
    goto :nssm_found
)

:: 3. Check winget
where winget >nul 2>&1
if %errorlevel% equ 0 (
    echo [Setup] Installing nssm via winget...
    winget install --accept-source-agreements --accept-package-agreements NSSM.NSSM
    where nssm >nul 2>&1
    if %errorlevel% equ 0 (
        for /f "delims=" %%i in ('where nssm') do set "NSSM_PATH=%%i"
        echo [Info] nssm installed via winget: %NSSM_PATH%
        goto :nssm_found
    )
)

:: 4. Download nssm
echo [Setup] Downloading nssm (Windows service wrapper)...
powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://nssm.cc/release/nssm-2.24.zip' -OutFile '%TEMP%\nssm.zip'" 2>nul
if exist "%TEMP%\nssm.zip" (
    powershell -Command "Expand-Archive -Path '%TEMP%\nssm.zip' -DestinationPath '%TEMP%\nssm_extract' -Force" 2>nul
    if exist "%TEMP%\nssm_extract\nssm-2.24\win64\nssm.exe" (
        copy /Y "%TEMP%\nssm_extract\nssm-2.24\win64\nssm.exe" "%~dp0nssm.exe" >nul
        set "NSSM_PATH=%~dp0nssm.exe"
        echo [Info] nssm downloaded to scripts\nssm.exe
        goto :nssm_found
    )
)

echo [Error] Could not install nssm.
echo Please install manually with one of these methods:
echo   1. winget install NSSM.NSSM
echo   2. Download from https://nssm.cc/download
echo      Place nssm.exe in the scripts\ folder or add to PATH
pause
exit /b 1

:nssm_found

:: ============================================
:: Get paths
:: ============================================
for /f "delims=" %%i in ('where node') do set "NODE_PATH=%%i"
set "APP_DIR=%CD%"

echo [Info] Node.js : %NODE_PATH%
echo [Info] App dir : %APP_DIR%
echo.

:: ============================================
:: Prepare app
:: ============================================
if not exist "node_modules" (
    echo [Setup] Installing dependencies...
    call npm install
    echo.
)

if not exist "client\dist" (
    echo [Build] Building frontend...
    call npm run build
    echo.
)

:: Create logs directory
if not exist "logs" mkdir "logs"

:: ============================================
:: Remove old broken service if exists
:: ============================================
sc query FileTransmitService >nul 2>&1
if %errorlevel% equ 0 (
    echo [Cleanup] Removing old service entry - was using sc create, which cannot work...
    sc stop FileTransmitService >nul 2>&1
    timeout /t 2 /nobreak >nul
    sc delete FileTransmitService >nul 2>&1
    echo.
)

:: ============================================
:: Install service via nssm
:: ============================================
echo [Setup] Installing service with nssm...

"%NSSM_PATH%" install FileTransmitService "%NODE_PATH%" "%APP_DIR%\server\index.js"
if %errorlevel% neq 0 (
    echo [Error] Failed to install service.
    pause
    exit /b 1
)

:: Configure service
"%NSSM_PATH%" set FileTransmitService AppDirectory "%APP_DIR%"
"%NSSM_PATH%" set FileTransmitService DisplayName "File Transmission Service"
"%NSSM_PATH%" set FileTransmitService Description "File Transmission Tool - Self-hosted file transfer service"
"%NSSM_PATH%" set FileTransmitService Start SERVICE_AUTO
"%NSSM_PATH%" set FileTransmitService AppStdout "%APP_DIR%\logs\service-out.log"
"%NSSM_PATH%" set FileTransmitService AppStderr "%APP_DIR%\logs\service-err.log"
"%NSSM_PATH%" set FileTransmitService AppExit Default Restart

echo.
echo [Start] Starting service...
"%NSSM_PATH%" start FileTransmitService

:: Wait a moment and check status
timeout /t 3 /nobreak >nul
"%NSSM_PATH%" status FileTransmitService 2>nul | findstr /i "RUNNING" >nul
if %errorlevel% equ 0 (
    echo.
    echo ============================================
    echo   Service installed and RUNNING!
    echo ============================================
) else (
    echo.
    echo ============================================
    echo   Service installed but may not be running.
    echo   Check status: nssm status FileTransmitService
    echo   Check logs:   logs\service-err.log
    echo ============================================
)

echo.
echo Commands:
echo   Status:  nssm status FileTransmitService
echo   Start:   nssm start  FileTransmitService
echo   Stop:    nssm stop   FileTransmitService
echo   Restart: nssm restart FileTransmitService
echo   Remove:  nssm remove FileTransmitService confirm
echo.
echo Or manage via: services.msc  (look for "File Transmission Service")
echo.

pause
