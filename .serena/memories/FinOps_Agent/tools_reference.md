# FinOps Agent - Tools & MCP Server Reference

## Complete Tool Inventory by Agent

### HOST BATCH AGENT TOOLS (host-batch-server.ts)

#### 1. get_instance_specs_tool
**Purpose**: Fetch AWS EC2 instance specifications
**MCP Server**: host-batch-tools (custom, in-process)
**Schema**:
```typescript
{
  instance_type: string,       // e.g. "t2.medium", "m5a.large", "c5.xlarge"
  region?: string              // default: "us-east-1"
}
```
**Response**:
```json
{
  "vcpu": 2,
  "ram_gb": 4,
  "instance_type": "t2.medium"
}
// OR error if not found in catalog
```
**Usage**: Called in STEP C when instance_type is known (used to populate instance_cpu_count, instance_ram_gb)

---

#### 2. get_instance_on_demand_price_tool
**Purpose**: Get monthly on-demand pricing for EC2 instance
**MCP Server**: host-batch-tools (custom)
**Schema**:
```typescript
{
  instance_type: string,       // e.g. "t2.medium"
  region?: string              // default: "us-east-1"
}
```
**Response**:
```json
{
  "monthly_usd": 7.66
}
// OR error if price unavailable
```
**Usage**: Called in PATH 3 (AWS + instance_type + no metrics) to populate current_monthly_cost before write_host_result_tool

---

#### 3. suggest_right_sized_instance_tool
**Purpose**: AWS EC2-specific right-sizing with live pricing
**MCP Server**: host-batch-tools (custom)
**Schema**:
```typescript
{
  cpu_p95_pct: number,         // 0-100, 95th percentile CPU utilization
  ram_avg_pct: number | null,  // 0-100, average RAM as % of current instance total
  current_instance: string,    // e.g. "m5a.large"
  region?: string              // default: "us-east-1"
}
```
**Response** (Success - AWS catalog found):
```json
{
  "suggested": "t3.small",
  "already_right_sized": false,
  "suggested_monthly_usd": 18.45,
  "current_monthly_usd": 82.00,
  "monthly_savings": 63.55,
  "savings_percent": 77.5
}
```
**Response** (Fallback - Azure/GCP detected):
```json
{
  "catalog_not_available": true,
  "reason": "Standard_D2s_v3 is not an AWS EC2 instance type"
}
// → Agent should call suggest_universal_rightsizing_tool instead
```
**Response** (Fallback - RAM data unavailable):
```json
{
  "ram_unavailable": true,
  "message": "RAM data unavailable — use PATH 2: call suggest_universal_rightsizing_tool with ram_avg_pct=null",
  "current_monthly_usd": 82.00
}
// → Agent should use PATH 2 logic
```
**Usage**: PATH 1 decision tree (AWS + instance_type + cpu + ram metrics available)

**Implementation Detail**: Uses CANDIDATE_FAMILIES_V1 (hardcoded list of AWS instance families to consider: t2, t3, m5a, m5, m6i, c5, c6i, r5, r6i, etc.)

---

#### 4. suggest_universal_rightsizing_tool
**Purpose**: Cloud-agnostic utilization-based recommendations (no catalog lookup)
**MCP Server**: host-batch-tools (custom)
**Schema**:
```typescript
{
  host_name: string,
  cpu_avg_pct: number | null,           // 0-100
  cpu_p95_pct: number | null,           // 0-100, primary for labeling
  ram_avg_pct: number | null,           // 0-100
  disk_avg_pct: number | null,          // 0-100
  network_in_bytes_day: number | null,  // bytes/day (informational only)
  network_out_bytes_day: number | null, // bytes/day (informational only)
  instance_cpu_count: number | null,    // vCPU count for scaling advice
  instance_ram_gb: number | null,       // RAM GB for scaling advice
  cloud_provider?: string               // default: "unknown"
}
```
**Response**:
```json
{
  "efficiency_label": "over-provisioned",
  "recommendation": "CPU averaged 6.1% and RAM averaged 22.4% over 30 days — over-provisioned; consider reducing vCPUs from 8 to ~2 and RAM from 32 GB to ~12 GB.",
  "suggested_cpu_count": 2,
  "suggested_ram_gb": 12,
  "cloud_provider": "unknown"
}
```
**Efficiency Labels**:
- "under-provisioned": cpu > 80% OR ram > 85% OR disk > 85%
- "over-provisioned": cpu < 20% AND ram < 40%
- "right-sized": any other case with metric data
- "unknown": all metrics null

**Usage**:
- PATH 2: AWS + instance_type + cpu only (no RAM)
- PATH 4: No instance_type OR Azure/GCP
- Called when suggest_right_sized_instance_tool returns catalog_not_available or ram_unavailable

---

#### 5. build_pricing_calculator_url_tool
**Purpose**: Generate AWS pricing calculator URL for manual comparison
**MCP Server**: host-batch-tools (custom)
**Schema**:
```typescript
{
  current_instance: string,    // e.g. "m5a.large"
  suggested_instance: string,  // e.g. "t3.small"
  region?: string              // default: "us-east-1"
}
```
**Response**:
```json
{
  "pricing_calc_url": "https://aws.amazon.com/ec2/pricing/on-demand/?nc2=type_a#us-east-1",
  "note": "Compare m5a.large vs t3.small in us-east-1 on the AWS EC2 On-Demand pricing page"
}
```
**Usage**: Called after suggest_right_sized_instance_tool when already_right_sized=false (not an upgrade)

---

#### 6. write_host_result_tool
**Purpose**: Persist per-host analysis result to DynamoDB
**MCP Server**: host-batch-tools (custom)
**Schema**:
```typescript
{
  host_id: string,                    // hostname
  result_json: string,                // JSON string with full result object
  dd_host_metadata?: string           // JSON string of raw Datadog search_datadog_hosts row
}
```
**Result JSON Fields** (ALL required, use null for missing):
```json
{
  "host_name": "prod-web-01",
  "cloud_provider": "aws|azure|gcp|on-prem|unknown",
  "cpu_avg_30d": 12.5 | null,
  "cpu_p95_30d": 28.3 | null,
  "ram_avg_30d": 45.0 | null,
  "network_in_avg_30d": 1048576 | null,        // bytes/sec
  "network_out_avg_30d": 2097152 | null,
  "disk_avg_30d": 62.0 | null,
  "instance_type": "t2.medium" | null,
  "instance_region": "us-east-1" | null,
  "instance_cpu_count": 2 | null,
  "instance_ram_gb": 4.0 | null,
  "has_instance_tag": true | false,
  "catalog_data_available": true | false,
  "current_monthly_cost": 7.66 | null,
  "suggested_instance": "t3.small" | null,
  "suggested_monthly_cost": 2.96 | null,
  "monthly_savings": 4.70 | null,
  "savings_percent": 61.3 | null,
  "pricing_calc_url": "https://..." | null,
  "efficiency_score": 20 | null,               // 0-100
  "efficiency_label": "over-provisioned|right-sized|under-provisioned|unknown",
  "recommendation": "CPU averaged 12.5% and RAM averaged 45% over 30 days — over-provisioned; downsize from t2.medium to t3.small to save $4.70/month."
}
```
**Server-Side Processing**:
1. Normalizes field name aliases (cpu_avg vs cpu_avg_pct vs cpu_avg_30d)
2. Recovers metrics from recommendation text if JSON fields null
3. Extracts instance_type authoritatively from dd_host_metadata if provided (Datadog's own data is authoritative)
4. Recomputes efficiency_label from metric data (never trusts agent)
5. Validates PATH 3 rule: if AWS + instance_type + no metrics, requires current_monthly_cost
6. Normalizes cloud_provider to canonical values

**dd_host_metadata Format** (raw from search_datadog_hosts):
```json
{
  "hostname": "prod-web-01",
  "instance_type": "t2.medium",
  "cloud_provider": "aws",
  "hostname_aliases": "i-0123456789abcdef0",
  "tags": {"instance-type": "t2.medium", "cloud_provider": "aws"},
  "sources": "aws,datadog agent"
}
```

**Response**: `{ "content": [{ "type": "text", "text": "Wrote result for host prod-web-01" }] }`

**Validation**: Returns error with action required if PATH 3 violation detected

---

#### 7. update_run_progress_tool
**Purpose**: Update run progress counters and log
**MCP Server**: host-batch-tools (custom)
**Schema**:
```typescript
{
  hosts_done: number,          // increment by this many
  log_message: string          // append to run.log
}
```
**Response**: `{ "content": [{ "type": "text", "text": "Progress updated: batch 3/5 complete (15 hosts) for tenant-id" }] }`

---

### SLO BATCH AGENT TOOLS (slo-batch-server.ts)

#### 1. write_slo_result_tool
**Purpose**: Persist per-SLO compliance audit result to DynamoDB
**MCP Server**: slo-batch-tools (custom)
**Schema**:
```typescript
{
  slo_id: string,                    // e.g. "abc123def456"
  result_json: string                // JSON string with full audit result
}
```
**Result JSON Fields** (ALL required):
```json
{
  "slo_name": "API Response Time p99 < 200ms",
  "slo_type": "metric|monitor|time_slice",
  "sli_category": "availability|latency|error_rate|throughput|saturation|unclassified",
  "formula_valid": true | false,
  "formula_issue": "numerator metric exceeds denominator possible" | null,
  "context_compatible": true | false,
  "validation_score": 72,                    // 0-100
  "validation_status": "excellent|good|needs_improvement|poor|critical",
  "blocker_issues": [
    "No time windows configured",
    "trace.* metrics used but APM not enabled"
  ],
  "quality_issues": [
    "avg: aggregation for latency SLO (should use p95 or p99)",
    "Only 7d window, missing 30d for monthly reporting"
  ],
  "enhancements": [
    "Add team tag for ownership",
    "Add description explaining business context"
  ],
  "insight": "This SLO uses avg aggregation for latency, which masks peak response times. Replace with percentile(0.99) to capture worst-case user experience.",
  "tags": ["prod", "api", "latency"],
  "target_percentage": 99.5,
  "time_windows": ["7d", "30d"]
}
```

**Scoring Rules**:
- Start: 100
- BLOCKER issues: -40 pts each (max 4 = -160, floored to 0)
  - No time windows configured
  - Target = 100% (no error budget)
  - Target < 0.1% (nonsensical)
  - Formula inverted
  - Metric requires disabled capability (trace.* without APM)
  - Monitor type contradicts SLO category
- QUALITY issues: -15 pts each
  - avg: for latency (should be p95/p99)
  - agent.up for service availability
  - Short window only (7d without 30d)
  - No team tag
- ENHANCEMENTS: -5 pts each
  - No description
  - Missing service tag
  - Missing env tag
  - Target unrealistic (>99.99%)

**Validation Status**:
- 90-100: "excellent"
- 75-89: "good"
- 50-74: "needs_improvement"
- 25-49: "poor"
- 0-24: "critical"

---

#### 2. update_slo_progress_tool
**Purpose**: Update SLO run progress
**MCP Server**: slo-batch-tools (custom)
**Schema**:
```typescript
{
  slos_done: number,          // increment by this many
  log_message: string
}
```

---

### LIST-HOSTS AGENT TOOLS (list-hosts-server.ts)

#### fetch_and_store_all_hosts_tool
**Purpose**: Discover all hosts in a Datadog org via DDSQL
**MCP Server**: list-hosts-tools (custom)
**Schema**: `{}` (no parameters)
**Response**:
```json
{
  "success": true,
  "tenant_id": "PDI-Enterprise",
  "total_hosts": 1247
}
```
**Implementation**:
1. Builds DDSQL query: `SELECT hostname FROM hosts`
2. Fetches page by page (start_at pagination)
3. Stores full host list in DynamoDB finops_host_lists
4. Updates run.hosts_total
5. Returns summary

---

### SUMMARIZE AGENT TOOLS (summarize-server.ts)

#### compute_and_write_org_summary_tool
**Purpose**: Aggregate per-host results into org summary
**MCP Server**: summarize-tools (custom)
**Schema**: `{}` (no parameters; reads from DynamoDB for this run/tenant)
**Response**:
```json
{
  "success": true,
  "tenant_id": "PDI-Enterprise",
  "total_hosts": 1247,
  "hosts_analyzed": 1195,
  "over_provisioned": 521,
  "right_sized": 562,
  "under_provisioned": 112,
  "total_monthly_spend": 98765.43,
  "potential_savings": 34512.87,
  "savings_percent": 34.9,
  "avg_cpu_utilization": 18.5,
  "avg_ram_utilization": 42.3
}
```

---

### SLO-LIST AGENT TOOLS (slo-list-server.ts)

#### fetch_and_store_all_slos_tool
**Purpose**: Discover all SLOs and derive monitoring context
**MCP Server**: slo-list-tools (custom)
**Schema**: `{}` (no parameters)
**Response**:
```json
{
  "success": true,
  "tenant_id": "PDI-Enterprise",
  "total_slos": 87,
  "monitoring_context": {
    "apm_enabled": true,
    "synthetics_enabled": true,
    "infra_monitoring": true
  }
}
```
**Implementation**:
1. Calls Datadog REST API to fetch all SLOs for tenant
2. Analyzes SLO portfolio to determine monitoring capabilities:
   - apm_enabled: true if any SLO uses trace.* metrics or APM monitors
   - synthetics_enabled: true if any SLO uses synthetics monitors
   - infra_monitoring: always true (assumed)
3. Pre-fetches monitor details for monitor-type SLOs (embeds in SLO objects)
4. Stores all SLOs + context in DynamoDB slo_lists
5. Returns summary

---

### SLO-SUMMARIZE AGENT TOOLS (slo-summarize-server.ts)

#### compute_and_write_slo_org_summary_tool
**Purpose**: Aggregate per-SLO audit results into org compliance report
**MCP Server**: slo-summarize-tools (custom)
**Schema**: `{}` (no parameters; reads from DynamoDB for this run/tenant)
**Response**:
```json
{
  "success": true,
  "tenant_id": "PDI-Enterprise",
  "total_slos": 87,
  "valid_slos": 72,
  "misconfigured_slos": 12,
  "unclassified_slos": 3,
  "compliance_score": 78.5,
  "compliance_tier": "good",
  "category_scores": {
    "availability": 82,
    "latency": 75,
    "error_rate": 68,
    "throughput": null,
    "saturation": 71
  },
  "na_categories": ["throughput"],
  "gap_analysis": [
    {
      "severity": "high",
      "category": "configuration",
      "insight": "7 SLOs use avg: aggregation for latency (should use p95/p99)",
      "affected_slos": 7,
      "recommendation": "Update aggregation function in metric SLOs for consistency"
    }
  ]
}
```

---

## Datadog MCP Server Tools

**HTTP Server**: https://mcp.datadoghq.com/api/unstable/mcp-server/mcp

**Tools Used** (core toolset):

### search_datadog_hosts
**Purpose**: Query hosts by filter, get tags and aliases
**Parameters**:
- query: filter string (e.g. "host:prod-web-01" or "tag:env:prod")
- start_at: pagination offset (0 for first page)
- max_tokens: 100000

**Response**: TSV data block with columns:
- hostname
- instance_type (Datadog's own metadata if available)
- cloud_provider (Datadog's own metadata if available)
- hostname_aliases (AWS EC2 ID if available)
- tags (JSON array or space-separated)
- sources (e.g. "aws,datadog agent")

---

### get_datadog_metric
**Purpose**: Fetch metric time series
**Parameters**:
- query: metric query (e.g. "avg:system.cpu.idle{host:prod-web-01}")
- from: unix timestamp
- to: unix timestamp
- max_tokens: 100000

**Response**: Metric data points with aggregated values

---

### search_datadog_monitors
**Purpose**: Query monitors
**Parameters**:
- query: filter string
- max_tokens: 100000

**Response**: Monitor objects with name, type, query, tags

---

## Summary: Tool Organization by Workflow

### Host Batch Agent (7 tools)
1. get_instance_specs_tool - AWS catalog
2. get_instance_on_demand_price_tool - AWS pricing
3. suggest_right_sized_instance_tool - AWS right-sizing
4. suggest_universal_rightsizing_tool - Cloud-agnostic
5. build_pricing_calculator_url_tool - URL builder
6. write_host_result_tool - Persistence
7. update_run_progress_tool - Progress tracking

### SLO Batch Agent (2 tools)
1. write_slo_result_tool - Persistence
2. update_slo_progress_tool - Progress tracking

### List Agents (2 tools)
1. fetch_and_store_all_hosts_tool - Host discovery
2. fetch_and_store_all_slos_tool - SLO discovery

### Summarize Agents (2 tools)
1. compute_and_write_org_summary_tool - Host aggregation
2. compute_and_write_slo_org_summary_tool - SLO aggregation

### Datadog MCP (3 tools)
1. search_datadog_hosts - Host metadata
2. get_datadog_metric - Metric queries
3. search_datadog_monitors - Monitor queries

