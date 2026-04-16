# PDI FinOps Intelligence Agent - Architecture and Design

> Primary architecture reference for the PDI FinOps Intelligence Agent application.
> Last updated: 2026-03-26

---

## Table of Contents

1. [Application Overview](#1-application-overview)
2. [Architecture Overview](#2-architecture-overview)
3. [Agent Architecture and Orchestration Patterns](#3-agent-architecture-and-orchestration-patterns)
4. [Data Flow: End-to-End Example](#4-data-flow-end-to-end-example)
5. [MCP Integration Design](#5-mcp-integration-design)
6. [Database Design and Why DynamoDB](#6-database-design-and-why-dynamodb)
7. [Authentication Architecture](#7-authentication-architecture)
8. [Frontend Architecture](#8-frontend-architecture)
9. [Design Decisions and Trade-offs](#9-design-decisions-and-trade-offs)
10. [Implementation Status](#10-implementation-status)
11. [Deployment Architecture](#11-deployment-architecture)
12. [Tech Stack Reference](#12-tech-stack-reference)

---

## 1. Application Overview

### Purpose

The PDI FinOps Intelligence Agent is an AI-powered infrastructure cost analysis platform that operates across multiple Datadog organizations. It performs two primary functions:

1. **Infrastructure Right-Sizing Analysis** - Analyzes every host in each Datadog organization for CPU, RAM, network, and disk utilization over a rolling 30-day window. Produces per-host right-sizing recommendations with AWS cost comparisons and monthly savings estimates.

2. **SLO Compliance Auditing** - Validates all Service Level Objectives (SLOs) across Datadog organizations for formula correctness, monitoring context, description quality, and produces a weighted compliance score per organization.

### What Makes It Different

This is a **fully agentic application** - every functional operation runs through Claude Agent SDK agents. There are no hardcoded analysis rules in application code. Instead, Claude agents receive detailed system prompts with analysis procedures, use MCP-connected tools to query Datadog and AWS, and write structured results to DynamoDB. The application code is pure orchestration: spawning agents, wiring MCP servers, and serving results via REST API.

### Monorepo Structure

```
FinOps_Agent/
+-- packages/
|   +-- agent/                          # Backend: TypeScript Express server + Claude agents
|   |   +-- src/
|   |   |   +-- agents/                 # Agent definitions (system prompts + orchestration)
|   |   |   +-- mcp-servers/            # Custom MCP tool servers (in-process)
|   |   |   +-- tools/                  # Shared utilities (DynamoDB client, AWS SDK, abort)
|   |   |   +-- routes/                 # Express API route handlers
|   |   |   +-- middleware/             # Okta JWT authentication middleware
|   |   |   +-- config/                 # Tenant registry, MCP server registry
|   |   |   +-- db/                     # DynamoDB table setup
|   |   |   +-- server.ts              # Express application entry point
|   |   +-- config/
|   |       +-- dd-org-registry.json   # Datadog organization credentials
|   +-- frontend/                       # React single-page application
|       +-- src/
|           +-- pages/                  # Route-level page components
|           +-- components/             # Reusable UI components
|           +-- services/               # API client (axios)
|           +-- contexts/               # React Context providers (Auth)
|           +-- App.tsx                 # Router + Okta Security wrapper
+-- infra/                              # SST infrastructure-as-code (stub)
+-- docs/                               # Project documentation
+-- playwright/                         # End-to-end test specs
+-- sst.config.ts                       # SST entry point
+-- playwright.config.ts                # Playwright configuration
```

---

## 2. Architecture Overview

### High-Level System Diagram

```
+-------------------+         +-------------------------------------------+
|                   |  HTTPS  |          Express Server (Port 8005)       |
|  React Frontend   +-------->+  Bearer <okta-token>                     |
|  (Port 3000 dev)  |         |                                          |
|  (CloudFront prod)|         |  +-------------------------------------+ |
|                   |         |  |  REST API Layer                     | |
+-------------------+         |  |  /api/trigger, /api/status,         | |
                              |  |  /api/results, /api/active-run,     | |
                              |  |  /api/abort                         | |
                              |  |  /api/slo/trigger, /api/slo/status, | |
                              |  |  /api/slo/results, /api/slo/abort   | |
                              |  +------------------+------------------+ |
                              |                     |                    |
                              |  +------------------v------------------+ |
                              |  |       Orchestrator Agent            | |
                              |  |  (spawns per-tenant pipelines       | |
                              |  |   in parallel via Promise.all)      | |
                              |  +--+-----------------------------+--+ | |
                              |     |                             |     | |
                              |  +--v-----------+  +-----------v--+    | |
                              |  | PDI-Enterprise|  |  PDI-Orbis   |   | |
                              |  | Org Pipeline  |  | Org Pipeline |   | |
                              |  +--+-----------++  ++-----------+-+   | |
                              |     |            |   |           |     | |
                              +-----+------------+---+-----------+-----+
                                    |            |   |           |
                              +-----v----+ +----v---v--+ +------v----+
                              | Datadog  | | DynamoDB   | |  AWS      |
                              | MCP      | | (7 tables) | |  Pricing  |
                              | (HTTP)   | |            | |  API      |
                              +----------+ +------------+ +-----------+
```

### Request Flow Summary

1. **User triggers analysis** via React UI (or scheduled EventBridge event)
2. **Express API** validates Okta JWT, creates a run record in DynamoDB, returns `202 Accepted`
3. **Orchestrator** spawns per-tenant analysis pipelines in parallel
4. **Each pipeline** runs four phases: List Hosts -> Metric Pre-Fetch -> Batch Analyze -> Summarize
5. **Metric pre-fetch** fetches all 23 metrics for all hosts org-wide (wildcard or chunked), stores in `finops_metric_cache`
6. **Batch agents** read pre-fetched metrics from cache, call AWS tools for pricing, write results to DynamoDB
7. **Frontend** polls `/api/status` for progress, then fetches `/api/results` when complete

---

## 3. Agent Architecture and Orchestration Patterns

### Agent Hierarchy

```
Orchestrator (TypeScript function, not an SDK agent)
|
+-- runOrgAnalysis("PDI-Enterprise", runId)      [Promise.all - parallel]
|   |
|   +-- Phase 1: List-Hosts Agent                [Claude SDK agent, maxTurns: 10]
|   |     Tool: fetch_and_store_all_hosts_tool
|   |
|   +-- Phase 1.5: Metric Pre-Fetch              [TypeScript function, not an SDK agent]
|   |     Fetches all 23 metrics for all hosts org-wide before batches start
|   |     Stores results in DynamoDB finops_metric_cache
|   |
|   +-- Phase 2: Host Batch Agents               [Claude SDK agents, maxTurns: 500 each]
|   |     15 hosts per batch, 30 concurrent batches per wave
|   |     Tools: Datadog MCP + 8 custom tools (incl. get_prefetched_metrics_tool)
|   |
|   +-- Phase 3: Summarize Agent                  [Claude SDK agent, maxTurns: 15]
|         Tool: compute_and_write_org_summary_tool
|
+-- runOrgAnalysis("PDI-Orbis", runId)            [Promise.all - parallel]
    |
    +-- (same 3-phase pipeline)
```

### 3.1 Orchestrator (orchestrator.ts)

The orchestrator is a TypeScript function, not a Claude agent. It coordinates the entire analysis run.

**Responsibilities:**
- Reads enabled tenants from `dd-org-registry.json`
- Spawns `runOrgAnalysis()` for each tenant using `Promise.all()` (parallel execution)
- Validates that `hosts_done > 0` before marking a run as "completed" (zero-host guard)
- Handles abort signals - checks `isAborted(runId)` after all tenants complete
- Sets final run status in DynamoDB: "completed" or "failed"

**Zero-Host Guard:** If all tenants produce zero hosts (indicating credential failures, API errors, or empty orgs), the orchestrator marks the run as "failed" rather than "completed". This prevents an empty run from overwriting the last valid report in the UI.

### 3.2 Organization Analysis Pipeline (org-agent.ts)

A TypeScript orchestration wrapper, not a single agent. Executes three phases sequentially per tenant.

```
Phase 1: List Hosts
    |
    v
Phase 1.5: Metric Pre-Fetch (org-wide, before any batch agent runs)
    |
    v
Phase 2: Batch Processing (waves of 30 concurrent batch agents)
    |
    v
Phase 3: Summarize
```

**Batching Strategy:**
- `BATCH_SIZE = 15` - Each batch agent analyzes 15 hosts
- `BATCH_CONCURRENCY = 30` - Up to 30 batch agents run in parallel per wave
- Hosts are split into batches, then batches are grouped into waves
- Each wave completes before the next wave starts
- Abort checks occur between each wave

**Example:** 450 hosts -> 30 batches -> 1 wave of 30 batches (all parallel)
**Example:** 900 hosts -> 60 batches -> 2 waves (30 batches each, sequential waves)

### 3.3 List-Hosts Agent (list-hosts-agent.ts)

A single-turn Claude SDK agent that discovers all hosts in a Datadog organization.

| Property | Value |
|----------|-------|
| maxTurns | 10 |
| MCP Servers | Datadog MCP (per-tenant), list-hosts-tools (custom) |
| Tool | `fetch_and_store_all_hosts_tool` |
| Output | Host list written to `finops_host_lists` table |

The tool handles pagination internally, fetching all hosts from Datadog and storing them as a single array in DynamoDB. It also updates the `hosts_total` counter on the run record.

### 3.4 Host Batch Agent (host-batch-agent.ts) - Primary Analysis Engine

The most complex agent in the system. Each batch agent receives 15 hosts and executes a detailed 5-step analysis for each one.

| Property | Value |
|----------|-------|
| maxTurns | 500 |
| System Prompt | ~72 KB of detailed analysis procedures |
| MCP Servers | Datadog MCP (per-tenant), host-batch-tools (custom, 8 tools) |
| Concurrency | Up to 30 batch agents run simultaneously per wave |

#### Step A: Host Classification (Evidence-First)

The agent classifies each host's cloud provider using an ordered evidence chain. This is the most nuanced part of the system.

**Classification Priority Order:**

| Priority | Evidence Source | Result |
|----------|---------------|--------|
| 1 | Alias matches `i-[0-9a-f]{8,17}` | aws (EC2) |
| 2 | App: "ecs" or "fargate" | aws (ECS/Fargate) |
| 3 | App: "vsphere" or "vmware" | on-prem (positive evidence) |
| 4 | Instance-type tag: AWS format (t2/t3/m5/c5/r5...) | aws |
| 5 | Instance-type tag: Azure format (Standard_*) | azure |
| 6 | Instance-type tag: GCP format (n1-/n2-/e2-...) | gcp |
| 7 | Region/AZ tag: AWS regions | aws |
| 8 | Region tag: Azure regions | azure |
| 9 | Region tag: GCP regions | gcp |
| 10 | Explicit cloud_provider/subscriptionid/project_id tag | Respective cloud |
| 11 | aws_account tag | aws |
| 12 | T2 probe: `vsphere.cpu.usage.avg` returns data | on-prem (positive evidence) |
| 13 | T2 probe: aws/azure/gcp metric returns data | Respective cloud |
| 14 | All T2 probes return nothing | **unknown** (NOT on-prem) |

**Critical Design Rule:** The absence of cloud tags does NOT mean on-prem. A host with only `system.*` metrics could be EC2 with a directly installed agent (no AWS account integration), an ECS task, an EKS node, or actual on-prem. Only **positive evidence** (vsphere app tag or vsphere T2 metric data) can set a host to "on-prem". Everything else without evidence is "unknown".

**T2 Metric Probes:** When no tags identify the cloud provider, the agent runs cloud-specific CPU metric queries in order:
1. `aws.ec2.cpuutilization` - If data returns, host is AWS
2. `azure.vm.percentage_cpu` - If data returns, host is Azure
3. `gcp.gce.instance.cpu.utilization` - If data returns, host is GCP
4. `vsphere.cpu.usage.avg` - If data returns, host is on-prem

The agent stops at the first probe that returns data. The returned CPU value is reused in Step B to avoid duplicate queries.

#### Step B: Metrics Collection (Pre-Fetch Cache Lookup)

All metrics are read from the pre-fetched cache via `get_prefetched_metrics_tool`. No per-host Datadog metric queries are made. The tool returns all T1 and T2 values for the host in a single call.

**T1 — Datadog Agent (`system.*` namespace):**

| Cache Key | Maps To | Computation |
|-----------|---------|-------------|
| `system.cpu.idle` | `cpu_avg_30d` | `100 - value` (idle % → used %) |
| `system.cpu.idle.p95` | `cpu_p95_30d` | `100 - value` (rollup p95 of hourly buckets) |
| `system.mem.pct_usable` | `ram_avg_30d` | `100 - value` (pct_usable is 0–100%) |
| `system.disk.in_use` | `disk_avg_30d` | `value × 100` (fraction 0–1 → %) |
| `system.net.bytes_rcvd` | `network_in_avg_30d` | bytes/sec direct |
| `system.net.bytes_sent` | `network_out_avg_30d` | bytes/sec direct |

**T2 — Cloud integration fallback (only for metrics still null after T1):**

| Cloud | CPU | RAM | Network | Disk |
|-------|-----|-----|---------|------|
| AWS | `aws.ec2.cpuutilization` | N/A (CloudWatch limitation) | `aws.ec2.network_in/out` | N/A (EBS limitation) |
| Azure | `azure.vm.percentage_cpu` | `azure.vm.available_memory_bytes` (needs instance_ram_gb) | `azure.vm.network_in/out_total` | N/A |
| GCP | `gcp.gce.instance.cpu.utilization` (x100) | `gcp.gce.instance.memory.balloon.ram_used` (needs instance_ram_gb) | `gcp.gce.instance.network.*` | N/A |
| VMware | `vsphere.cpu.usage.avg` | `vsphere.mem.usage.average` | `vsphere.net.received/transmitted.avg` (KBps × 1024 → bytes/sec) | N/A (`vsphere.disk.usage.avg` is I/O throughput in KBps, not disk space %) |

#### Step C: Instance Specs

If an `instance_type` was found in Step A, the agent calls `get_instance_specs_tool(instance_type, region)` to retrieve:
- `vcpu` -> `instance_cpu_count`
- `ram_gb` -> `instance_ram_gb`

For AWS instances with no region tag, `us-east-1` is passed as a tool argument but NOT stored as `instance_region`.

#### Step D: Right-Sizing Recommendation

Five decision paths based on available data:

```
                          +-------------------+
                          | instance_type     |
                          | known?            |
                          +--------+----------+
                                   |
                    +--------------+--------------+
                    | YES                         | NO
                    v                             v
          +-----------------+           +------------------+
          | CPU + RAM       |           | Any metrics?     |
          | available?      |           +--------+---------+
          +---+--------+----+                    |
              |        |                   +-----+-----+
         YES  |        | NO               YES         NO
              v        v                   v           v
          PATH 1   +-------+           PATH 4      PATH 5
          (Full    | CPU   |           (Universal   (No data
          catalog  | only? |           rightsizing)  available)
          match)   +--+----+
                      |
                 +----+----+
                YES       NO
                 v         v
              PATH 2    PATH 3
              (CPU only, (No metrics,
              no RAM     get pricing
              assumption) only)
```

| Path | Condition | Tool Called | Output |
|------|-----------|------------|--------|
| PATH 1 | AWS + cpu + ram | `suggest_right_sized_instance_tool` | Full recommendation with cost comparison |
| PATH 2 | AWS + cpu only | `suggest_universal_rightsizing_tool` (ram=null) + `get_instance_on_demand_price_tool` | Recommendation with RAM caveat |
| PATH 3 | AWS + no metrics | `get_instance_on_demand_price_tool` | Current cost only, install agent recommendation |
| PATH 4 | Non-AWS or no instance type + metrics | `suggest_universal_rightsizing_tool` | Heuristic recommendation |
| PATH 5 | No metrics at all | None | Generic "no data" recommendation |

#### Step E: Write Result

Every host gets a result written to DynamoDB, regardless of how much data was collected. The `write_host_result_tool` receives:

1. `host_id` - The host name
2. `result_json` - Complete result object with all 20+ fields
3. `dd_host_metadata` - Raw Datadog host metadata from Step A (used for server-side validation)

**Efficiency Scoring:**
- `efficiency_score = round((cpu_avg_30d + ram_avg_30d) / 2)` (0-100 scale)
- `efficiency_label` determination:
  - `cpu_p95 > 80%` OR `ram_avg > 85%` OR `disk_avg > 85%` -> "under-provisioned"
  - `cpu_p95 < 20%` AND `ram_avg < 40%` -> "over-provisioned"
  - Any metric data, otherwise -> "right-sized"
  - All metrics null -> "unknown"

### 3.5 Summarize Agent (summarize-agent.ts)

Single-directive agent that calls `compute_and_write_org_summary_tool` once.

| Property | Value |
|----------|-------|
| maxTurns | 15 |
| Tool | `compute_and_write_org_summary_tool` |
| Input | All host results for the org from DynamoDB |
| Output | Org-level summary written to `finops_org_summary` |

Computes: total hosts, categorized counts (over/right-sized/under-provisioned), total monthly spend, potential savings, average utilization, top 5 offenders by savings.

### 3.6 SLO Audit Agents

The SLO audit system follows the same three-phase pattern as infrastructure analysis.

#### SLO Orchestrator (slo-orchestrator.ts)
- Spawns `runSloOrgAnalysis()` per tenant in parallel

#### SLO Organization Analysis (slo-org-agent.ts)
Three phases:
1. **SLO List Agent** - Fetches all SLOs plus monitoring context (APM enabled? Synthetics enabled?)
2. **Batch Processing** - 20 SLOs per batch, 10 concurrent batches per wave
3. **SLO Summarize Agent** - Aggregates validation results

#### SLO Batch Agent (slo-batch-agent.ts)

7-step validation per SLO:

| Step | Action |
|------|--------|
| 1. Classification | Categorize: "availability", "latency", "error_rate", "throughput", "saturation", "unclassified" |
| 2. Formula Validation | Numerator/denominator sanity check, inverted formula detection |
| 3. Monitoring Context | Latency SLO requires APM OR Synthetics enabled |
| 4. Description Quality | Empty = -5 pts, contradicts implementation = -15 pts |
| 5. Scoring | Start at 100; Blockers: -40 each; Quality: -15 each; Enhancements: -5 each |
| 6. Insight | One specific, actionable finding |
| 7. Write Result | `write_slo_result_tool` |

#### SLO Summarize Agent (slo-summarize-agent.ts)
- `compliance_score` - Weighted average of category scores
- `compliance_tier` - "excellent" / "good" / "needs_improvement" / "critical"
- Gap analysis: Coverage gaps, formula issues, missing monitoring

---

## 4. Data Flow: End-to-End Example

This traces a complete infrastructure analysis run from trigger to result display.

### Step 1: User Triggers Run

```
Browser                        Express Server                    DynamoDB
  |                                |                                |
  |-- POST /api/trigger ---------->|                                |
  |   Authorization: Bearer <jwt>  |                                |
  |                                |-- Validate JWT (Okta JWKS) --->|
  |                                |                                |
  |                                |-- Check active run ----------->|
  |                                |   Query finops_runs            |
  |                                |   GSI: status="running"        |
  |                                |                                |
  |                                |-- Create run record ---------->|
  |                                |   run_id: "run_2026-03-25..."  |
  |                                |   status: "running"            |
  |                                |                                |
  |<-- 202 { run_id, status } ----|                                |
  |                                |                                |
  |                                |-- Fire & forget: ------------->|
  |                                |   runOrchestrator(runId)       |
```

### Step 2: Orchestrator Fans Out

```
Orchestrator
  |
  +-- Promise.all([
  |     runOrgAnalysis("PDI-Enterprise", runId),
  |     runOrgAnalysis("PDI-Orbis", runId)
  |   ])
```

### Step 3: Per-Tenant Pipeline (PDI-Enterprise)

```
Phase 1: List Hosts
  |
  | List-Hosts Agent -> Datadog MCP: search_datadog_hosts
  | -> fetch_and_store_all_hosts_tool: writes 300 hosts to finops_host_lists
  | -> Updates finops_runs.hosts_total = 300
  |
Phase 2: Batch Processing
  |
  | 300 hosts / 15 per batch = 20 batches
  | Wave 1: batches 0-19 (20 batches, all parallel, within BATCH_CONCURRENCY=30)
  |
  | Each batch agent (example: batch 0, hosts 0-14):
  |   For each host:
  |     Step A: search_datadog_hosts -> classify cloud provider
  |     Step B: get_datadog_metric (T1 pass) -> get_datadog_metric (T2 fallback)
  |     Step C: get_instance_specs_tool (if instance_type found)
  |     Step D: suggest_right_sized_instance_tool OR suggest_universal_rightsizing_tool
  |     Step E: write_host_result_tool -> finops_host_results
  |   After all 15 hosts: update_run_progress_tool (hosts_done += 15)
  |
Phase 3: Summarize
  |
  | Summarize Agent -> compute_and_write_org_summary_tool
  | -> Reads all 300 host results from finops_host_results
  | -> Computes aggregates, writes to finops_org_summary
```

### Step 4: Frontend Polls and Displays

```
Browser                        Express Server                    DynamoDB
  |                                |                                |
  |-- GET /api/status?run_id= --->|                                |
  |                                |-- Get run record ------------->|
  |<-- { progress_pct: 45%,       |                                |
  |      hosts_done: 135,         |                                |
  |      hosts_total: 300 } ------|                                |
  |                                |                                |
  | ... (polls every 2-3 seconds) |                                |
  |                                |                                |
  |-- GET /api/results?run_id= -->|                                |
  |                                |-- Get org summaries ---------->|
  |                                |-- Get all host results ------->|
  |                                |-- Recompute org summaries      |
  |                                |   from host results            |
  |<-- { org_summaries: [...],    |                                |
  |      host_results: [...] } ---|                                |
```

**Note:** The `/api/results` endpoint recomputes org summaries from the full host results rather than returning stored summaries. This guarantees the summary numbers always match the host table exactly, even if the stored summaries were written before pagination fixes were applied.

---

## 5. MCP Integration Design

### 5.1 Datadog MCP (External, HTTP)

Each Datadog organization gets its own HTTP MCP server connection. The registry maps `dd_site` values to regional MCP endpoints.

```
Tenant Registry (dd-org-registry.json)
  |
  +-- PDI-Enterprise
  |     dd_site: "datadoghq.com"
  |     -> https://mcp.datadoghq.com/api/unstable/mcp-server/mcp?toolsets=core
  |     Headers: DD_API_KEY, DD_APPLICATION_KEY
  |
  +-- PDI-Orbis
        dd_site: "datadoghq.com"
        -> https://mcp.datadoghq.com/api/unstable/mcp-server/mcp?toolsets=core
        Headers: DD_API_KEY, DD_APPLICATION_KEY
```

**Supported Datadog Sites:**

| Site | MCP Endpoint |
|------|-------------|
| datadoghq.com | `https://mcp.datadoghq.com/api/unstable/mcp-server/mcp` |
| datadoghq.eu | `https://mcp.datadoghq.eu/api/unstable/mcp-server/mcp` |
| us3.datadoghq.com | `https://mcp.us3.datadoghq.com/api/unstable/mcp-server/mcp` |
| us5.datadoghq.com | `https://mcp.us5.datadoghq.com/api/unstable/mcp-server/mcp` |
| ap1.datadoghq.com | `https://mcp.ap1.datadoghq.com/api/unstable/mcp-server/mcp` |

The `?toolsets=core` parameter selects the core toolset which includes: hosts, metrics, logs, monitors, dashboards, incidents, services, events, notebooks, traces, spans, and RUM.

**Key Datadog MCP tools used by agents:**
- `search_datadog_hosts` - Host discovery and metadata
- `get_datadog_metric` - Time-series metric queries with from/to timestamps
- `search_datadog_monitors` - Monitor/SLO context
- `get_datadog_slo` - SLO definition retrieval

### 5.2 Custom MCP Servers (In-Process, SDK-based)

Six custom MCP servers provide 15 specialized tools. These are in-process servers created using the Claude Agent SDK's MCP server primitives - no separate process or network hop.

```
+-----------------------------------------------------------+
| Custom MCP Servers (6 servers, 15 tools)                  |
+-----------------------------------------------------------+
|                                                           |
| list-hosts-server.ts                                      |
|   +-- fetch_and_store_all_hosts_tool                      |
|                                                           |
| host-batch-server.ts                                      |
|   +-- get_prefetched_metrics_tool    (DynamoDB cache read)|
|   +-- get_instance_specs_tool          (AWS EC2 catalog)  |
|   +-- get_instance_on_demand_price_tool (AWS Pricing API) |
|   +-- suggest_right_sized_instance_tool (AWS rightsizing)  |
|   +-- suggest_universal_rightsizing_tool (heuristic)       |
|   +-- build_pricing_calculator_url_tool (URL builder)     |
|   +-- write_host_result_tool           (DynamoDB write)   |
|   +-- update_run_progress_tool         (progress counter) |
|                                                           |
| summarize-server.ts                                       |
|   +-- compute_and_write_org_summary_tool                  |
|                                                           |
| slo-list-server.ts                                        |
|   +-- fetch_and_store_all_slos_tool                       |
|                                                           |
| slo-batch-server.ts                                       |
|   +-- write_slo_result_tool                               |
|   +-- update_slo_progress_tool                            |
|                                                           |
| slo-summarize-server.ts                                   |
|   +-- compute_and_write_slo_summary_tool                  |
+-----------------------------------------------------------+
```

### 5.3 MCP Server Wiring Per Agent

Each agent type gets a specific combination of MCP servers:

| Agent | Datadog MCP | Custom MCP Server |
|-------|-------------|-------------------|
| List-Hosts Agent | Yes (per-tenant) | list-hosts-tools |
| Host Batch Agent | Yes (per-tenant) | host-batch-tools |
| Summarize Agent | No | summarize-tools |
| SLO List Agent | Yes (per-tenant) | slo-list-tools |
| SLO Batch Agent | Yes (per-tenant) | slo-batch-tools |
| SLO Summarize Agent | No | slo-summarize-tools |

The custom MCP servers are instantiated per-agent-invocation with context (tenantId, runId, batchIndex, etc.) baked in. This means the agent doesn't need to pass tenantId on every tool call - it's captured in the closure.

---

## 6. Database Design and Why DynamoDB

### 6.1 Table Overview

```
+---------------------+     +---------------------+     +---------------------+
| finops_runs         |     | finops_host_lists   |     | finops_host_results |
| PK: run_id          |     | PK: tenant_id       |     | PK: tenant_id       |
| SK: "METADATA"      |     | SK: run_id          |     | SK: {host_id}#{run} |
| GSI: status-started |     |                     |     | GSI: run_id-index   |
| TTL: yes            |     | TTL: 7 days         |     | TTL: 90 days        |
+---------------------+     +---------------------+     +---------------------+

+---------------------+     +---------------------+     +---------------------+
| finops_org_summary  |     | finops_slo_runs     |     | finops_slo_results  |
| PK: tenant_id       |     | PK: run_id          |     | PK: tenant_id       |
| SK: run_id          |     | SK: "METADATA"      |     | SK: {slo_id}#{run}  |
| GSI: run_id-index   |     | GSI: status-started |     | GSI: run_id-index   |
+---------------------+     +---------------------+     +---------------------+

+---------------------+
| finops_metric_cache |
| PK: tenant_id       |
| SK: {run_id}#{metric}|
| TTL: 7 days         |
+---------------------+
```

### 6.2 Table Schemas

#### finops_runs

Tracks infrastructure analysis run lifecycle.

| Attribute | Type | Key | Description |
|-----------|------|-----|-------------|
| run_id | String | HASH | Format: `run_2026-03-25T12:00:00Z` |
| sk | String | RANGE | Always `"METADATA"` |
| status | String | GSI HASH | `"running"` / `"completed"` / `"failed"` |
| started_at | String | GSI RANGE | ISO 8601 timestamp |
| trigger_type | String | - | `"manual"` / `"scheduled"` |
| triggered_by | String | - | User email or `"scheduler"` |
| completed_at | String | - | ISO 8601 timestamp |
| tenants_total | Number | - | Count of enabled tenants |
| tenants_done | Number | - | Completed tenant count |
| hosts_total | Number | - | Total hosts discovered |
| hosts_done | Number | - | Hosts analyzed so far |
| log | List | - | Last 400 log entries |
| ttl | Number | - | DynamoDB TTL epoch |

**GSI: `status-started_at-index`** - Enables querying for active runs (`status = "running"`) and latest completed runs, ordered by start time.

#### finops_host_lists

Ephemeral host discovery results per tenant per run.

| Attribute | Type | Key | Description |
|-----------|------|-----|-------------|
| tenant_id | String | HASH | e.g., `"PDI-Enterprise"` |
| run_id | String | RANGE | Run identifier |
| hosts | List | - | Array of `{host_id, host_name, aliases}` |
| ttl | Number | - | 7-day expiration |

#### finops_host_results

Per-host analysis results - the primary data table.

| Attribute | Type | Key | Description |
|-----------|------|-----|-------------|
| tenant_id | String | HASH | Tenant identifier |
| sk | String | RANGE | Format: `{host_id}#{run_id}` |
| run_id | String | GSI HASH | Run identifier |
| host_id | String | - | Host name |
| cloud_provider | String | - | `"aws"` / `"azure"` / `"gcp"` / `"on-prem"` / `"unknown"` |
| cpu_avg_30d | Number | - | 0-100 percentage or null |
| cpu_p95_30d | Number | - | 0-100 percentage or null |
| ram_avg_30d | Number | - | 0-100 percentage or null |
| network_in_avg_30d | Number | - | Bytes/sec or null |
| network_out_avg_30d | Number | - | Bytes/sec or null |
| disk_avg_30d | Number | - | 0-100 percentage or null |
| instance_type | String | - | e.g., `"m5.large"` or null |
| instance_region | String | - | e.g., `"us-east-1"` or null |
| instance_cpu_count | Number | - | vCPU count or null |
| instance_ram_gb | Number | - | RAM in GB or null |
| has_instance_tag | Boolean | - | Whether instance-type tag exists |
| catalog_data_available | Boolean | - | Whether AWS catalog lookup succeeded |
| current_monthly_cost | Number | - | USD or null |
| suggested_instance | String | - | Recommended instance type or null |
| suggested_monthly_cost | Number | - | USD or null |
| monthly_savings | Number | - | USD or null |
| savings_percent | Number | - | 0-100 or null |
| pricing_calc_url | String | - | AWS Pricing Calculator URL or null |
| efficiency_score | Number | - | 0-100 composite score |
| efficiency_label | String | - | `"over-provisioned"` / `"right-sized"` / `"under-provisioned"` / `"unknown"` |
| recommendation | String | - | Complete sentence, minimum 15 words |
| dd_host_metadata | Map | - | Raw Datadog host response |
| ttl | Number | - | 90-day expiration |

**GSI: `run_id-index`** - Enables fetching all host results for a given run across all tenants.

#### finops_org_summary

Aggregated org-level statistics per tenant per run.

| Attribute | Type | Key | Description |
|-----------|------|-----|-------------|
| tenant_id | String | HASH | Tenant identifier |
| run_id | String | RANGE / GSI HASH | Run identifier |
| total_hosts | Number | - | Total hosts in org |
| hosts_analyzed | Number | - | Hosts with known efficiency |
| hosts_over_provisioned | Number | - | Count |
| hosts_right_sized | Number | - | Count |
| hosts_under_provisioned | Number | - | Count |
| hosts_no_tag | Number | - | Hosts missing instance-type tag |
| total_monthly_spend | Number | - | Aggregate USD |
| potential_savings | Number | - | Aggregate potential savings USD |
| savings_percent | Number | - | Savings as percentage of spend |
| avg_cpu_utilization | Number | - | Org-wide average |
| avg_ram_utilization | Number | - | Org-wide average |
| top_offenders | List | - | Top 5 host IDs by savings |
| completed_at | String | - | ISO 8601 timestamp |

#### finops_slo_runs

Same schema as `finops_runs` but with `slos_total` and `slos_done` instead of `hosts_total` and `hosts_done`.

#### finops_slo_results

| Attribute | Type | Key | Description |
|-----------|------|-----|-------------|
| tenant_id | String | HASH | Tenant identifier |
| sk | String | RANGE | Format: `{slo_id}#{run_id}` |
| run_id | String | GSI HASH | Run identifier |
| slo_name | String | - | SLO display name |
| slo_type | String | - | Datadog SLO type |
| sli_category | String | - | Classification category |
| formula_valid | Boolean | - | Formula sanity check result |
| formula_issue | String | - | Description of formula issue or null |
| context_compatible | Boolean | - | Monitoring context check |
| validation_score | Number | - | 0-100 quality score |
| validation_status | String | - | Status label |
| blocker_issues | List | - | Critical issues (-40 pts each) |
| quality_issues | List | - | Quality issues (-15 pts each) |
| enhancements | List | - | Enhancement suggestions (-5 pts each) |
| insight | String | - | Single actionable finding |
| tags | List | - | SLO tags from Datadog |
| target_percentage | Number | - | SLO target |
| time_windows | List | - | SLO time windows |
| analyzed_at | String | - | ISO 8601 timestamp |

### 6.3 Why DynamoDB

| Reason | Explanation |
|--------|-------------|
| **DynamoDB as Message Bus** | Agents write results to DynamoDB; TypeScript wrappers read them back. This decouples agents from each other - a batch agent doesn't need to know about the summarize agent. |
| **Schema Flexibility** | Host results have 20+ fields where many can be null. DynamoDB's schemaless nature accommodates this without ALTER TABLE migrations. |
| **TTL for Automatic Cleanup** | Host lists (7-day TTL) and results (90-day TTL) automatically expire without cron jobs. |
| **GSI for Access Patterns** | `status-started_at-index` enables "find the latest running run" queries. `run_id-index` enables "get all results for this run" without scanning. |
| **Pay-per-Request Billing** | Burst-heavy workload (many writes during a run, then idle). PAY_PER_REQUEST billing fits this pattern better than provisioned capacity. |
| **AWS Ecosystem Alignment** | Production deployment targets ECS Fargate + DynamoDB - same region, no cross-service latency. Local development uses DynamoDB Local via Docker. |

### 6.4 Access Patterns

| Pattern | Table | Key Condition |
|---------|-------|---------------|
| Get run status | finops_runs | `run_id = X, sk = "METADATA"` |
| Find active run | finops_runs | GSI: `status = "running"` (latest by started_at) |
| Find latest completed run | finops_runs | GSI: `status = "completed"` (latest by started_at) |
| Read host list for a tenant | finops_host_lists | `tenant_id = X, run_id = Y` |
| Get all host results for a run | finops_host_results | GSI: `run_id = X` |
| Get org summary for a run | finops_org_summary | GSI: `run_id = X` |

---

## 7. Authentication Architecture

### 7.1 Authentication Flow

```
+----------+     +-----------+     +-------------------+     +--------------+
| Browser  |     | Okta IdP  |     | React Frontend    |     | Express API  |
+----+-----+     +-----+-----+     +--------+----------+     +------+-------+
     |                 |                     |                        |
     |--- Navigate --->|                     |                        |
     |                 |                     |                        |
     |<-- Login form --|                     |                        |
     |                 |                     |                        |
     |--- Credentials->|                     |                        |
     |                 |                     |                        |
     |<-- Auth code -->|                     |                        |
     |                 |                     |                        |
     |--- Redirect /login/callback -------->|                        |
     |                 |                     |                        |
     |                 |<-- PKCE exchange ---|                        |
     |                 |                     |                        |
     |                 |--- ID Token ------->|                        |
     |                 |                     |                        |
     |                 |                     |-- Store in AuthContext  |
     |                 |                     |                        |
     |                 |                     |-- GET /api/results ---->|
     |                 |                     |   Bearer <id_token>     |
     |                 |                     |                        |
     |                 |                     |              Verify JWT |
     |                 |                     |              via JWKS   |
     |                 |                     |              Validate   |
     |                 |                     |              cid claim  |
     |                 |                     |                        |
     |                 |                     |<--- JSON response -----|
```

### 7.2 Frontend Auth Stack

- **@okta/okta-react** wraps the entire React app in a `<Security>` provider
- **@okta/okta-auth-js** handles PKCE code exchange and token management
- **AuthContext** (React Context) stores the current token and exposes `isAuthenticated`, `isLoading`, `token`, and `logout`
- **ProtectedRoute** component redirects unauthenticated users to `/login`
- All API calls include the token via axios interceptor: `Authorization: Bearer <token>`

### 7.3 Server-Side JWT Validation (middleware/auth.ts)

The `requireAuth` middleware performs these steps:

1. Extract `Bearer <token>` from the `Authorization` header
2. Build a JWKS fetcher from `{OKTA_ISSUER}/v1/keys`
3. Verify RS256 signature using `jose.jwtVerify()`
4. Validate the `cid` (client ID) claim matches `OKTA_CLIENT_ID`
5. Attach decoded claims + raw token to `req.user`

**Key Rotation Handling:** On `JWKSNoMatchingKey` error (Okta has rotated signing keys), the middleware invalidates its cached JWKS instance, creates a fresh fetcher, and retries verification once. This handles key rotation without server restart.

**Issuer Flexibility:** Supports both org-level (`https://domain.okta.com`) and custom authorization server (`https://domain.okta.com/oauth2/default`) issuers.

---

## 8. Frontend Architecture

### 8.1 Routing

| Route | Page Component | Purpose |
|-------|---------------|---------|
| `/login` | LoginPage | Okta redirect + callback |
| `/login/callback` | LoginCallback (Okta) | PKCE code exchange |
| `/` | DashboardPage | Main dashboard (protected) |
| `/run/:runId` | RunProgressPage | Live run progress (protected) |
| `/slo` | SloAuditPage | SLO audit results (protected) |
| `/slo/run/:runId` | SloRunProgressPage | Live SLO run progress (protected) |

### 8.2 Page Components

**DashboardPage.tsx**
- Org summary cards showing key metrics per tenant
- Paginated, sortable, filterable host results table
- Run trigger button with conflict detection modal
- Active run banner with link to progress page
- Displays data from the latest completed run by default

**RunProgressPage.tsx**
- Real-time progress bar (hosts_done / hosts_total)
- Live log feed streamed from the run record
- Abort button to gracefully stop a running analysis
- Auto-redirects to dashboard when run completes

**SloAuditPage.tsx**
- Org cards with compliance score and tier
- SLO results table with validation scores
- Gap analysis tab showing org-wide patterns
- Same trigger/abort pattern as infrastructure runs

**SloRunProgressPage.tsx**
- SLO-specific progress tracking (slos_done / slos_total)

**LoginPage.tsx**
- Initiates Okta login redirect
- Handles callback with code exchange

### 8.3 Key UI Components

| Component | Responsibility |
|-----------|---------------|
| OrgSummaryCard | Displays per-org metrics: host counts, spend, savings, utilization averages |
| HostTable | Sortable by any column, filterable by cloud provider/efficiency/tenant, paginated |
| HostDetailRow | Expandable table row showing full recommendation and instance details |
| SloOrgCard | Compliance score, tier badge, category breakdown |
| SloTable | SLO results with validation scores and issue counts |
| SloGapAnalysis | Org-wide pattern analysis across all SLOs |
| ProgressPanel | Progress bar + scrolling live log output |
| ActiveRunBanner | Notification banner when a run is in progress |
| RunTriggerButton | Trigger button with conflict modal (shows existing run info) |
| AuthContext | Okta token management, login/logout state |

### 8.4 API Client Layer

The `services/` directory contains typed axios client functions that handle:
- Attaching Bearer token from AuthContext to every request
- Parsing response types
- Error handling with structured error objects from the API (e.g., 409 conflict with run details)

---

## 9. Design Decisions and Trade-offs

### 9.1 Evidence-First Cloud Provider Detection

**Decision:** Never assume a cloud provider. Only set `cloud_provider` based on explicit tags, alias patterns, or positive metric probe results. Hosts without evidence get `cloud_provider = "unknown"`, NOT `"on-prem"`.

**Why:** In enterprise environments, many hosts have Datadog agents installed directly without AWS/Azure/GCP account-level integrations. These hosts have `system.*` metrics but no cloud tags. Assuming they're on-prem would misclassify potentially hundreds of cloud instances. The T2 metric probe step catches many of these by checking for cloud-specific metrics.

**Trade-off:** Some genuinely on-prem hosts may be classified as "unknown" if they don't have vsphere tags or metrics. This is acceptable - false "unknown" is better than false "on-prem" for cost analysis.

### 9.2 Split List/Batch/Summarize Agent Pattern

**Decision:** Three separate agent types instead of one agent per org.

**Why:** A single agent analyzing 300+ hosts would need thousands of turns. Claude SDK agents have practical turn limits. By splitting into phases:
- List-Hosts: 10 turns (sufficient for one paginated API call)
- Batch: 500 turns per batch of 15 hosts (~4-6 turns per host — pre-fetch eliminates per-host metric queries)
- Summarize: 15 turns (one aggregation call)

**Trade-off:** More complex orchestration code, but each agent stays within its turn budget.

### 9.3 DynamoDB as Message Bus

**Decision:** Agents communicate exclusively through DynamoDB. No in-memory state sharing between agents.

**Why:** This enables:
- Loose coupling between agent phases (List-Hosts writes, Batch reads, Summarize reads)
- Crash recovery: partial results are persisted even if the process dies
- Multiple concurrent batch agents writing independently without coordination
- Frontend can read progress without the orchestrator being aware

**Trade-off:** Higher latency for inter-agent communication (DynamoDB round-trip vs. in-memory). Acceptable because agent phases are sequential, not real-time.

### 9.4 No Mocks, No Fallbacks

**Decision:** All infrastructure connections (DynamoDB, AWS Pricing API, Datadog MCP) are real, even in local development.

**Why:** Mock data masks integration failures. In a system where the primary value comes from querying real infrastructure, mock data would provide false confidence. Local development uses DynamoDB Local (Docker container on port 8003), not a mock.

**Trade-off:** Requires Docker running for local development. Requires valid Datadog API keys for any meaningful testing.

### 9.5 Server-Side Validation in write_host_result_tool

**Decision:** The `write_host_result_tool` implementation normalizes field aliases, recovers metrics from text, and recomputes `efficiency_label` before writing to DynamoDB.

**Why:** LLM agents occasionally:
- Use field name variants (`instance-type` vs `instance_type`)
- Embed metric values in text instead of structured fields
- Compute efficiency labels inconsistently with the defined rules

Server-side validation catches these inconsistencies, ensuring data quality regardless of agent behavior quirks.

**Trade-off:** Adds complexity to the tool implementation. But it's a single point of normalization rather than debugging hundreds of agent runs.

### 9.6 maxTurns: 500 for Batch Agents

**Decision:** Each batch agent gets 500 turns to analyze 15 hosts.

**Why:** With the pre-fetch architecture, each host requires only ~4-6 turns (search host + read pre-fetched cache + instance specs + rightsizing tool + write result). With 15 hosts: 15 × 5 avg = 75 turns typical. The 500 limit provides ample headroom for retries, errors, and edge cases without constraining the agent.

**Trade-off:** The generous limit means a runaway agent could consume more turns than necessary. In practice, the agent completes well within budget because the pre-fetch eliminates the most expensive per-host operations (17 Datadog metric queries per host in the old design).

### 9.7 Universal Rightsizing for Non-AWS

**Decision:** AWS instances get catalog-based rightsizing (lookup the next smaller instance). Non-AWS instances get heuristic recommendations ("reduce vCPUs from 8 to ~2").

**Why:** AWS has a comprehensive, queryable instance catalog via the Pricing API. Azure and GCP don't have equivalent MCP-accessible catalogs. Building catalog scrapers for all clouds was deferred in favor of heuristic recommendations that are still actionable.

**Trade-off:** Non-AWS recommendations are less specific (no exact instance type or cost delta). They still provide utilization insights and directional guidance.

### 9.8 Stale Run Auto-Reset

**Decision:** If a run has been in "running" status for more than 4 hours, the trigger endpoint auto-resets it to "failed".

**Why:** If the server process crashes or restarts while a run is in progress, the run record stays "running" forever, blocking all future runs. The 4-hour threshold is generous (a typical full run completes in 30-90 minutes) to avoid premature reset.

**Trade-off:** If a legitimately slow run exceeds 4 hours, a new trigger would reset it. In practice, runs that take >4 hours have already failed.

### 9.9 Recomputed Org Summaries in /api/results

**Decision:** The results endpoint recomputes org summaries from the full host results rather than returning stored summaries.

**Why:** The summarize agent writes org summaries based on the host results it reads. If there were pagination issues during the summarize step (fixed later), the stored summary would undercount. Recomputing from the full result set guarantees accuracy.

**Trade-off:** Slightly more CPU on the API server for each results request. Negligible given the data sizes.

### 9.10 SLO Monitoring Context Pre-Fetch

**Decision:** The SLO List Agent fetches APM and Synthetics enabled status once per org and passes it to all SLO batch agents.

**Why:** Each SLO validation needs to know if APM/Synthetics is enabled (for latency SLOs). Querying this per-SLO would be N additional API calls. Fetching once and passing as context to all batches eliminates redundant queries.

---

## 10. Implementation Status

### Fully Implemented

| Component | Status | Notes |
|-----------|--------|-------|
| Orchestrator + Org Pipeline | Complete | Full parallel execution with abort support |
| List-Hosts Agent | Complete | Pagination, DynamoDB persistence |
| Host Batch Agent | Complete | 72KB system prompt, 5-step analysis, all right-sizing paths |
| Summarize Agent | Complete | Aggregation with top-5 offenders |
| SLO Orchestrator + Pipeline | Complete | Parallel per-tenant, 3-phase |
| SLO Batch Agent | Complete | 7-step validation, scoring |
| SLO Summarize Agent | Complete | Compliance tiers, gap analysis |
| All 6 Custom MCP Servers | Complete | 14 tools total |
| Datadog MCP Integration | Complete | Multi-site support, per-tenant auth |
| DynamoDB Schema (7 tables) | Complete | Auto-creation on startup |
| REST API (10 endpoints) | Complete | Infra + SLO routes |
| Okta Auth (Frontend + Backend) | Complete | PKCE + JWKS validation |
| React Frontend (5 pages) | Complete | Dashboard, progress, SLO audit |
| Abort Mechanism | Complete | In-memory signal + DB status update |
| Stale Run Recovery | Complete | 4-hour auto-reset |
| Server-Side Result Validation | Complete | Normalization in write_host_result_tool |

### Infrastructure-as-Code (Stub)

| Component | Status | Notes |
|-----------|--------|-------|
| SST Config | Stub | `sst.config.ts` wires modules but no real resources |
| infra/dynamodb.ts | Stub | Returns empty object |
| infra/backend.ts | Stub | Returns empty URL |
| infra/frontend.ts | Stub | Returns empty URL |
| infra/scheduler.ts | Stub | Returns empty object |
| infra/secrets.ts | Stub | Not implemented |

The SST infrastructure files are scaffolded with the correct module structure (`Tables`, `Secrets`, `Backend`, `SchedulerLambda`, `Frontend`) but contain placeholder implementations. The actual table creation happens at runtime in `db/setup.ts`.

### Not Yet Implemented

| Component | Notes |
|-----------|-------|
| SST Resource Definitions | ECS Fargate service, CloudFront distribution, DynamoDB tables in IaC |
| EventBridge Scheduler | Nightly automated runs (currently manual trigger only) |
| Scheduler Lambda | Lambda to invoke backend on EventBridge schedule |
| Multi-Region Deployment | Currently single-region (us-east-1) |
| RBAC / Role-Based Access | All authenticated users have full access |
| Run History / Comparison | Cannot compare two runs side-by-side |
| Export (CSV/PDF) | No data export capability |
| Alerting on Cost Spikes | No notifications when savings exceed threshold |

---

## 11. Deployment Architecture

### 11.1 Local Development

```
+------------------+     +---------------------+     +---------------------+
| React Dev Server |     | Express Server      |     | DynamoDB Local      |
| Port 3000        +---->| Port 8005           +---->| Port 8003           |
| (npm start)      |     | (npm run dev)       |     | (Docker container)  |
+------------------+     +----------+----------+     +---------------------+
                                    |
                         +----------v----------+
                         | Datadog MCP         |
                         | (HTTPS, external)   |
                         +---------------------+
                         +----------v----------+
                         | AWS Pricing API     |
                         | (HTTPS, external)   |
                         +---------------------+
```

**Local Setup:**
- Backend: `packages/agent/` - Express server started via `start-backend.ps1`
- Frontend: `packages/frontend/` - React dev server started via `start-frontend.ps1`
- DynamoDB Local: Docker container on port 8003 (persisted volume)
- Environment: `packages/agent/.env.local` with `DYNAMODB_ENDPOINT=http://localhost:8003`

### 11.2 AWS Production Architecture (Target)

```
+-------------------+     +-------------------+     +-------------------+
| CloudFront        |     | ALB               |     | ECS Fargate       |
| Distribution      +---->| (Internal)        +---->| Express Server    |
| + S3 Bucket       |     |                   |     | (Port 8005)       |
| (React SPA)       |     +-------------------+     +--------+----------+
+-------------------+                                        |
                                                   +---------+---------+
                                                   |                   |
                                              +----v----+    +--------v-------+
                                              | DynamoDB|    | Datadog MCP    |
                                              | (6 tbl) |    | + AWS Pricing  |
                                              +---------+    +----------------+

+-------------------+     +-------------------+
| EventBridge Rule  +---->| Scheduler Lambda  |
| (nightly cron)    |     | POST /run         |
+-------------------+     +-------------------+
```

**Production Components:**
- **Frontend:** React SPA built and deployed to S3, served via CloudFront CDN
- **Backend:** Express server running in ECS Fargate container
- **Database:** AWS-managed DynamoDB (PAY_PER_REQUEST billing mode)
- **Scheduler:** EventBridge rule triggers a Lambda function nightly, which POSTs to the backend's `/run` endpoint
- **IaC:** SST (Serverless Stack) - currently stubbed, module structure defined

### 11.3 Environment Variables

**Backend (packages/agent/.env.local):**

| Variable | Description |
|----------|-------------|
| ANTHROPIC_API_KEY | Claude API key for agent SDK |
| OKTA_ISSUER | Okta issuer URL |
| OKTA_CLIENT_ID | Okta application client ID |
| DYNAMODB_ENDPOINT | Local: `http://localhost:8003`, Prod: omitted (uses AWS default) |
| AWS_REGION | Default: `us-east-1` |
| AGENT_SERVER_PORT | Default: `8005` |

**Frontend (packages/frontend/.env):**

| Variable | Description |
|----------|-------------|
| REACT_APP_OKTA_ISSUER | Okta issuer URL |
| REACT_APP_OKTA_CLIENT_ID | Okta client ID |
| REACT_APP_API_BASE_URL | Backend URL (local: `http://localhost:8005`, prod: ALB/CloudFront URL) |

### 11.4 Process Tuning

The server sets `process.setMaxListeners(100)` at startup. This is necessary because each concurrent `query()` call from the Claude Agent SDK adds a process exit listener. With up to 30 batch agents + 2 org pipelines running in parallel, the default Node.js limit of 10 would trigger warnings.

---

## 12. Tech Stack Reference

### Backend

| Dependency | Version | Purpose |
|-----------|---------|---------|
| Node.js | 18+ | Runtime |
| TypeScript | 5.3+ | Language |
| Express | 4.18 | HTTP framework |
| @anthropic-ai/claude-agent-sdk | 0.2.77 | Agent orchestration and MCP |
| jose | - | JWT verification (RS256, JWKS) |
| @okta/okta-auth-js | - | Okta token utilities |
| @aws-sdk/client-dynamodb | - | DynamoDB low-level client |
| @aws-sdk/lib-dynamodb | - | DynamoDB document client |
| dotenv | - | Environment variable loading |
| cors | - | Cross-origin request handling |

### Frontend

| Dependency | Version | Purpose |
|-----------|---------|---------|
| React | 19.2.4 | UI framework |
| TypeScript | 4.9.5 | Language |
| react-router-dom | 7.13 | Client-side routing |
| @okta/okta-react | 6.10 | Okta React integration |
| @okta/okta-auth-js | - | PKCE auth flow |
| axios | - | HTTP client |

### Infrastructure & Testing

| Tool | Purpose |
|------|---------|
| SST (Serverless Stack) | Infrastructure-as-code (AWS) |
| Docker | DynamoDB Local for development |
| Playwright | 1.58.2 | End-to-end testing |

---

*This document reflects the current implementation as of 2026-03-25. For deployment guides, see the root-level documentation. For feature-specific details, see individual docs under `/docs/`.*
