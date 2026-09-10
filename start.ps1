$projectDir = $PSScriptRoot
$serverScript = Join-Path $projectDir 'server.mjs'
$listening = Get-NetTCPConnection -LocalPort 4174 -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  Start-Process -FilePath 'node' -ArgumentList @(('"' + $serverScript + '"')) -WorkingDirectory $projectDir -WindowStyle Hidden
  Start-Sleep -Seconds 2
}
Start-Process 'http://127.0.0.1:4174'
