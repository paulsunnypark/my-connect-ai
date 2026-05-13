@echo off
setlocal

cd /d "%~dp0"

if "%CONNECTAI_PROXY_PORT%"=="" set "CONNECTAI_PROXY_PORT=4000"
set "CONNECTAI_PROXY_HEALTH=http://127.0.0.1:%CONNECTAI_PROXY_PORT%/health"

powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-RestMethod -Uri $env:CONNECTAI_PROXY_HEALTH -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if "%ERRORLEVEL%"=="0" (
  echo ConnectAI proxy is already running on %CONNECTAI_PROXY_HEALTH%
  exit /b 0
)

where node >nul 2>nul
if not "%ERRORLEVEL%"=="0" (
  echo Node.js was not found on PATH.
  echo Install Node.js or add node.exe to PATH, then run this file again.
  exit /b 1
)

echo Starting ConnectAI proxy from %CD%
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'node' -ArgumentList 'proxy.js' -WorkingDirectory (Get-Location).Path -WindowStyle Hidden"

timeout /t 2 /nobreak >nul

powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-RestMethod -Uri $env:CONNECTAI_PROXY_HEALTH -TimeoutSec 5 | Out-Null; exit 0 } catch { exit 1 }"
if "%ERRORLEVEL%"=="0" (
  echo ConnectAI proxy started: %CONNECTAI_PROXY_HEALTH%
  exit /b 0
)

echo Failed to start ConnectAI proxy. Run "node proxy.js" manually to see the error.
exit /b 1
