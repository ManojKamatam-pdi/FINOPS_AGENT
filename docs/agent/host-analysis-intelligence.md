# Host Analysis Intelligence — Per-Scenario Reference

This document describes exactly how the FinOps host batch agent analyzes each host depending on its infrastructure type, what data is collected, which analysis path is taken, and what the output contains. It covers every supported scenario including gaps that are platform limitations (not agent limitations).

---

## How the Agent Works — Overview

The analysis pipeline has two stages: a **pre-fetch phase** that runs once per org, followed by **batch agents** that process hosts in parallel.

### Stage 1 — Org-Wide Metric Pre-Fetch

Before any batch agent runs, `metric-prefetch-agent.ts` fetches all 23 metrics for every known host using explicit host-scoped queries. The strategy is chosen at runtime based on org size:

**Orgs with ≤ 1 000 hosts — wildcard path (23 calls total):**
```
avg:system.cpu.idle{*} by {host}
avg:system.mem.pct_usable{*} by {host}
... (23 metrics, one call each)
```

**Orgs with > 1 000 hosts — chunked explicit-scope path:**
```
avg:system.cpu.idle{host:h1 OR host:h2 OR ... OR host:h80} by {host}
avg:system.cpu.idle{host:h81 OR host:h82 OR ... OR host:h160} by {host}
... (chunks × 23 metrics, all run with bounded concurrency)
```

Chunk size is computed from the actual hostname lengths in the org so the query string always fits within safe URL limits. For 3 406 hosts with typical AWS FQDNs (~46 chars), this yields ~35 chunks × 23 metrics = **805 calls** — compared to the old per-host approach of 3 406 × 17 = **57 902 calls** (36× reduction).

Every host is explicitly named in a chunk. **100% coverage is guaranteed — there are no cache misses.** Results are stored in DynamoDB (`finops_metric_cache` table) keyed by `(tenant_id, run_id, metric_name)`.

### Stage 2 — Batch Agent Processing

Every host goes through five phases, executed in parallel across all hosts in a batch:

| Phase | What happens |
|---|---|
| **A — Classify** | `search_datadog_hosts` → determine `cloud_provider`, `instance_type`, `host_subtype` from tags/aliases/apps. T2 classification (rule 7) reads directly from the pre-fetched cache — no extra Datadog calls. |
| **B — Collect metrics** | `get_prefetched_metrics_tool` → returns all T1 + T2 values from cache. Apply transformations to get canonical fields. No per-host Datadog metric calls. |
| **C — Instance specs** | `get_instance_specs_tool` → `instance_cpu_count`, `instance_ram_gb` (AWS catalog only) |
| **D — Right-size** | Choose PATH 1–5 based on available data → recommendation + cost |
| **E — Write result** | `write_host_result_tool` → persisted to DynamoDB |

Phases A and B are issued simultaneously in the same turn for all hosts in the batch (both are independent). The agent completes all hosts in as few turns as possible.

---

## Metric Coverage — Complete Audit

Every metric the agent needs for every cloud provider and scenario is pre-fetched. The table below shows the full coverage:

### T1 — Datadog Agent (`system.*` namespace)
Available when the Datadog agent is installed directly on the host.

| Pre-fetched metric | Cache key | Field | Computation |
|---|---|---|---|
| `avg:system.cpu.idle` | `system.cpu.idle` | `cpu_avg_30d` | `100 - value` (system.cpu.idle is 0–100%) |
| `avg:system.cpu.idle.rollup(p95, 3600)` | `system.cpu.idle.p95` | `cpu_p95_30d` | `100 - value` (rollup p95 of hourly buckets) |
| `avg:system.mem.pct_usable` | `system.mem.pct_usable` | `ram_avg_30d` | `100 - value` (system.mem.pct_usable is 0–100%) |
| `avg:system.disk.in_use` | `system.disk.in_use` | `disk_avg_30d` | `value × 100` (system.disk.in_use is fraction 0–1) |
| `avg:system.net.bytes_rcvd` | `system.net.bytes_rcvd` | `network_in_avg_30d` | bytes/sec direct |
| `avg:system.net.bytes_sent` | `system.net.bytes_sent` | `network_out_avg_30d` | bytes/sec direct |

### T2 — AWS EC2 (CloudWatch via Datadog integration)

| Pre-fetched metric | Cache key | Field | Notes |
|---|---|---|---|
| `avg:aws.ec2.cpuutilization` | `aws.ec2.cpuutilization` | `cpu_avg_30d` | Used if T1 null |
| `avg:aws.ec2.cpuutilization.rollup(p95, 3600)` | `aws.ec2.cpuutilization.p95` | `cpu_p95_30d` | Used if T1 null |
| `avg:aws.ec2.network_in` | `aws.ec2.network_in` | `network_in_avg_30d` | Used if T1 null |
| `avg:aws.ec2.network_out` | `aws.ec2.network_out` | `network_out_avg_30d` | Used if T1 null |
| RAM | — | `ram_avg_30d` | ❌ **Platform limitation** — CloudWatch does not expose RAM |
| Disk % | — | `disk_avg_30d` | ❌ **Platform limitation** — EBS exposes throughput only, not % full |

### T2 — Azure VM (Azure Monitor via Datadog integration)

| Pre-fetched metric | Cache key | Field | Notes |
|---|---|---|---|
| `avg:azure.vm.percentage_cpu` | `azure.vm.percentage_cpu` | `cpu_avg_30d` | Used if T1 null |
| `avg:azure.vm.available_memory_bytes` | `azure.vm.available_memory_bytes` | `ram_avg_30d` | Raw bytes → compute % after Step C: `100 - (bytes / (instance_ram_gb × 1073741824)) × 100`. Null if `instance_ram_gb` unavailable. |
| `avg:azure.vm.network_in_total` | `azure.vm.network_in_total` | `network_in_avg_30d` | Used if T1 null |
| `avg:azure.vm.network_out_total` | `azure.vm.network_out_total` | `network_out_avg_30d` | Used if T1 null |
| CPU p95 | — | `cpu_p95_30d` | ❌ **Platform limitation** — Azure Monitor does not expose p95 CPU |
| Disk % | — | `disk_avg_30d` | ❌ **Platform limitation** — Azure Monitor exposes throughput only |

### T2 — GCP GCE (GCP integration via Datadog)

| Pre-fetched metric | Cache key | Field | Notes |
|---|---|---|---|
| `avg:gcp.gce.instance.cpu.utilization` | `gcp.gce.instance.cpu.utilization` | `cpu_avg_30d` | `value > 1.0 ? min(100, value) : min(100, value × 100)` |
| `avg:gcp.gce.instance.memory.balloon.ram_used` | `gcp.gce.instance.memory.balloon.ram_used` | `ram_avg_30d` | Raw bytes → compute % after Step C: `(bytes / (instance_ram_gb × 1073741824)) × 100`. Null if `instance_ram_gb` unavailable. |
| `avg:gcp.gce.instance.network.received_bytes_count` | `gcp.gce.instance.network.received_bytes_count` | `network_in_avg_30d` | Used if T1 null |
| `avg:gcp.gce.instance.network.sent_bytes_count` | `gcp.gce.instance.network.sent_bytes_count` | `network_out_avg_30d` | Used if T1 null |
| CPU p95 | — | `cpu_p95_30d` | ❌ **Platform limitation** — GCP integration does not expose p95 CPU |
| Disk % | — | `disk_avg_30d` | ❌ **Platform limitation** — GCP integration does not expose disk space % |

### T2 — VMware vSphere (vSphere integration via Datadog)

VMware is the **most complete T2 integration** — exposes CPU, RAM, and network without the Datadog agent. Disk space % is not available (vSphere exposes I/O throughput only).

| Pre-fetched metric | Cache key | Field | Notes |
|---|---|---|---|
| `avg:vsphere.cpu.usage.avg` | `vsphere.cpu.usage.avg` | `cpu_avg_30d` | Already 0–100, no transform |
| `avg:vsphere.mem.usage.average` | `vsphere.mem.usage.average` | `ram_avg_30d` | Already 0–100, no transform |
| `avg:vsphere.disk.usage.avg` | `vsphere.disk.usage.avg` | — | ⚠️ **Disk I/O throughput in KBps** — NOT disk space %. Informational only. `disk_avg_30d` stays null for VMware-only hosts. |
| `avg:vsphere.net.received.avg` | `vsphere.net.received.avg` | `network_in_avg_30d` | KBps → `× 1024` → bytes/sec |
| `avg:vsphere.net.transmitted.avg` | `vsphere.net.transmitted.avg` | `network_out_avg_30d` | KBps → `× 1024` → bytes/sec |
| CPU p95 | — | `cpu_p95_30d` | ❌ **Platform limitation** — vSphere integration does not expose p95 aggregation |
| Disk % | — | `disk_avg_30d` | ❌ **Platform limitation** — vSphere exposes I/O throughput (KBps), not disk space % |

### Priority Rule — T1 always wins over T2

When both T1 and T2 values are non-null for the same field, T1 (Datadog agent) takes precedence as it is more precise (measured directly on the host vs. sampled by the cloud platform).

| Field | T1 source | T2 fallback (in priority order) |
|---|---|---|
| `cpu_avg_30d` | `system.cpu.idle` | `aws.ec2.cpuutilization` → `azure.vm.percentage_cpu` → `gcp.gce.instance.cpu.utilization` → `vsphere.cpu.usage.avg` |
| `cpu_p95_30d` | `system.cpu.idle.p95` | `aws.ec2.cpuutilization.p95` (only AWS has T2 p95) |
| `ram_avg_30d` | `system.mem.pct_usable` | `vsphere.mem.usage.average` → Azure/GCP raw bytes (needs `instance_ram_gb`) |
| `disk_avg_30d` | `system.disk.in_use` | No T2 fallback — `vsphere.disk.usage.avg` is I/O throughput (KBps), not disk space %. AWS/Azure/GCP have no disk space % T2 either. |
| `network_in_avg_30d` | `system.net.bytes_rcvd` | `aws.ec2.network_in` → `azure.vm.network_in_total` → `gcp received` → `vsphere.net.received.avg` |
| `network_out_avg_30d` | `system.net.bytes_sent` | `aws.ec2.network_out` → `azure.vm.network_out_total` → `gcp sent` → `vsphere.net.transmitted.avg` |

---

## Classification Logic (Step A)

The agent applies these rules in strict priority order — stops at the first match:

1. **EC2 alias** — alias matches `i-[0-9a-f]{8,17}` → `aws / ec2`
2. **App/source tags** — `ecs` → `aws/ecs`, `fargate` → `aws/fargate`, `vsphere`/`vmware` → `on-prem/vmware`, `azure` → `azure`, `gcp`/`google` → `gcp`, `kubernetes`/`k8s` → `host_subtype=kubernetes_node` (continue classifying)
3. **Instance-type tag** — AWS format (`t3.*`, `m5.*`, etc.) → `aws`, Azure format (`Standard_*`) → `azure`, GCP format (`n1-*`, `n2-*`) → `gcp`
4. **Region/AZ tag** — AWS region pattern → `aws`, Azure region name → `azure`, GCP region name → `gcp`
5. **Explicit cloud tag** — `cloud_provider:aws/azure/gcp`, `subscriptionid:*` → `azure`, `project_id:*` → `gcp`
6. **AWS account tag** — `aws_account:*` → `aws` (instance type still unknown)
7. **T2 namespace check from cache** — if still unknown, inspect the pre-fetched metrics map directly (no extra Datadog calls): `aws.ec2.cpuutilization` non-null → `aws/ec2`, `azure.vm.percentage_cpu` non-null → `azure`, `gcp.gce.instance.cpu.utilization` non-null → `gcp`, `vsphere.cpu.usage.avg` non-null → `on-prem/vmware`. The T2 CPU value is reused as `cpu_avg_30d` in Step B.
8. **All T2 cache values null** → `cloud_provider = "unknown"` (NOT assumed on-prem — absence of cloud metrics is not evidence of on-prem)

---

## Per-Scenario Analysis

---

### Scenario 1 — AWS EC2 with Datadog Agent + Account Integration

**Tags present:** `instance-type:m5.large`, `region:us-east-1`, `aws_account:123456789`
**Metrics available:** T1 `system.*` (agent) + T2 `aws.ec2.*` (integration)

**Step A:** `instance-type` tag → `cloud_provider = "aws"`, `instance_type = "m5.large"` — done at rule 3.

**Step B (from cache):**
- `system.cpu.idle` → `cpu_avg_30d` ✅
- `system.cpu.idle.p95` → `cpu_p95_30d` ✅
- `system.mem.pct_usable` → `ram_avg_30d` ✅
- `system.disk.in_use` → `disk_avg_30d` ✅
- `system.net.bytes_rcvd/sent` → `network_in/out_avg_30d` ✅
- T2 AWS values also present in cache but T1 takes priority.

**Step C:** `get_instance_specs_tool("m5.large", "us-east-1")` → `instance_cpu_count = 2`, `instance_ram_gb = 8`

**Step D — PATH 1:** `suggest_right_sized_instance_tool(cpu_p95, ram_avg, "m5.large", "us-east-1")` → full AWS catalog right-sizing with `current_monthly_cost`, `suggested_instance`, `monthly_savings`, `savings_percent`, `pricing_calc_url`

**Output:** Complete — all metrics, instance specs, cost, suggested instance, savings, pricing URL.

---

### Scenario 2 — AWS EC2 with Datadog Agent Only (No Account Integration Tags)

**Tags present:** None (or only generic tags — no `instance-type`, no `aws_account`)
**Metrics available:** T1 `system.*` only

**Step A:** Rules 1–6 all miss → rule 7: check cache. `aws.ec2.cpuutilization` is non-null → `cloud_provider = "aws"`, `cpu_avg_30d` captured from cache value.

**Step B (from cache):**
- T1 `system.*` values all present → full metrics. T1 `system.cpu.idle` overwrites the T2 cpu value (T1 is more precise).

**Step C:** No `instance_type` → skipped. `instance_cpu_count = null`, `instance_ram_gb = null`.

**Step D — PATH 4:** `suggest_universal_rightsizing_tool` with all available metrics → efficiency label + recommendation with suggested vCPU/RAM reduction based on actual utilization percentages.

**Output:** Full utilization data (cpu, ram, network, disk). No cost, no specific instance suggestion — `instance_type` is unknown without the account integration tag. Recommendation: "CPU averaged X%, RAM averaged Y% — over-provisioned; consider reducing vCPUs from 8 to ~2."

---

### Scenario 3 — AWS EC2 with Account Integration Only (No Datadog Agent)

**Tags present:** `instance-type:m5.large`, `region:us-east-1`
**Metrics available:** T2 `aws.ec2.*` only

**Step A:** `instance-type` tag → `cloud_provider = "aws"`, `instance_type = "m5.large"` — done at rule 3.

**Step B (from cache):**
- `system.cpu.idle` → null (no agent)
- `aws.ec2.cpuutilization` → `cpu_avg_30d` ✅
- `aws.ec2.cpuutilization.p95` → `cpu_p95_30d` ✅
- `aws.ec2.network_in/out` → `network_in/out_avg_30d` ✅
- RAM → null ❌ (AWS CloudWatch platform limitation)
- Disk → null ❌ (EBS platform limitation)

**Step C:** `get_instance_specs_tool("m5.large")` → `instance_cpu_count`, `instance_ram_gb`

**Step D — PATH 2:** CPU available, RAM null → `suggest_universal_rightsizing_tool(cpu_p95, ram_avg_pct=null, ...)` + `get_instance_on_demand_price_tool` → `current_monthly_cost` populated.

**Output:** CPU + network metrics. RAM and disk null (platform limitation). Cost populated. Recommendation includes: "RAM utilization unavailable — verify RAM before acting on this recommendation."

---

### Scenario 4 — Azure VM with Datadog Agent

**Tags present:** `instance-type:Standard_D4s_v3`, `region:eastus`
**Metrics available:** T1 `system.*`

**Step A:** `instance-type` tag Azure format → `cloud_provider = "azure"`, `instance_type = "Standard_D4s_v3"` — done at rule 3.

**Step B (from cache):**
- All T1 `system.*` values present → full metrics including disk ✅

**Step C:** `get_instance_specs_tool("Standard_D4s_v3")` → returns `catalog_not_available` (Azure not in AWS pricing catalog). `instance_cpu_count` and `instance_ram_gb` remain null.

**Step D — PATH 1 → catalog_not_available → PATH 4:** `suggest_universal_rightsizing_tool` with all metrics → efficiency label + resource reduction recommendation.

**Output:** Full utilization data. No dollar cost (Azure pricing not integrated). Recommendation: "CPU averaged X%, RAM averaged Y%, disk at Z% — over-provisioned; consider reducing vCPUs from 4 to ~2 and RAM from 16 GB to ~6 GB."

---

### Scenario 5 — Azure VM with Azure Monitor Integration Only (No Agent)

**Tags present:** `instance-type:Standard_D4s_v3`, `region:eastus`
**Metrics available:** T2 `azure.vm.*` only

**Step A:** `instance-type` tag → `cloud_provider = "azure"`, `instance_type = "Standard_D4s_v3"`.

**Step B (from cache):**
- `system.cpu.idle` → null (no agent)
- `azure.vm.percentage_cpu` → `cpu_avg_30d` ✅
- `azure.vm.available_memory_bytes` → raw bytes collected; RAM % computed after Step C
- `azure.vm.network_in/out_total` → `network_in/out_avg_30d` ✅
- CPU p95 → null ❌ (Azure Monitor platform limitation)
- Disk → null ❌ (Azure Monitor platform limitation)

**Step C:** `get_instance_specs_tool("Standard_D4s_v3")` → `catalog_not_available`. `instance_ram_gb = null` → Azure RAM % conversion skipped, `ram_avg_30d = null`.

**Step D — PATH 4:** `suggest_universal_rightsizing_tool` with cpu + network (ram null).

**Output:** CPU + network. RAM null (raw bytes unusable without `instance_ram_gb`). Disk null (platform limitation). No cost.

---

### Scenario 6 — GCP Instance with Datadog Agent

**Tags present:** `instance-type:n2-standard-4`, `region:us-central1`
**Metrics available:** T1 `system.*`

**Step A:** `instance-type` tag GCP format → `cloud_provider = "gcp"`, `instance_type = "n2-standard-4"`.

**Step B (from cache):** All T1 `system.*` values present → full metrics ✅

**Step C:** `get_instance_specs_tool("n2-standard-4")` → `catalog_not_available`.

**Step D — PATH 1 → catalog_not_available → PATH 4:** `suggest_universal_rightsizing_tool`.

**Output:** Full utilization data. No cost. Resource-based recommendation.

---

### Scenario 7 — GCP Instance with GCP Integration Only (No Agent)

**Tags present:** `instance-type:n2-standard-4`, `region:us-central1`
**Metrics available:** T2 `gcp.gce.*` only

**Step B (from cache):**
- `system.cpu.idle` → null (no agent)
- `gcp.gce.instance.cpu.utilization` → `cpu_avg_30d` (×100 if ≤1.0, clamped 0–100) ✅
- `gcp.gce.instance.memory.balloon.ram_used` → raw bytes; RAM % needs `instance_ram_gb` — null for GCP → `ram_avg_30d = null`
- `gcp.gce.instance.network.received/sent_bytes_count` → `network_in/out_avg_30d` ✅
- CPU p95 → null ❌ (GCP integration platform limitation)
- Disk → null ❌ (GCP integration platform limitation)

**Output:** CPU + network. RAM and disk null. No cost.

---

### Scenario 8 — VMware / On-Prem with Datadog Agent

**Tags present:** `app: vsphere` (or `vmware`)
**Metrics available:** T1 `system.*`

**Step A:** App `vsphere` → `cloud_provider = "on-prem"`, `host_subtype = "vmware"` — done at rule 2. T2 cloud checks skipped entirely (confirmed on-prem).

**Step B (from cache):** All T1 `system.*` values present → full metrics ✅

**Step C:** No `instance_type` for on-prem → skipped.

**Step D — PATH 4:** `suggest_universal_rightsizing_tool` with all metrics.

**Output:** Full utilization data (cpu, ram, network, disk). No cost (on-prem has no cloud pricing). Recommendation with vCPU/RAM reduction guidance.

---

### Scenario 9 — VMware / On-Prem with vSphere Integration Only (No Agent)

**Tags present:** `app: vsphere`
**Metrics available:** T2 `vsphere.*` only

**Step B (from cache):**
- `vsphere.cpu.usage.avg` → `cpu_avg_30d` ✅ (already 0–100)
- `vsphere.mem.usage.average` → `ram_avg_30d` ✅ (already 0–100, no conversion needed)
- `vsphere.disk.usage.avg` → ⚠️ **INFORMATIONAL ONLY** — this is disk I/O throughput in KBps, NOT disk space %. `disk_avg_30d = null`.
- `vsphere.net.received.avg` → `network_in_avg_30d = value × 1024` (KBps → bytes/sec) ✅
- `vsphere.net.transmitted.avg` → `network_out_avg_30d = value × 1024` (KBps → bytes/sec) ✅
- CPU p95 → null ❌ (vSphere integration platform limitation)
- Disk % → null ❌ (vSphere exposes I/O throughput only, not disk space %)

**Output:** CPU, RAM, and network utilization data. Disk null (platform limitation — vSphere exposes I/O throughput in KBps, not disk space %). No cost (on-prem). Recommendation with vCPU/RAM reduction guidance.

---

### Scenario 10 — On-Prem Bare-Metal (Agent Only, No Cloud Tags)

**Tags present:** None (or only generic hostname/env tags)
**Metrics available:** T1 `system.*`

**Step A:** Rules 1–6 miss. Rule 7: check cache — all four T2 CPU metrics null → `cloud_provider = "unknown"`.

**Step B (from cache):** T1 `system.*` values present → full metrics ✅. T2 cloud values all null (no cloud integration).

**Step D — PATH 4:** `suggest_universal_rightsizing_tool` with all T1 metrics.

**Output:** Full utilization data. `cloud_provider = "unknown"` (not assumed on-prem — absence of cloud metrics is not positive evidence). Recommendation with resource guidance.

> **Note:** The only way to get `cloud_provider = "on-prem"` is positive evidence: the `vsphere`/`vmware` app tag, or `vsphere.cpu.usage.avg` being non-null in the cache. A bare-metal Linux server with only `system.*` metrics and no cloud tags is classified `"unknown"`, not `"on-prem"`.

---

### Scenario 11 — AWS ECS / Fargate Task

**Tags present:** `app: ecs` or `app: fargate`
**Metrics available:** None scoped to `host:<name>`

**Step A:** App `ecs`/`fargate` → `cloud_provider = "aws"`, `host_subtype = "ecs"/"fargate"` — done at rule 2.

**Step B (from cache):** All metrics null — ECS/Fargate metrics are scoped to cluster/task/container, not to the host entry. This is expected.

**Step D — PATH 5:** No metrics.

**Output:** `efficiency_label = "unknown"`. Recommendation: "ECS/Fargate task — container-level metrics are not scoped to host in Datadog. Use AWS Container Insights or the Datadog container integration to analyze resource utilization at the task/container level."

> **Why:** ECS tasks and Fargate containers report metrics scoped to cluster name, task family, or container name — not to the host entry in Datadog's infrastructure list. This is a Datadog/ECS architectural constraint, not an agent limitation.

---

### Scenario 12 — Kubernetes Node (EKS / AKS / GKE)

**Tags present:** `app: kubernetes` or `k8s`, plus cloud tags (e.g. `instance-type:m5.large` for EKS)
**Metrics available:** T1 `system.*` (if node agent installed) or T2 cloud metrics

**Step A:** App `kubernetes`/`k8s` → `host_subtype = "kubernetes_node"` noted, but cloud_provider classification **continues** through rules 3–7. The underlying VM is still a real instance that can be right-sized.

**Step B / C / D:** Same as the underlying cloud scenario (AWS EC2, Azure VM, GCP GCE) — full analysis proceeds normally.

**Output:** Same as the underlying cloud scenario, with recommendation noting: "This is a Kubernetes node — right-sizing should account for cluster scheduling overhead and node pool configuration."

---

## Right-Sizing Decision Paths

| Condition | Path | Tools called | Output |
|---|---|---|---|
| AWS instance_type + cpu + ram | **PATH 1** | `suggest_right_sized_instance_tool` → `build_pricing_calculator_url_tool` | Specific instance suggestion, monthly savings, pricing URL |
| AWS instance_type + cpu only (no RAM) | **PATH 2** | `suggest_universal_rightsizing_tool` + `get_instance_on_demand_price_tool` | Utilization-based recommendation, current cost, RAM caveat |
| AWS instance_type + no metrics | **PATH 3** | `suggest_right_sized_instance_tool(null, null)` → `get_instance_on_demand_price_tool` | Current cost only, "install agent" recommendation |
| Azure/GCP instance_type + any metrics | **PATH 4** | `suggest_universal_rightsizing_tool` | Resource reduction guidance, no dollar cost |
| No instance_type + any metrics | **PATH 4** | `suggest_universal_rightsizing_tool` | Resource reduction guidance |
| No metrics at all | **PATH 5** | None | "No data available" recommendation |
| ECS/Fargate | **PATH 5** | None | Container-level metrics guidance |

---

## Platform Limitations (Not Agent Gaps)

These are hard limits of the underlying cloud platforms — no amount of agent improvement can work around them without additional integrations.

| Platform | Missing metric | Reason | Workaround |
|---|---|---|---|
| AWS (no agent) | RAM | CloudWatch does not expose RAM metrics | Install Datadog agent |
| AWS (no agent) | Disk % | EBS/CloudWatch exposes throughput only, not % full | Install Datadog agent |
| Azure (no agent) | Disk % | Azure Monitor exposes throughput only | Install Datadog agent |
| Azure (no agent) | CPU p95 | Azure Monitor does not expose p95 aggregation | Install Datadog agent |
| GCP (no agent) | Disk % | GCP integration does not expose disk space % | Install Datadog agent |
| GCP (no agent) | CPU p95 | GCP integration does not expose p95 aggregation | Install Datadog agent |
| VMware (no agent) | CPU p95 | vSphere integration does not expose p95 aggregation | Install Datadog agent |
| VMware (no agent) | Disk % | vSphere exposes I/O throughput (KBps) via `vsphere.disk.usage.avg`, not disk space % | Install Datadog agent |
| Azure/GCP | Cost + instance suggestion | AWS pricing catalog only | Azure Pricing API / GCP Billing API integration (future) |
| ECS/Fargate | All metrics | Metrics scoped to task/cluster, not host | AWS Container Insights or Datadog container integration |

VMware vSphere is the most complete T2 integration for CPU and RAM — it exposes both without the Datadog agent. However, disk space % is not available from any T2 integration (vSphere exposes I/O throughput in KBps, not disk space %). The only gap shared by all T2 integrations is CPU p95 (except AWS which provides `.rollup(p95, 3600)`).

---

## Output Fields Reference

Every host result written to DynamoDB contains:

| Field | Type | Source |
|---|---|---|
| `host_name` | string | Datadog host entry |
| `cloud_provider` | `aws` \| `azure` \| `gcp` \| `on-prem` \| `unknown` | Step A classification |
| `cpu_avg_30d` | float 0–100 \| null | T1 preferred, T2 fallback |
| `cpu_p95_30d` | float 0–100 \| null | T1 preferred, AWS T2 fallback; null for Azure/GCP/VMware without agent |
| `ram_avg_30d` | float 0–100 \| null | T1 preferred, VMware T2 direct; Azure/GCP T2 needs `instance_ram_gb`; null for AWS without agent |
| `network_in_avg_30d` | float bytes/sec \| null | T1 preferred, T2 fallback for all clouds |
| `network_out_avg_30d` | float bytes/sec \| null | T1 preferred, T2 fallback for all clouds |
| `disk_avg_30d` | float 0–100 \| null | T1 (`system.disk.in_use`) only; null for all T2-only hosts (no T2 integration exposes disk space %) |
| `instance_type` | string \| null | Datadog tag (authoritative) |
| `instance_region` | string \| null | Datadog region/AZ tag |
| `instance_cpu_count` | integer \| null | AWS catalog (Step C) |
| `instance_ram_gb` | float \| null | AWS catalog (Step C) |
| `has_instance_tag` | boolean | Whether instance_type was found |
| `catalog_data_available` | boolean | Whether AWS pricing catalog was used |
| `current_monthly_cost` | float USD \| null | AWS catalog (PATH 1/2/3 only) |
| `suggested_instance` | string \| null | AWS catalog (PATH 1 only) |
| `suggested_monthly_cost` | float USD \| null | AWS catalog (PATH 1 only) |
| `monthly_savings` | float USD \| null | AWS catalog (PATH 1 only) |
| `savings_percent` | float 0–100 \| null | Computed from savings/current |
| `pricing_calc_url` | string \| null | AWS EC2 pricing page URL (PATH 1 only) |
| `efficiency_score` | integer 0–100 \| null | `(cpu_avg + ram_avg) / 2` |
| `efficiency_label` | `over-provisioned` \| `right-sized` \| `under-provisioned` \| `unknown` | Based on cpu_p95 + ram + disk thresholds |
| `recommendation` | string | Complete sentence, minimum 15 words |
| `analyzed_at` | ISO timestamp | Write time |

**Efficiency label thresholds:**
- `under-provisioned`: cpu_p95 > 80% OR ram > 85% OR disk > 85%
- `over-provisioned`: cpu_p95 < 20% AND ram < 40%
- `right-sized`: any metric data, neither threshold met
- `unknown`: cpu, ram, and disk all null
