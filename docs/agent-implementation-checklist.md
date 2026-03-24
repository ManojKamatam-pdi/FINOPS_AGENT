# FinOps Agent — Implementation Checklist & Session Sync Guide

> **Purpose:** Every Claude session working on this codebase must read this first.
> This is the single source of truth for what the agent does, what's been fixed, what's known-correct, and what to never break.
> Last updated: 2026-03-24

---

## 1. THE AGENDA (What the Agent Must Do for Every Host)

The agenda is simple and provider-agnostic:

1. **What is provisioned?** — instance type, vCPU count, RAM GB (from Datadog metadata)
2. **What is actually used?** — CPU %, RAM %, Disk %, Network in/out (from metrics over 30 days)
3. **How much is really needed?** — right-size recommendation based on 30-day usage with safety headroom

This applies to **every host** regardless of cloud provider, environment, or whether the Datadog agent is installed.

---

## 2. HOW HOSTS SEND DATA TO DATADOG

### Tier 1 — Datadog Agent Installed on Host (`system.*` namespace)
The agent runs on the host OS and reports:

| Metric | What it measures | How to use |
|--------|-----------------|------------|
| `system.cpu.idle` | % CPU idle | `cpu_avg = 100 - idle` |
| `system.cpu.user` | % CPU user-space (fallback if idle unavailable) | `cpu_avg = value` |
| `system.mem.pct_usable` | Fraction of RAM available (0.0–1.0) | `ram_avg = 100 - (value * 100)` |
| `system.disk.in_use` | Fraction of disk used (0.0–1.0) | `disk_avg = value * 100` |
| `system.net.bytes_rcvd` | Network bytes received per second | `network_in = value` (bytes/sec) |
| `system.net.bytes_sent` | Network bytes sent per second | `network_out = value` (bytes/sec) |

**Works for:** AWS EC2 (with agent), Azure VM (with agent), GCP GCE (with agent), on-prem, bare-metal, VMware guest.

### Tier 2 — Cloud Integration (no agent required)

#### AWS (requires AWS account integration in Datadog)
| Metric | What it measures | Notes |
|--------|-----------------|-------|
| `aws.ec2.cpuutilization` | CPU % (0–100) | Already a percentage, no conversion |
| `aws.ec2.network_in` | Network bytes received | Already bytes/sec — **NO unit conversion needed** |
| `aws.ec2.network_out` | Network bytes sent | Already bytes/sec — **NO unit conversion needed** |
| ~~RAM~~ | **Not available** | CloudWatch does NOT expose RAM — null is correct |
| ~~Disk %~~ | **Not available** | EBS gives I/O throughput, not % full — null is correct |

**AWS without account integration:** Only `system.*` metrics available if agent is installed. No T2 metrics. `cloud_provider` may still be `"aws"` if EC2 alias (`i-*`) or `aws_account` tag is present.

#### Azure (requires Azure integration in Datadog)
| Metric | What it measures | Notes |
|--------|-----------------|-------|
| `azure.vm.percentage_cpu` | CPU % (0–100) | Already a percentage |
| `azure.vm.available_memory_bytes` | Free RAM in bytes | Needs `instance_ram_gb` to compute %: `ram = 100 - (value / (ram_gb * 1073741824)) * 100` |
| `azure.vm.network_in_total` | Network bytes received | bytes/sec |
| `azure.vm.network_out_total` | Network bytes sent | bytes/sec |
| ~~Disk %~~ | **Not available** | Azure Monitor gives throughput only — null is correct |

#### GCP (requires GCP integration in Datadog)
| Metric | What it measures | Notes |
|--------|-----------------|-------|
| `gcp.gce.instance.cpu.utilization` | CPU fraction (0.0–1.0) | **Must convert:** `cpu = value > 1.0 ? min(100, value) : min(100, value * 100)` |
| `gcp.gce.instance.memory.balloon.ram_used` | RAM used in bytes | Needs `instance_ram_gb`: `ram = (value / (ram_gb * 1073741824)) * 100` |
| `gcp.gce.instance.network.received_bytes_count` | Network bytes received | bytes/sec |
| `gcp.gce.instance.network.sent_bytes_count` | Network bytes sent | bytes/sec |
| ~~Disk %~~ | **Not available** | GCP gives I/O throughput only — null is correct |

#### VMware / On-Prem (requires vSphere integration in Datadog)
| Metric | What it measures | Notes |
|--------|-----------------|-------|
| `vsphere.cpu.usage.avg` | CPU % (0–100) | Already a percentage |
| `vsphere.mem.usage.average` | RAM % (0–100) | Already a percentage |
| `vsphere.disk.usage.avg` | Disk % (0–100) | Already a percentage |
| `vsphere.net.received.avg` | Network bytes received | bytes/sec |
| `vsphere.net.transmitted.avg` | Network bytes sent | bytes/sec |

---

## 3. CLOUD PROVIDER CLASSIFICATION — RULES & EVIDENCE

### Ground Truth from Datadog MCP (as of 2026-03-24)

**PDI-Enterprise:** 2034 AWS hosts (no instance_type in Datadog), 1375 hosts with no cloud_provider
**PDI-Orbis:** 168 AWS hosts (most with instance_type), 5 Azure hosts, 11 with no cloud_provider

### Classification Decision Order (highest confidence first)

| Priority | Evidence | Result |
|----------|----------|--------|
| 1 | `hostname_aliases` contains `i-[0-9a-f]{8,17}` | `"aws"` (EC2) |
| 2 | `sources` contains `"ecs"` or `"fargate"` | `"aws"` (ECS/Fargate) |
| 3 | `sources` contains `"vsphere"` or `"vmware"` | `"on-prem"` (VMware) |
| 4 | `instance_type` column in Datadog is AWS format (t2/t3/m5/c5/r5/m6i…) | `"aws"` |
| 5 | `instance_type` column is Azure format (`Standard_*`) | `"azure"` |
| 6 | `instance_type` column is GCP format (`n1-*/n2-*/e2-*`) | `"gcp"` |
| 7 | Tag `region:us-east-*` / `eu-*` / `ap-*` (full AWS format `prefix-name-digit`) | `"aws"` |
| 8 | Tag `region:eastus` / `westus` / `northeurope` etc. | `"azure"` |
| 9 | Tag `region:us-central1` / `europe-west*` / `asia-east*` | `"gcp"` |
| 10 | Tag `cloud_provider:aws/azure/gcp` or `subscriptionid:*` or `project_id:*` | use that value |
| 11 | Tag `aws_account:*` | `"aws"` |
| 12 | T2 probe: `vsphere.cpu.usage.avg` returns data | `"on-prem"` |
| 13 | T2 probe: `aws.ec2.cpuutilization` returns data | `"aws"` |
| 14 | T2 probe: `azure.vm.percentage_cpu` returns data | `"azure"` |
| 15 | T2 probe: `gcp.gce.instance.cpu.utilization` returns data | `"gcp"` |
| 16 | All T2 probes return nothing | `"unknown"` — **NOT "on-prem"** |

### Critical Rules — Never Break These

- ✅ `"unknown"` is a valid, correct result — do not force a provider when evidence is absent
- ✅ `"on-prem"` requires **positive vsphere evidence** (rule 3 or 12 above) — nothing else
- ✅ "No cloud tags" = `"unknown"`, NOT `"on-prem"`
- ✅ "Only system.* metrics" = `"unknown"`, NOT `"on-prem"` (could be EC2 with agent, no integration)
- ✅ GCP region `us-central1` must NOT match AWS region pattern — AWS requires `prefix-name-digit` format
- ✅ `"unknown"` hosts still get full metric collection and right-sizing (PATH 4 or PATH 5)

### Canonical cloud_provider Values
```
"aws" | "azure" | "gcp" | "on-prem" | "unknown"
```
**Never write:** `"on-premise"`, `"on-premises"`, `"bare-metal"`, `"vmware"`, `"on-prem/unknown"`, `"unknown/on-prem"`, `"unknown (on-prem/untagged)"`, `"on-prem/untagged"`

---

## 4. INSTANCE TYPE — AUTHORITATIVE SOURCE RULES

### Where instance_type Comes From (in priority order)

1. **`instance_type` column** returned by `search_datadog_hosts` DDSQL query — Datadog's own metadata
2. **`instance-type:<value>` tag** in the host's tags object from `search_datadog_hosts`
3. **Nothing else** — hostname, naming convention, role, environment, memory size, CPU count → all forbidden

### Server-Side Enforcement (host-batch-server.ts)

The `write_host_result_tool` accepts a `dd_host_metadata` parameter (the raw `search_datadog_hosts` row). When provided:
- Server extracts `instance_type` from `ddMeta.instance_type` (Datadog column) first
- Falls back to `instance-type` tag in `ddMeta.tags`
- **Ignores** the agent's `result_json.instance_type` entirely
- Only uses agent's value when `dd_host_metadata` is absent (host not found in Datadog)

### Known Reality (from MCP validation 2026-03-24)

**PDI-Enterprise `c*` hosts** (e.g. `c00746-dc01`, `c1634-12`, `c2041-06`):
- Datadog `instance_type` column = **empty**
- No `instance-type` tag
- Correct value = `null`
- Previous agent was hallucinating types like `t3.small`, `m5.large` from hostname patterns

**PDI-Orbis named hosts** (e.g. `prod-pos-mt-asg-app-sg-10.70.18.20`):
- Datadog `instance_type` column = real value (e.g. `m5a.large`)
- Tags also contain `instance-type:m5a.large`
- Both sources agree — correct

---

## 5. METRIC COLLECTION STRATEGY

### Execution Order (efficiency-first)

**PASS 1 — Issue all T1 queries simultaneously** (regardless of cloud_provider):
```
avg:system.cpu.idle{host:<name>}            → cpu_avg = 100 - value
percentile(95):system.cpu.idle{host:<name>} → cpu_p95 = 100 - value
avg:system.mem.pct_usable{host:<name>}      → ram_avg = 100 - (value * 100)
avg:system.net.bytes_rcvd{host:<name>}      → network_in (bytes/sec)
avg:system.net.bytes_sent{host:<name>}      → network_out (bytes/sec)
avg:system.disk.in_use{host:<name>}         → disk_avg = value * 100
```

**PASS 2 — T2 fallback only for metrics still null after PASS 1**
(Skip T2 entirely only for confirmed on-prem hosts — vsphere app tag or vsphere T2 probe data)

### Known Null Cases (null is CORRECT, not a bug)

| Provider | Metric | Why null is correct |
|----------|--------|---------------------|
| AWS (agentless) | `ram_avg_30d` | CloudWatch has no RAM metric |
| AWS (agentless) | `disk_avg_30d` | EBS gives I/O throughput, not % full |
| Azure (agentless) | `disk_avg_30d` | Azure Monitor gives throughput only |
| GCP (agentless) | `disk_avg_30d` | GCP integration gives throughput only |
| ECS/Fargate | All metrics | Metrics scoped to cluster/task, not host |

---

## 6. RIGHT-SIZING PATH DECISION TREE

```
instance_type known + cpu + ram available  → PATH 1 (AWS catalog right-sizing)
instance_type known + cpu only (no RAM)    → PATH 2 (universal, note RAM unavailable)
instance_type known + no metrics at all    → PATH 3 (get price, label=unknown)
Azure/GCP instance_type + cpu + ram        → PATH 1 → catalog_not_available → PATH 4
Azure/GCP instance_type + cpu only         → PATH 4 (universal rightsizing)
Azure/GCP instance_type + no metrics       → PATH 5
null instance_type + any metrics           → PATH 4 (universal rightsizing)
null instance_type + no metrics            → PATH 5
"unknown" cloud_provider + any metrics     → PATH 4 (treat like null instance_type)
"unknown" cloud_provider + no metrics      → PATH 5
```

### PATH 3 Mandatory Step
When `cloud_provider = "aws"` AND `instance_type` is known AND no metrics:
**MUST call `get_instance_on_demand_price_tool` before `write_host_result_tool`.**
`current_monthly_cost` must be populated. Never leave it null for PATH 3.

---

## 7. EFFICIENCY LABEL RULES (server-side, always recomputed)

Applied in order — first match wins:

1. `cpu_p95 > 80%` OR `ram_avg > 85%` OR `disk_avg > 85%` → `"under-provisioned"`
2. `cpu_p95 < 20%` AND `ram_avg < 40%` → `"over-provisioned"`
3. Any metric data present (neither above) → `"right-sized"`
4. cpu, ram, AND disk all null → `"unknown"`

**Network throughput does NOT affect efficiency label** — informational only.
**Label is always recomputed server-side** — agent's submitted value is ignored.

---

## 8. PERFORMANCE CONFIGURATION

| Parameter | Current Value | File | Rationale |
|-----------|--------------|------|-----------|
| `BATCH_SIZE` | 15 | `org-agent.ts:7` | 15 hosts × ~13 turns avg = ~195 turns |
| `BATCH_CONCURRENCY` | 30 | `org-agent.ts:8` | 30 batches run in parallel per wave |
| `maxTurns` | 200 | `host-batch-agent.ts:415` | Fits 15 hosts with headroom |

### Turn Budget per Host (approximate)
- Step A: 1 search + up to 4 T2 probes (if unknown) = 1–5 turns
- Step B PASS 1: 6 T1 queries = 6 turns (but reuses T2 probe results from Step A)
- Step B PASS 2: 0–4 T2 fallback queries
- Step C: 1 specs lookup (if instance_type known)
- Step D: 1–3 right-sizing tool calls
- Step E: 1 write
- **Total: ~8–13 turns per host** (best case 8, worst case 18 for unknown provider)

### Wave Math for 3533 hosts
- 3533 hosts ÷ 15 per batch = 236 batches
- 236 batches ÷ 30 concurrency = 8 waves
- Each wave: ~30 batches × ~13 turns × ~2s/turn = ~780s ≈ 13 min per wave
- Total: ~8 waves × 13 min = ~104 min (vs ~180 min with BATCH_SIZE=10)

### Further Optimization Opportunities
1. **Pre-fetch host metadata in bulk** — query all hosts in a batch with a single DDSQL `WHERE hostname IN (...)` before the agent starts, inject into the prompt. Saves 1 `search_datadog_hosts` call per host = 15 turns per batch.
2. **Skip T2 probes for confirmed AWS hosts** — if `hostname_aliases` contains `i-*` or `aws_account` tag present, skip T2 probe entirely in Step A.
3. **Batch metric queries** — `get_datadog_metric` accepts multiple `queries` in one call. Issue all 6 T1 metrics in a single call instead of 6 separate calls. Saves 5 turns per host = 75 turns per batch.

---

## 9. UI DISPLAY — WHAT SHOWS WHERE

### Host Table (HostTable.tsx)
Columns shown: Host, Tenant, Cloud, Instance Type, CPU avg, RAM avg, Current $/mo, Suggested, Savings $/mo, Label

**Disk and Network are NOT table columns** — they only appear in the expanded detail row.

### Host Detail Row (HostDetailRow.tsx)
Shows when a row is clicked:
- 30-Day Utilisation: CPU avg/p95, RAM avg, Disk avg (if not null), Network in/out (if not null)
- Instance Info: cloud, region, instance type, vCPU, RAM GB
- Right-Sizing: suggested instance, current cost, suggested cost, savings

### Filter Behavior (HostTable.tsx lines 87–103)
When a utilization filter is active, hosts with **null data for that metric are excluded** (not included).
This is correct: "show me hosts with RAM ≤ 20%" should not include hosts with no RAM data.

```typescript
// CPU filter — null hosts excluded when filter active
if (filters.cpuMax !== null && (h.cpu_avg_30d === null || h.cpu_avg_30d > filters.cpuMax)) return false;
// RAM filter — null hosts excluded when filter active
if (filters.ramMax !== null && (h.ram_avg_30d === null || h.ram_avg_30d > filters.ramMax)) return false;
// Disk filter — null hosts excluded when filter active
if (filters.diskMax !== null && (h.disk_avg_30d === null || h.disk_avg_30d > filters.diskMax)) return false;
// Network filter — null hosts excluded; converts bytes/sec to MB/day correctly
if (filters.netMax !== null) {
  if (h.network_in_avg_30d === null && h.network_out_avg_30d === null) return false;
  const totalMBPerDay = (netIn + netOut) * 86400 / (1024 * 1024);
  if (totalMBPerDay > filters.netMax) return false;
}
```

---

## 10. KNOWN BUGS — FIXED (do not reintroduce)

| # | Bug | Fix Applied | Where |
|---|-----|-------------|-------|
| 1 | `system.* data + no T2 data → "on-prem"` | Rule 8 now sets `"unknown"` | host-batch-agent.ts |
| 2 | Non-canonical cloud_provider values (`"on-prem/unknown"` etc.) | `providerNormMap` + canonical safety net | host-batch-server.ts |
| 3 | Unknown hosts skipping metric collection | Explicit rule: unknown hosts try T1 + all T2 | host-batch-agent.ts |
| 4 | GCP CPU values > 100 (missing clamp) | `value > 1.0 ? min(100,value) : min(100,value*100)` | host-batch-agent.ts |
| 5 | AWS network values inflated 17× (KiB/min conversion) | Removed conversion — Datadog already normalizes to bytes/sec | host-batch-agent.ts |
| 6 | RAM assumed as 50% when unavailable | PATH 2 uses `ram_avg_pct=null`, tool returns `ram_unavailable=true` | host-batch-server.ts |
| 7 | Azure/GCP T2 RAM conversion when `instance_ram_gb` is null | Explicit null guard before conversion | host-batch-agent.ts |
| 8 | PATH 3 missing `current_monthly_cost` | Mandatory `get_instance_on_demand_price_tool` call enforced | host-batch-agent.ts |
| 9 | Azure/GCP + CPU-only not routed to PATH 4 | Added to PATH selection rules | host-batch-agent.ts |
| 10 | `"unknown"` cloud_provider not in PATH selection | Added PATH 4/5 routing for unknown | host-batch-agent.ts |
| 11 | VMware hosts missing T2 RAM metric | Added `vsphere.mem.usage.average` | host-batch-agent.ts |
| 12 | AWS region regex matching GCP `us-central1` | Regex requires full format `prefix-name-digit` | host-batch-server.ts |
| 13 | Min CPU suggestion was 1 vCPU | Changed to `Math.max(2, ...)` | host-batch-server.ts |
| 14 | Efficiency label mislabeling (agent's value trusted) | Label always recomputed server-side from metrics | host-batch-server.ts |
| 15 | Empty recommendations when agent hits max_turns | Server-side fallback synthesis from metric data | host-batch-server.ts |
| 16 | Negative monthly_savings | `Math.max(0, ...)` floor applied | host-batch-server.ts |
| 17 | RAM/CPU/disk filter passing null-data hosts through | AND condition → OR condition in filter logic | HostTable.tsx |
| 18 | Network filter treating null as 0 MB/day | Null network hosts excluded when filter active | HostTable.tsx |
| 19 | Network unit conversion wrong (bytes/sec → MB/day) | Fixed: `× 86400 / (1024*1024)` | HostTable.tsx |
| 20 | Agent hallucinating instance_type from hostname | `dd_host_metadata` passed to write tool; server extracts from Datadog directly | host-batch-server.ts + host-batch-agent.ts |

---

## 11. OUTPUT SCHEMA — ALL 23 FIELDS REQUIRED

Every host result must have all these fields. `null` is valid; absent/missing is a bug.

| Field | Type | Valid Values |
|-------|------|-------------|
| `host_name` | string | hostname |
| `cloud_provider` | string | `"aws"` \| `"azure"` \| `"gcp"` \| `"on-prem"` \| `"unknown"` |
| `cpu_avg_30d` | float \| null | 0–100 |
| `cpu_p95_30d` | float \| null | 0–100 |
| `ram_avg_30d` | float \| null | 0–100 |
| `network_in_avg_30d` | float \| null | bytes/sec |
| `network_out_avg_30d` | float \| null | bytes/sec |
| `disk_avg_30d` | float \| null | 0–100 |
| `instance_type` | string \| null | from Datadog only |
| `instance_region` | string \| null | from tags only |
| `instance_cpu_count` | integer \| null | from get_instance_specs_tool |
| `instance_ram_gb` | float \| null | from get_instance_specs_tool |
| `has_instance_tag` | boolean | true if instance_type not null |
| `catalog_data_available` | boolean | true if AWS pricing found |
| `current_monthly_cost` | float \| null | USD |
| `suggested_instance` | string \| null | from suggest tool |
| `suggested_monthly_cost` | float \| null | USD |
| `monthly_savings` | float \| null | ≥ 0 USD |
| `savings_percent` | float \| null | 0–100 |
| `pricing_calc_url` | string \| null | URL |
| `efficiency_score` | integer \| null | 0–100 |
| `efficiency_label` | string | `"over-provisioned"` \| `"right-sized"` \| `"under-provisioned"` \| `"unknown"` |
| `recommendation` | string | complete sentence ≥ 15 words |

---

## 12. KEY FILES

| File | Purpose |
|------|---------|
| `packages/agent/src/agents/host-batch-agent.ts` | Agent system prompt — all classification, metric, and right-sizing rules |
| `packages/agent/src/agents/org-agent.ts` | Orchestrator — BATCH_SIZE, BATCH_CONCURRENCY, wave execution |
| `packages/agent/src/mcp-servers/host-batch-server.ts` | MCP tools — write_host_result_tool (server-side normalization, label recompute, instance_type validation) |
| `packages/agent/src/config/dd-org-registry.json` | Datadog org credentials (PDI-Enterprise, PDI-Orbis) |
| `packages/agent/src/config/mcp-registry.ts` | Builds HTTP MCP server configs from registry |
| `packages/agent/src/tools/aws-instances.ts` | EC2 instance specs + right-sizing math |
| `packages/agent/src/tools/aws-pricing.ts` | AWS public pricing API (no credentials needed) |
| `packages/frontend/src/components/HostTable.tsx` | Host table with filters, sorting, column display |
| `packages/frontend/src/components/HostDetailRow.tsx` | Expanded row — disk, network, right-sizing detail |
| `docs/host-analysis-validation-checklist.md` | Validation checklist for running against exported JSON reports |

---

## 13. HOW TO VALIDATE A REPORT WITH MCP

Use the Datadog MCP directly (HTTP, no OAuth):

```javascript
// PDI-Enterprise
const API_KEY = 'fd296ead14f55dfa8e1fcbc95ecbff02';
const APP_KEY = '7bf7c6ee7d99f7454965986584a0722154886a2b';

// PDI-Orbis
const API_KEY = 'f9e7d19c4687186323e79aaa0620468a';
const APP_KEY = '637d46c17bb8e1ddce8ba6eadf65331fc86282ec';

const MCP_URL = 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp?toolsets=core';
```

**Init session:** POST with `method: "initialize"`, get `mcp-session-id` from response headers.
**Query hosts:** `search_datadog_hosts` tool with `query: "SELECT hostname, instance_type, cloud_provider, tags, hostname_aliases, sources FROM hosts WHERE hostname = 'X'"`.
**Query metrics:** `get_datadog_metric` tool with `queries: ["avg:system.cpu.idle{host:X}"]`, `from: "now-30d"`, `to: "now"`.

**MCP-validated facts (2026-03-24):**
- PDI-Enterprise: 2034 AWS hosts, 1375 unknown — **zero have instance_type in Datadog**
- PDI-Orbis: 168 AWS hosts with real instance_types, 5 Azure, 11 unknown
- `prod-pos-mt-asg-app-sg-10.70.18.20`: disk, network, CPU, RAM all have 30-day data in Datadog
- `c00746-dc01`: instance_type empty in Datadog — agent was hallucinating `t3.small`

---

*This document reflects the implementation as of 2026-03-24. Update Section 10 when new bugs are fixed.*
