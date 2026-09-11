@echo off
rem NOTE: ASCII-only on purpose - see the comment in convert.cmd.
rem Chinese output comes from Node (src\cli.js).
rem
rem Health check: prints the .kgg header and whether the key was found.
rem Writes no files. Run this first when conversion fails.

setlocal
chcp 65001 >nul
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [ERROR] Node.js not found.
  echo   Please install Node.js 22.5 or newer: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

node src\cli.js --probe %*
set "CODE=%errorlevel%"
echo.
pause
exit /b %CODE%
