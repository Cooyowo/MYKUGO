@echo off
rem Creates (or refreshes) the launcher shortcut in the project folder.
rem Run this again after moving the project to another folder.
rem ASCII-only on purpose - see the note in convert.cmd.

setlocal
chcp 65001 >nul
cd /d "%~dp0.."

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "bin\make-shortcut.ps1"
set "CODE=%errorlevel%"

echo.
if not "%CODE%"=="0" echo   Failed. Exit code: %CODE%
pause
exit /b %CODE%
