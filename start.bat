@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ardite.ps1" start
start "" http://localhost:7878
timeout /t 3 >nul
