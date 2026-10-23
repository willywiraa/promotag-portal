@echo off
rem Updates the Promo Tag Portal from GitHub and restarts it. See DEPLOY-VM.md.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-portal.ps1"
echo.
echo Press any key to close this window.
pause >nul
