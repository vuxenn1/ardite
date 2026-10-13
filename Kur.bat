@echo off
chcp 65001 >nul
title Ardite kurulumu
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js bulunamadı. https://nodejs.org adresinden LTS sürümünü kurup tekrar dene. & pause & exit /b 1)
node setup.js || (pause & exit /b 1)
set PS=powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ardite.ps1"
%PS% otomatik-ac
echo   Telefondan erişim için güvenlik duvarı izni isteniyor (Evet de)...
%PS% guvenlik-duvari
%PS% yeniden
%PS% durum
start "" http://localhost:7878
echo   Kurulum bitti. Bu pencereyi kapatabilirsin.
pause >nul
