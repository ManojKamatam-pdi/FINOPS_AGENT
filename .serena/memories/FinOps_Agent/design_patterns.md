# FinOps Agent - Design Patterns & Decision Points

## 1. Evidence-First Reasoning (No Hallucination)

### Host Classification Rule
In `host-batch-agent.ts` system prompt, cloud provider classification uses explicit precedence:

```
PRECEDENCE (highest confidence first):
1. EC2 alias pattern (i-[0-9a-f]{8,17}) → CONFIRMED AWS EC2
2. App/source tags (ecs, fargate, vmware, azure, gcp) → CONFIRMED specific cloud
3. Instance-type tag pattern (t2.*, m5.*, Standard_*, n1-*) → infer cloud
4. Region tag pattern (us-east-1, eastus, us-central1) → infer cloud
5. Explicit cloud_provider tag → use verbatim
6. T2 metric probes (aws.ec2.*, azure.vm.*, gcp.gce.*, vsphere.*) → CONFIRMED by metric data
7. If all probes fail → "unknown" (NOT "on-prem")
```

**Critical**: Absence of tags does NOT mean on-prem. Only POSITIVE evidence (vmware app, vsphere metrics) confirms on-prem.

### Why This Matters
- Prevents false "on-prem" classification for EC2 instances with Datadog agent but no AWS integration
- Prevents false "on-prem" classification for ECS/EKS nodes with no cloud tags
- Fallback to "unknown" is more honest than guessing

---

## 2. Multi-Tier Metric Collection (Efficiency Optimization)

### Tier Strategy
```
PASS 1: Issue ALL T1 (system.*) queries simultaneously
  - avg:system.cpu.idle
  - percentile(95):system.cpu.idle
  - avg:system.mem.pct_usable
  - avg:system.net.bytes_rcvd
  - avg:system.net.bytes_sent
  - avg:system.disk.in_use
  
PASS 2: Check which metrics are still null
  
PASS 3: Fall back to T2 (cloud integrations) ONLY for null fields
  - If T1 CPU succeeded: skip aws.ec2.*, azure.vm.*, gcp.gce.* CPU queries
  - If T1 RAM succeeded: skip cloud RAM queries
```

### Why PASS 1 First?
- Maximizes data from agent (most likely source, least API latency)
- Parallel queries reduce total wall-clock time
- Avoids redundant cloud API calls when agent has the data

### Example: RAM Metric
```
PASS 1: avg:system.mem.pct_usable → returns 45%
PASS 2: Check result → found! (ram_avg_30d = 45)
PASS 3: Skip azure.vm.available_memory_bytes and gcp.gce.instance.memory.balloon.ram_used

Result: Exactly 1 metric call for RAM, not 3
```

---

## 3. Right-Sizing Decision Tree (Critical Path Selection)

### Decision Logic Flowchart

```
┌─────────────────────────────────────────────────────────────┐
│ Do we have instance_type tag?                               │
└────────────────┬────────────────────────────────────────┬───┘
                 YES                                      NO
                  │                                        │
        ┌─────────▼─────────┐                     ┌────────▼────────┐
        │ Is it AWS format? │                     │  Any metrics?   │
        └────┬──────────┬───┘                     └────┬─────────┬──┘
       YES   │ NO       │                         YES  │ NO      │
            │          │                              │         │
     ┌──────▼─┐    ┌────▼──────┐              ┌──────▼─┐   ┌────▼───────┐
     │ PATH 1 │    │ PATH 1    │              │ PATH 4 │   │ PATH 5     │
     │ Suggest│    │ (fallback)│              │ Univ.  │   │ No metrics │
     │ Right  │    │ Univ.     │              │ Sizing │   │ (generic)  │
     │ Sized  │    │ Sizing    │              └────────┘   └────────────┘
     │ (AWS)  │    │ (for AZ   │
     └───┬────┘    │ /GCP)     │
         │         └───────────┘
    ┌────▼─────────────────────┐
    │ Do we have RAM data?     │
    └────┬────────────────┬────┘
         YES              NO
          │                │
    ┌─────▼────┐      ┌────▼─────────┐
    │ PATH 1   │      │ PATH 2       │
    │ (proceed)│      │ (Univ. Sizing│
    └──────────┘      │ with ram=null)
                      └──────────────┘

BUT WAIT: If AWS + instance_type + NO metrics:
  MANDATORY: Call get_instance_on_demand_price_tool first
  (PATH 3 enforcement — reject write_host_result_tool if price missing)
```

### Code Location
**File**: `host-batch-agent.ts` system prompt, STEP D section

### Why This Complexity?
1. **AWS instances** have AWS pricing catalog → use it for precise cost savings
2. **Azure/GCP instances** have no AWS catalog entry → fall back to utilization-based advice
3. **No instance_type** (on-prem, bare-metal, untagged EC2) → can't use catalog → utilization-based
4. **No RAM metrics** (AWS limitation) → can't use 2-dimensional right-sizing → use CPU only
5. **No metrics at all** → can't right-size → generic recommendation to install agent

---

## 4. Efficiency Label Computation (Server-Side Validation)

### Rule
**Server-side ALWAYS recomputes** efficiency_label from raw metric data. Never trusts agent's value.

```typescript
if ((cpu_p95 ?? 0) > 80 || (ram ?? 0) > 85 || (disk ?? 0) > 85) {
  label = "under-provisioned";  // Check FIRST
} else if ((cpu_p95 ?? 100) < 20 && (ram ?? 100) < 40) {
  label = "over-provisioned";   // Check SECOND
} else if (cpu !== null || ram !== null || disk !== null) {
  label = "right-sized";        // Check THIRD (has data)
} else {
  label = "unknown";            // All metrics null
}
```

### Why Recompute?
- Agent might have made math errors in thresholds
- Ensures consistent labeling across all hosts
- Catches agent hallucinations (impossible values like cpu=150%)

### Edge Cases Handled
```
cpu_p95 = 81%   → under-provisioned (not right-sized)
cpu_p95 = 79.9% → check ram/disk next (might be right-sized)
cpu_p95 = 5%, ram = 38% → right-sized (barely passes over-prov check: <20 AND <40)
cpu_p95 = 5%, ram = null → neither under nor over (has data but fails both checks)
```

---

## 5. Metric Recovery from Recommendation Text

### Pattern Matching Rules
```typescript
// Agent wrote null for cpu_avg_30d but recommendation has "CPU averaged 12.5%"
const recCpuMatch = recommendation.match(/CPU averaged ([\d.]+)%/i);
const cpu_avg = recCpuMatch ? parseFloat(recCpuMatch[1]) : null;

// Similar for p95
const recCpuP95AtMatch = recommendation.match(/CPU p95 at ([\d.]+)%/i);
const recCpuP95Match = recommendation.match(/p95[:\s]+([0-9.]+)%/i);
const cpu_p95 = recCpuP95AtMatch ? parseFloat(...) : recCpuP95Match ? parseFloat(...) : null;

// Similar for RAM
const recRamMatch = recommendation.match(/RAM averaged ([\d.]+)%/i);
const ram_avg = recRamMatch ? parseFloat(recRamMatch[1]) : null;
```

### Why Recover?
- Handles agents that compute metrics correctly but forget to put them in JSON fields
- Ensures efficiency_label can be recomputed reliably

### Fallback Hierarchy
```
1. Use value from result JSON if present
2. Try pattern match recommendation text
3. Use null if no data found
```

---

## 6. PATH 3 Enforcement (AWS + instance_type + no metrics)

### The Problem
AWS instances without metrics (no agent, no cloud integration) need a cost estimate to justify the recommendation.

### The Solution
**Mandatory tool call**: `get_instance_on_demand_price_tool` MUST be called before `write_host_result_tool`.

### Rejection Pattern
```typescript
if (cloud_provider === "aws" && 
    hasInstanceType && 
    hasNoMetrics && 
    !current_monthly_cost) {
  return {
    error: "PATH 3 VIOLATION",
    action_required: "Call get_instance_on_demand_price_tool(...) first, then retry write_host_result_tool with current_monthly_cost populated"
  };
}
```

### Why Enforce?
- Without cost, recommendation is incomplete ("downsize from m5.large" — but how much will we save?)
- Cost is mandatory input for FinOps decision-making
- Forces agent to think through all data paths

---

## 7. Cloud Provider Normalization (Canonical Values)

### Allowed Values
```typescript
const canonicalProviders = new Set(["aws", "azure", "gcp", "on-prem", "unknown"]);
```

### Normalization Rules
```typescript
// POSITIVE on-prem evidence (confirmed)
"on-premise" → "on-prem"
"bare-metal" → "on-prem"
"vmware" → "on-prem"

// AMBIGUOUS (unconfirmed, treat as unknown)
"on-prem/unknown" → "unknown"       // Could be either
"unknown (on-prem)" → "unknown"     // Uncertain
"unknown (on-prem/bare-metal)" → "unknown"  // Very uncertain
"untagged" → "unknown"              // No evidence of on-prem

// CANONICAL
"aws" → "aws"
"azure" → "azure"
"gcp" → "gcp"
"unknown" → "unknown"
```

### Why Two Categories?
- **Confirmed** (vmware tag, vsphere metrics) → "on-prem"
- **Unconfirmed** (no tags, only system.* metrics) → "unknown"

Absence of cloud tags is NOT evidence of on-prem. Could be EC2 with agent only.

---

## 8. Instance Type Authority (Datadog Metadata > Agent)

### Hierarchy
```
1. dd_host_metadata.instance_type (from Datadog's own API)  ← MOST AUTHORITATIVE
2. dd_host_metadata.tags["instance-type"]  (Datadog's tags)
3. result_json.instance_type (agent's computation)  ← FALLBACK
4. null (no data)
```

### Why Datadog First?
- Datadog's own API data is the source of truth
- Agent might misinterpret tag values
- Prevents hallucinations (agent inventing instance types)

### Code Pattern
```typescript
if (dd_host_metadata.instance_type) {
  instance_type = dd_host_metadata.instance_type;  // Use this
} else if (dd_host_metadata.tags?.["instance-type"]) {
  instance_type = dd_host_metadata.tags["instance-type"];  // Use this
} else if (!dd_host_metadata && result_json.instance_type) {
  instance_type = result_json.instance_type;  // Only if no DD metadata passed
}
```

---

## 9. ECS/Fargate Exception Handling

### The Problem
ECS tasks and Fargate containers don't report metrics at `host:<host_name>`. Their metrics are at container/task level.

### The Solution
```
1. Agent detects host_subtype = "ecs" or "fargate"
2. T1 system.* queries return no data (expected)
3. T2 aws.ec2.* queries return no data (expected, not EC2)
4. Set efficiency_label = "unknown"
5. Recommendation = "ECS/Fargate task — container-level metrics are not scoped to host. Use AWS Container Insights or Datadog container integration."
```

### Why Handle Separately?
- Prevents misclassification as "unknown cloud provider"
- Prevents recommendation to downsize (can't downsize tasks without changing task definition)
- Guides user to appropriate tools for analysis

---

## 10. Abort Signal Pattern (Graceful Shutdown)

### In-Memory Registry
```typescript
// packages/agent/src/tools/abort-registry.ts
const abortedRuns = new Set<string>();

markAborted(runId);      // Signal abort
isAborted(runId);        // Check flag
clearAborted(runId);     // Clean up
```

### Checkpoints
Each agent checks `isAborted()` at:
1. Before starting a new batch/wave
2. Between major phases (after list, before batch, after batches, before summarize)
3. NOT between individual hosts (too fine-grained)

### Why In-Memory?
- Instant signal propagation (no DynamoDB latency)
- Doesn't persist to storage (transient, only for current run)
- Thread-safe enough for Node.js async context

### Guarantee
If abort is signaled:
- No new batches start
- Partial results already written stay (can inspect what completed)
- Run marked as "failed" (not "completed")

---

## 11. Batch & Wave Sizing Logic

### Host Batching
```
15 hosts/batch × ~13 turns/host avg = ~195 turns
maxTurns: 200 (just fits, with 5 turn headroom)
```

### Concurrency
```
30 concurrent batches/wave
Reason: Balances throughput vs AWS API rate limits
```

### Waves
```
Split processing into waves to:
1. Allow progress reporting (batch completion logs)
2. Prevent resource exhaustion (30 concurrent Promise.all)
3. Enable abort checks between waves
```

### Example: 1500 Hosts
```
Batch count: 1500 / 15 = 100 batches
Wave count: 100 / 30 = 3.33 → 4 waves
Wave 1: 30 batches (450 hosts)
Wave 2: 30 batches (450 hosts)
Wave 3: 30 batches (450 hosts)
Wave 4: 10 batches (150 hosts)

Timeline: ~4 serial waves, each ~5-10 min → ~20-40 min total (cloud API latency dominates)
```

---

## 12. Org Summary Computation Pattern

### Recomputation Strategy
**Never store partial/cached summaries if results incomplete.**

```typescript
// Frontend may request results while run still running
// Solution: Recompute org summaries from latest host results each time

const hostResults = await getHostResultsForRun(runId);
const summaryMap = new Map<string, Record>();

for (const host of hostResults) {
  const tenantId = host.tenant_id;
  if (!summaryMap.has(tenantId)) {
    summaryMap.set(tenantId, { /* initialize */ });
  }
  const summary = summaryMap.get(tenantId);
  // Accumulate: total_hosts++, over_provisioned++, etc.
}
```

### Why Recompute?
- If some hosts haven't been analyzed yet, stored summary is stale
- Guarantees numbers always match the host table (no reconciliation needed)
- Cheap operation (DynamoDB scan, not API calls)

---

## 13. Log Trimming (Last 400 Entries)

### Why Trim?
```
DynamoDB item size limit: 400 KB
Log as JSON array: avg 100 bytes/entry → ~4000 entries before limit
Trim to 400 entries: safe headroom, most recent activity visible
```

### Trimming Logic
```typescript
if (log.length > 400) {
  log = log.slice(-400);  // Keep last 400 entries
}
```

### When Triggered
After each batch completion (updateRunProgress called), check and trim if needed.

---

## 14. SLO Validation Scoring Rules

### Blocker Issues (-40 pts each)
```
- No time windows configured
- Target = 100% (error budget = 0)
- Target < 0.1% (nonsensical)
- Formula inverted (numerator > denominator possible)
- Metric requires unsupported capability (trace.* without APM)
- Monitor type contradicts SLO category (e.g., agent.up for "service availability")
```

### Quality Issues (-15 pts each)
```
- avg: aggregation for latency SLO (should use p95/p99)
- agent.up monitor for a "service availability" SLO (measures agent heartbeat, not service)
- Only 7d window without 30d (limits monthly reporting)
- No team tag (ownership undefined)
```

### Enhancements (-5 pts each)
```
- No description
- Missing service tag
- Missing env tag
- Target above 99.99% (leaves no room for deployments/bugs)
```

### Status Tiers
```
90–100: excellent
75–89: good
50–74: needs_improvement
25–49: poor
0–24: critical
```

---

## 15. Monitor-Details Pre-Fetching (SLO Optimization)

### Problem
Agent needs monitor details (name, type, query) to audit monitor-type SLOs. Fetching one by one is 10+ API calls per SLO.

### Solution
**SLO-list agent pre-fetches all monitors** and embeds in SLO objects.

```json
{
  "id": "slo_abc123",
  "type": "monitor",
  "monitor_ids": ["12345678", "12345679"],
  "monitor_details": [
    {
      "id": "12345678",
      "name": "API endpoint availability",
      "type": "synthetics alert",
      "query": "synthetics(\"api_health_check\").over(\"*\").at_least(1).each()",
      "tags": ["env:prod", "team:platform"]
    },
    {
      "id": "12345679",
      "name": "Database response time",
      "type": "metric alert",
      "query": "avg:trace.web.request.duration{service:api}.by(endpoint) > 200ms",
      "tags": ["env:prod"]
    }
  ]
}
```

### Why Pre-Fetch?
- SLO-list agent runs once per org
- SLO-batch agents run many times per org
- Pre-fetching: 1-2 API calls per org
- Without: 10+ API calls per batch

---

## 16. Monitoring Context Derivation (SLO)

### Rules
```
apm_enabled:
  True if ANY SLO uses:
    - trace.* metrics
    - APM-dependent monitor types (APM synthetic alerts)
    - Trace-based SLO types

synthetics_enabled:
  True if ANY SLO uses:
    - synthetics monitor type
    - Browser/API test monitors

infra_monitoring:
  Always true (assumption)
```

### Usage
Passed to SLO-batch agent to validate SLO correctness.

```
Example: SLO uses trace.* metrics but apm_enabled=false
→ BLOCKER: "Metric requires APM but APM not configured"
→ validation_score -= 40 pts
```

---

## Summary: Design Philosophy

1. **Evidence-First**: No hallucinations. Only explicit data and positive proofs.
2. **Multi-Path Reasoning**: Different paths for different data availability (PATH 1-5).
3. **Server-Side Validation**: Normalize, recompute, validate at persistence layer.
4. **Batching for Scale**: 15-20 items per batch fits agent token limits.
5. **Waves for Control**: Parallel but staged to allow progress, abort checks, resource management.
6. **Graceful Degradation**: Provide recommendations even with incomplete data (PATH 2, PATH 5).
7. **Canonical Values**: Normalize all enums to prevent client-side parsing complexity.
8. **Pre-Fetch Optimization**: Reduce API calls by pre-fetching related data.
9. **Audit Trail**: Log every step, allow result inspection even on failure.
10. **Deterministic Output**: Same input → same analysis (reproducible).

