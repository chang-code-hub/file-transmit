@echo off
title Uninstall File Transmission Service

echo ============================================
echo   Uninstall File Transmission Windows Service
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

:: ============================================
:: Find nssm
:: ============================================
set "NSSM_PATH="

where nssm >nul 2>&1
if %errorlevel% equ 0 (
    for /f "delims=" %%i in ('where nssm') do set "NSSM_PATH=%%i"
)
if "%NSSM_PATH%"=="" if exist "%~dp0nssm.exe" (
    set "NSSM_PATH=%~dp0nssm.exe"
)

:: ============================================
:: Try nssm first (new-style install)
:: ============================================
if not "%NSSM_PATH%"=="" (
    "%NSSM_PATH%" status FileTransmitService >nul 2>&1
    if %errorlevel% equ 0 (
        echo [Stop] Stopping service via nssm...
        "%NSSM_PATH%" stop FileTransmitService >nul 2>&1
        timeout /t 2 /nobreak >nul

        echo [Delete] Removing service via nssm...
        "%NSSM_PATH%" remove FileTransmitService confirm
        if %errorlevel% equ 0 (
            echo Service uninstalled successfully!
        ) else (
            echo [Warning] nssm remove failed, trying sc delete...
            sc delete FileTransmitService
        )
        goto :done
    )
)

:: ============================================
:: Fallback: try sc (old-style install)
:: ============================================
sc query FileTransmitService >nul 2>&1
if %errorlevel% equ 0 (
    echo [Stop] Stopping service...
    sc stop FileTransmitService >nul 2>&1
    timeout /t 2 /nobreak >nul

    echo [Delete] Removing service...
    sc delete FileTransmitService
    if %errorlevel% equ 0 (
        echo Service uninstalled successfully!
    ) else (
        echo [Error] Failed to remove service.
    )
) else (
    echo Service is not installed.
)

:done
echo.
pause
