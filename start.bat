@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ardite.ps1" start
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ardite.ps1" open
timeout /t 3 >nul
