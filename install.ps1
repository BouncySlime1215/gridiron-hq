# Gridiron HQ installer - Windows.
#
# Double-click "Install Gridiron HQ.cmd" instead of running this directly -
# that's the no-PowerShell-typing entry point. This file is what it calls into.
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

function Test-NodeOk {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return $false }
  try {
    $major = [int](node -p "process.versions.node.split('.')[0]")
    $minor = [int](node -p "process.versions.node.split('.')[1]")
  } catch { return $false }
  return ($major -gt 22) -or ($major -eq 22 -and $minor -ge 5)
}

if (-not (Test-NodeOk)) {
  $existing = Get-Command node -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "  ! Node $(node -v) is too old - Gridiron HQ needs 22.5 or newer." -ForegroundColor Yellow
  } else {
    Write-Host "  ! Node.js is not installed yet." -ForegroundColor Yellow
  }

  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    Write-Host "  Installing Node with winget (a Windows security prompt may appear - click Yes)..."
    try { winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements | Out-Null } catch {}
  }

  # winget updates the system PATH, but this already-running PowerShell process
  # won't see it until it restarts - rather than fight that, ask for one more
  # double-click, which is still far short of anything resembling a terminal.
  if (Test-NodeOk) {
    Write-Host "  + Node installed." -ForegroundColor Green
  } else {
    Write-Host ""
    if ($winget) {
      Write-Host "  Node is installing in the background. Once it finishes, close this" -ForegroundColor Yellow
      Write-Host "  window and double-click 'Install Gridiron HQ' again." -ForegroundColor Yellow
    } else {
      Write-Host "  x Opening the download page - grab the LTS installer, run it, then" -ForegroundColor Red
      Write-Host "    double-click 'Install Gridiron HQ' again." -ForegroundColor Red
      Start-Process "https://nodejs.org/en/download"
    }
    Write-Host ""
    exit 1
  }
} else {
  Write-Host "  + Node $(node -v)" -ForegroundColor Green
}

node scripts\install.mjs @args
exit $LASTEXITCODE
