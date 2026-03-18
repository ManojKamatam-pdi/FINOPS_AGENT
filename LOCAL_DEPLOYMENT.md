# Local Deployment Guide

Two PowerShell scripts start the full stack. Open two terminals from the repo root.

---

## Terminal 1 — Backend

```powershell
.\start-backend.ps1
```

This script:
1. Fixes the `INHYDPDI` PATH issue so Node/npm work correctly
2. Starts **DynamoDB Local** in Docker on port 8003
3. Waits until DynamoDB is healthy (Node.js TCP probe — no Python required)
4. Kills any stale process on port 8005
5. Installs npm dependencies if needed (`--legacy-peer-deps`)
6. Builds the TypeScript agent
7. Starts the **TypeScript Agent Server** on port 8005 (foreground — creates DynamoDB tables on startup)

## Terminal 2 — Frontend

```powershell
.\start-frontend.ps1
```

This script:
1. Fixes the `INHYDPDI` PATH issue
2. Kills any stale process on port 3000 (including WSL2 webpack)
3. Clears webpack cache
4. Installs npm dependencies if `node_modules` is missing
5. Starts **React frontend** on port 3000

Open **http://localhost:3000** and sign in with Okta.

---

## Prerequisites

| Tool | Check |
|---|---|
| Docker Desktop (running) | `docker info` |
| Node.js 18+ | `node --version` |

> **No Python required.** The backend is pure TypeScript/Node.js.

---

## One-time setup (first run only)

### 1. Fill in agent credentials

Edit `packages/agent/.env.local`:

```env
OKTA_ISSUER=https://pdisoftware.okta.com
OKTA_CLIENT_ID=<your-okta-client-id>
```

Everything else is already set:
- `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` — PDI gateway, pre-filled
- `MCP_REGISTRY` — Datadog MCP, pre-filled
- `DYNAMODB_ENDPOINT=http://127.0.0.1:8003` — pre-filled
- `AGENT_SERVER_PORT=8005` — pre-filled

### 2. Fill in frontend credentials

Edit `packages/frontend/.env.local`:

```env
REACT_APP_OKTA_CLIENT_ID=<your-okta-client-id>
REACT_APP_OKTA_ISSUER=https://pdisoftware.okta.com
REACT_APP_API_URL=http://localhost:8005
```

> **Okta requirement:** `http://localhost:3000/login/callback` must be in your Okta app's Sign-in redirect URIs.

---

## Port Map

| Service | Port |
|---|---|
| React frontend | **3000** (fixed — Okta callback requires this) |
| TypeScript Agent Server | **8005** |
| DynamoDB Local | **8003** |

---

## Running Tests

```powershell
# E2E Playwright tests (both start-backend.ps1 and start-frontend.ps1 must be running)
.\start-playwright.ps1
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `EPERM lstat INHYDPDI` error | Always use the `.ps1` scripts — they fix the PATH before running anything |
| Docker not found | Start Docker Desktop first |
| Port 8003 / 8005 / 3000 in use | The scripts auto-clear 8005 and 3000; for 8003 stop the conflicting container |
| `401 Unauthorized` on API calls | Token expired — sign out and sign back in |
| `No analysis run yet` on Dashboard | Click **▶ Run Fresh Analysis** to trigger the first run |
| Tables missing on restart | `start-backend.ps1` builds and starts the server which creates tables automatically on boot |
| Frontend shows stale code | The script clears webpack cache on every start |
| Build failed | Check `packages/agent/src` for TypeScript errors — run `npm run build` in `packages/agent` manually |
