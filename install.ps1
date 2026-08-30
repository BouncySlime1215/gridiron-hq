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

  # A private, per-user copy of Node rather than a system install.
  #
  # This is deliberately preferred over winget. winget needs a UAC prompt, and
  # worse, it updates the *system* PATH which this already-running PowerShell
  # process cannot see - which is why this used to end in "close this window and
  # double-click again". Unpacking the official zip into the user's own profile
  # needs no admin, and the PATH change applies immediately, so the install
  # actually finishes on the first double-click.
  #
  # It writes only to %USERPROFILE%\.gridiron. Uninstalling is deleting that.
  $privateRoot = Join-Path $env:USERPROFILE '.gridiron'
  $privateNode = Join-Path $privateRoot 'node'
  if (Test-Path (Join-Path $privateNode 'node.exe')) {
    $env:Path = "$privateNode;$env:Path"
  }

  if (-not (Test-NodeOk)) {
    Write-Host "  No usable Node.js - fetching a private copy (about 30 MB, one time)..."
    try {
      $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
      # Resolve the current LTS instead of pinning a version that quietly rots;
      # the pin below is only the fallback for when that lookup fails.
      $ver = 'v22.20.0'
      try {
        $idx = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 20
        $lts = $idx | Where-Object { $_.lts -is [string] } | Select-Object -First 1
        if ($lts.version) { $ver = $lts.version }
      } catch {}

      $zipName = "node-$ver-win-$arch"
      $tmp = Join-Path $env:TEMP "gridiron-node-$([guid]::NewGuid().ToString('N'))"
      New-Item -ItemType Directory -Path $tmp -Force | Out-Null
      $zip = Join-Path $tmp 'node.zip'

      $ProgressPreference = 'SilentlyContinue'   # the progress bar makes this ~10x slower
      Invoke-WebRequest -Uri "https://nodejs.org/dist/$ver/$zipName.zip" -OutFile $zip -TimeoutSec 600
      Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force

      New-Item -ItemType Directory -Path $privateRoot -Force | Out-Null
      if (Test-Path $privateNode) { Remove-Item -LiteralPath $privateNode -Recurse -Force }
      Move-Item -LiteralPath (Join-Path $tmp $zipName) -Destination $privateNode
      Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue

      $env:Path = "$privateNode;$env:Path"
      Write-Host "  + Installed Node $ver privately (~\.gridiron\node)" -ForegroundColor Green
    } catch {
      Write-Host "  ! Private Node download failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
  }

  # Last resort only, because of the UAC prompt and the PATH problem above.
  if (-not (Test-NodeOk)) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
      Write-Host "  Trying winget (a Windows security prompt may appear - click Yes)..."
      try { winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements | Out-Null } catch {}
    }
  }

  if (Test-NodeOk) {
    Write-Host "  + Node $(node -v)" -ForegroundColor Green
  } else {
    Write-Host ""
    Write-Host "  x Could not get a working Node.js automatically." -ForegroundColor Red
    Write-Host "    This usually means no internet, or a network that blocks nodejs.org."
    Write-Host "    Opening the download page - grab the LTS installer, run it, then"
    Write-Host "    double-click 'Install Gridiron HQ' again."
    Start-Process "https://nodejs.org/en/download"
    Write-Host ""
    exit 1
  }
} else {
  Write-Host "  + Node $(node -v)" -ForegroundColor Green
}

node scripts\install.mjs @args
exit $LASTEXITCODE
