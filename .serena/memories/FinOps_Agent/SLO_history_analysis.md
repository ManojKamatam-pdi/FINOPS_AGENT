# SLO History Analysis: Current Architecture & Findings

## Executive Summary

**Current State**: The SLO audit agent **DOES NOT** fetch 12-month SLO history during the audit run. Instead:
- **Audit run** = fetches current SLO configuration + validates + scores
- **History fetch** = on-demand from frontend via `/api/slo/history` endpoint, which calls Datadog REST API in real-time

**Data Stored in DynamoDB per SLO result**: Configuration validation results ONLY (no time-series data)

---

## 1. SLO AUDIT WORKFLOW (What Runs Now)

### Entry Point
`POST /api/slo/trigger` → creates run, orchestrator starts async

### 3-Phase Pipeline per Tenant

**Phase 1: SLO Discovery** (`runSloListAgent`)
- Fetches all SLOs from `GET /api/v1/slo` (Datadog REST API)
- Handles pagination (limit=1000, offset)
- **Bulk-fetches monitor details** for all monitor-type SLOs:
  - Collects unique monitor IDs from all monitor SLOs
  - Fetches monitors in batches of 100
  - Embeds monitor details into SLO objects
- Derives monitoring context from portfolio:
  - `apm_enabled`: looks for `trace.*` metrics in any SLO query
  - `synthetics_enabled`: looks for `synthetics` monitors or tags
  - `infra_monitoring`: always true
- Stores in DynamoDB `slo_lists` table
- **No time-series data fetched**

**Phase 2: SLO Batch Audit** (`runSloBatchAgent`)
- Splits SLOs into batches (20 SLOs/batch)
- Processes in waves (10 concurrent batches)
- For EACH SLO:
  - Classifies SLI category (availability, latency, error_rate, throughput, saturation)
  - Validates formula/monitor configuration
  - Checks APM/Synthetics compatibility
  - Computes validation_score (0-100)
  - Generates specific insight
  - Writes to DynamoDB `slo_results` table
- **Uses pre-fetched monitor details** (no API calls during audit)

**Phase 3: Org SLO Summary** (`runSloSummarizeAgent`)
- Reads all per-SLO results from DynamoDB
- Computes org-level metrics:
  - compliance_score (weighted average of SLO validation_scores)
  - compliance_tier (excellent|good|needs_improvement|poor|critical)
  - category_scores (by SLI category)
  - gap_analysis (common patterns)
- Writes to DynamoDB `slo_org_summary` table

### Batch Performance Tuning
- **SLO_BATCH_SIZE**: 20 SLOs/batch
- **SLO_BATCH_CONCURRENCY**: 10 parallel batches per wave
- **maxTurns**: 200 per batch agent

---

## 2. DATA STORED IN DYNAMODB

### `slo_results` Table (Per-SLO)

**Primary Key**: 
- PK: `tenant_id`
- SK: `{slo_id}#{run_id}`

**Fields Stored** (CONFIGURATION ONLY):
```typescript
{
  tenant_id: string;
  sk: string;
  run_id: string;
  slo_id: string;
  slo_name: string;
  slo_type: "metric" | "monitor" | "time_slice";
  sli_category: "availability" | "latency" | "error_rate" | "throughput" | "saturation" | "unclassified";
  formula_valid: boolean;
  formula_issue: string | null;
  context_compatible: boolean;
  validation_score: number; // 0-100
  validation_status: "excellent" | "good" | "needs_improvement" | "poor" | "critical";
  blocker_issues: string[];
  quality_issues: string[];
  enhancements: string[];
  insight: string; // ONE specific finding about THIS SLO
  tags: string[];
  target_percentage: number | null;
  time_windows: string[]; // ["7d"] or ["7d", "30d"]
  analyzed_at: string; // ISO timestamp when audit ran
  ttl: number; // 90 days
}
```

**What's NOT stored**:
- No SLI values (current or historical)
- No time-series data
- No "current SLI status"
- No performance metrics

---

### `slo_org_summary` Table (Per-Org)

**Primary Key**: 
- PK: `tenant_id`
- SK: `run_id`

**Fields Stored**:
```typescript
{
  tenant_id: string;
  run_id: string;
  total_slos: number;
  valid_slos: number;
  misconfigured_slos: number;
  unclassified_slos: number;
  compliance_score: number; // weighted average validation_score
  compliance_tier: string; // excellent|good|needs_improvement|poor|critical
  monitoring_context: {
    apm_enabled: boolean;
    synthetics_enabled: boolean;
    infra_monitoring: boolean;
  };
  category_scores: {
    availability: number | null;
    latency: number | null;
    error_rate: number | null;
  };
  na_categories: string[];
  gap_analysis: Array<{
    severity: string;
    category: string;
    insight: string;
    affected_slos: number;
    recommendation: string;
  }>;
  completed_at: string;
  ttl: number; // 90 days
}
```

---

## 3. SLO HISTORY ENDPOINT (On-Demand)

### Route
```
GET /api/slo/history?slo_id={id}&tenant_id={tid}
```

### Process (slo-api.ts)

```typescript
// 1. Validate inputs
slo_id (required)
tenant_id (required)

// 2. Look up tenant from registry
// 3. Resolve Datadog site (datadoghq.com | datadoghq.eu | us3.datadoghq.com | etc)
// 4. Calculate time window
toTs = now
fromTs = now - 365 * 24 * 60 * 60  // 12 months ago

// 5. Call Datadog SLO History API
GET {apiBase}/api/v1/slo/{slo_id}/history?from_ts={fromTs}&to_ts={toTs}
  Headers:
    DD-API-KEY: {tenant.dd_api_key}
    DD-APPLICATION-KEY: {tenant.dd_app_key}

// 6. Parse response
// For metric SLOs:
//   - Response format: { data.series.times[], data.series.values[][] }
//   - Extract: sli_values from values[0][]
// For monitor SLOs:
//   - Response format: { data.groups[] }
//   - Each group has: history: [[timestamp, sli_value], ...]
//   - Aggregate across all groups → average per timestamp

// 7. Convert to monthly buckets
dataPoints = [
  { month: "2025-12", timestamp: 1735689600, sli_value: 99.5 },
  { month: "2026-01", timestamp: 1738368000, sli_value: 99.8 },
  ...
]

// 8. Return
{
  slo_id: string;
  tenant_id: string;
  overall_sli: number | null;
  data_points: [{ month, timestamp, sli_value }];
}
```

### Key Observations

**Time Window**: Hard-coded 12 months from now
```typescript
const toTs = Math.floor(Date.now() / 1000);
const fromTs = toTs - 365 * 24 * 60 * 60;
```

**Data Parsing**:
- Metric SLOs: Use `series.times[]` and `series.values[0][]`
- Monitor SLOs: Aggregate `groups[].history[]` (each is [timestamp, sli_value])
- Result: Flattened to monthly granularity (NOT hourly or daily)

**Caching**: NONE (real-time fetch every time endpoint called)

---

## 4. BULK/PRE-FETCH PATTERNS IN CURRENT CODE

### Pattern 1: Monitor Details Pre-Fetching (SLO Discovery)

**Where**: `slo-list-server.ts` → `fetch_and_store_all_slos_tool`

```typescript
// Step 1: Fetch all SLOs
allSlos = fetch_paginated(/api/v1/slo)

// Step 2: Identify all monitor IDs
monitorIds = new Set()
for (const slo of allSlos) {
  if (slo.type === "monitor") {
    for (const id of slo.monitor_ids) {
      monitorIds.add(id);  // Collect
    }
  }
}

// Step 3: BULK fetch monitors in batches of 100
for (chunk of batch(monitorIds, 100)) {
  monitors = fetch(/api/v1/monitor?monitor_ids={chunk.join(",")})
  for (const m of monitors) {
    monitorMap.set(m.id, m)  // Cache
  }
}

// Step 4: Embed monitors into SLO objects
for (const slo of allSlos) {
  if (slo.type === "monitor") {
    slo.monitor_details = slo.monitor_ids
      .map(id => monitorMap.get(id))
      .filter(m => m !== undefined)
  }
}

// Result: Batch agent has ALL data it needs (no extra API calls)
```

**Benefit**: Batch agent does NOT need to call `search_datadog_monitors` for every SLO

---

### Pattern 2: Host Details Pre-Fetching (Infrastructure Rightsizing)

Similar pattern in `list-hosts-server.ts` (for host analysis, not SLOs):
- Fetches all hosts
- Pre-fetches all instance specs
- Embeds into host objects
- Batch agent has everything

---

## 5. WHAT WOULD BE NEEDED FOR PRE-FETCHED HISTORY

If we wanted 12-month SLI history fetched DURING the audit run (not on-demand):

### Option A: Fetch During Discovery Phase
```typescript
// In slo-list-server.ts → fetch_and_store_all_slos_tool
for (const slo of allSlos) {
  // Fetch 12-month history
  const history = await fetch(
    /api/v1/slo/{slo.id}/history?from_ts={...}&to_ts={...}
  )
  slo.history_data_points = history.data_points
}

// Store in slo_lists alongside SLO config
await storeSloList(runId, tenantId, allSlos_with_history, ...)
```

**Cost**: 
- N API calls where N = number of SLOs
- ~1-2 hours history per SLO × N SLOs

---

### Option B: Fetch During Batch Phase
```typescript
// In batch agent
for (const slo of batch) {
  const history = await fetch(/api/v1/slo/{slo.id}/history)
  // Analyze history (trends, etc)
  // Write result with history metrics
}
```

**Cost**: Same N API calls, but parallelized across 10 concurrent batches

---

### Option C: Post-Audit Async Fetch
```typescript
// After org summary completes
for (const slo in org_results) {
  async fetch_history_and_store(slo)
}
```

**Cost**: Same N API calls, queued after audit

---

## 6. KEY FILES & THEIR ROLES

| File | Role | Fetches History? |
|------|------|------------------|
| `slo-orchestrator.ts` | Orchestrates per-tenant analysis | No |
| `slo-org-agent.ts` | Coordinates phases (discovery → batch → summarize) | No |
| `slo-list-agent.ts` | Invokes discovery | No |
| `slo-list-server.ts` | **Bulk-fetches SLOs + monitor details** | No |
| `slo-batch-agent.ts` | Validates SLO config + scores | No |
| `slo-batch-server.ts` | Persists per-SLO results | No |
| `slo-summarize-agent.ts` | Generates org summary | No |
| `slo-summarize-server.ts` | Persists org summary | No |
| `slo-dynamodb.ts` | DynamoDB operations | No (stores results only) |
| `slo-api.ts` | REST API endpoints | **YES** (`/api/slo/history` endpoint) |

---

## 7. WHAT GETS LOGGED DURING AUDIT

### `slo_results` insight Field

Example insights from system prompt:
```
"This SLO uses monitor 'Shell SLO By Alerts' which is currently at 26.86% SLI — 
 well below the 99.9% target, actively burning error budget."

"The metric sum:trace.web.request.hits{service:payment-api} requires APM which 
 is not enabled — this SLO has no data and always shows 0%."

"This SLO uses agent.up monitor 'PDI-Orbis Host Availability' — measures Datadog 
 agent heartbeat, not actual service health."
```

**Note**: Insights reference the SLO's CURRENT configuration, not historical performance

---

## 8. METRICS NOT COMPUTED DURING AUDIT

The audit agent DOES NOT compute:
- Average SLI over time
- SLI trend (improving vs degrading)
- Number of days below target
- Error budget remaining
- Historical compliance score

These would REQUIRE historical SLI data, which is not fetched during audit.

---

## 9. SUMMARY TABLE

| Aspect | Current | Notes |
|--------|---------|-------|
| **What runs during audit** | SLO config discovery + validation + scoring | Real-time SLO definitions only |
| **What data is stored** | Validation results (score, issues, tags, windows) | Configuration state, not performance |
| **Time-series SLI data** | Not fetched during audit | Fetched on-demand via `/api/slo/history` |
| **Bulk-fetch patterns** | ✅ Monitor details pre-fetched & embedded | Prevents N separate API calls during batch |
| **History caching** | ❌ None (real-time Datadog API call per request) | Could be optimized with cache |
| **Audit phase dependencies** | Discovery → Batch (parallel waves) → Summarize | Sequential, but within phases parallelized |

---

## 10. RECOMMENDATIONS FOR HISTORY PRE-FETCH (If Needed)

If you want to fetch 12-month SLI history during the audit run:

**Approach 1: Early (Minimal Risk)**
- Extend `fetch_and_store_all_slos_tool` to batch-fetch history during discovery
- Store history in `slo_lists` alongside SLO config
- Batch agent can access without extra API calls
- Summarize agent can compute trends

**Approach 2: Defer (Post-Audit)**
- After org summary completes, spawn async history-fetch tasks
- Store separately in new DynamoDB table `slo_history_cache`
- Frontend uses cache if available, falls back to on-demand

**Approach 3: Hybrid (Best UX)**
- Fetch history during discovery (pre-cache)
- Store in DynamoDB `slo_history_cache` with TTL (30 days)
- `/api/slo/history` checks cache first, falls back to Datadog if expired
- Reduces API costs significantly

