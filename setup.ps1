$ErrorActionPreference = "Stop"

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $appDir

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is required. Install Node.js, then run this again."
}

if (-not (Test-Path "$appDir\node_modules")) {
  Write-Host "Installing packages..."
  npm install
}

$envPath = "$appDir\.env"
if (-not (Test-Path $envPath)) {
  $token = Read-Host "Paste your BotFather bot token"
  $pepperBytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($pepperBytes)
  $pepper = [Convert]::ToBase64String($pepperBytes).Replace("+", "-").Replace("/", "_")

  @"
TELEGRAM_BOT_TOKEN=$token
PASSWORD_PEPPER=$pepper
ROOM_SIZE=5
MESSAGE_TTL_MS=3600000
PORT=3000
"@ | Set-Content -Path $envPath -Encoding UTF8
  Write-Host ".env created."
} else {
  Write-Host ".env already exists. Keeping it."
}

Write-Host ""
Write-Host "Generating five unique passwords..."
npm run generate-passwords -- 5
Write-Host ""
Write-Host "Setup done. Keep the generated passwords private."
