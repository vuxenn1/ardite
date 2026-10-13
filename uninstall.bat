@echo off
echo   Ardite will be stopped, and autostart and the firewall rule will be removed.
echo   (You can delete this folder yourself afterwards.)
pause
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ardite.ps1" uninstall
pause
