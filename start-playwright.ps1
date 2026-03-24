# start-playwright.ps1
# Runs Playwright e2e tests for FinOps Agent
# Run from repo root: .\start-playwright.ps1
# Prerequisites: .\start-backend.ps1 and .\start-frontend.ps1 must be running

Write-Host "PDI FinOps Agent - Playwright E2E Tests" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

# Fix PATH: remove inaccessible INHYDPDI NVM entry
$env:PATH = ($env:PATH -split ";" | Where-Object { $_ -notmatch "INHYDPDI" -and $_ -notmatch "nvm" }) -join ";"
$env:PATH = "C:\Program Files\nodejs;" + $env:PATH

$env:npm_config_prefix  = "$env:APPDATA\npm"
$env:npm_config_cache   = "$env:LOCALAPPDATA\npm-cache"
$env:NODE_PATH          = "$env:APPDATA\npm\node_modules"

$npm = "C:\Program Files\nodejs\npm.cmd"
$pw  = "$PSScriptRoot\node_modules\.bin\playwright.cmd"

# Step 1: Install @playwright/test if not present
if (-not (Test-Path $pw)) {
    Write-Host "Installing @playwright/test..." -ForegroundColor Cyan
    & $npm install --save-dev @playwright/test typescript --prefix "$PSScriptRoot"
    if ($LASTEXITCODE -ne 0) { Write-Host "npm install failed" -ForegroundColor Red; exit 1 }
}

# Step 2: Install Chromium browser if not present
$chromium = "$env:LOCALAPPDATA\ms-playwright\chromium-*\chrome-win\chrome.exe"
if (-not (Test-Path $chromium)) {
    Write-Host "Installing Playwright Chromium browser..." -ForegroundColor Cyan
    & $pw install chromium
    if ($LASTEXITCODE -ne 0) { Write-Host "Playwright browser install failed" -ForegroundColor Red; exit 1 }
}

# Step 3: Run auth setup (opens browser for manual Okta login if needed)
Write-Host "Checking auth state..." -ForegroundColor Cyan
& $pw test --project=setup
if ($LASTEXITCODE -ne 0) {
    Write-Host "Auth setup failed" -ForegroundColor Red
    exit 1
}

# Step 4: Run all e2e tests
Write-Host ""
Write-Host "Running e2e tests..." -ForegroundColor Green
Write-Host ""
& $pw test --project=e2e

$exitCode = $LASTEXITCODE

# Step 5: Show report path
Write-Host ""
if ($exitCode -eq 0) {
    Write-Host "All tests passed!" -ForegroundColor Green
} else {
    Write-Host "Some tests failed. Opening report..." -ForegroundColor Yellow
    & $pw show-report playwright\report
}
