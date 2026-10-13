@echo off
title Ardite setup
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js not found. Install the LTS version from https://nodejs.org and try again. & pause & exit /b 1)
node setup.js || (pause & exit /b 1)
set PS=powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ardite.ps1"
%PS% autostart-on
echo   Asking for firewall permission so your phone can connect (click Yes)...
%PS% firewall
%PS% restart
%PS% status
start "" http://localhost:7878
echo   Setup complete. You can close this window.
pause >nul
