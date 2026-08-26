Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ProcessName -in @('local-console','本地总台') -or $_.Path -match 'win-unpacked'
} | ForEach-Object {
  Write-Host "停止 PID=$($_.Id) $($_.ProcessName)"
  Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1
$left = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ProcessName -in @('local-console','本地总台') -or $_.Path -match 'win-unpacked'
}
if ($left) {
  Write-Host "[warn] 残留: $($left.Count)" -ForegroundColor Yellow
} else {
  Write-Host "[ok] 已停止" -ForegroundColor Green
}
Read-Host "按 Enter 关闭"
