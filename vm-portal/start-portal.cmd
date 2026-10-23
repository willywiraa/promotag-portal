@echo off
rem Starts the Promo Tag Portal. Keep this window open; see DEPLOY-VM.md in the project folder.
rem Installs the portal's libraries first when they are missing (first start, or after an update
rem that changed them).
rem
rem Settings for this VM go in data\env.cmd, which is not in Git, so updates keep it. One per line:
rem   set PTAE_HOST=127.0.0.1                          behind IIS: only IIS on this VM can reach the portal
rem   set PTAE_PUBLIC_URL=http://<vm-name>/promotag/   the address shown for colleagues
rem   set PTAE_PORT=8080                               another port (also change it in IIS's web.config)
rem   set NODE_USE_ENV_PROXY=1                         internet through a proxy (Teams reply, libraries),
rem   set HTTPS_PROXY=http://proxy.example.com:8080    with the proxy address from IT
cd /d "%~dp0"
if exist "data\env.cmd" call "data\env.cmd"
title Promo Tag Portal
if not exist "node_modules\playwright-core\package.json" call :install || goto stopped
node --use-system-ca server.js
rem Exit code 3: stopped by update-portal.cmd, which starts the portal again.
if %ERRORLEVEL% EQU 3 exit /b 0
:stopped
echo.
echo The portal has stopped. Press any key to close this window.
pause >nul
exit /b 1

:install
echo Installing the portal's libraries (npm ci). This takes a minute...
rem Trust the certificates Windows trusts, as the portal does (company networks may inspect HTTPS).
set "NODE_OPTIONS=--use-system-ca"
call npm ci --no-audit --no-fund
set "FAILED=%ERRORLEVEL%"
set "NODE_OPTIONS="
if not "%FAILED%"=="0" (
  echo.
  echo The libraries could not be installed: the message above says why. If this VM cannot reach
  echo registry.npmjs.org, copy the vm-portal\node_modules folder from your laptop into this folder
  echo and start the portal again.
  exit /b 1
)
exit /b 0
