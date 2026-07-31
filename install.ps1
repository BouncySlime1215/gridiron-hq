# Gridiron HQ installer - Windows.
#
#   git clone https://github.com/BouncySlime1215/gridiron-hq.git
#   cd gridiron-hq
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# Everything real happens in scripts\install.mjs; this only guarantees a Node new
# enough to run it, since that is the one thing a Node script cannot check for you.
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

Write-Host ""
Write-Host "  Gridiron HQ - 2026 Fantasy Command Center" -ForegroundColor White
Write-Host "  Installing for Windows..."
Write-Host ""

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "  x Node.js is not installed." -ForegroundColor Red
  Write-Host ""
  Write-Host "    Install it with winget:"
  Write-Host "      winget install OpenJS.NodeJS.LTS" -ForegroundColor White
  Write-Host "    or download the LTS installer from https://nodejs.org"
  Write-Host ""
  Write-Host "    Close and reopen this window afterwards so PATH updates." -ForegroundColor Yellow
  Write-Host ""
  exit 1
}

$major = [int](node -p "process.versions.node.split('.')[0]")
$minor = [int](node -p "process.versions.node.split('.')[1]")
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 5)) {
  $v = node -v
  Write-Host "  x Node $v is too old - Gridiron HQ needs 22.5 or newer." -ForegroundColor Red
  Write-Host "    The app stores data with Node's built-in SQLite, which arrived in 22.5."
  Write-Host "    Update with: winget upgrade OpenJS.NodeJS.LTS" -ForegroundColor White
  Write-Host ""
  exit 1
}
Write-Host "  + Node $(node -v)" -ForegroundColor Green

node scripts\install.mjs @args
exit $LASTEXITCODE
