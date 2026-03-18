# Eliminate Python Layer — Full TypeScript Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Python FastAPI layer entirely and consolidate all backend responsibilities (Okta JWT auth, REST API, DynamoDB table setup, run management) into the existing TypeScript Express server at `packages/agent`, then update startup scripts and frontend to point at port 8005.

**Architecture:** The TypeScript agent server (`packages/agent/src/server.ts`) already owns agent execution and DynamoDB writes. We extend it with three REST routes (`/api/trigger`, `/api/status`, `/api/results`), Okta JWT middleware, and table-creation on startup — making it the single backend process. The Python `packages/backend` folder is then deleted. The scheduler was a no-op stub in Python (EventBridge handles scheduling in AWS; no local scheduler runs) — no TypeScript equivalent is needed.

**Tech Stack:** TypeScript/ESM (`"type": "module"`, NodeNext resolution), Express, `jose` (Okta RS256 JWT), `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` (already installed), `@anthropic-ai/claude-agent-sdk` (already installed), Docker (DynamoDB Local).

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| **Create** | `packages/agent/src/middleware/auth.ts` | Okta JWKS fetch + RS256 JWT verify, Express middleware |
| **Create** | `packages/agent/src/routes/api.ts` | `/api/trigger`, `/api/status`, `/api/results` route handlers |
| **Create** | `packages/agent/src/db/setup.ts` | DynamoDB table creation (4 tables) on startup |
| **Extend** | `packages/agent/src/tools/dynamodb.ts` | Add `createRun`, `getRun`, `getLatestRun`, `getLatestCompletedRun`, `getOrgSummariesForRun`, `getHostResultsForRun` |
| **Modify** | `packages/agent/src/server.ts` | Mount auth middleware + API routes, call `createTables()` on startup |
| **Modify** | `packages/agent/.env.local` | Add `OKTA_ISSUER`, `OKTA_CLIENT_ID` |
| **Modify** | `packages/frontend/.env.local` | Change `REACT_APP_API_URL` from `8004` → `8005` |
| **Modify** | `start-backend.ps1` | Remove Python uvicorn step + Python DynamoDB probe; agent server becomes foreground process |
| **Modify** | `playwright/tests/02-api-integration.spec.ts` | Update hardcoded `8004` → `8005` (6 occurrences) |
| **Modify** | `playwright/tests/04-run-analysis.spec.ts` | Update hardcoded `8004` → `8005` (4 occurrences) |
| **Modify** | `playwright/tests/05-results-display.spec.ts` | Update hardcoded `8004` → `8005` (3 occurrences) |
| **Delete** | `packages/backend/` | Entire Python package removed |

---

## Task 1: Add run-management DynamoDB operations to `dynamodb.ts`

The existing `packages/agent/src/tools/dynamodb.ts` handles agent writes. We add the API-facing read/write operations the REST routes will use.

**Files:**
- Modify: `packages/agent/src/tools/dynamodb.ts`

> **Important:** Do Step 1 (update the import block) **first**, before appending any new functions. All new functions use `ScanCommand` which must be in the top-level import.

- [ ] **Step 1: Update the import block at the top of `dynamodb.ts`**

Replace the existing `@aws-sdk/lib-dynamodb` import line with:

```typescript
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
```

- [ ] **Step 2: Append `createRun` function**

Add at the bottom of `packages/agent/src/tools/dynamodb.ts`:

```typescript
// ─── Run Management (API layer) ───────────────────────────────────────────────

export async function createRun(params: {
  runId: string;
  triggerType: string;
  triggeredBy: string;
  oktaToken: string;
  tenantsTotal: number;
}): Promise<void> {
  const now = new Date().toISOString();
  await getClient().send(new PutCommand({
    TableName: "finops_runs",
    Item: {
      run_id: params.runId,
      sk: "METADATA",
      trigger_type: params.triggerType,
      triggered_by: params.triggeredBy,
      okta_token: params.oktaToken,
      status: "running",
      started_at: now,
      completed_at: null,
      tenants_total: params.tenantsTotal,
      tenants_done: 0,
      hosts_total: 0,
      hosts_done: 0,
      log: [],
    },
  }));
}
```

- [ ] **Step 3: Append `getRun` function**

```typescript
export async function getRun(runId: string): Promise<Record<string, unknown> | null> {
  const resp = await getClient().send(new GetCommand({
    TableName: "finops_runs",
    Key: { run_id: runId, sk: "METADATA" },
  }));
  return (resp.Item as Record<string, unknown>) ?? null;
}
```

- [ ] **Step 4: Append `getLatestRun` function**

```typescript
export async function getLatestRun(): Promise<Record<string, unknown> | null> {
  const resp = await getClient().send(new ScanCommand({
    TableName: "finops_runs",
    FilterExpression: "sk = :sk",
    ExpressionAttributeValues: { ":sk": "METADATA" },
  }));
  const items = (resp.Items ?? []) as Record<string, unknown>[];
  if (!items.length) return null;
  return items.sort((a, b) =>
    String(b["started_at"] ?? "").localeCompare(String(a["started_at"] ?? ""))
  )[0];
}
```

- [ ] **Step 5: Append `getLatestCompletedRun` function**

```typescript
export async function getLatestCompletedRun(): Promise<Record<string, unknown> | null> {
  const resp = await getClient().send(new QueryCommand({
    TableName: "finops_runs",
    IndexName: "status-started_at-index",
    KeyConditionExpression: "#s = :s",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":s": "completed" },
    ScanIndexForward: false,
    Limit: 1,
  }));
  const items = (resp.Items ?? []) as Record<string, unknown>[];
  return items[0] ?? null;
}
```

- [ ] **Step 6: Append `getOrgSummariesForRun` function**

```typescript
export async function getOrgSummariesForRun(runId: string): Promise<Record<string, unknown>[]> {
  const resp = await getClient().send(new QueryCommand({
    TableName: "finops_org_summary",
    IndexName: "run_id-index",
    KeyConditionExpression: "run_id = :r",
    ExpressionAttributeValues: { ":r": runId },
  }));
  return (resp.Items ?? []) as Record<string, unknown>[];
}
```

- [ ] **Step 7: Append `getHostResultsForRun` function**

```typescript
export async function getHostResultsForRun(runId: string): Promise<Record<string, unknown>[]> {
  const resp = await getClient().send(new QueryCommand({
    TableName: "finops_host_results",
    IndexName: "run_id-index",
    KeyConditionExpression: "run_id = :r",
    ExpressionAttributeValues: { ":r": runId },
  }));
  const items = (resp.Items ?? []) as Record<string, unknown>[];
  // Split composite SK "host_id#run_id" → expose host_id field
  return items.map((item) => {
    const sk = String(item["sk"] ?? "");
    if (sk.includes("#")) {
      return { ...item, host_id: sk.split("#")[0] };
    }
    return item;
  });
}
```

- [ ] **Step 8: Commit**

```bash
git add packages/agent/src/tools/dynamodb.ts
git commit -m "feat(agent): add run management DynamoDB operations for API layer"
```

---

## Task 2: Create DynamoDB table setup module

The Python `dynamodb.py` creates 4 tables on startup. We replicate this in TypeScript so the agent server creates tables when it boots.

**Files:**
- Create: `packages/agent/src/db/setup.ts`

- [ ] **Step 1: Create `packages/agent/src/db/setup.ts`**

```typescript
/**
 * DynamoDB table setup — called once on server startup.
 * Safe to re-run: skips tables that already exist.
 */
import {
  DynamoDBClient,
  CreateTableCommand,
  ListTablesCommand,
  ResourceInUseException,
} from "@aws-sdk/client-dynamodb";

function getRawClient(): DynamoDBClient {
  const endpoint = process.env.DYNAMODB_ENDPOINT ?? "";
  return endpoint
    ? new DynamoDBClient({
        endpoint,
        region: "us-east-1",
        credentials: { accessKeyId: "local", secretAccessKey: "local" },
      })
    : new DynamoDBClient({ region: process.env.AWS_REGION ?? "us-east-1" });
}

const TABLE_DEFINITIONS = [
  {
    TableName: "finops_runs",
    KeySchema: [
      { AttributeName: "run_id", KeyType: "HASH" as const },
      { AttributeName: "sk", KeyType: "RANGE" as const },
    ],
    AttributeDefinitions: [
      { AttributeName: "run_id", AttributeType: "S" as const },
      { AttributeName: "sk", AttributeType: "S" as const },
      { AttributeName: "status", AttributeType: "S" as const },
      { AttributeName: "started_at", AttributeType: "S" as const },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "status-started_at-index",
        KeySchema: [
          { AttributeName: "status", KeyType: "HASH" as const },
          { AttributeName: "started_at", KeyType: "RANGE" as const },
        ],
        Projection: { ProjectionType: "ALL" as const },
      },
    ],
    BillingMode: "PAY_PER_REQUEST" as const,
  },
  {
    TableName: "finops_host_lists",
    KeySchema: [
      { AttributeName: "tenant_id", KeyType: "HASH" as const },
      { AttributeName: "run_id", KeyType: "RANGE" as const },
    ],
    AttributeDefinitions: [
      { AttributeName: "tenant_id", AttributeType: "S" as const },
      { AttributeName: "run_id", AttributeType: "S" as const },
    ],
    BillingMode: "PAY_PER_REQUEST" as const,
  },
  {
    TableName: "finops_org_summary",
    KeySchema: [
      { AttributeName: "tenant_id", KeyType: "HASH" as const },
      { AttributeName: "run_id", KeyType: "RANGE" as const },
    ],
    AttributeDefinitions: [
      { AttributeName: "tenant_id", AttributeType: "S" as const },
      { AttributeName: "run_id", AttributeType: "S" as const },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "run_id-index",
        KeySchema: [{ AttributeName: "run_id", KeyType: "HASH" as const }],
        Projection: { ProjectionType: "ALL" as const },
      },
    ],
    BillingMode: "PAY_PER_REQUEST" as const,
  },
  {
    TableName: "finops_host_results",
    KeySchema: [
      { AttributeName: "tenant_id", KeyType: "HASH" as const },
      { AttributeName: "sk", KeyType: "RANGE" as const },
    ],
    AttributeDefinitions: [
      { AttributeName: "tenant_id", AttributeType: "S" as const },
      { AttributeName: "sk", AttributeType: "S" as const },
      { AttributeName: "run_id", AttributeType: "S" as const },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "run_id-index",
        KeySchema: [{ AttributeName: "run_id", KeyType: "HASH" as const }],
        Projection: { ProjectionType: "ALL" as const },
      },
    ],
    BillingMode: "PAY_PER_REQUEST" as const,
  },
];

export async function createTables(): Promise<void> {
  const client = getRawClient();
  const { TableNames: existing = [] } = await client.send(new ListTablesCommand({}));

  for (const def of TABLE_DEFINITIONS) {
    if (existing.includes(def.TableName)) {
      console.log(`[db] Table ${def.TableName} already exists`);
      continue;
    }
    try {
      await client.send(new CreateTableCommand(def));
      console.log(`[db] Created table ${def.TableName}`);
    } catch (err) {
      if (err instanceof ResourceInUseException) {
        console.log(`[db] Table ${def.TableName} already exists (race)`);
      } else {
        throw err;
      }
    }
  }
  console.log("[db] All tables ready");
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/agent/src/db/setup.ts
git commit -m "feat(agent): add DynamoDB table setup module"
```

---

## Task 3: Create Okta JWT auth middleware

The Python `auth.py` fetches JWKS from Okta and verifies RS256 tokens. We replicate this using `jose`.

> **Note on JWKS URL:** The Python implementation uses OIDC discovery (`/.well-known/openid-configuration`) to find the JWKS URI dynamically. The TypeScript version hardcodes `/v1/keys` which is correct for standard Okta org authorization servers. If a custom authorization server is ever used, the path would be `/oauth2/<authServerId>/v1/keys` — update `OKTA_ISSUER` in `.env.local` to include the full path prefix in that case.

> **Note on `OKTA_ISSUER` trailing slash:** `jose` performs strict string matching on the `aud` claim. Ensure `OKTA_ISSUER` in `.env.local` has **no trailing slash** (e.g., `https://pdisoftware.okta.com` not `https://pdisoftware.okta.com/`).

**Files:**
- Create: `packages/agent/src/middleware/auth.ts`
- Modify: `packages/agent/package.json` (add `jose`)

- [ ] **Step 1: Install `jose`**

```bash
cd packages/agent
npm install jose --legacy-peer-deps
```

Expected: `jose` appears in `node_modules`, added to `dependencies` in `package.json`.

- [ ] **Step 2: Create `packages/agent/src/middleware/auth.ts`**

```typescript
/**
 * Okta JWT middleware for Express.
 * Validates RS256 Bearer tokens using Okta's JWKS endpoint.
 * Attaches decoded claims + raw token to req.user.
 *
 * IMPORTANT: OKTA_ISSUER must have no trailing slash.
 * Standard Okta org JWKS URI: {OKTA_ISSUER}/v1/keys
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Request, Response, NextFunction } from "express";

const OKTA_ISSUER = (process.env.OKTA_ISSUER ?? "").replace(/\/$/, "");
const OKTA_CLIENT_ID = process.env.OKTA_CLIENT_ID ?? "";

// Cache JWKS for process lifetime
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!_jwks) {
    _jwks = createRemoteJWKSet(new URL(`${OKTA_ISSUER}/v1/keys`));
  }
  return _jwks;
}

export interface AuthenticatedRequest extends Request {
  user?: {
    email: string;
    sub: string;
    rawToken: string;
    claims: Record<string, unknown>;
  };
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Bearer token required" });
    return;
  }
  const token = authHeader.slice(7).trim();

  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: OKTA_ISSUER,
      audience: OKTA_ISSUER, // Okta access tokens use issuer URL as audience
    });

    if (payload["cid"] !== OKTA_CLIENT_ID) {
      res.status(401).json({ error: "Token client ID mismatch" });
      return;
    }

    req.user = {
      email: String(payload["email"] ?? payload["sub"] ?? ""),
      sub: String(payload["sub"] ?? ""),
      rawToken: token,
      claims: payload as Record<string, unknown>,
    };
    next();
  } catch (err) {
    res.status(401).json({ error: `Invalid token: ${String(err)}` });
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/middleware/auth.ts packages/agent/package.json packages/agent/package-lock.json
git commit -m "feat(agent): add Okta JWT auth middleware using jose"
```

---

## Task 4: Create REST API routes

Three routes mirror the Python FastAPI endpoints exactly so the frontend contract is unchanged.

**Files:**
- Create: `packages/agent/src/routes/api.ts`

- [ ] **Step 1: Create `packages/agent/src/routes/api.ts`**

```typescript
/**
 * REST API routes — mirrors the Python FastAPI endpoints exactly.
 * POST /api/trigger  — start a new analysis run
 * GET  /api/status   — poll run progress
 * GET  /api/results  — fetch completed run results
 */
import { Router } from "express";
import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { getTenants } from "../config/tenants.js";
import {
  createRun,
  getRun,
  getLatestRun,
  getLatestCompletedRun,
  getOrgSummariesForRun,
  getHostResultsForRun,
} from "../tools/dynamodb.js";
import { runOrchestrator } from "../agents/orchestrator.js";

export const apiRouter = Router();

// POST /api/trigger
apiRouter.post("/trigger", async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const tenants = getTenants();
  const user = req.user!;

  // Reject if a run is already in progress
  const latest = await getLatestRun();
  if (latest && latest["status"] === "running") {
    res.status(409).json({
      error: "A run is already in progress",
      run_id: latest["run_id"],
    });
    return;
  }

  // Generate run_id matching Python format: run_2026-03-18T12:00:00Z
  const runId = `run_${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}`;
  const triggerType = user.email === "scheduler" ? "scheduled" : "manual";

  await createRun({
    runId,
    triggerType,
    triggeredBy: user.email,
    oktaToken: user.rawToken,
    tenantsTotal: tenants.length,
  });

  // Respond immediately — orchestrator runs in background
  res.status(202).json({ run_id: runId, status: "running" });

  // Fire and forget
  runOrchestrator(runId, user.rawToken).catch((err: unknown) => {
    console.error(`[api] Orchestrator failed for run ${runId}:`, err);
  });
});

// GET /api/status
apiRouter.get("/status", async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const runId = req.query["run_id"] as string | undefined;
  const run = runId ? await getRun(runId) : await getLatestRun();

  if (!run) {
    res.status(404).json({ error: "No run found" });
    return;
  }

  const hostsTotal = Number(run["hosts_total"] ?? 0);
  const hostsDone = Number(run["hosts_done"] ?? 0);
  const progressPct = hostsTotal > 0 ? Math.round((hostsDone / hostsTotal) * 100) : 0;

  res.json({
    run_id: run["run_id"],
    status: run["status"],
    trigger_type: run["trigger_type"],
    triggered_by: run["triggered_by"],
    started_at: run["started_at"],
    completed_at: run["completed_at"],
    tenants_total: run["tenants_total"] ?? 0,
    tenants_done: run["tenants_done"] ?? 0,
    hosts_total: hostsTotal,
    hosts_done: hostsDone,
    progress_pct: progressPct,
    log: run["log"] ?? [],
  });
});

// GET /api/results
apiRouter.get("/results", async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const runId = req.query["run_id"] as string | undefined;
  let run: Record<string, unknown> | null;

  if (runId) {
    run = await getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
  } else {
    run = await getLatestCompletedRun();
    if (!run) {
      res.status(404).json({ error: "No completed run found" });
      return;
    }
  }

  const rid = String(run["run_id"]);
  const [orgSummaries, hostResults] = await Promise.all([
    getOrgSummariesForRun(rid),
    getHostResultsForRun(rid),
  ]);

  res.json({
    run_id: rid,
    completed_at: run["completed_at"],
    trigger_type: run["trigger_type"],
    org_summaries: orgSummaries,
    host_results: hostResults,
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add packages/agent/src/routes/api.ts
git commit -m "feat(agent): add REST API routes (trigger, status, results)"
```

---

## Task 5: Wire everything into `server.ts`

Update the Express server to call `createTables()` on startup, mount the auth middleware, and register the API router. The `createRequire` import in the current `server.ts` is unused and is removed.

**Files:**
- Modify: `packages/agent/src/server.ts`

- [ ] **Step 1: Replace `server.ts` with the updated version**

```typescript
/**
 * FinOps Agent Server — single TypeScript backend.
 * Replaces Python FastAPI entirely.
 *
 * Routes:
 *   GET  /health          — no auth, liveness check
 *   POST /api/trigger     — Okta auth, start analysis run
 *   GET  /api/status      — Okta auth, poll run progress
 *   GET  /api/results     — Okta auth, fetch completed results
 *   POST /run             — internal agent trigger (no auth, localhost only)
 *
 * Startup: creates DynamoDB tables if they don't exist, then listens.
 * Scheduler: no-op locally; EventBridge + Lambda handles nightly runs in AWS.
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, "../../.env.local") });

import express from "express";
import cors from "cors";
import { createTables } from "./db/setup.js";
import { requireAuth } from "./middleware/auth.js";
import { apiRouter } from "./routes/api.js";
import { runOrchestrator } from "./agents/orchestrator.js";

const app = express();

app.use(cors({
  origin: ["http://localhost:3000", /\.cloudfront\.net$/],
  credentials: true,
}));
app.use(express.json());

const PORT = parseInt(process.env.AGENT_SERVER_PORT ?? "8005", 10);

// Health — no auth required
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "finops-agent" });
});

// REST API — Okta auth required
app.use("/api", requireAuth, apiRouter);

// Internal agent trigger — kept for direct testing / backward compat
app.post("/run", async (req, res) => {
  const { run_id, okta_token } = req.body as { run_id?: string; okta_token?: string };
  if (!run_id) {
    res.status(400).json({ error: "run_id is required" });
    return;
  }
  res.status(202).json({ run_id, status: "started" });
  runOrchestrator(run_id, okta_token ?? "").catch((err: unknown) => {
    console.error(`[agent-server] Orchestrator failed for run ${run_id}:`, err);
  });
});

// Startup: create tables then listen
createTables()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[agent-server] FinOps Agent Server running on port ${PORT}`);
      console.log(`[agent-server] API: http://localhost:${PORT}/api`);
    });
  })
  .catch((err) => {
    console.error("[agent-server] Failed to create DynamoDB tables:", err);
    process.exit(1);
  });
```

- [ ] **Step 2: Commit**

```bash
git add packages/agent/src/server.ts
git commit -m "feat(agent): wire auth middleware, API routes, and table setup into server"
```

---

## Task 6: Update environment files

**Files:**
- Modify: `packages/agent/.env.local`
- Modify: `packages/frontend/.env.local`

- [ ] **Step 1: Add Okta config to `packages/agent/.env.local`**

Full file after edit (no trailing slash on `OKTA_ISSUER`):

```env
ANTHROPIC_BASE_URL=https://ai-gateway.platform.pditechnologies.com
ANTHROPIC_AUTH_TOKEN=pdi_Ozhe4_AIV9NJsQfmacdZNOM_XkLmMVm1UDZvrBMPbeQ

# Okta JWT validation (no trailing slash on OKTA_ISSUER)
OKTA_ISSUER=https://pdisoftware.okta.com
OKTA_CLIENT_ID=0oa19vxje17dMG4NJ2p8

# MCP Registry
MCP_REGISTRY=[{"name":"datadog","url":"https://dm9vya05q5.execute-api.us-east-1.amazonaws.com/mcp","transport":"http","auth":"okta_forward"}]
DATADOG_MCP_URL=https://dm9vya05q5.execute-api.us-east-1.amazonaws.com/mcp

# DynamoDB local
DYNAMODB_ENDPOINT=http://127.0.0.1:8003

# Agent server port
AGENT_SERVER_PORT=8005
```

- [ ] **Step 2: Update `packages/frontend/.env.local` — change port 8004 → 8005**

```env
REACT_APP_OKTA_CLIENT_ID=0oa19vxje17dMG4NJ2p8
REACT_APP_OKTA_ISSUER=https://pdisoftware.okta.com
REACT_APP_API_URL=http://localhost:8005
```

- [ ] **Step 3: Commit**

```bash
git add packages/agent/.env.local packages/frontend/.env.local
git commit -m "config: point frontend at port 8005, add Okta vars to agent env"
```

---

## Task 7: Rewrite `start-backend.ps1`

Remove the Python uvicorn step and the Python DynamoDB probe. The TypeScript agent server becomes the foreground process. The DynamoDB readiness probe uses a Node.js TCP check (no Python required, no `require()` in ESM context).

**Files:**
- Modify: `start-backend.ps1`

- [ ] **Step 1: Replace `start-backend.ps1`**

```powershell
# start-backend.ps1
# Starts DynamoDB Local + TypeScript FinOps Agent Server (port 8005)
# Run from repo root: .\start-backend.ps1

Write-Host "PDI FinOps Agent - Backend Startup" -ForegroundColor Cyan
Write-Host "====================================" -ForegroundColor Cyan
Write-Host ""

# Fix PATH: remove inaccessible INHYDPDI NVM entry
$env:PATH = ($env:PATH -split ";" | Where-Object { $_ -notmatch "INHYDPDI" }) -join ";"
$env:PATH = "C:\Program Files\nodejs;" + $env:PATH

$node = "C:\Program Files\nodejs\node.exe"
$npm  = "C:\Program Files\nodejs\npm.cmd"

# Step 1: Start DynamoDB Local via Docker
Write-Host "Starting DynamoDB Local (port 8003)..." -ForegroundColor Cyan
docker compose up -d dynamodb
if ($LASTEXITCODE -ne 0) {
    Write-Host "docker compose failed. Is Docker Desktop running?" -ForegroundColor Red
    exit 1
}

# Step 2: Wait for DynamoDB Local to be ready (Node.js TCP probe — no Python needed)
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
if (-not (Test-Path "$agentDir\node_modules\@anthropic-ai")) {
    Write-Host "Installing agent dependencies..." -ForegroundColor Gray
    & $npm install --prefix $agentDir --legacy-peer-deps --silent
}

# Step 5: Build TypeScript
Write-Host "Building TypeScript agent..." -ForegroundColor Cyan
& $npm run build --prefix $agentDir 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed — check packages/agent/src for errors" -ForegroundColor Red
    exit 1
}
Write-Host "Build complete" -ForegroundColor Green

# Step 6: Start agent server (foreground — blocks until Ctrl+C)
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
```

- [ ] **Step 2: Commit**

```bash
git add start-backend.ps1
git commit -m "chore: rewrite start-backend.ps1 — single TypeScript server, no Python"
```

---

## Task 8: Build and smoke-test

- [ ] **Step 1: Build the TypeScript package**

```bash
cd packages/agent
npm run build
```

Expected: `dist/` folder created with **zero TypeScript errors**. If errors appear, fix them before proceeding.

- [ ] **Step 2: Start backend**

In terminal 1:
```
.\start-backend.ps1
```

Expected output (in order):
```
DynamoDB Local ready
Build complete
[db] Table finops_runs already exists   (or "Created table finops_runs")
[db] All tables ready
[agent-server] FinOps Agent Server running on port 8005
[agent-server] API: http://localhost:8005/api
```

- [ ] **Step 3: Verify health endpoint**

```bash
curl http://localhost:8005/health
```

Expected: `{"status":"ok","service":"finops-agent"}`

- [ ] **Step 4: Verify auth is enforced**

```bash
curl http://localhost:8005/api/status
```

Expected: `401 {"error":"Bearer token required"}`

- [ ] **Step 5: Start frontend**

In terminal 2:
```
.\start-frontend.ps1
```

Open `http://localhost:3000` — login with Okta — dashboard loads (may show "No run found" for a fresh DB — that is correct).

- [ ] **Step 6: Trigger a run from the UI**

Click "Run Fresh Analysis" — verify:
- Response is 202 with a `run_id`
- `/api/status` returns `status: "running"`
- Agent server logs show orchestrator starting

---

## Task 9: Update Playwright port references

The Playwright tests have hardcoded `8004` in 3 files (13 total occurrences). Update all to `8005`.

**Files:**
- Modify: `playwright/tests/02-api-integration.spec.ts` (6 occurrences — includes `/health` probe)
- Modify: `playwright/tests/04-run-analysis.spec.ts` (4 occurrences)
- Modify: `playwright/tests/05-results-display.spec.ts` (3 occurrences)

- [ ] **Step 1: Update all `8004` → `8005` in the three test files**

In each file, do a find-and-replace of `localhost:8004` → `localhost:8005` and `http://127.0.0.1:8004` → `http://127.0.0.1:8005` (if present).

Verify with:
```bash
grep -r "8004" playwright/tests/
```

Expected: no output (zero matches).

- [ ] **Step 2: Commit**

```bash
git add playwright/tests/
git commit -m "test: update Playwright port references from 8004 to 8005"
```

---

## Task 10: Delete Python backend and run full E2E suite

Only after Task 8 smoke-test passes.

- [ ] **Step 1: Remove Python backend package**

```bash
rm -rf packages/backend
```

- [ ] **Step 2: Commit deletion**

```bash
git add -A
git commit -m "chore: remove Python backend — TypeScript server is now the sole backend"
```

- [ ] **Step 3: Run the full Playwright suite**

```bash
.\start-playwright.ps1
```

Expected: **32/32 tests passing**.

- [ ] **Step 4: If any tests fail**

Check the failure message. Common causes after this migration:
- Remaining `8004` reference → fix and re-run
- Auth middleware rejecting test tokens → check `OKTA_ISSUER` has no trailing slash in `packages/agent/.env.local`
- DynamoDB table not found → verify `createTables()` ran on startup (check server logs)

---

## Summary

After this plan:
- **One backend process**: `node dist/server.js` on port 8005 (TypeScript only)
- **One startup script**: `.\start-backend.ps1` (DynamoDB Docker + TypeScript server, foreground)
- **Zero Python**: `packages/backend/` deleted, no `python` in startup scripts
- **Frontend unchanged**: same API contract (`/api/trigger`, `/api/status`, `/api/results`) — now served from port 8005
- **Two terminals**: `.\start-backend.ps1` + `.\start-frontend.ps1`
