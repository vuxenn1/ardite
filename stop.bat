@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ardite.ps1" stop
timeout /t 3 >nul
