@echo off
rem Connects "Load from Daily Alert" to the Daily Alert archive (asks for the SQL login). See DEPLOY-VM.md, step 12.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0connect-daily-alert.ps1" %*
echo.
echo Press any key to close this window.
pause >nul
