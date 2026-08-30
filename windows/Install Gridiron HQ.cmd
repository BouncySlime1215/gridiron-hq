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
REM expected. Click "More info", then "Run anyway". This clears the download
REM mark only from the extracted Gridiron HQ folder, not the rest of your PC.
REM
setlocal
title Gridiron HQ - Installer
cd /d "%~dp0.."

echo.
echo   Gridiron HQ
echo   Fantasy football + NFL market analytics
echo.

REM -- Trust the files in this extracted app bundle for future launches --
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-ChildItem -LiteralPath '%CD%' -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue" 2>nul

powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\install.ps1" %*

echo.
pause
