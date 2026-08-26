# 独立 ps1 启动器 —— 用英文引号避免 PowerShell 解析歧义
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$candidates = @(
  (Join-Path $root 'dist\win-unpacked\本地总台.exe'),
  (Join-Path $root 'dist\win-unpacked\local-console.exe')
)
$exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) {
  Write-Error "no exe found, run npm run build first"
  Read-Host "Enter to exit"
  exit 1
}

$running = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ProcessName -in @('local-console','本地总台') -or ($_.Path -and $_.Path -match 'win-unpacked')
}
if ($running) {
  Write-Host '[ok] already running:' -ForegroundColor Green
  $running | Select-Object Id, ProcessName, StartTime | Format-Table -AutoSize
} else {
  Write-Host "[info] launching $exe" -ForegroundColor Cyan
  Start-Process -FilePath $exe -WindowStyle Hidden
  Write-Host '[ok] launched, tray icon in 5~10s' -ForegroundColor Green
}

Write-Host ''
Write-Host 'Browser: http://127.0.0.1:9600'
Write-Host "Data:    $env:APPDATA\Local Console\"
Write-Host ''
Read-Host 'Enter to close (does not stop local-console)'
