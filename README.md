# PDI FinOps Intelligence Agent

AI-powered infrastructure cost analysis. Analyzes all hosts across PDI Datadog orgs for CPU/RAM/Network utilization, produces right-sizing recommendations, and surfaces results in a hosted React dashboard.

## Quick Start (Local)

### Prerequisites
- Docker (for DynamoDB Local)
- Python 3.11+
- Node.js 18+
- Okta app configured with `http://localhost:3000/login/callback` redirect URI

### 1. Configure

```bash
cp .env.local.example packages/backend/.env.local
cp packages/frontend/.env.local.example packages/frontend/.env.local
# Fill in your Okta, Anthropic, and AWS credentials
```

### 2. Start DynamoDB Local

```bash
docker-compose up -d
```

### 3. Create DynamoDB tables

```bash
cd packages/backend
pip install -r requirements.txt
python dynamodb.py
```

### 4. Start backend

```bash
cd packages/backend
uvicorn main:app --reload --port 8001
```

### 5. Start frontend

```bash
cd packages/frontend
npm install && npm start
# Opens http://localhost:3000
```

## Architecture

See `docs/superpowers/specs/2026-03-17-finops-agent-design.md` for full design spec.

## AWS Deployment

```bash
npm run deploy --stage prod
```
