@echo off
rem Makes the Promo Tag Portal run without a window from now on: Windows starts it when you sign in to
rem this VM, and it starts again if it stops unexpectedly. See DEPLOY-VM.md, step 9.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-portal.ps1" -Background
echo.
echo Press any key to close this window.
pause >nul
