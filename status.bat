@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ardite.ps1" status
pause
