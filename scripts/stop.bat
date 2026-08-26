@echo off
REM ============================================================
REM  本地总台 —— 停止 v4
REM  通过 .NET 杀进程 + 通配文件路径（兼容中文乱码 exe）
REM ============================================================
setlocal
chcp 65001 >nul

powershell -NoProfile -Command ^
  "Get-Process -Name local-console -ErrorAction SilentlyContinue | Stop-Process -Force; ^
   \$extra = Get-Process -ErrorAction SilentlyContinue | Where-Object { \$_.Path -and \$_.Path -match 'win-unpacked' }; ^
   \$extra | Stop-Process -Force -ErrorAction SilentlyContinue; ^
   Start-Sleep -Seconds 1; ^
   \$left = @(Get-Process -Name local-console -ErrorAction SilentlyContinue) + @(Get-Process -ErrorAction SilentlyContinue | Where-Object { \$_.Path -and \$_.Path -match 'win-unpacked' }); ^
   if (\$left.Count -eq 0) { Write-Host '[ok] stopped' -ForegroundColor Green } else { Write-Host '[warn] left:' \$left.Count -ForegroundColor Yellow; \$left | Format-Table Id, ProcessName -AutoSize }"
pause
endlocal
