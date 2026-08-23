@echo off
cd /d "%~dp0"
title Two-boat testing (dev)
where node >nul 2>nul || goto NONODE
node launcher.js
echo.
echo Stopped. You can close this window.
pause
goto END
:NONODE
echo Node.js is not installed. Install the LTS version from https://nodejs.org then run this again.
pause
:END
