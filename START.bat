@echo off
title JB AI Proxy
cd /d "%~dp0"

echo ================================================================
echo                JB AI Proxy   One-Click Starter
echo ================================================================
echo.

REM Step 1: check Node.js
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    echo.
    echo Please install Node.js 18+ first: https://nodejs.org/
    echo Then double-click this script again.
    echo.
    pause
    exit /b 1
)

echo [1/4] Node.js detected:
node --version

REM Step 2: copy config templates on first run
if not exist config.json (
    echo [2/4] First run, creating config.json from template
    copy /Y config.example.json config.json >nul
) else (
    echo [2/4] config.json exists, skip
)

if not exist credentials.json (
    copy /Y credentials.example.json credentials.json >nul
)

if not exist cf_settings.json (
    copy /Y cf_settings.example.json cf_settings.json >nul
)

REM Step 3: install dependencies on first run
if not exist node_modules (
    echo [3/4] First run, installing dependencies (about 30 seconds)...
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install failed. Check your network.
        echo If you are in mainland China, try the Taobao mirror:
        echo     npm config set registry https://registry.npmmirror.com
        echo Then double-click this script again.
        echo.
        pause
        exit /b 1
    )
) else (
    echo [3/4] node_modules exists, skip
)

REM Step 4: launch
echo [4/4] Starting proxy server...
echo.
echo ================================================================
echo  Service URLs:
echo    Panel:     http://localhost:3000/panel    (default password: 12345)
echo    OpenAI:    http://localhost:3000/v1/chat/completions
echo    Anthropic: http://localhost:3000/v1/messages
echo.
echo  First-time setup in the panel:
echo    1. Click "Batch Import" to paste accounts
echo    2. Configure "CF Proxy Pool" (recommended)
echo       Mainland China users MUST fill the ladder proxy field
echo       Example: http://127.0.0.1:7890
echo    3. Click "Sync Upstream Models" to fetch latest model list
echo.
echo  Close this window to stop the service.
echo ================================================================
echo.

node server.js

pause
