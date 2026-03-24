# start-agent.ps1
# Starts the TypeScript FinOps Agent Server (port 8005) — no Docker step
# Run from repo root: .\start-agent.ps1
# Prerequisites: Docker (DynamoDB) must already be running

Write-Host "PDI FinOps - TypeScript Agent Server" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

# ---------------------------------------------------------------------------
# Fix PATH: strip inaccessible INHYDPDI NVM entries, pin to system Node
# ---------------------------------------------------------------------------
$env:PATH = ($env:PATH -split ";" | Where-Object { $_ -notmatch "INHYDPDI" -and $_ -notmatch "nvm" }) -join ";"
$env:PATH = "C:\Program Files\nodejs;" + $env:PATH

# Prevent Node from resolving the old user-profile prefix
$env:npm_config_prefix  = "$env:APPDATA\npm"
$env:npm_config_cache   = "$env:LOCALAPPDATA\npm-cache"
$env:NODE_PATH          = "$env:APPDATA\npm\node_modules"

$npm  = "C:\Program Files\nodejs\npm.cmd"
$node = "C:\Program Files\nodejs\node.exe"

Write-Host "Node: $(& $node --version)   npm: $(& $npm --version)" -ForegroundColor Green
Write-Host ""

$agentDir = "$PSScriptRoot\packages\agent"

# Step 1: Install dependencies
Write-Host "Installing agent dependencies..." -ForegroundColor Cyan
& $npm install --prefix $agentDir --legacy-peer-deps
if ($LASTEXITCODE -ne 0) { Write-Host "npm install failed" -ForegroundColor Red; exit 1 }

# Step 2: Build TypeScript
Write-Host "Building TypeScript..." -ForegroundColor Cyan
& $npm run build --prefix $agentDir
if ($LASTEXITCODE -ne 0) { Write-Host "TypeScript build failed" -ForegroundColor Red; exit 1 }
Write-Host "Build complete" -ForegroundColor Green

# Step 3: Copy .env.local if not present
$envSrc = "$agentDir\.env.local"
if (-not (Test-Path $envSrc)) {
    Copy-Item "$PSScriptRoot\packages\backend\.env.local" $envSrc -ErrorAction SilentlyContinue
    Write-Host "Copied .env.local from backend" -ForegroundColor Yellow
}

# Step 4: Start server
Write-Host ""
Write-Host "Starting agent server on port 8005..." -ForegroundColor Green
Push-Location $agentDir
try {
    & $node dist/server.js
} finally {
    Pop-Location
}
