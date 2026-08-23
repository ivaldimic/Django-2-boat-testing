@echo off
cd /d "%~dp0"
title Expedition bridge
echo Starting the Expedition bridge...
echo.
where node >nul 2>nul || goto NONODE
if exist node_modules goto RUN
echo Installing dependencies (first run only)...
call npm install
:RUN
node bridge.js
echo.
echo Bridge stopped. You can close this window.
pause
goto END
:NONODE
echo Node.js is not installed. Install the LTS version from https://nodejs.org
echo then run this again.
pause
:END
