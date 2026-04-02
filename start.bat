@echo off
REM Daily Command Center — Windows launcher

SET PORT=8090
IF NOT "%1"=="" SET PORT=%1

REM Check for Node.js
where node >nul 2>&1
IF ERRORLEVEL 1 (
  echo Node.js is not installed. Download it at https://nodejs.org
  pause
  exit /b 1
)

echo Installing dependencies...
npm install

echo.
echo Starting Daily Command Center on http://localhost:%PORT%
echo Press Ctrl+C to stop.
echo.

SET PORT=%PORT%
node server.js

pause
