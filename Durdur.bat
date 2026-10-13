@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ardite.ps1" durdur
timeout /t 3 >nul
