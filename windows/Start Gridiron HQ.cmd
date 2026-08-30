@echo off
REM Double-click to start Gridiron HQ. It opens in your browser by itself.
REM
REM Leave this window open while you use the app - closing it stops the server.
setlocal
title Gridiron HQ
cd /d "%~dp0.."

REM If the installer fetched a private Node it is not on the system PATH, and
REM this window would otherwise say "npm is not recognized" on a machine where
REM the app is installed and working perfectly.
if exist "%USERPROFILE%\.gridiron\node\node.exe" set "PATH=%USERPROFILE%\.gridiron\node;%PATH%"

where npm >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is missing. Double-click "Install Gridiron HQ" in this folder first.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting Gridiron HQ - your browser will open in a moment.
echo   Keep this window open. Close it to stop the app.
echo.
call npm start
pause
