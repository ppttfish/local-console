$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ProcessName -in @('local-console','本地总台') -or $_.Path -match 'win-unpacked'
}
Write-Host "=== 进程 ===" -ForegroundColor Cyan
if ($procs) {
  $procs | Select-Object Id, ProcessName, @{N='StartTime';E={$_.StartTime}}, @{N='Mem(MB)';E={[math]::Round($_.WorkingSet64/1MB,1)}} | Format-Table -AutoSize
} else { Write-Host "  (未运行)" -ForegroundColor Yellow }

Write-Host "`n=== 9600 端口 ===" -ForegroundColor Cyan
$p = netstat -ano | Select-String ':9600\s.*LISTENING'
if ($p) { Write-Host "  $p" -ForegroundColor Green; Write-Host "  浏览器: http://127.0.0.1:9600" }
else { Write-Host "  (未监听)" -ForegroundColor Yellow }

Write-Host "`n=== 开机自启 ===" -ForegroundColor Cyan
$reg = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'LocalConsole' -ErrorAction SilentlyContinue
if ($reg) { Write-Host "  [已开] $($reg.LocalConsole)" -ForegroundColor Green }
else { Write-Host "  (未开)  scripts\autostart.bat on" -ForegroundColor Yellow }

Write-Host "`n=== 数据目录 ===" -ForegroundColor Cyan
Write-Host "  $env:APPDATA\Local Console\"

Write-Host "`n=== startup.log 最近 8 行 ===" -ForegroundColor Cyan
$log = Join-Path $env:APPDATA 'Local Console\startup.log'
if (Test-Path $log) { Get-Content $log -Tail 8 } else { Write-Host "  (不存在)" -ForegroundColor Yellow }
Read-Host "`n按 Enter 关闭"
