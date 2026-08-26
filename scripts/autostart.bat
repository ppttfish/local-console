@echo off
REM ============================================================
REM  本地总台 —— 开机自启 v4
REM ============================================================
setlocal
chcp 65001 >nul

set "ROOT=%~dp0.."
set "DIR=%ROOT%\dist\win-unpacked"
set "ASCII_EXE=%DIR%\local-console.exe"

REM 确保 ASCII exe 存在
powershell -NoProfile -Command ^
  "if (-not (Test-Path '%ASCII_EXE%')) { ^
     \$e = Get-ChildItem '%DIR%\*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1; ^
     if (\$e) { [System.IO.File]::Move(\$e.FullName, '%ASCII_EXE%'); Write-Host '[fix] renamed' } ^
   }"

set "REG_KEY=HKCU\Software\Microsoft\Windows\CurrentVersion\Run"
set "REG_NAME=LocalConsole"

if /I "%~1"=="on" goto do_on
if /I "%~1"=="off" goto do_off
if /I "%~1"=="status" goto do_status
echo Usage: %~nx0 on ^| off ^| status
pause
exit /b 1

:do_on
if not exist "%ASCII_EXE%" (
  echo [error] no exe, run npm run build first
  pause
  exit /b 1
)
reg add "%REG_KEY%" /v "%REG_NAME%" /t REG_SZ /d "\"%ASCII_EXE%\" --hidden" /f >NUL
echo [ok] autostart enabled
echo      HKCU\...\Run\LocalConsole = "%ASCII_EXE%" --hidden
pause
exit /b 0

:do_off
reg delete "%REG_KEY%" /v "%REG_NAME%" /f >NUL 2>&1
echo [ok] autostart disabled
pause
exit /b 0

:do_status
reg query "%REG_KEY%" /v "%REG_NAME%" 2>NUL
if errorlevel 1 (echo [off]) else (echo [on])
pause
exit /b 0
endlocal
