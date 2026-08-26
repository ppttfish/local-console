# 修 electron-builder winCodeSign symlink bug
# 解决 7za 错误导致 PS 终止问题：重定向到文件再读
$ErrorActionPreference = 'Continue'
$cacheDir = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\winCodeSign'
$7za = 'F:\local-console\node_modules\7zip-bin\win\x64\7za.exe'

if (-not (Test-Path $cacheDir)) { Write-Host "no cache dir, skip"; exit 0 }

Get-ChildItem $cacheDir -Directory | ForEach-Object {
  $dir = $_.FullName
  $hash = $_.Name
  $zip = Join-Path $cacheDir "$hash.7z"
  if (-not (Test-Path $zip)) { return }
  Write-Host "processing $hash ..."

  $tmp = Join-Path $env:TEMP "wcs-$hash"
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  $null = New-Item -ItemType Directory -Path $tmp

  # 7za 错误写到 stderr，2>&1 合并到 stdout；用 cmd /c 包装避免 PS 的 native error 终止
  cmd /c "`"$7za`" x -bd -y -o`"$tmp`" `"$zip`"" 2>&1 | Out-Null
  $ec = $LASTEXITCODE
  Write-Host "  extract exit=$ec"

  $darwin = Join-Path $tmp 'darwin'
  if (Test-Path $darwin) {
    Remove-Item -Recurse -Force $darwin
    Write-Host "  removed darwin"
  }

  $newZip = "$tmp.7z"
  if (Test-Path $newZip) { Remove-Item $newZip }
  cmd /c "`"$7za`" a -bd -y `"$newZip`" `"$tmp\*`"" 2>&1 | Out-Null
  Move-Item -Force $newZip $zip
  Remove-Item -Recurse -Force $tmp
  Write-Host "  repacked"
}

Write-Host "done"
