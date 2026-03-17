# PDI FinOps Intelligence Agent — Design Spec
**Date:** 2026-03-17
**Status:** Approved
**Author:** Brainstorming session with Claude

---

## 1. Problem Statement

PDI runs infrastructure across multiple Datadog orgs (PDI-Enterprise, PDI-Orbis). Hosts are over-provisioned — CPU and RAM utilization averages well below provisioned capacity — but there is no automated way to surface this waste, quantify it in dollars, or suggest right-sized alternatives. Existing Datadog Workflow-based attempts hit agent turn limits and context bloat when trying to analyze all hosts in a single agent. The goal is to eliminate dependency on Onica and similar tools by building a fully owned, Claude-powered FinOps intelligence product.

---

## 2. Goals

- Analyze all hosts across all PDI Datadog orgs for CPU, RAM, and Network utilization over 30 days
- For hosts with AWS instance type tags: produce specific right-sizing recommendations with current vs. suggested cost and an AWS Pricing Calculator link
- For hosts without instance type tags: produce an efficiency score and usage guidance
- Surface results in a hosted React dashboard with Okta SSO, accessible to all PDI users via a URL
- Run automatically on a nightly schedule; also triggerable on-demand via a "Run Fresh Analysis" button
- Deploy to AWS; fully testable locally with no mocks

---

## 3. Non-Goals

- No write operations to Datadog or AWS (read-only analysis only)
- No per-user personalization or saved preferences
- No Azure or GCP cost analysis in v1 (efficiency score only for non-AWS hosts)
- No alerting or notification system in v1
- No 30-day time-series sparklines in v1 (scalar aggregates only; sparklines are a v2 feature)
- No 6th-gen or Graviton instance family recommendations in v1 (5th-gen Intel/AMD only)
- No `"partial"` run recovery in v1 — a run is either `"completed"` or `"failed"`

---

## 4. Architecture Overview

```
Browser (React + Okta, port 3000 local / CloudFront AWS)
    │ Bearer <okta-token>
    ▼
FastAPI Backend (Python, port 8001 local / ECS Fargate AWS)
    ├── GET  /api/results    → read from DynamoDB
    ├── GET  /api/status     → current run progress
    ├── POST /api/trigger    → kick off orchestrator agent
    └── verifyOktaToken middleware on all /api/* routes
    │
    ▼
Orchestrator Agent (claude_agent_sdk, Python)
    │ reads tenant registry
    │ spawns one Org Analysis flow per tenant (asyncio.gather)
    │
    ├── Org Analysis Flow: PDI-Enterprise  (Python wrapper, not a single agent)
    │       │
    │       ├── Invocation 1: List-Hosts Agent
    │       │     calls Datadog MCP → lists all hosts
    │       │     writes host list to DynamoDB (finops_host_lists table)
    │       │     updates hosts_total on finops_runs
    │       │
    │       ├── Python wrapper: asyncio.gather across batches of 10
    │       │       └── Host Batch Sub-Agent (per 10 hosts)
    │       │               MCP loop until complete per host:
    │       │               - CPU avg/p95 (30d)
    │       │               - RAM usable avg (30d)
    │       │               - Network in/out avg (30d) [informational]
    │       │               - Host tags → instance_type, region
    │       │               Own tools:
    │       │               - get_instance_on_demand_price (boto3 Pricing API)
    │       │               - get_instance_specs (local EC2 catalog)
    │       │               - suggest_right_sized_instance (pure Python logic)
    │       │               - build_pricing_calculator_url (URL construction)
    │       │               - write_host_result (boto3 DynamoDB)
    │       │               Writes per-host result → DynamoDB
    │       │
    │       └── Invocation 2: Summarize Agent
    │             reads all host results for this org from DynamoDB
    │             computes org summary + top 5 offenders
    │             writes finops_org_summary to DynamoDB
    │             updates tenants_done on finops_runs
    │
    └── Org Analysis Flow: PDI-Orbis (parallel, same flow)

DynamoDB (4 tables)
    ├── finops_runs           run metadata + progress
    ├── finops_host_lists     intermediate: host list per org per run
    ├── finops_org_summary    per-org aggregated results
    └── finops_host_results   per-host analysis detail
```

---

## 5. Data Sources

| Source | What We Get | How |
|---|---|---|
| Datadog MCP (live) | CPU avg/p95, RAM usable, Network in/out (30d), host tags (instance_type, region, cloud) | `claude_agent_sdk` HTTP MCP at `https://dm9vya05q5.execute-api.us-east-1.amazonaws.com/mcp` |
| AWS Pricing API | On-demand price per instance type + region | boto3 `pricing` client (us-east-1 endpoint) |
| EC2 Instance Catalog | CPU count + RAM GB per instance type | Local JSON (ec2instances.info data, bundled in repo, refreshed quarterly) |
| AWS Pricing Calculator | Cost comparison URL | Pure URL construction (no API) |

**Note on cost data:** We use the AWS Pricing API (on-demand rate × 730 hours/month) to compute monthly cost — not AWS Cost Explorer. Cost Explorer aggregates by dimension and requires Resource-level granularity opt-in; it cannot reliably return per-host cost without additional tagging infrastructure. The Pricing API gives us a clean, always-available on-demand rate sufficient for right-sizing comparison.

The Datadog MCP is the **only external MCP**. All AWS data is fetched via boto3 directly inside agent tools.

---

## 6. Agent Layer Detail

### 6.1 Orchestrator Agent (`orchestrator.py`)

```
System prompt: "You are a FinOps orchestrator for PDI infrastructure.
Given a list of Datadog tenants, coordinate parallel org analysis.
Write run status to DynamoDB as each org completes.
When all orgs are done, mark the run as completed."

max_turns: 20
  Justification: 2 tenants × ~3 turns each (start, check, complete) + overhead = ~10 turns.
  20 gives comfortable headroom.
Tools: write_run_status, get_tenant_registry
MCP: none (orchestration only)
```

### Tenant Registry Schema

`tenant_registry.py` returns a list of tenant configs. Each tenant maps to a Datadog org. The Datadog MCP handles org routing internally via `tenant_id` — the agent passes `tenant_id` as a parameter to `query-datadog` and the MCP routes to the correct Datadog org using its internal workflow registry.

```python
# agents/config/tenant_registry.py
TENANTS = [
    {
        "tenant_id": "PDI-Enterprise",   # passed to query-datadog MCP tool
        "display_name": "PDI Enterprise",
        "default_region": "us-east-1",   # used for AWS Pricing API calls
    },
    {
        "tenant_id": "PDI-Orbis",
        "display_name": "PDI Orbis",
        "default_region": "us-east-1",
    },
]
```

All tenants share the same `DATADOG_MCP_URL`. The MCP's `tenant_id` parameter selects the org — no per-org MCP endpoint needed.

### 6.2 Org Analysis Flow — Two-Invocation Design

The Org Analysis Flow is **not a single agent**. It is a Python wrapper function (`run_org_analysis`) that makes two separate `claude_agent_sdk` calls plus one `asyncio.gather` step. This is the correct pattern for `claude_agent_sdk` — agents return final message text, not structured data; structured data is passed via DynamoDB.

```python
# org_agent.py — Python wrapper (not inside any agent loop)

async def run_org_analysis(tenant_id: str, okta_token: str, run_id: str):

    # ── Invocation 1: List-Hosts Agent ──────────────────────────────
    # Agent queries Datadog MCP, writes host list to DynamoDB,
    # updates hosts_total on finops_runs.
    await run_list_hosts_agent(tenant_id, okta_token, run_id)
    # max_turns: 10 (list hosts = 2-3 MCP calls + write + confirm)

    # ── Python step: read host list back from DynamoDB ───────────────
    hosts = await read_host_list_from_dynamodb(tenant_id, run_id)

    # ── Python step: fan out batches (no agent involved) ─────────────
    batches = [hosts[i:i+10] for i in range(0, len(hosts), 10)]
    await asyncio.gather(*[
        run_host_batch_agent(tenant_id, batch, okta_token, run_id)
        for batch in batches
    ])

    # ── Invocation 2: Summarize Agent ────────────────────────────────
    # Agent reads all host results for this org from DynamoDB,
    # computes org summary + top 5 offenders by monthly_savings,
    # writes finops_org_summary, updates tenants_done on finops_runs.
    await run_summarize_agent(tenant_id, okta_token, run_id)
    # max_turns: 10 (read results + reason + write summary)
```

**How the host list is passed between invocations:** The List-Hosts Agent writes the host list as a JSON item to `finops_host_lists` (DynamoDB). The Python wrapper reads it back. The agent never returns structured data directly — it always writes to DynamoDB and the wrapper reads from there.

**How `top_offenders` is computed:** The Summarize Agent reads all `finops_host_results` rows for the org (via a `read_org_host_results` tool that does a DynamoDB query by `tenant_id`), sorts by `monthly_savings` descending, takes the top 5 `host_id` values, and writes them into `finops_org_summary`.

### 6.3 List-Hosts Agent (`list_hosts_agent.py`)

```
System prompt: "You are a host discovery agent for {tenant_id}.
Use the datadog-mcp to list all hosts in this org by calling
query-datadog with tenant_id='{tenant_id}' and a query like
'list all monitored hosts with their tags and metadata'.
Write the complete host list to DynamoDB using write_host_list.
Then update the run's hosts_total count using update_hosts_total."

max_turns: 10
Tools: write_host_list, update_hosts_total
MCP: datadog-mcp (Okta token forwarded)
```

### 6.4 Host Batch Sub-Agent (`host_batch_agent.py`)

```
System prompt: "You are a FinOps host analyzer. For each host in
your list, query 30-day CPU, RAM, and Network metrics from Datadog.
Check for instance_type tag.

IMPORTANT: Datadog CPU metric is system-wide percentage (0–100% of
all vCPUs combined). Pass it directly — no per-core normalization needed.

IF instance_type tag found AND instance is in the EC2 catalog:
  - Get instance specs (CPU count, RAM GB) from catalog
  - Compute actual utilization % against provisioned capacity
  - Suggest the best-fit right-sized instance (see right-sizing rules)
  - Get on-demand price for current and suggested instance
  - Build AWS Pricing Calculator comparison URL
  - Write result with specific recommendation and monthly savings

IF instance_type tag found BUT instance NOT in EC2 catalog:
  - Set has_instance_tag=true, catalog_data_available=false
  - Compute efficiency score from raw CPU/RAM usage
  - Write result with note: 'Instance type {X} not in catalog — efficiency guidance only'

IF no instance_type tag:
  - Compute efficiency score from CPU and RAM usage
  - Label as over-provisioned / right-sized / under-provisioned
  - Write result with efficiency guidance only

IF Datadog returns no metric data for a host (new/decommissioned host):
  - Set efficiency_score=0, efficiency_label='unknown'
  - Write result with note: 'No metric data available for this host'
  - Do not skip — always write a result row

Network in/out metrics are informational — include in the result
but do not use them to drive instance type selection in v1.

Write each host result to DynamoDB before moving to the next host."

max_turns: 200
  Justification: 10 hosts × (4 MCP calls + 3 tool calls + 2 reasoning turns) = ~90 turns
  baseline. 200 provides headroom for retries, partial data re-queries, and
  reasoning over edge cases. Tune down if cost is a concern after first real run.
Tools: get_instance_on_demand_price, get_instance_specs,
       suggest_right_sized_instance, build_pricing_calculator_url,
       write_host_result, update_run_progress
MCP: datadog-mcp (Okta token forwarded)
```

**Batch delivery:** The host batch agent receives its list of hosts as the initial user message — a JSON array of `{ "host_id": "...", "host_name": "..." }` objects. The Python wrapper constructs this message before calling `claude_agent_sdk.query()`.

**Progress tracking:** The host batch agent calls `update_run_progress(run_id, tenant_id, hosts_done_increment, log_message)` after completing each host. This tool increments `hosts_done` on `finops_runs` and appends a message to the `log` list (capped at last 20 entries). Example log message: `"PDI-Enterprise: batch 3/15 complete (10 hosts)"`.

### 6.5 Summarize Agent (`summarize_agent.py`)

```
System prompt: "You are a FinOps org summarizer for {tenant_id}.
Read all host results for this org from DynamoDB.
Compute the org summary: total hosts, over-provisioned count,
right-sized count, under-provisioned count, no-tag count,
total monthly spend, potential savings, savings percent,
avg CPU utilization, avg RAM utilization.
Identify the top 5 hosts by monthly_savings (highest waste first).
Write the org summary to DynamoDB."

max_turns: 15
Tools: read_org_host_results, write_org_summary, update_tenants_done
MCP: none
```

### 6.6 Right-Sizing Logic

**Cross-family selection** — the algorithm evaluates candidates across all v1 supported families, not just the current instance's family. An `r5.xlarge` running at 12% RAM should be considered for `t3.large`, not just `r5.large`.

**v1 supported families:** `t3`, `t3a`, `m5`, `m5a`, `c5`, `r5` (5th-gen Intel/AMD only). 6th-gen (`m6i`, `c6i`, `r6i`) and Graviton (`t4g`, `m6g`) are v2 additions.

```python
# aws_instances.py

CANDIDATE_FAMILIES_V1 = ["t3", "t3a", "m5", "m5a", "c5", "r5"]
# v1: 5th-gen Intel/AMD only. Add m6i, c6i, r6i, t4g, m6g in v2.

def suggest_right_sized_instance(
    cpu_p95_pct: float,     # Datadog system-wide CPU % (0-100, no normalization needed)
    ram_avg_pct: float,     # avg RAM used as % of current instance's RAM GB
    current_instance: str,  # e.g. "r5.xlarge"
    region: str             # e.g. "us-east-1"
) -> dict:
    # Convert % to absolute requirements with 30% headroom
    current_specs = get_instance_specs(current_instance)
    required_vcpu = (cpu_p95_pct / 100) * current_specs["vcpu"] * 1.3
    required_ram_gb = (ram_avg_pct / 100) * current_specs["ram_gb"] * 1.3

    # Build candidate list across all v1 families, sorted by on-demand price (cheapest first)
    candidates = get_all_instances_sorted_by_price(region, families=CANDIDATE_FAMILIES_V1)

    for candidate in candidates:
        specs = get_instance_specs(candidate)
        if specs["vcpu"] >= required_vcpu and specs["ram_gb"] >= required_ram_gb:
            if candidate == current_instance:
                # Already right-sized — no cheaper option fits
                return {"suggested": current_instance, "already_right_sized": True}
            return {"suggested": candidate, "already_right_sized": False}

    # Fallback: no candidate found (shouldn't happen with full catalog)
    return {"suggested": current_instance, "already_right_sized": True}
```

**When `already_right_sized=True`:** Write `suggested_instance = current_instance`, `monthly_savings = 0.0`, `savings_percent = 0.0`, `pricing_calc_url = null`, `efficiency_label = "right-sized"`. The UI shows "Already right-sized" instead of a savings figure.

**Efficiency score formula (for hosts without instance_type tag or no catalog data):**

```python
def compute_efficiency_score(cpu_avg: float, ram_avg: float) -> int:
    # Weighted average: CPU 50%, RAM 50%
    # Score = how well utilized the host is (higher = better used)
    # Returns 0 if either metric is None (no data case)
    if cpu_avg is None or ram_avg is None:
        return 0
    raw = (cpu_avg * 0.5) + (ram_avg * 0.5)
    return int(min(100, max(0, raw)))

def efficiency_label(score: int, cpu_avg, ram_avg) -> str:
    if cpu_avg is None or ram_avg is None:
        return "unknown"
    if score < 30:  return "over-provisioned"
    if score < 70:  return "right-sized"
    return "under-provisioned"
```

**EC2 instance catalog:**
- Bundled as `agents/config/ec2_instances.json` (sourced from ec2instances.info)
- Committed to the repo; refreshed manually each quarter
- Unknown instance type handling: `has_instance_tag=True`, `catalog_data_available=False`, fall back to efficiency score, note in `recommendation`

**RAM metric clarification:** Datadog's `system.mem.usable` metric returns **absolute bytes** (not a percentage). The agent must convert to a percentage before passing to the right-sizing function:

```python
# In host_batch_agent tools or system prompt instruction:
ram_used_gb = instance_ram_gb - (datadog_mem_usable_bytes / 1e9)
ram_avg_pct = (ram_used_gb / instance_ram_gb) * 100
```

This requires `instance_ram_gb` from the EC2 catalog. If the instance is not in the catalog, RAM percentage cannot be computed — fall back to efficiency score only.

**Network metric clarification:** Datadog's `system.net.bytes_rcvd` and `system.net.bytes_sent` return **bytes/second**. The agent converts to GB/day for storage:

```python
network_in_avg_30d_gb_day = (datadog_bytes_rcvd_per_sec * 86400) / 1e9
network_out_avg_30d_gb_day = (datadog_bytes_sent_per_sec * 86400) / 1e9
```

The UI displays network in GB/day.

---

## 7. API Contracts

### `POST /api/trigger`

**Request:** `Authorization: Bearer <okta-token>` (no body required)

**Response (202 Accepted):**
```json
{
  "run_id": "run_2026-03-17T14:32:00Z",
  "status": "running"
}
```

**Concurrent run behavior:** If a run is already `"running"`, return `409 Conflict`:
```json
{ "error": "A run is already in progress", "run_id": "run_2026-03-17T14:30:00Z" }
```
The frontend shows a toast: "Analysis already running" with a link to RunProgress for that `run_id`.

**Scheduled trigger:** EventBridge does not call `/api/trigger` directly (it cannot send a Bearer token). Instead, EventBridge invokes a dedicated Lambda (`scheduler_lambda.py`) that: (1) fetches an M2M token via Okta Client Credentials, (2) calls `POST /api/trigger` with `Authorization: Bearer <m2m-token>`. The FastAPI `verifyOktaToken` middleware validates the M2M token identically to a user token. `triggered_by` is set to `"scheduler"` for these runs.

---

### `GET /api/status?run_id=<run_id>`

**Request:** `Authorization: Bearer <okta-token>`
If `run_id` is omitted, returns status of the most recently started run.

**`hosts_total` during early run:** The Orchestrator writes `finops_runs` with `hosts_total=0` at run start. The List-Hosts Agent updates `hosts_total` once host discovery completes for each org. The frontend renders the progress bar as indeterminate (spinner) when `hosts_total=0`, switching to a percentage bar once `hosts_total > 0`.

**Response:**
```json
{
  "run_id": "run_2026-03-17T14:32:00Z",
  "status": "running",
  "trigger_type": "manual",
  "triggered_by": "user@pdi.com",
  "started_at": "2026-03-17T14:32:00Z",
  "completed_at": null,
  "tenants_total": 2,
  "tenants_done": 1,
  "hosts_total": 229,
  "hosts_done": 142,
  "progress_pct": 62,
  "log": [
    "PDI-Enterprise: batch 1/15 complete (10 hosts)",
    "PDI-Enterprise: batch 2/15 complete (10 hosts)",
    "PDI-Orbis: batch 1/9 analyzing..."
  ]
}
```
`log` is the last 20 progress messages, newest last. Frontend appends new entries on each poll.

---

### `GET /api/results?run_id=<run_id>`

**Request:** `Authorization: Bearer <okta-token>`
If `run_id` is omitted, returns results from the most recently **completed** run (not a currently running one).
If no completed run exists yet, returns `404 { "error": "No completed run found" }`.

**Response — DynamoDB keys are stripped; composite SK `host_id#run_id` is split into `host_id` only:**
```json
{
  "run_id": "run_2026-03-17T02:00:00Z",
  "completed_at": "2026-03-17T02:47:00Z",
  "trigger_type": "scheduled",
  "org_summaries": [
    {
      "tenant_id": "PDI-Enterprise",
      "total_hosts": 142,
      "hosts_analyzed": 140,
      "hosts_over_provisioned": 89,
      "hosts_right_sized": 41,
      "hosts_under_provisioned": 3,
      "hosts_no_tag": 9,
      "total_monthly_spend": 12400.00,
      "potential_savings": 4100.00,
      "savings_percent": 33.1,
      "avg_cpu_utilization": 21.4,
      "avg_ram_utilization": 34.2,
      "top_offenders": ["i-0abc123", "i-0def456", "i-0ghi789", "i-0jkl012", "i-0mno345"],
      "completed_at": "2026-03-17T02:44:00Z"
    }
  ],
  "host_results": [
    {
      "tenant_id": "PDI-Enterprise",
      "host_id": "i-0abc123",
      "host_name": "web-prod-01",
      "cloud_provider": "aws",
      "cpu_avg_30d": 18.2,
      "cpu_p95_30d": 31.4,
      "ram_avg_30d": 22.1,
      "network_in_avg_30d": 1.2,
      "network_out_avg_30d": 0.8,
      "instance_type": "t3.xlarge",
      "instance_region": "us-east-1",
      "instance_cpu_count": 4,
      "instance_ram_gb": 16.0,
      "has_instance_tag": true,
      "catalog_data_available": true,
      "current_monthly_cost": 134.40,
      "suggested_instance": "t3.small",
      "suggested_monthly_cost": 16.80,
      "monthly_savings": 117.60,
      "savings_percent": 87.5,
      "pricing_calc_url": "https://calculator.aws/...",
      "efficiency_score": 20,
      "efficiency_label": "over-provisioned",
      "recommendation": "This host averages 18% CPU and 22% RAM over 30 days...",
      "analyzed_at": "2026-03-17T02:31:00Z"
    }
  ]
}
```

**DynamoDB query pattern for `/api/results`:** `finops_org_summary` and `finops_host_results` both have a GSI on `run_id` (see Section 8). The backend queries both tables by `run_id` to assemble the response.

**Finding the latest completed run:** `finops_runs` has a GSI `status-started_at-index` (PK=`status`, SK=`started_at`). The backend queries this GSI with `status="completed"`, sorted descending by `started_at`, limit 1. Given the 90-day TTL, this table stays small (~90 items max) — a GSI query is clean and efficient.

---

## 8. DynamoDB Schema

### `finops_runs`
| Key | Type | Description |
|---|---|---|
| PK: `run_id` | String | e.g. `run_2026-03-17T02:00:00Z` |
| SK: `"METADATA"` | String | fixed |
| GSI: `status-started_at-index` | — | PK=`status`, SK=`started_at` (enables latest-completed-run query) |
| `trigger_type` | String | `"scheduled"` \| `"manual"` |
| `triggered_by` | String | user email or `"scheduler"` |
| `status` | String | `"running"` \| `"completed"` \| `"failed"` (no `"partial"` in v1) |
| `started_at` | String | ISO timestamp |
| `completed_at` | String | ISO timestamp or null |
| `tenants_total` | Number | set at run start |
| `tenants_done` | Number | incremented as each org finishes |
| `hosts_total` | Number | 0 at start; updated after host discovery per org |
| `hosts_done` | Number | incremented per host via `update_run_progress` tool |
| `log` | List | last 20 progress message strings (appended by `update_run_progress`) |
| `okta_token` | String | token used for this run (forwarded to Datadog MCP by agents) |
| `ttl` | Number | Unix timestamp = started_at + 90 days (DynamoDB TTL attribute) |

### `finops_host_lists` *(intermediate, not shown in UI)*
| Key | Type | Description |
|---|---|---|
| PK: `tenant_id` | String | |
| SK: `run_id` | String | |
| `hosts` | List | list of `{ host_id, host_name }` objects |
| `ttl` | Number | Unix timestamp = created_at + 7 days |

### `finops_org_summary`
| Key | Type | Description |
|---|---|---|
| PK: `tenant_id` | String | e.g. `PDI-Enterprise` |
| SK: `run_id` | String | |
| GSI: `run_id-index` | — | PK=`run_id` (enables query-by-run_id in `/api/results`) |
| `total_hosts` | Number | |
| `hosts_analyzed` | Number | |
| `hosts_over_provisioned` | Number | |
| `hosts_right_sized` | Number | |
| `hosts_under_provisioned` | Number | |
| `hosts_no_tag` | Number | no instance_type tag |
| `total_monthly_spend` | Number | USD, AWS hosts with catalog data only |
| `potential_savings` | Number | USD/month |
| `savings_percent` | Number | |
| `avg_cpu_utilization` | Number | % across all hosts |
| `avg_ram_utilization` | Number | % across all hosts |
| `top_offenders` | List | top 5 host_ids by monthly_savings descending |
| `completed_at` | String | ISO timestamp |
| `ttl` | Number | Unix timestamp = completed_at + 90 days |

### `finops_host_results`
| Key | Type | Description |
|---|---|---|
| PK: `tenant_id` | String | |
| SK: `host_id#run_id` | String | composite, e.g. `i-0abc123#run_2026-03-17T02:00:00Z` |
| GSI: `run_id-index` | — | PK=`run_id` (enables query-by-run_id in `/api/results`) |
| `host_id` | String | extracted from SK for API response |
| `host_name` | String | |
| `cloud_provider` | String | `aws` \| `azure` \| `gcp` \| `on-prem` \| `unknown` |
| `cpu_avg_30d` | Number | % (null if no data) |
| `cpu_p95_30d` | Number | % (null if no data) |
| `ram_avg_30d` | Number | % (null if no data) |
| `network_in_avg_30d` | Number | GB/day (informational, null if no data) |
| `network_out_avg_30d` | Number | GB/day (informational, null if no data) |
| `instance_type` | String | null if no tag |
| `instance_region` | String | null if no tag |
| `instance_cpu_count` | Number | null if no tag or catalog miss |
| `instance_ram_gb` | Number | null if no tag or catalog miss |
| `has_instance_tag` | Boolean | |
| `catalog_data_available` | Boolean | false if instance_type not in EC2 catalog |
| `current_monthly_cost` | Number | USD, null if no tag or catalog miss |
| `suggested_instance` | String | null if no tag or catalog miss |
| `suggested_monthly_cost` | Number | null if no tag or catalog miss |
| `monthly_savings` | Number | 0.0 if already right-sized; null if no tag or catalog miss |
| `savings_percent` | Number | 0.0 if already right-sized; null if no tag or catalog miss |
| `pricing_calc_url` | String | null if no tag, catalog miss, or already right-sized |
| `efficiency_score` | Number | 0–100 always; 0 if no metric data |
| `efficiency_label` | String | `over-provisioned` \| `right-sized` \| `under-provisioned` \| `unknown` |
| `recommendation` | String | agent-generated human-readable text |
| `analyzed_at` | String | ISO timestamp |
| `ttl` | Number | Unix timestamp = analyzed_at + 90 days |

**TTL policy:** All tables use DynamoDB TTL set to 90 days from record creation. This retains ~3 months of nightly runs (≈90 runs) and prevents unbounded table growth.

---

## 9. Frontend UI

**Stack:** React + TypeScript + Tailwind CSS + shadcn/ui + Okta PKCE
**Port:** 3000 (local), CloudFront (AWS)

### Pages
1. **Login** — Okta SSO entry, identical to IAC Agent pattern
2. **Dashboard** — org summary cards (top) + host detail table (bottom)
3. **RunProgress** — live progress bars + log stream, shown during active run

### Key Components
| Component | Purpose |
|---|---|
| `OrgSummaryCard` | Per-org: host count, spend, savings opportunity, avg CPU/RAM |
| `HostTable` | Sortable/filterable table: host, instance type, CPU%, RAM%, current $/mo, suggested instance, savings $/mo |
| `HostDetailRow` | Expandable: agent recommendation text, metric aggregates, pricing calculator link |
| `ProgressPanel` | Per-org progress bars + live log of batch completions |
| `RunTriggerButton` | "Run Fresh Analysis" with confirm dialog |

### Data Flow
```
Dashboard load
  → GET /api/results (no run_id → latest completed run)
  → if 404: show "No analysis run yet" empty state with "Run Analysis" button
  → else: render org cards + host table

"Run Analysis" clicked
  → POST /api/trigger
  → if 409: show toast "Already running" + link to RunProgress for existing run_id
  → if 202: store run_id in component state, navigate to RunProgress

RunProgress
  → poll GET /api/status?run_id=<run_id> every 3s
  → when hosts_total=0: show indeterminate spinner ("Discovering hosts...")
  → when hosts_total>0: show percentage progress bars
  → append new log[] entries to live log panel on each poll
  → pause polling when browser tab is hidden (Page Visibility API); resume on focus
  → when status="completed": stop polling, navigate to Dashboard
  → when status="failed": stop polling, show error state with last log entries
```

---

## 10. Authentication

**Single Okta login, token flows everywhere** — identical to IAC Agent strategy.

| Layer | Auth |
|---|---|
| Frontend → Backend | `Authorization: Bearer <okta-token>` on all `/api/*` |
| Backend → Datadog MCP | Same okta-token forwarded in MCP HTTP header |
| Scheduled runs | Okta Client Credentials (M2M) via scheduler Lambda |
| Local dev | Real Okta (localhost:3000 already in allowed redirect URIs) |

`verifyOktaToken` FastAPI middleware validates JWT against `OKTA_ISSUER` on every request. M2M tokens from Client Credentials grant are validated identically.

### Scheduled Run Auth (M2M)

```
EventBridge (nightly cron)
  → invokes scheduler_lambda.py (AWS Lambda)
      → POST https://{OKTA_ISSUER}/v1/token
           grant_type=client_credentials
           client_id={OKTA_M2M_CLIENT_ID}
           client_secret={OKTA_M2M_CLIENT_SECRET}
           scope=datadog-mcp
      → receives short-lived access_token (~1 hour)
      → POST https://{backend}/api/trigger
           Authorization: Bearer <m2m-access-token>
      → FastAPI verifyOktaToken validates token (same validation as user tokens)
      → run proceeds; triggered_by = "scheduler" (hardcoded string, not the M2M client ID)
```

**M2M token forwarded to Datadog MCP:** The same M2M access token is stored on the run context in DynamoDB (`finops_runs.okta_token`) at trigger time. The List-Hosts and Host Batch agents read this token from the run context and forward it to the Datadog MCP as the Bearer header. The Datadog MCP shim validates Okta JWTs regardless of grant type — the M2M Client Credentials token is a valid Okta JWT and passes the same RS256 + claims validation as a user PKCE token, provided the M2M Okta app is configured with the same audience and `datadog-mcp` scope.

`OKTA_M2M_CLIENT_ID` and `OKTA_M2M_CLIENT_SECRET` stored in AWS Secrets Manager. Token is fetched fresh on each scheduled run — no stored token expiry problem.

### Scheduler Dual-Mode (Local vs AWS)

`scheduler.py` runs in two modes:
- **Local:** APScheduler runs inside the FastAPI process, triggered by `SCHEDULER_CRON` env var. Fetches M2M token and calls the local `/api/trigger` endpoint on schedule.
- **AWS:** APScheduler is disabled (detected by absence of `DYNAMODB_ENDPOINT` env var). EventBridge + scheduler Lambda handles the trigger externally.

---

## 11. Project Structure

```
finops-agent/
├── sst.config.ts
├── package.json
├── .env.local.example
├── .env.example
├── packages/
│   ├── frontend/                    React + TypeScript + Tailwind + shadcn
│   │   └── src/
│   │       ├── pages/               Login, Dashboard, RunProgress
│   │       ├── components/          OrgSummaryCard, HostTable, HostDetailRow,
│   │       │                        ProgressPanel, RunTriggerButton
│   │       ├── contexts/            AuthContext (Okta)
│   │       └── services/            api.ts, polling.ts
│   │
│   └── backend/                     Python FastAPI
│       ├── main.py                  routes + app
│       ├── auth.py                  Okta JWT middleware
│       ├── scheduler.py             APScheduler (local) / disabled (AWS)
│       ├── dynamodb.py              boto3 DynamoDB helpers
│       ├── requirements.txt
│       └── agents/
│           ├── orchestrator.py      top-level coordinator
│           ├── org_agent.py         Python wrapper: list → batch → summarize
│           ├── list_hosts_agent.py  Invocation 1: discover hosts via MCP
│           ├── host_batch_agent.py  per-batch: metrics + recommendations
│           ├── summarize_agent.py   Invocation 2: aggregate org summary
│           ├── tools/
│           │   ├── aws_pricing.py   boto3 Pricing API (on-demand rates)
│           │   ├── aws_instances.py instance catalog + right-size logic
│           │   ├── pricing_url.py   AWS Pricing Calculator URL builder
│           │   └── dynamodb_tools.py all DynamoDB read/write tools
│           └── config/
│               ├── tenant_registry.py
│               └── ec2_instances.json   bundled EC2 catalog (refresh quarterly)
│
├── infra/
│   ├── frontend.ts                  CloudFront + S3
│   ├── backend.ts                   ECS Fargate (always-on for polling)
│   ├── scheduler_lambda.ts          EventBridge + Lambda (M2M trigger)
│   ├── dynamodb.ts                  4 tables + GSIs + TTL config
│   └── secrets.ts                   Okta config + M2M client credentials
│
└── docs/
    └── superpowers/specs/
        └── 2026-03-17-finops-agent-design.md
```

---

## 12. Local Dev Setup

```bash
# Terminal 1 — DynamoDB Local
docker run -p 8000:8000 amazon/dynamodb-local

# Terminal 2 — Python backend (APScheduler active when DYNAMODB_ENDPOINT is set)
cd packages/backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8001

# Terminal 3 — React frontend
cd packages/frontend
npm install && npm start    # http://localhost:3000
```

### Environment Variables

**.env.local (backend)**
```
ANTHROPIC_BASE_URL=https://pdi-gateway.pditechnologies.com/v1
ANTHROPIC_AUTH_TOKEN=your-token
OKTA_ISSUER=https://your-domain.okta.com
OKTA_CLIENT_ID=your-client-id
OKTA_M2M_CLIENT_ID=your-m2m-client-id
OKTA_M2M_CLIENT_SECRET=your-m2m-client-secret
DATADOG_MCP_URL=https://dm9vya05q5.execute-api.us-east-1.amazonaws.com/mcp
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-key
AWS_SECRET_ACCESS_KEY=your-secret
DYNAMODB_ENDPOINT=http://localhost:8000   # presence enables APScheduler + local DynamoDB
SCHEDULER_CRON=0 2 * * *
```

**.env.local (frontend)**
```
REACT_APP_OKTA_CLIENT_ID=your-client-id
REACT_APP_OKTA_ISSUER=https://your-domain.okta.com
REACT_APP_API_URL=http://localhost:8001
```

### Local → AWS Parity

| Concern | Local | AWS |
|---|---|---|
| DynamoDB | Docker port 8000 | Real DynamoDB |
| Scheduler | APScheduler in FastAPI (DYNAMODB_ENDPOINT present) | EventBridge + Lambda |
| Frontend | npm start port 3000 | CloudFront |
| Backend | uvicorn port 8001 | ECS Fargate |
| Okta (user) | Real Okta (localhost:3000 allowed) | Real Okta (CloudFront URL) |
| Okta (M2M) | Client credentials (same Okta tenant) | Client credentials (same Okta tenant) |
| Datadog MCP | Live endpoint (same URL) | Live endpoint (same URL) |

No mocks anywhere.

---

## 13. AWS Deployment

```bash
npm run deploy --stage prod
```

Produces: CloudFront URL (frontend), ECS Fargate (FastAPI backend, always-on), EventBridge nightly rule + scheduler Lambda, 4 DynamoDB tables with GSIs and TTL, Secrets Manager entries for Okta config and M2M client credentials.

---

## 14. Key Design Decisions

| Decision | Rationale |
|---|---|
| Three-tier agent hierarchy (Orchestrator → Org Flow → Host Batch) | Keeps each agent's context small and bounded; isolates failures; mirrors what the Datadog Workflow attempted but with full Python control |
| Org Analysis Flow = two agent invocations + Python wrapper | `claude_agent_sdk` agents return text, not structured data. Structured data passes via DynamoDB. Python wrapper handles parallelism via `asyncio.gather` — avoids async-in-sync problem inside `@tool` callbacks |
| Batch size = 10 hosts | Prevents context blowup in host batch agent; each agent handles a fixed, predictable scope |
| `max_turns: 200` for host batch agent | 10 hosts × ~9 turns each = ~90 baseline + generous retry headroom. Tune down after first real run if cost is a concern |
| AWS Pricing API (not Cost Explorer) for cost data | Pricing API gives clean on-demand rates per instance type without requiring Resource-level Cost Explorer opt-in or per-host tagging infrastructure |
| Cross-family right-sizing (v1: 5th-gen Intel/AMD) | Evaluates all supported families sorted by price; finds cheapest instance fitting CPU p95 × 1.3 and RAM avg × 1.3. Not limited to same family. 6th-gen + Graviton in v2 |
| Network metrics informational only (v1) | Collected and displayed; not used for instance selection. Network-optimized instance recommendation is a v2 feature |
| Efficiency score = weighted avg CPU+RAM (50/50) | Simple, explainable formula. Returns 0 for no-data hosts. Tune weights in v2 |
| Okta Client Credentials (M2M) for scheduler | PKCE requires a browser. Scheduled runs need non-interactive token. Client credentials is the correct Okta grant type for M2M; token fetched fresh each run |
| EventBridge → Lambda → POST /api/trigger (not direct) | EventBridge cannot send Bearer tokens. Lambda fetches M2M token then calls the API — keeps auth consistent across manual and scheduled triggers |
| APScheduler dual-mode (local only) | Presence of `DYNAMODB_ENDPOINT` env var signals local mode; APScheduler activates. In AWS, EventBridge + Lambda handles scheduling externally |
| GSI on `run_id` for both result tables | Enables efficient query-by-run_id in `/api/results` without scanning all tenant PKs |
| GSI `status-started_at-index` on `finops_runs` | Enables efficient latest-completed-run lookup without table scan |
| `okta_token` stored on `finops_runs` | Agents read the run's token from DynamoDB to forward to Datadog MCP — works for both manual (user token) and scheduled (M2M token) runs without passing tokens through function arguments |
| 90-day TTL on all tables | Retains ~3 months of nightly runs; prevents unbounded table growth |
| React frontend (not Gradio) | Hosted product with Okta SSO requires a proper web app; Gradio is for local dev tools only |
| ECS Fargate for backend | FastAPI must be always-on to serve the `/api/status` polling endpoint continuously during a run; Lambda cold starts would cause missed polls and stale progress UI |
