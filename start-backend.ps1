# start-backend.ps1
# Starts DynamoDB Local + TypeScript FinOps Agent Server (port 8005)
# Run from repo root: .\start-backend.ps1

Write-Host "PDI FinOps Agent - Backend Startup" -ForegroundColor Cyan
Write-Host "====================================" -ForegroundColor Cyan
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

$node = "C:\Program Files\nodejs\node.exe"
$npm  = "C:\Program Files\nodejs\npm.cmd"

Write-Host "Node: $(& $node --version)   npm: $(& $npm --version)" -ForegroundColor Green
Write-Host ""

# Step 1: Start DynamoDB Local via Docker
Write-Host "Starting DynamoDB Local (port 8003)..." -ForegroundColor Cyan
docker compose up -d dynamodb
if ($LASTEXITCODE -ne 0) {
    Write-Host "docker compose failed. Is Docker Desktop running?" -ForegroundColor Red
    exit 1
}

# Step 2: Wait for DynamoDB Local to be ready
Write-Host "Waiting for DynamoDB Local..." -ForegroundColor Cyan
$timeout = 30
$elapsed = 0
$ready = $false
while ($elapsed -lt $timeout) {
    $probe = & $node --input-type=module -e "import net from 'net'; const s=net.createConnection(8003,'127.0.0.1'); s.on('connect',()=>{process.stdout.write('ok');s.destroy();}); s.on('error',()=>{process.stdout.write('fail');});" 2>$null
    if ($probe -eq "ok") { $ready = $true; break }
    Start-Sleep -Seconds 2
    $elapsed += 2
    Write-Host "  ... waiting ($elapsed/$timeout s)" -ForegroundColor Gray
}
if ($ready) {
    Write-Host "DynamoDB Local ready" -ForegroundColor Green
} else {
    Write-Host "DynamoDB Local did not respond in ${timeout}s - aborting" -ForegroundColor Red
    exit 1
}

# Step 3: Kill any stale process on port 8005
Write-Host ""
Write-Host "Checking for stale processes on port 8005..." -ForegroundColor Cyan
$pids8005 = (Get-NetTCPConnection -LocalPort 8005 -ErrorAction SilentlyContinue).OwningProcess | Sort-Object -Unique
foreach ($p in $pids8005) {
    Write-Host "  Clearing port 8005 (PID $p)..." -ForegroundColor Yellow
    Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1

# Step 4: Install deps if needed
$agentDir = "$PSScriptRoot\packages\agent"
if (-not (Test-Path "$agentDir\node_modules\jose")) {
    Write-Host "Installing agent dependencies..." -ForegroundColor Gray
    & $npm install --prefix $agentDir --legacy-peer-deps
    if ($LASTEXITCODE -ne 0) { Write-Host "npm install failed" -ForegroundColor Red; exit 1 }
}

# Step 5: Build TypeScript (show output so errors are visible)
Write-Host "Building TypeScript agent..." -ForegroundColor Cyan
& $npm run build --prefix $agentDir
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed - check packages/agent/src for errors" -ForegroundColor Red
    exit 1
}
Write-Host "Build complete" -ForegroundColor Green

# Step 6: Start agent server
Write-Host ""
Write-Host "Starting FinOps Agent Server on http://localhost:8005 ..." -ForegroundColor Green
Write-Host "  API:    http://localhost:8005/api"
Write-Host "  Health: http://localhost:8005/health"
Write-Host ""

Push-Location $agentDir
try {
    & $node dist/server.js
} finally {
    Pop-Location
}
