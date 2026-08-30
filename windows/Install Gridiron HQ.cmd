@echo off
REM ══════════════════════════════════════════════════════════════════════
REM   GRIDIRON HQ - double-click this file. That is the whole installation.
REM ══════════════════════════════════════════════════════════════════════
REM
REM You do not need Node.js or anything else installed first. If Node is
REM missing, this fetches a private copy into %USERPROFILE%\.gridiron and
REM uses that. Nothing is installed system-wide and no admin prompt appears.
REM
REM IF WINDOWS BLOCKS THIS THE FIRST TIME
REM SmartScreen warns about anything downloaded that is not signed with a
REM commercial certificate. This project is not signed, so the warning is
REM expected. Click "More info", then "Run anyway". This script's first act
REM is to unblock every file in the folder, so you see that at most once.
REM
setlocal
title Gridiron HQ - Installer
cd /d "%~dp0.."

echo.
echo   Gridiron HQ
echo   Fantasy football + NFL market analytics
echo.

REM -- Clear the "downloaded from the internet" mark on every project file --
REM Windows stores it as an alternate data stream; Unblock-File strips it.
REM Doing the whole tree first means the start launcher and scripts are
REM already trusted, so this is the only file SmartScreen can ever stop.
echo   Clearing the Windows download flag...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-ChildItem -LiteralPath '%CD%' -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue" 2>nul
echo   Done - Windows will not ask about these files again.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\install.ps1" %*

echo.
pause
