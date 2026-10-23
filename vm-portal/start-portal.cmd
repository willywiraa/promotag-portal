@echo off
rem Starts the Promo Tag Portal. Keep this window open; see DEPLOY-VM.md in the project folder.
rem To use another port, remove "rem" from the next line and change the number.
rem set PTAE_PORT=8080
rem If the VM reaches the internet only through a proxy (needed for the Teams reply), remove "rem"
rem from the next two lines and put in the proxy address from IT.
rem set NODE_USE_ENV_PROXY=1
rem set HTTPS_PROXY=http://proxy.example.com:8080
cd /d "%~dp0"
title Promo Tag Portal
node --use-system-ca server.js
rem Exit code 3: stopped by update-portal.cmd, which starts the portal again.
if %ERRORLEVEL% EQU 3 exit /b 0
echo.
echo The portal has stopped. Press any key to close this window.
pause >nul
