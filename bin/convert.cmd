@echo off
rem NOTE: This file is intentionally ASCII-only.
rem cmd.exe reads .cmd files using the system OEM codepage (GBK on Chinese Windows),
rem so UTF-8 Chinese text here would be mangled and break the parser.
rem All Chinese output comes from Node (src\cli.js), which prints UTF-8 under chcp 65001.
rem
rem Double-click to convert. Put .kgg files in the project folder or input\,
rem results go to output\.

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

node src\cli.js %*
set "CODE=%errorlevel%"

echo.
if "%CODE%"=="0" (
  echo   Done. Output files are in the output\ folder.
) else (
  echo   Finished with errors. Exit code: %CODE%
)
echo.
pause
exit /b %CODE%
