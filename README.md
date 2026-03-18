# PDI FinOps Intelligence Agent

AI-powered infrastructure cost analysis. Analyzes all hosts across PDI Datadog orgs (PDI-Enterprise, PDI-Orbis) for CPU/RAM/Network utilization over 30 days, produces right-sizing recommendations with AWS cost comparisons, and surfaces results in a hosted React dashboard with Okta SSO.

## Quick Start

See **[LOCAL_DEPLOYMENT.md](./LOCAL_DEPLOYMENT.md)** for the full local setup guide.

```powershell
# Terminal 1
.\start-backend.ps1   # starts DynamoDB + FastAPI on :8004

# Terminal 2
.\start-frontend.ps1  # starts React on :3000
```

Open **http://localhost:3000**

## Architecture

See `docs/superpowers/specs/2026-03-17-finops-agent-design.md` for the full design spec.

## AWS Deployment

```bash
npm run deploy --stage prod
```
