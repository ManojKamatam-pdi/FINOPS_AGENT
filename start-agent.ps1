# start-agent.ps1
# Starts the TypeScript FinOps Agent Server (port 8005)
# Run from repo root: .\start-agent.ps1
# Prerequisites: Docker (DynamoDB) must be running

Write-Host "PDI FinOps - TypeScript Agent Server" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

$env:PATH = ($env:PATH -split ";" | Where-Object { $_ -notmatch "INHYDPDI" }) -join ";"
$env:PATH = "C:\Program Files\nodejs;" + $env:PATH

$npm = "C:\Program Files\nodejs\npm.cmd"
$node = "C:\Program Files\nodejs\node.exe"
$agentDir = "$PSScriptRoot\packages\agent"

# Step 1: Install dependencies
Write-Host "Installing agent dependencies..." -ForegroundColor Cyan
& $npm install --prefix $agentDir
if ($LASTEXITCODE -ne 0) { Write-Host "npm install failed" -ForegroundColor Red; exit 1 }

# Step 2: Build TypeScript
Write-Host "Building TypeScript..." -ForegroundColor Cyan
& $npm run build --prefix $agentDir
if ($LASTEXITCODE -ne 0) { Write-Host "TypeScript build failed" -ForegroundColor Red; exit 1 }

# Step 3: Copy .env.local if not present
$envSrc = "$agentDir\.env.local"
if (-not (Test-Path $envSrc)) {
    Copy-Item "$PSScriptRoot\packages\backend\.env.local" $envSrc
    Write-Host "Copied .env.local from backend" -ForegroundColor Yellow
}

# Step 4: Start server
Write-Host ""
Write-Host "Starting agent server on port 8005..." -ForegroundColor Green
Set-Location $agentDir
& $node dist/server.js
