# start-frontend.ps1
# Starts the React frontend for FinOps Agent
# Run from repo root in a SEPARATE terminal: .\start-frontend.ps1

Write-Host "PDI FinOps Agent - Frontend Startup" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""

# ---------------------------------------------------------------------------
# Fix PATH: strip inaccessible INHYDPDI NVM entries, pin to system Node
# ---------------------------------------------------------------------------
$env:PATH = ($env:PATH -split ';' | Where-Object { $_ -notmatch 'INHYDPDI' -and $_ -notmatch 'nvm' }) -join ';'
$env:PATH = "C:\Program Files\nodejs;" + $env:PATH

# Prevent Node from resolving the old user-profile prefix
$env:npm_config_prefix  = "$env:APPDATA\npm"
$env:npm_config_cache   = "$env:LOCALAPPDATA\npm-cache"
$env:NODE_PATH          = "$env:APPDATA\npm\node_modules"

$npm  = "C:\Program Files\nodejs\npm.cmd"
$node = "C:\Program Files\nodejs\node.exe"

Write-Host "Node: $(& $node --version)   npm: $(& $npm --version)" -ForegroundColor Green
Write-Host ""

# ---------------------------------------------------------------------------
# Kill any stale process on port 3000
# ---------------------------------------------------------------------------
Write-Host "Checking for stale processes on port 3000..." -ForegroundColor Cyan
$staleProcs = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue |
              Select-Object -ExpandProperty OwningProcess -Unique |
              Where-Object { $_ -ne 0 }
foreach ($procId in $staleProcs) {
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($proc -and $proc.Name -match 'node') {
        Write-Host "  Killing stale node process PID $procId..." -ForegroundColor Yellow
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
}

# Kill any WSL2 webpack/react-scripts processes
$wslKill = wsl -- bash -c "pkill -f 'react-scripts' 2>/dev/null; pkill -f 'webpack.*3000' 2>/dev/null; echo ok" 2>$null
if ($wslKill -eq 'ok') {
    Write-Host "  Cleared WSL2 webpack processes" -ForegroundColor Yellow
}
Start-Sleep -Seconds 1
Write-Host "Port 3000 cleared" -ForegroundColor Green
Write-Host ""

# ---------------------------------------------------------------------------
# Clear webpack cache (prevents stale bundle issues)
# ---------------------------------------------------------------------------
$cacheDir = "$PSScriptRoot\packages\frontend\node_modules\.cache"
if (Test-Path $cacheDir) {
    Write-Host "Clearing webpack cache..." -ForegroundColor Cyan
    Remove-Item -Recurse -Force $cacheDir
    Write-Host "Cache cleared" -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# Install npm dependencies if node_modules is missing
# ---------------------------------------------------------------------------
$frontendDir = "$PSScriptRoot\packages\frontend"
if (-not (Test-Path "$frontendDir\node_modules")) {
    Write-Host "Installing npm dependencies..." -ForegroundColor Cyan
    & $npm install --prefix $frontendDir
    if ($LASTEXITCODE -ne 0) {
        Write-Host "npm install failed" -ForegroundColor Red
        exit 1
    }
    Write-Host "Dependencies installed" -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# Start React frontend
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "Starting frontend on http://localhost:3000 ..." -ForegroundColor Green
Write-Host "Open http://localhost:3000 (NOT the network IP)" -ForegroundColor Yellow
Write-Host ""

Push-Location $frontendDir
try {
    & $npm start
} finally {
    Pop-Location
}
