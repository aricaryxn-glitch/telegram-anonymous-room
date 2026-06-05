$ErrorActionPreference = "Stop"

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $appDir

if (-not (Test-Path "$appDir\.env")) {
  Write-Host "No .env file found. Running setup first."
  & "$appDir\setup.ps1"
}

if (-not (Test-Path "$appDir\node_modules")) {
  npm install
}

Write-Host ""
Write-Host "Starting Telegram Anonymous Room bot."
Write-Host "Health check: http://localhost:3000/health"
Write-Host "Keep this window open if you are running locally."
Write-Host ""

npm start
