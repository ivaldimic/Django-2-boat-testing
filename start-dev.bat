@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org (LTS), then try again.
  pause
  exit /b 1
)
node launcher.js
pause
