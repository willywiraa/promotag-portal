@echo off
rem Starts the Promo Tag Portal. Keep this window open; see DEPLOY-VM.md in the project folder.
rem (run-in-background.cmd makes it run without a window instead.)
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
if /i "%~1"=="/background" goto background
title Promo Tag Portal
if not exist "node_modules\playwright-core\package.json" call :install || goto stopped
node --use-system-ca server.js
rem Exit code 3: stopped by update-portal.cmd, which starts the portal again. 4: it is already running.
if %ERRORLEVEL% EQU 3 exit /b 0
if %ERRORLEVEL% EQU 4 goto close
:stopped
echo.
echo The portal has stopped.
:close
echo Press any key to close this window.
pause >nul
exit /b 1

:background
rem Without a window (update-portal.ps1 starts it so): the output goes to data\portal.log, and the
rem portal is started again 30 seconds after it stops unexpectedly. It ends when the portal was
rem stopped on purpose (exit code 3: update-portal.cmd, stop-portal.cmd) or is already running (4).
set "PTAE_BACKGROUND=1"
if not exist "data" mkdir "data"
:again
if exist "data\portal.log" for %%F in ("data\portal.log") do if %%~zF GTR 5000000 move /y "data\portal.log" "data\portal.old.log" >nul
call :run >>"data\portal.log" 2>&1
if %ERRORLEVEL% EQU 3 exit /b 0
if %ERRORLEVEL% EQU 4 exit /b 0
ping -n 31 127.0.0.1 >nul
goto again

:run
echo.
echo ---- %DATE% %TIME%
if not exist "node_modules\playwright-core\package.json" call :install || exit /b 1
node --use-system-ca server.js
exit /b %ERRORLEVEL%

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
