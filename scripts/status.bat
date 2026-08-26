@echo off
REM ============================================================
REM  本地总台 —— 状态 v4
REM ============================================================
setlocal
chcp 65001 >nul

echo === 进程 ===
powershell -NoProfile -Command ^
  "\$p = @(Get-Process -Name local-console -ErrorAction SilentlyContinue); ^
   \$p += @(Get-Process -ErrorAction SilentlyContinue | Where-Object { \$_.Path -and \$_.Path -match 'win-unpacked' }); ^
   if (\$p.Count -eq 0) { Write-Host '  (not running)' -ForegroundColor Yellow } ^
   else { \$p | Select-Object Id, ProcessName, @{N='StartTime';E={\$_.StartTime}}, @{N='Mem(MB)';E={[math]::Round(\$_.WorkingSet64/1MB,1)}} | Format-Table -AutoSize }"
echo.

echo === 9600 ===
netstat -ano 2>NUL | findstr ":9600" | findstr "LISTENING" >NUL
if errorlevel 1 (echo   (not listening)) else (netstat -ano | findstr ":9600" | findstr "LISTENING" & echo   http://127.0.0.1:9600)
echo.

echo === Autostart (HKCU\Run) ===
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "LocalConsole" 2>NUL
if errorlevel 1 (echo   (off)  scripts\autostart.bat on) else (echo   (on)   scripts\autostart.bat off)
echo.

echo === Data dir ===
echo   %APPDATA%\Local Console\
echo.

echo === startup.log tail ===
if exist "%APPDATA%\Local Console\startup.log" (
  powershell -NoProfile -Command "Get-Content '%APPDATA%\Local Console\startup.log' -Tail 8" 2>NUL
) else echo   (no log)
echo.
pause
endlocal
