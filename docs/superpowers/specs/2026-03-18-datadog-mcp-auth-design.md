# Datadog MCP Authentication — Design Spec
**Date:** 2026-03-18
**Status:** Approved
**Author:** Brainstorming session with Claude

---

## 1. Problem Statement

The FinOps Agent's Claude Agent SDK cannot perform OAuth2 flows. The Datadog MCP shim requires a valid Okta Bearer token on every request. When the SDK calls the Datadog MCP without a valid token — or with a token whose `cid` claim doesn't match the shim's configured `clientId` — the shim returns `401 invalid_token`. Currently this causes the agent to fail confusedly (retries, hits `max_turns`) with no clean user-facing message.

---

## 2. Solution Overview

Two parts:

**Part 1 — Okta alignment (config only, no code):**
The FinOps Agent frontend is registered as an additional redirect URI on the existing Datadog MCP Okta app. Both apps share the same `clientId`. The user's Okta token — already passed through the entire agent stack via `mcp-registry.ts` `auth: "okta_forward"` — now has the correct `cid` claim that the Datadog shim expects. Zero code changes required for the happy path.

**Part 2 — Graceful 401 handling (code change):**
If a user has the FinOps Agent access but not Datadog MCP access (wrong group, misconfigured), the 401 is caught, propagated as a typed error, stored on the run record, and surfaced to the frontend as a clear human-readable message.

---

## 3. Token Flow (Happy Path)

```
User logs into FinOps Agent (Datadog MCP Okta app, shared clientId)
  → Okta token: cid = shared clientId ✅

POST /api/trigger
  → requireAuth validates token → req.user.rawToken
  → runOrchestrator(runId, user.rawToken)
  → runOrgAnalysis(tenantId, oktaToken, runId)
  → getMcpServers(["datadog"], oktaToken)
  → SDK header: Authorization: Bearer <okta-token>
  → Datadog shim: validates cid === shared clientId ✅ → forwards to AgentCore
```

No new infrastructure. No Secrets Manager. No per-user token storage. Token lives in memory for the duration of the request — scales to any number of users.

**Token expiry:** When the Okta token expires, the FinOps frontend's `@okta/okta-react` silently refreshes it (using `offline_access` refresh token). The next `/api/trigger` call uses the fresh token. No separate Datadog MCP re-login needed — one Okta session covers both.

---

## 4. Okta Configuration (Admin task — no code)

In the Datadog MCP Okta app:
- Add `http://localhost:3000/login/callback` as a sign-in redirect URI
- Add `https://<finops-cloudfront-domain>/login/callback` as a sign-in redirect URI
- Add the FinOps user group to the app's assignments

In the FinOps Agent:
- Set `REACT_APP_OKTA_CLIENT_ID` = Datadog MCP Okta app's `clientId`
- Set `OKTA_CLIENT_ID` = same value (backend JWT validation)
- `OKTA_ISSUER` is unchanged (same Okta org)

---

## 5. Graceful 401 Handling (Code Changes)

### 5.1 New Error Type

**File:** `packages/agent/src/agents/errors.ts` (new file)

```typescript
export class DatadogAuthError extends Error {
  constructor(tenantId: string) {
    super(`Not authorized to access Datadog MCP for tenant '${tenantId}'. Contact your admin team.`);
    this.name = "DatadogAuthError";
  }
}
```

### 5.2 Detection in Agent Loops

In `list-hosts-agent.ts` and `host-batch-agent.ts`, refactor the result capture inside the `for await` loop to hoist it to an outer `let`, then check it after the loop.

**SDK result shapes:**
- `SDKResultSuccess` (`is_error: false`) → has `result: string`
- `SDKResultError` (`is_error: true`) → has **no `result` field** — has `errors: string[]` instead

The detection must handle both shapes. Add the import and hoist the variable:

```typescript
import { DatadogAuthError } from "./errors.js";
import type { SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";

// Before the for-await loop:
let finalResult: (SDKResultSuccess & { is_error?: boolean; stop_reason?: string; errors?: string[] }) | null = null;

// Inside the for-await loop, replace the existing `if (msg.type === "result")` block:
if (msg.type === "result") {
  finalResult = msg as typeof finalResult;
  const r = finalResult!;
  if (r.is_error) console.error(`[<agent>:${tenantId}] Agent run failed: ${r.errors?.join(", ") ?? "unknown error"}`);
  else if (r.stop_reason === "max_turns") console.warn(`[<agent>:${tenantId}] Hit max_turns`);
  else console.log(`[<agent>:${tenantId}] Completed: stop_reason=${r.stop_reason}`);
}

// After the for-await loop:
if (finalResult?.is_error) {
  // SDKResultError surfaces auth failures in errors[], not result
  const errText = (finalResult.errors?.join(" ") ?? "").toLowerCase();
  if (errText.includes("401") || errText.includes("unauthorized") || errText.includes("invalid_token") || errText.includes("not authorized")) {
    throw new DatadogAuthError(tenantId);
  }
}
```

`summarize-agent.ts` does not call the Datadog MCP — no change needed there.

### 5.3 Propagation in org-agent.ts

`runOrgAnalysis` already re-throws errors from `runListHostsAgent` and `runHostBatchAgent`. `DatadogAuthError` propagates naturally — no change needed in `org-agent.ts`.

**Note on `Promise.all` fan-out:** `runHostBatchAgent` calls are fanned out via `Promise.all`. If multiple batches hit 401, each will throw `DatadogAuthError`. `Promise.all` rejects on the first error and the orchestrator catches it. The remaining in-flight batches will also throw but those errors are ignored by `Promise.all` after the first rejection. This is correct behaviour — no cancellation logic needed.

### 5.4 Orchestrator Catches and Records

**File:** `packages/agent/src/agents/orchestrator.ts`

Add import at top:
```typescript
import { DatadogAuthError } from "./errors.js";
```

Update the catch block:
```typescript
} catch (err) {
  const isAuthError = err instanceof DatadogAuthError;
  await updateRunStatus(runId, "failed", new Date().toISOString(),
    isAuthError ? (err as DatadogAuthError).message : "Agent error — check logs");
  throw err;
}
```

The success-path call `await updateRunStatus(runId, "completed", new Date().toISOString())` is unchanged — `errorMessage` is optional and defaults to absent.

### 5.5 DynamoDB — Add error_message Field

**File:** `packages/agent/src/tools/dynamodb.ts`

Update `updateRunStatus` to conditionally include `error_message`. DynamoDB requires the expression string and `ExpressionAttributeValues` to be built before the call — you cannot reference an unbound placeholder:

```typescript
export async function updateRunStatus(
  runId: string,
  status: string,
  completedAt: string,
  errorMessage?: string
): Promise<void> {
  const updateExpr = errorMessage
    ? "SET #s = :s, completed_at = :c, error_message = :e"
    : "SET #s = :s, completed_at = :c";

  const exprValues: Record<string, unknown> = { ":s": status, ":c": completedAt };
  if (errorMessage) exprValues[":e"] = errorMessage;

  await getClient().send(new UpdateCommand({
    TableName: "finops_runs",
    Key: { run_id: runId, sk: "METADATA" },
    UpdateExpression: updateExpr,
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: exprValues,
  }));
}
```

### 5.6 API Route — Expose error_message

**File:** `packages/agent/src/routes/api.ts`

Add to the `/api/status` response:
```typescript
error_message: run["error_message"] ?? null,
```

### 5.7 Frontend — Display Auth Error

**File:** `packages/frontend/src/services/api.ts`

Add `error_message: string | null` to the `RunStatus` interface.

**File:** `packages/frontend/src/pages/RunProgressPage.tsx`

Replace the generic failed message:
```typescript
} else if (s.status === 'failed') {
  stopRef.current?.();
  setError(s.error_message ?? 'Analysis run failed. Check the activity log for details.');
}
```

---

## 6. Files Changed

| File | Change |
|------|--------|
| `packages/agent/src/agents/errors.ts` | New — `DatadogAuthError` class |
| `packages/agent/src/agents/list-hosts-agent.ts` | Detect 401 in result, throw `DatadogAuthError` |
| `packages/agent/src/agents/host-batch-agent.ts` | Detect 401 in result, throw `DatadogAuthError` |
| `packages/agent/src/agents/orchestrator.ts` | Catch `DatadogAuthError`, pass message to `updateRunStatus` |
| `packages/agent/src/tools/dynamodb.ts` | Add optional `errorMessage` param to `updateRunStatus` |
| `packages/agent/src/routes/api.ts` | Expose `error_message` in `/api/status` response |
| `packages/frontend/src/services/api.ts` | Add `error_message` to `RunStatus` interface |
| `packages/frontend/src/pages/RunProgressPage.tsx` | Show `error_message` when run fails |

---

## 7. Non-Goals

- No token refresh logic in the agent — handled by `@okta/okta-react` in the frontend
- No retry on 401 — a 401 from the Datadog shim means the user lacks access; retrying won't help
- No per-user token storage anywhere (Secrets Manager, DynamoDB, Redis)
- No changes to the Datadog MCP codebase

---

## 8. Success Criteria

- User with correct Okta group: analysis runs end-to-end, Datadog MCP calls succeed
- User without Datadog MCP access: frontend shows *"Not authorized to access Datadog MCP for tenant '...'. Contact your admin team."* within one polling cycle
- Token expiry: silent refresh by `@okta/okta-react`; next triggered run works without re-login
- 3000 concurrent users: no AWS resource contention — token is in-memory per request only
