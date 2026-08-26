@echo off
REM ============================================================
REM  本地总台 —— 启动器 v5
REM  - 自检/修复 resources\icon.ico（electron-builder 漏拷）
REM  - 保证 exe 名为 local-console.exe
REM  - 不使用 Hidden（会破坏 Electron window.show）
REM ============================================================
setlocal
chcp 65001 >nul
set "ROOT=%~dp0.."
set "DIR=%ROOT%\dist\win-unpacked"
set "RES=%DIR%\resources"
set "EXE=%DIR%\local-console.exe"

REM 1. 确保 ASCII exe
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "if (-not (Test-Path '%EXE%')) { ^
     \$f = [System.IO.Directory]::GetFiles('%DIR%', '*.exe'); ^
     if (\$f.Count -gt 0) { [System.IO.File]::Move(\$f[0], '%EXE%'); Write-Host ('[fix] renamed ' + [System.IO.Path]::GetFileName(\$f[0]) + ' -> local-console.exe') } ^
   }"

REM 2. 确保 icon.ico 存在（11:08 重新打包时漏拷）
if not exist "%RES%\icon.ico" if exist "%ROOT%\build\icon.ico" (
  copy /Y "%ROOT%\build\icon.ico" "%RES%\icon.ico" >NUL
  echo [fix] copied icon.ico to resources\
)

if not exist "%EXE%" (
  echo [error] 找不到 exe，请先 npm run build
  pause
  exit /b 1
)

REM 3. 检查是否已跑
powershell -NoProfile -Command ^
  "if (Get-Process -Name local-console -ErrorAction SilentlyContinue) { ^
     Write-Host '[ok] already running'; Get-Process -Name local-console | Select-Object Id, SessionId, MainWindowTitle | Format-Table -AutoSize; exit 0 ^
   } else { exit 1 }"
if not errorlevel 1 (
  echo.
  echo Browser: http://127.0.0.1:9600
  pause
  exit /b 0
)

REM 4. 启动（不用 Hidden，GUI app 会被破坏）
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%EXE%'"
echo [ok] launched

REM 5. 等 10s 后看窗口是否起来
echo.
echo Waiting for window to appear...
timeout /t 15 /nobreak >NUL
powershell -NoProfile -Command ^
  "\$p = Get-Process -Name local-console -ErrorAction SilentlyContinue | Where-Object { \$_.MainWindowHandle -ne 0 } | Select-Object -First 1; ^
   if (\$p) { Write-Host ('[ok] window: ' + \$p.MainWindowTitle + ' (hwnd=' + \$p.MainWindowHandle + ')') -ForegroundColor Green } ^
   else { Write-Host '[warn] no window yet, try again in 10s' -ForegroundColor Yellow }"
echo.
echo Browser: http://127.0.0.1:9600
echo Data:    %APPDATA%\Local Console\
pause
endlocal
