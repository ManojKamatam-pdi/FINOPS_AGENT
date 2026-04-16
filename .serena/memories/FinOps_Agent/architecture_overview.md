# FinOps Agent - Complete Architecture Overview

## High-Level Application Structure

The FinOps Agent is a **fully agentic TypeScript application** built on the **Claude Agent SDK** that analyzes Datadog infrastructure and SLO compliance across multiple organizations (tenants). It uses **HTTP MCP servers** (Datadog official MCP + custom MCP servers) for tool access and **DynamoDB** for persistence.

### Key Components:
- **Express.js REST API** (port 8005) - external API entry points
- **Claude Agent SDK** - agentic orchestration engine
- **Datadog MCP Server** - HTTP-based tool access to Datadog APIs
- **Custom MCP Servers** - specialized tools for each agent workflow
- **DynamoDB** - data persistence (runs, hosts, results, SLOs)
- **TypeScript** - entire codebase (no Python)

---

## 1. REQUEST FLOW & API ENDPOINTS

### Entry Points (Express Routes)

**File:** `packages/agent/src/server.ts`

```
Health endpoint:
  GET /health (no auth) → liveness check

Infrastructure Analysis (Host Rightsizing):
  POST /api/trigger (Okta auth) → start new analysis run
  GET  /api/status  (Okta auth) → poll run progress
  GET  /api/results (Okta auth) → fetch completed run results
  GET  /api/active-run (Okta auth) → check if run in progress
  POST /api/abort   (Okta auth) → explicitly abort run

SLO Compliance Audit:
  POST /api/slo/trigger (Okta auth) → start new SLO audit run
  GET  /api/slo/status  (Okta auth) → poll SLO run progress
  GET  /api/slo/results (Okta auth) → fetch completed SLO audit results
  GET  /api/slo/active-run (Okta auth) → check if SLO run in progress
  POST /api/slo/abort   (Okta auth) → abort SLO audit run
```

### Response Formats
- **202 Accepted**: Fire-and-forget orchestration (async agents run in background)
- **409 Conflict**: Run already in progress with full progress metrics
- **404 Not Found**: Run or results not available
- **200 OK**: Status update or completed results

---

## 2. INFRASTRUCTURE RIGHTSIZING WORKFLOW

### Entry Point
`POST /api/trigger` → creates run, returns **run_id**, orchestrator starts async

### Orchestration Pipeline (Host Analysis)

**File:** `packages/agent/src/agents/orchestrator.ts`

```
runOrchestrator(runId) 
  → Run in parallel for ALL tenants:
    └─ runOrgAnalysis(tenantId, runId)
  → If all complete successfully: mark run as "completed"
  → If abort signal: mark run as "failed"
  → Guard: if 0 hosts processed, mark run "failed" (protect last good report)
```

### Per-Tenant Analysis Workflow

**File:** `packages/agent/src/agents/org-agent.ts`

```
runOrgAnalysis(tenantId, runId):
  1. Host Discovery
     └─ runListHostsAgent(tenantId, runId)
        └─ Fetches ALL hosts from Datadog via MCP DDSQL query
        └─ Stores in DynamoDB finops_host_lists
        └─ Updates run total count

  2. Host Batch Analysis (parallel waves)
     └─ Split hosts into batches (15 hosts/batch)
     └─ Process in waves (30 concurrent batches per wave)
     └─ Each batch: runHostBatchAgent(tenantId, batch, runId, batchIndex, totalBatches)

  3. Org Summarization
     └─ runSummarizeAgent(tenantId, runId)
     └─ Aggregates all host results → org-level summary
     └─ Stores in DynamoDB finops_org_summary
```

### BATCH PARAMETERS (Performance Tuning)
- **BATCH_SIZE**: 15 hosts per batch (15 × ~13 turns avg = ~195 turns, fits maxTurns:200)
- **BATCH_CONCURRENCY**: 30 parallel batches per wave (throughput optimization)
- **maxTurns**: 200 per host batch agent (peak per-host complexity)

---

## 3. AGENTS & THEIR ROLES

### 1. List-Hosts Agent (`list-hosts-agent.ts`)
**Purpose**: Discover all infrastructure hosts in a Datadog org

**Agent Type**: Single-turn, deterministic
- **Input**: Tenant ID, run ID
- **System Prompt**: "You have ONE tool: fetch_and_store_all_hosts_tool. Call it once."
- **MCP Servers Used**: 
  - `list-hosts-tools` (custom) - wraps fetch_and_store_all_hosts_tool
  - (No Datadog MCP needed — tool calls REST API directly)

**Tool**: `fetch_and_store_all_hosts_tool`
- Fetches ALL hosts from Datadog DDSQL via Datadog MCP
- Handles pagination internally (start_at offset)
- Writes to DynamoDB `finops_host_lists` table
- Updates `run.hosts_total`
- Returns: `{ success: true, tenant_id, total_hosts }`

**Output**: DynamoDB table with hostname list for batch processing

---

### 2. Host-Batch Agent (`host-batch-agent.ts`)
**Purpose**: Right-sizing analysis for infrastructure hosts (core business logic)

**Agent Type**: Multi-turn, complex reasoning
- **Input**: 15 hosts, 30-day time window (unix timestamps), tenant ID, run ID, batch index
- **System Prompt**: 72 KB comprehensive guide covering:
  - Cloud provider classification (AWS EC2, ECS, Azure, GCP, on-prem, bare-metal)
  - Multi-tier metric collection (Datadog agent system.* vs cloud integrations)
  - Right-sizing decision trees (3 paths for different data availability)
  - Efficiency labeling rules
  - Evidence-first reasoning (no hallucinations)

**MCP Servers Used**:
- `host-batch-tools` (custom) - 6 tools for analysis & persistence
- `{tenantId}` (HTTP Datadog MCP) - metrics, host search, monitor queries

**Tools**:

1. **`get_instance_specs_tool`**
   - Gets vCPU count & RAM GB for EC2 instance type from AWS catalog
   - Input: instance_type, region
   - Output: `{ vcpu, ram_gb }`

2. **`get_instance_on_demand_price_tool`**
   - Gets monthly on-demand USD price for instance type
   - Used when host has instance_type tag but NO metrics (PATH 3)
   - Input: instance_type, region
   - Output: `{ monthly_usd }`

3. **`suggest_right_sized_instance_tool`** (AWS-specific)
   - Intelligent right-sizing for AWS EC2 instances
   - Uses 95th percentile CPU + RAM utilization
   - Returns best-fit replacement with live pricing
   - Input: cpu_p95_pct, ram_avg_pct, current_instance, region
   - Output: `{ suggested, already_right_sized, suggested_monthly_usd, current_monthly_usd, monthly_savings, savings_percent }`
   - Falls back if Azure/GCP detected: returns `{ catalog_not_available: true }`
   - Falls back if RAM unavailable: returns `{ ram_unavailable: true }`

4. **`suggest_universal_rightsizing_tool`** (Cloud-agnostic)
   - For: (1) no instance_type, (2) Azure/GCP, (3) AWS with no RAM data
   - Generates utilization-based recommendations without catalog
   - Input: host_name, cpu_avg_pct, cpu_p95_pct, ram_avg_pct, disk_avg_pct, network_in/out, instance_cpu_count, instance_ram_gb, cloud_provider
   - Output: `{ efficiency_label, recommendation, suggested_cpu_count, suggested_ram_gb }`

5. **`build_pricing_calculator_url_tool`**
   - Builds AWS pricing calculator URL for manual verification
   - Input: current_instance, suggested_instance, region
   - Output: `{ pricing_calc_url }`

6. **`write_host_result_tool`** (Persistence)
   - Writes per-host analysis result to DynamoDB
   - **CRITICAL**: Accepts dd_host_metadata (raw Datadog response) for authoritative instance_type/cloud_provider
   - Server-side normalization:
     - Recovers metrics from recommendation text if agent omitted them
     - Recomputes efficiency_label from actual metric data (never trusts agent)
     - Validates PATH 3 rule: AWS + instance_type + no metrics MUST have current_monthly_cost
     - Normalizes cloud_provider to canonical values (aws|azure|gcp|on-prem|unknown)
     - Handles metric field name aliases (cpu_avg vs cpu_avg_pct vs cpu_avg_30d)
   - Input: host_id, result_json, dd_host_metadata (optional)
   - Output: Confirmation message

7. **`update_run_progress_tool`**
   - Updates run progress counters & log
   - Input: hosts_done, log_message
   - Increments `run.hosts_done`, appends to `run.log` (trimmed to last 400 entries)

**Agent Workflow (Per Batch)**:
```
For EACH host in batch, execute sequentially:

STEP A: Classify host — cloud provider discovery
  - Call search_datadog_hosts → tags, aliases, cloud metadata
  - EVIDENCE-FIRST: use only explicit tags, aliases, and app sources
  - Classification precedence: EC2 alias → ECS app → instance-type tag → region tag → T2 metric probes
  - T2 probes (if needed): aws.ec2.*, azure.vm.*, gcp.gce.*, vsphere.*
  - Result: cloud_provider (aws|azure|gcp|on-prem|unknown)

STEP B: Collect metrics — Tier 1 (system.*) then Tier 2 (cloud)
  - EFFICIENCY: Issue all T1 queries first, then T2 only for missing data
  - T1 system.* metrics: cpu.idle, mem.pct_usable, net.bytes_rcvd/sent, disk.in_use
  - T2 fallback per cloud: aws.ec2.*, azure.vm.*, gcp.gce.*, vsphere.*
  - Handle ECS/Fargate: T1 & T2 return nothing (expected; no host-scoped metrics)

STEP C: Get instance specs
  - If instance_type found: call get_instance_specs_tool
  - Extract vcpu, ram_gb from response

STEP D: Right-sizing recommendation (Decision Tree)
  - PATH 1: AWS + instance_type + cpu + ram → suggest_right_sized_instance_tool
  - PATH 2: AWS + instance_type + cpu only (no ram) → suggest_universal_rightsizing_tool
  - PATH 3: AWS + instance_type + no metrics → MANDATORY: call get_instance_on_demand_price_tool
  - PATH 4: No instance_type or Azure/GCP → suggest_universal_rightsizing_tool
  - PATH 5: No metrics at all → generic recommendation

STEP E: Write result
  - Call write_host_result_tool with full result JSON
  - Includes: host name, cloud provider, metrics, instance specs, cost, recommendation

After all hosts in batch:
  - Call update_run_progress_tool(hosts_done, log_message)
```

---

### 3. Summarize Agent (`summarize-agent.ts`)
**Purpose**: Aggregate per-host results into org-level summary

**Agent Type**: Single-turn, deterministic
- **Input**: Tenant ID, run ID
- **System Prompt**: "You have ONE tool: compute_and_write_org_summary_tool. Call it once."
- **MCP Servers Used**: 
  - `summarize-tools` (custom) - single tool

**Tool**: `compute_and_write_org_summary_tool`
- Reads all host results from finops_host_results (for this run & tenant)
- Computes aggregations:
  - Total hosts, analyzed hosts, efficiency distribution
  - Total spend, potential savings, top offenders
  - Average CPU/RAM utilization
- Writes to DynamoDB `finops_org_summary`
- Returns: `{ success, tenant_id, total_hosts, hosts_analyzed, savings }`

**Output**: Org-level summary available via `/api/results`

---

## 4. SLO COMPLIANCE AUDIT WORKFLOW

### Entry Point
`POST /api/slo/trigger` → creates SLO run, returns **run_id**, SLO orchestrator starts async

### SLO Orchestration Pipeline

**File:** `packages/agent/src/agents/slo-orchestrator.ts`

```
runSloOrchestrator(runId)
  → Run in parallel for ALL tenants:
    └─ runSloOrgAnalysis(tenantId, runId)
  → If all complete: mark run as "completed"
  → If abort signal: mark run as "failed"
  → Guard: if SLOs expected but 0 written, mark "failed"
```

### Per-Tenant SLO Analysis Workflow

**File:** `packages/agent/src/agents/slo-org-agent.ts`

```
runSloOrgAnalysis(tenantId, runId):
  1. SLO Discovery
     └─ runSloListAgent(tenantId, runId)
     └─ Fetches all SLOs from Datadog REST API
     └─ Derives monitoring context (APM enabled? Synthetics enabled?)
     └─ Stores in DynamoDB slo_lists

  2. SLO Batch Audit (parallel waves)
     └─ Split SLOs into batches (20 SLOs/batch)
     └─ Process in waves (10 concurrent batches per wave)
     └─ Each batch: runSloBatchAgent(tenantId, batch, runId, monitoring_context, batchIndex)

  3. Org SLO Summary
     └─ runSloSummarizeAgent(tenantId, runId)
     └─ Aggregates compliance scores → org-level audit summary
     └─ Identifies common gaps (misconfiguration patterns)
```

### BATCH PARAMETERS (Performance Tuning)
- **SLO_BATCH_SIZE**: 20 SLOs per batch
- **SLO_BATCH_CONCURRENCY**: 10 parallel batch agents
- **maxTurns**: 200 per SLO batch agent

---

## 5. SLO AGENTS

### 1. SLO-List Agent (`slo-list-agent.ts`)
**Purpose**: Discover all SLOs and monitoring context

**Tool**: `fetch_and_store_all_slos_tool` (in custom `slo-list-tools` MCP)
- Fetches all SLOs via Datadog REST API
- Derives monitoring context from portfolio:
  - apm_enabled: any APM-requiring SLO exists
  - synthetics_enabled: any synthetics monitor SLO exists
  - infra_monitoring: always true (assumed present)
- Writes to DynamoDB `slo_lists`
- Returns: `{ success, tenant_id, total_slos, monitoring_context }`

---

### 2. SLO-Batch Agent (`slo-batch-agent.ts`)
**Purpose**: Compliance audit for SLOs (validate configuration, identify gaps)

**Agent Type**: Multi-turn, complex reasoning
- **Input**: 20 SLOs (pre-fetched with embedded monitor details), monitoring_context, batch index
- **System Prompt**: 45 KB comprehensive audit guide covering:
  - SLI category classification (availability, latency, error_rate, throughput, saturation)
  - Formula validation (metric SLOs, monitor SLOs, time_slice)
  - Blocker detection (missing windows, target 100%, inverted formulas, unsupported metrics)
  - Quality scoring (0-100 scale)
  - Context compatibility (APM required but not enabled?)

**MCP Servers Used**:
- `slo-batch-tools` (custom) - 2 tools for analysis & persistence
- `{tenantId}` (HTTP Datadog MCP) - monitor queries (if needed, but monitor details pre-embedded)

**Tools**:

1. **`write_slo_result_tool`** (Persistence)
   - Writes per-SLO audit result to DynamoDB
   - Input: slo_id, result_json (contains validation_score, issues, insights)
   - Result structure:
     ```json
     {
       "slo_name": "...",
       "slo_type": "metric|monitor|time_slice",
       "sli_category": "availability|latency|error_rate|throughput|saturation|unclassified",
       "formula_valid": true|false,
       "formula_issue": "description or null",
       "context_compatible": true|false,
       "validation_score": 0-100,
       "validation_status": "excellent|good|needs_improvement|poor|critical",
       "blocker_issues": ["issue1", ...],
       "quality_issues": ["issue1", ...],
       "enhancements": ["item1", ...],
       "insight": "one specific finding",
       "tags": ["tag1", ...],
       "target_percentage": float|null,
       "time_windows": ["7d", "30d", ...]
     }
     ```

2. **`update_slo_progress_tool`**
   - Updates SLO run progress counters & log
   - Input: slos_done, log_message
   - Increments `run.slos_done`, appends to log

**Agent Workflow (Per SLO Batch)**:
```
For EACH SLO in batch:
  STEP 1: Classify SLI category
    - Check sli_category tag first
    - Fall back to semantic analysis (name + description)
    - Result: availability|latency|error_rate|throughput|saturation|unclassified

  STEP 2: Validate formula/monitor
    - For metric SLOs: check numerator/denominator logic
    - For monitor SLOs: use monitor_details[] (pre-fetched, no API calls)
    - Detect blockers: inverted formula, unsupported metrics, contradictions

  STEP 3: Check monitoring context compatibility
    - trace.* metrics but APM not enabled? → BLOCKER
    - latency/error_rate SLO but no APM or synthetics? → context_compatible=false (N/A)

  STEP 4: Assess description quality
    - Empty? → ENHANCEMENT
    - Contradicts implementation? → QUALITY issue

  STEP 5: Score (0-100)
    - Start: 100
    - BLOCKER: -40 pts each (no windows, target=100%, formula inverted, missing capabilities)
    - QUALITY: -15 pts each (avg aggregation for latency, agent.up misconception, short windows)
    - ENHANCEMENT: -5 pts each (no description, missing tags)

  STEP 6: Generate insight
    - One specific finding (not generic advice)
    - Example: "Formula appears inverted: numerator could exceed denominator"

  STEP 7: Write result
    - Call write_slo_result_tool with complete audit record
```

---

### 3. SLO-Summarize Agent (`slo-summarize-agent.ts`)
**Purpose**: Aggregate per-SLO audit into org-level compliance report

**Tool**: `compute_and_write_slo_org_summary_tool` (in custom `slo-summarize-tools` MCP)
- Reads all SLO audit results from DynamoDB
- Computes org summary:
  - total_slos, valid_slos, misconfigured_slos, unclassified_slos
  - compliance_score (weighted average of SLO validation_scores)
  - compliance_tier (critical|warning|good|excellent based on score)
  - category_scores (compliance breakdown by SLI category)
  - gap_analysis (common pattern issues across SLOs)
  - na_categories (SLI categories not used in this org)
- Writes to DynamoDB `slo_org_summary`

**Output**: Org SLO audit summary available via `/api/slo/results`

---

## 6. MCP SERVERS & TOOL ARCHITECTURE

### Datadog MCP Server (HTTP, External)
**URL**: https://mcp.datadoghq.com/api/unstable/mcp-server/mcp (configurable per site)

**Authentication**: Headers (not OAuth)
- `DD-API-KEY`: Datadog API key
- `DD-APPLICATION-KEY`: Datadog app key
- `mcp-session-id`: Session token (from initialize response)

**Toolsets**:
- `core` toolset includes: hosts, metrics, logs, monitors, dashboards, incidents, services, events, notebooks, traces, spans, RUM

**Key Tools Used**:
- `search_datadog_hosts` - Query hosts by filter, returns tags/aliases/cloud metadata
- `get_datadog_metric` - Fetch metric time series (avg, p95, p99 aggregations)
- `search_datadog_monitors` - Query monitors by name/tag (though details pre-embedded in SLO batch)

**Note**: SLO tools NOT exposed via Datadog MCP — SLOs fetched directly via REST API

---

### Custom MCP Servers (SDK-based, In-Process)

**Pattern**: `createSdkMcpServer()` from Claude Agent SDK

#### 1. List-Hosts MCP (`list-hosts-server.ts`)
- **Tool**: `fetch_and_store_all_hosts_tool`
- **Purpose**: Fetch ALL hosts from DDSQL, paginate, persist

#### 2. Host-Batch MCP (`host-batch-server.ts`)
- **Tools**:
  1. `get_instance_specs_tool` - AWS catalog lookup
  2. `get_instance_on_demand_price_tool` - Pricing lookup
  3. `suggest_right_sized_instance_tool` - AWS right-sizing
  4. `suggest_universal_rightsizing_tool` - Cloud-agnostic recommendations
  5. `build_pricing_calculator_url_tool` - URL builder
  6. `write_host_result_tool` - DynamoDB persistence
  7. `update_run_progress_tool` - Progress tracking

#### 3. Summarize MCP (`summarize-server.ts`)
- **Tool**: `compute_and_write_org_summary_tool`
- **Purpose**: Aggregate host results → org summary

#### 4. SLO-List MCP (`slo-list-server.ts`)
- **Tool**: `fetch_and_store_all_slos_tool`
- **Purpose**: Fetch all SLOs + monitoring context

#### 5. SLO-Batch MCP (`slo-batch-server.ts`)
- **Tools**:
  1. `write_slo_result_tool` - DynamoDB persistence
  2. `update_slo_progress_tool` - Progress tracking

#### 6. SLO-Summarize MCP (`slo-summarize-server.ts`)
- **Tool**: `compute_and_write_slo_org_summary_tool`
- **Purpose**: Aggregate SLO audit results → org summary

---

## 7. DATA PERSISTENCE (DynamoDB)

### Tables

**`finops_runs`** (Host Analysis Runs)
- **PK**: run_id
- **SK**: "METADATA"
- **Fields**:
  - status: "running" | "completed" | "failed"
  - trigger_type: "scheduled" | "manual"
  - triggered_by: email
  - started_at: ISO timestamp
  - completed_at: ISO timestamp (null if running)
  - tenants_total, tenants_done: counters
  - hosts_total, hosts_done: counters
  - log: array of log messages (last 400)
  - okta_token: Okta access token
- **Indexes**:
  - status-started_at-index: for querying completed runs

**`finops_host_lists`** (Discovered Hosts)
- **PK**: tenant_id
- **SK**: run_id
- **Fields**:
  - hosts: array of { host_id, host_name, aliases? }
  - ttl: 7 days (for local cleanup)

**`finops_host_results`** (Per-Host Analysis Results)
- **PK**: tenant_id
- **SK**: `{host_id}#{run_id}`
- **Fields**:
  - run_id: for indexing
  - host_id: hostname
  - host_name: hostname
  - cloud_provider: aws|azure|gcp|on-prem|unknown
  - cpu_avg_30d, cpu_p95_30d, ram_avg_30d: percentages
  - network_in_avg_30d, network_out_avg_30d: bytes/sec
  - disk_avg_30d: percentage
  - instance_type, instance_region: spec identifiers
  - instance_cpu_count, instance_ram_gb: spec values
  - current_monthly_cost, suggested_monthly_cost, monthly_savings: USD
  - efficiency_label: over-provisioned|right-sized|under-provisioned|unknown
  - efficiency_score: 0-100
  - recommendation: full sentence (min 15 words)
  - analyzed_at: ISO timestamp
  - ttl: 90 days
- **Indexes**:
  - run_id-index: query by run_id

**`finops_org_summary`** (Per-Org Aggregated Results)
- **PK**: tenant_id
- **SK**: run_id
- **Fields**:
  - total_hosts, hosts_analyzed, efficiency distribution
  - total_monthly_spend, potential_savings, savings_percent
  - avg_cpu_utilization, avg_ram_utilization
  - top_offenders: array of host IDs with highest savings
  - completed_at: ISO timestamp
  - ttl: 90 days
- **Indexes**:
  - run_id-index: query by run_id

**`slo_runs`** (SLO Audit Runs)
- Similar structure to finops_runs
- Fields: slos_total, slos_done (instead of hosts_total/hosts_done)

**`slo_lists`** (Discovered SLOs)
- **PK**: tenant_id
- **SK**: run_id
- **Fields**:
  - slos: array of SLO objects (with embedded monitor_details)
  - monitoring_context: { apm_enabled, synthetics_enabled, infra_monitoring }

**`slo_results`** (Per-SLO Audit Results)
- **PK**: tenant_id
- **SK**: `{slo_id}#{run_id}`
- **Fields**:
  - slo_id, slo_name, slo_type
  - sli_category: availability|latency|error_rate|throughput|saturation|unclassified
  - formula_valid, formula_issue
  - context_compatible
  - validation_score: 0-100
  - validation_status: excellent|good|needs_improvement|poor|critical
  - blocker_issues, quality_issues, enhancements: arrays of strings
  - insight: specific finding
  - tags, target_percentage, time_windows
  - analyzed_at: ISO timestamp

**`slo_org_summary`** (Per-Org SLO Audit Summary)
- **PK**: tenant_id
- **SK**: run_id
- **Fields**:
  - total_slos, valid_slos, misconfigured_slos, unclassified_slos
  - compliance_score: weighted average validation score
  - compliance_tier: critical|warning|good|excellent
  - category_scores: { availability: 85, latency: 72, ... }
  - na_categories: categories not used
  - gap_analysis: array of common issues found
  - monitoring_context
  - completed_at: ISO timestamp

---

## 8. ORCHESTRATION & FLOW CONTROL

### Parallel Execution

All **tenants** run in parallel:
```javascript
await Promise.all(
  tenants.map(tenant => runOrgAnalysis(tenant.tenant_id, runId))
)
```

Within each tenant, **batches** run in **waves** (concurrent but staged):
```javascript
// 15-host batches, 30 concurrent per wave
for (let i = 0; i < batches.length; i += BATCH_CONCURRENCY) {
  const wave = batches.slice(i, i + BATCH_CONCURRENCY);
  await Promise.all(wave.map(batch => runHostBatchAgent(...)));
}
```

### Abort Mechanism

**File:** `packages/agent/src/tools/abort-registry.ts`

In-memory registry for abort signals:
```typescript
markAborted(runId)    // Signal abort
isAborted(runId)      // Check if aborted
clearAborted(runId)   // Clear after handling
```

Each agent checks `isAborted()` before starting and between waves. If aborted:
- Stop immediately
- Don't write partial results
- Mark run as "failed"

### Progress Tracking

Real-time progress updates to DynamoDB:
- Increment `hosts_done` / `slos_done` after each batch
- Append log messages (trimmed to last 400)
- Frontend polls `/api/status` to display progress

---

## 9. MULTI-TENANT CONFIGURATION

**File:** `packages/agent/src/config/tenants.ts`

Loads from `config/dd-org-registry.json`:
```json
[
  {
    "tenant_id": "PDI-Enterprise",
    "display_name": "PDI Enterprise",
    "dd_api_key": "...",
    "dd_app_key": "...",
    "dd_site": "datadoghq.com",
    "default_region": "us-east-1",
    "enabled": true
  }
]
```

Each tenant gets its own Datadog MCP server configured with tenant-specific API keys.

---

## 10. AGENT SDK PATTERNS

### Query Loop Pattern

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const msg of query({
  prompt: "Your task...",
  options: {
    systemPrompt: "You are...",
    permissionMode: "bypassPermissions",
    tools: [],
    maxTurns: 200,
    mcpServers: {
      "local-tools": localServer,
      "tenant-id": datadog_mcp_server,
    }
  }
})) {
  if (msg.type === "assistant") {
    // Agent response
  }
  if (msg.type === "result") {
    // Final result
  }
}
```

### MCP Server Creation Pattern

```typescript
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export function createMyServer() {
  return createSdkMcpServer({
    name: "my-tools",
    version: "1.0.0",
    tools: [
      tool(
        "my_tool_name",
        "Tool description",
        { param1: z.string(), param2: z.number() },
        async ({ param1, param2 }) => {
          const result = await doWork(param1, param2);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(result)
            }]
          };
        }
      ),
    ]
  });
}
```

---

## 11. ERROR HANDLING & SAFEGUARDS

### Run Completion Guards

**Zero-host protection** (orchestrator.ts):
```typescript
if (hostsDone === 0) {
  console.error("Run produced 0 hosts — marking failed to protect last good report");
  await updateRunStatus(runId, "failed", ...);
}
```

**Stale run auto-reset** (api.ts):
```typescript
if (ageMs > 4 * 60 * 60 * 1000) { // 4 hours
  await updateRunStatus(runId, "failed", ...);
  console.log("Auto-reset stale run");
}
```

### Result Validation

**Path 3 enforcement** (host-batch-server.ts):
```typescript
if (cloud_provider === "aws" && hasInstanceType && hasNoMetrics && !current_monthly_cost) {
  return { error: "PATH 3 VIOLATION: AWS host with instance_type but no metrics requires current_monthly_cost" };
}
```

**Efficiency label recomputation** (host-batch-server.ts):
```typescript
// Never trust agent-provided label; always recompute from metrics
if ((cpu_for_label ?? 0) > 80 || (ram ?? 0) > 85) {
  efficiency_label = "under-provisioned";
}
```

**Metric recovery from text** (host-batch-server.ts):
```typescript
// If agent passed null for cpu_avg_30d but recommendation contains "CPU averaged X%", recover it
const recCpuMatch = recommendation.match(/CPU averaged ([\d.]+)%/i);
const cpu_avg_final = cpu_avg ?? (recCpuMatch ? parseFloat(recCpuMatch[1]) : null);
```

---

## 12. KEY PERFORMANCE INSIGHTS

### Batching Strategy
- **15 hosts per batch**: ~195 turns at ~13 turns/host average = just under maxTurns:200 limit
- **30 concurrent batches**: maximize throughput while staying within API limits
- **Waves**: prevent thundering herd, allow progress tracking

### Tool Call Optimization
- **Parallel T1 metric queries**: all system.* queries issued at once (no waiting)
- **T2 fallback only for null fields**: skip cloud API calls if T1 succeeded
- **Pre-fetched monitor details in SLO objects**: agent never calls search_datadog_monitors

### Cost Optimization
- **TTL cleanup**: host_lists (7 days), results (90 days) auto-expire in DynamoDB
- **Single DynamoDB read for org summary**: no pagination needed for most orgs
- **Last 10 completed runs check**: prevent zero-host runs from overwriting good reports

---

## 13. CONFIGURATION & DEPLOYMENT

### Environment Variables (`.env.local`)
- `DYNAMODB_ENDPOINT`: Local DynamoDB or AWS
- `AWS_REGION`: DynamoDB region
- `AGENT_SERVER_PORT`: Express server port (default 8005)
- `DD_API_KEY_*`: Tenant-specific Datadog API keys
- `OKTA_ISSUER`, `OKTA_CLIENT_ID`: Okta authentication

### Startup
```bash
# Create DynamoDB tables (idempotent)
await createTables();

# Listen for API requests
app.listen(8005);
```

### Frontend Integration
**File:** `packages/frontend/src/services/api.ts`

- **Polling pattern**: Poll `/api/status` every 2-5 seconds during run
- **Results endpoint**: `/api/results` returns paginated results after completion
- **Abort handler**: POST `/api/abort` to stop running analysis

---

## Summary: Key Architectural Principles

1. **Fully Agentic**: Every analysis step uses Claude agents with MCP tools
2. **SDK-First**: Uses Claude Agent SDK for orchestration (not direct Claude API)
3. **MCP-Centric**: Combines Datadog's official HTTP MCP + custom in-process MCP servers
4. **Parallel by Default**: Tenants, batches, and waves all run concurrently
5. **Evidence-Based**: System prompts enforce no hallucination (evidence-first reasoning)
6. **Deterministic Tools**: All tool outcomes validated/normalized server-side
7. **Fire-and-Forget REST**: API returns 202 Accepted, agents run async in background
8. **DynamoDB Persistence**: All results and progress tracked in DynamoDB with TTL cleanup
9. **No Mocks**: All data from real Datadog APIs or authentic calculations
10. **Recovery & Safety**: Guards against zero-result runs, stale runs, and inverted formulas

