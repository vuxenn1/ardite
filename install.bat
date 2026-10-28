@echo off
title Ardite setup
cd /d "%~dp0"
rem Release packages ship their own Node.js in runtime\, otherwise the installed one is used
set "NODE=node"
if exist "%~dp0runtime\node.exe" set "NODE=%~dp0runtime\node.exe"
if not "%NODE%"=="node" goto setup
where node >nul 2>nul && goto setup
echo   Node.js not found. Download the ready-made package from the Releases page,
echo   or install the LTS version from https://nodejs.org and try again.
pause
exit /b 1

:setup
"%NODE%" setup.js || (pause & exit /b 1)
set PS=powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ardite.ps1"
%PS% autostart-on
echo   Asking for firewall permission so your phone can connect (click Yes)...
%PS% firewall
%PS% restart
%PS% status
%PS% open
echo   Setup complete. You can close this window.
pause >nul
