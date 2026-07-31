@echo off
REM Double-click this file to install Gridiron HQ. No PowerShell typing required.
REM
REM The first time you double-click it, Windows SmartScreen may warn that it's
REM from an unrecognized publisher (normal for any downloaded script, and only
REM happens once) — click "More info", then "Run anyway".
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
echo.
pause
