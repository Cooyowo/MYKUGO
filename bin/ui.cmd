@echo off
rem NOTE: ASCII-only on purpose - see the comment in convert.cmd.
rem Chinese output comes from Node (src\web\server.js).
rem
rem Starts the local web UI on http://127.0.0.1:8787 and opens the browser.
rem Loopback only: not reachable from LAN or internet. Closing this window stops it.

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

node src\web\server.js %*
set "CODE=%errorlevel%"
echo.
echo   Web UI stopped.
pause
exit /b %CODE%
