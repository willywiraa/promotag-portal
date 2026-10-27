@echo off
rem Stops the Promo Tag Portal, never during a run. update-portal.cmd starts it again. See DEPLOY-VM.md.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-portal.ps1" -Stop
echo.
echo Press any key to close this window.
pause >nul
