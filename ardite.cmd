@echo off
rem Runs ardite.js with the Node.js bundled in runtime\ (release packages), otherwise the installed one.
rem Usage: ardite install ^| start ^| stop ^| restart ^| status ^| open ^| update ^| uninstall
set "ARDITE_NODE=%~dp0runtime\node.exe"
if not exist "%ARDITE_NODE%" set "ARDITE_NODE=node"
"%ARDITE_NODE%" "%~dp0ardite.js" %*
if errorlevel 9009 (
  echo   Node.js not found. Download the ready-made package from the Releases page,
  echo   or install the LTS version from https://nodejs.org and try again.
  pause
)
