@echo off
chcp 65001 >nul
echo   Ardite durdurulacak, otomatik başlatma ve güvenlik duvarı izni kaldırılacak.
echo   (Klasörü sonra elle silebilirsin.)
pause
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ardite.ps1" kaldir
pause
