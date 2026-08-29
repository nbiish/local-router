Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $rootDir

Write-Host "Installing Local Router dependencies..." -ForegroundColor Cyan
npm install
node scripts/setup-platform.mjs
