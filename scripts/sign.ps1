# Signs the Windows binary with Authenticode when a certificate is configured;
# exits successfully with a notice when it isn't, so unsigned local builds work.
#
# Usage: powershell -File scripts/sign.ps1 -Path dist/agency-windows-x64.exe
# Requires: WINDOWS_SIGN_THUMBPRINT (cert in CurrentUser\My or LocalMachine\My).
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Thumbprint = $env:WINDOWS_SIGN_THUMBPRINT,
  [string]$TimestampServer = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Path)) {
  throw "sign: binary not found: $Path"
}

if (-not $Thumbprint) {
  Write-Host "sign: WINDOWS_SIGN_THUMBPRINT not set; skipping Authenticode signing (unsigned build)"
  exit 0
}

$cert = Get-ChildItem "Cert:\CurrentUser\My\$Thumbprint" -ErrorAction SilentlyContinue
if (-not $cert) {
  $cert = Get-ChildItem "Cert:\LocalMachine\My\$Thumbprint" -ErrorAction SilentlyContinue
}
if (-not $cert) {
  throw "sign: certificate $Thumbprint not found in CurrentUser\My or LocalMachine\My"
}

Set-AuthenticodeSignature -FilePath $Path -Certificate $cert -TimestampServer $TimestampServer -HashAlgorithm SHA256 | Out-Null

$status = (Get-AuthenticodeSignature -FilePath $Path).Status
if ($status -ne "Valid") {
  throw "sign: signature status is $status"
}
Write-Host "sign: $Path signed (Authenticode, cert $Thumbprint)"
