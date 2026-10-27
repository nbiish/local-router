Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $rootDir

Write-Host "Installing Local Router dependencies..." -ForegroundColor Cyan
npm install --prefer-offline
if ($LASTEXITCODE -ne 0) { npm install }
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node scripts/setup-platform.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
