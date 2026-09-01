# Installs the Agency binary from a GitHub release. Fails closed: a missing or
# mismatched checksum aborts the install, nothing is written.
#
# Usage: irm https://raw.githubusercontent.com/Pixeless001/Agency/master/scripts/install.ps1 | iex
# Env overrides: AGENCY_VERSION (default: latest release), AGENCY_INSTALL_DIR (default: %LOCALAPPDATA%\Programs\agency).
$ErrorActionPreference = "Stop"

$Repo = "Pixeless001/Agency"
$InstallDir = if ($env:AGENCY_INSTALL_DIR) { $env:AGENCY_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\agency" }

$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  "AMD64" { "x64" }
  "ARM64" { "arm64" }
  default { throw "install: unsupported architecture '$($env:PROCESSOR_ARCHITECTURE)'" }
}

if ($env:AGENCY_VERSION) {
  $version = $env:AGENCY_VERSION.TrimStart("v")
} else {
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "User-Agent" = "agency-install" }
  $version = $release.tag_name.TrimStart("v")
  if (-not $version) { throw "install: could not determine the latest release" }
}

$asset = "agency-windows-$arch.exe"
$baseUrl = "https://github.com/$Repo/releases/download/v$version"
$tmp = New-Item -ItemType Directory -Path (Join-Path ([System.IO.Path]::GetTempPath()) ("agency-install-" + [guid]::NewGuid().ToString("N")))
try {
  Write-Host "install: downloading agency v$version (windows-$arch)"
  $binaryPath = Join-Path $tmp $asset
  $checksumPath = Join-Path $tmp "checksums.txt"
  Invoke-WebRequest -Uri "$baseUrl/$asset" -OutFile $binaryPath -UserAgent "agency-install"
  Invoke-WebRequest -Uri "$baseUrl/checksums.txt" -OutFile $checksumPath -UserAgent "agency-install"

  $expected = (Get-Content $checksumPath | Where-Object { $_ -match "(^|\s)$([regex]::Escape($asset))(\s|$)" }) -split "\s+" | Select-Object -First 1
  if (-not $expected) {
    throw "install: FAIL - no checksum for $asset in checksums.txt; refusing to install"
  }
  $actual = (Get-FileHash -Path $binaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected.ToLowerInvariant()) {
    throw "install: FAIL - checksum mismatch for $asset (expected $expected, got $actual); refusing to install"
  }
  Write-Host "install: checksum verified"

  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  $dest = Join-Path $InstallDir "agency.exe"
  Copy-Item $binaryPath $dest -Force

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (($userPath -split ";") -notcontains $InstallDir) {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$InstallDir", "User")
    Write-Host "install: added $InstallDir to your user PATH (restart your terminal to pick it up)"
  }

  Write-Host "install: agency v$version installed to $dest"
  Write-Host "install: run 'agency --help' to get started"
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
