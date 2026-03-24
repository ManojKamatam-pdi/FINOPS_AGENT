# Host Analysis Validation Checklist

Use this checklist to validate every FinOps host analysis report produced by the agent.
Each item is a pass/fail check. Run against the exported JSON report.

---

## SECTION 1 — Core Agenda (Provider-Agnostic)

Every host, regardless of cloud provider or environment, must satisfy all of these:

- [ ] **Every host has a result written** — no host from the input list is missing from the output
- [ ] **CPU metric attempted** — `cpu_avg_30d` is present (null is acceptable only if all queries returned no data)
- [ ] **RAM metric attempted** — `ram_avg_30d` is present (null is acceptable only if all queries returned no data)
- [ ] **Disk metric attempted** — `disk_avg_30d` is present (null is acceptable for agentless AWS/Azure/GCP — see Section 4)
- [ ] **Network metric attempted** — `network_in_avg_30d` and `network_out_avg_30d` are present (null only if all queries returned no data)
- [ ] **Provisioned specs captured** — `instance_cpu_count` and `instance_ram_gb` populated when `instance_type` is known and it's an AWS type
- [ ] **Right-sizing recommendation present** — `recommendation` is a complete sentence (≥15 words), never empty when metrics exist
- [ ] **Efficiency label assigned** — `efficiency_label` is one of: `over-provisioned`, `right-sized`, `under-provisioned`, `unknown`
- [ ] **30-day window used** — metrics cover the full 30-day window, not a shorter range

---

## SECTION 2 — Cloud Provider Classification

### 2a. Canonical Values
- [ ] `cloud_provider` is exactly one of: `"aws"` | `"azure"` | `"gcp"` | `"on-prem"` | `"unknown"`
- [ ] **NEVER** these non-canonical values: `"on-premise"`, `"on-premises"`, `"on-prem/unknown"`, `"unknown/on-prem"`, `"unknown (on-prem/untagged)"`, `"on-prem/untagged"`, `"bare-metal"`, `"vmware"`

### 2b. On-Prem Classification — POSITIVE EVIDENCE REQUIRED
- [ ] A host is classified `"on-prem"` ONLY when there is positive vsphere/vmware evidence:
  - App tag contains `"vsphere"` or `"vmware"`, OR
  - `vsphere.cpu.usage.avg` T2 probe returned data
- [ ] **"No cloud tags" does NOT mean on-prem** — it means `"unknown"`
- [ ] **"Only system.* metrics" does NOT mean on-prem** — it means `"unknown"` (could be EC2 with agent but no AWS account integration)

### 2c. AWS Classification Scenarios
- [ ] EC2 alias pattern `i-[0-9a-f]{8,17}` → `cloud_provider = "aws"`
- [ ] `instance-type` tag with AWS format (t2/t3/m5/c5/r5/m6i/c6g etc.) → `cloud_provider = "aws"`
- [ ] AWS region tag (e.g. `region:us-east-1`) → `cloud_provider = "aws"`
- [ ] `aws_account:*` tag → `cloud_provider = "aws"`
- [ ] `aws.ec2.cpuutilization` T2 probe returns data → `cloud_provider = "aws"`
- [ ] AWS with no account integration (T2 probe returns nothing, system.* exists) → `cloud_provider = "unknown"` (NOT on-prem)

### 2d. Azure/GCP Classification
- [ ] `instance-type:Standard_*` → `cloud_provider = "azure"`
- [ ] `instance-type:n1-*/n2-*/e2-*/c2-*` → `cloud_provider = "gcp"`
- [ ] `subscriptionid:*` tag → `cloud_provider = "azure"`
- [ ] `project_id:*` tag → `cloud_provider = "gcp"`
- [ ] Azure/GCP region tags correctly identified (not confused with AWS regions)

### 2e. Unknown Provider
- [ ] `"unknown"` is a valid, correct result when no cloud evidence exists
- [ ] Unknown hosts still have metrics collected (CPU/RAM/Disk/Network attempted)
- [ ] Unknown hosts still get a right-sizing recommendation (PATH 4 or PATH 5)

---

## SECTION 3 — Metric Collection Standards

### 3a. AWS Hosts
| Metric | With Agent (T1) | With Integration (T2) | Agentless Only |
|--------|----------------|----------------------|----------------|
| CPU | `system.cpu.idle` or `system.cpu.user` | `aws.ec2.cpuutilization` | T2 only |
| RAM | `system.mem.pct_usable` | ❌ CloudWatch has NO RAM | null is correct |
| Disk | `system.disk.in_use` | ❌ EBS has no % utilization | null is correct |
| Network | `system.net.bytes_rcvd/sent` | `aws.ec2.network_in/out` (bytes/sec, no conversion) | T2 only |

- [ ] AWS RAM null is **not a bug** when agent is not installed — CloudWatch does not provide RAM
- [ ] AWS disk null is **not a bug** when agent is not installed — EBS does not provide disk % utilization
- [ ] AWS network values are in bytes/sec range (e.g. 50,000–5,000,000 for typical EC2) — NOT inflated by 17× from KiB/min conversion

### 3b. Azure Hosts
| Metric | With Agent (T1) | With Integration (T2) |
|--------|----------------|----------------------|
| CPU | `system.cpu.idle` | `azure.vm.percentage_cpu` |
| RAM | `system.mem.pct_usable` | `azure.vm.available_memory_bytes` (needs `instance_ram_gb`) |
| Disk | `system.disk.in_use` | ❌ Azure Monitor gives throughput only, not % |
| Network | `system.net.bytes_rcvd/sent` | `azure.vm.network_in/out_total` |

- [ ] Azure disk null is **not a bug** when agent is not installed — Azure Monitor does not provide disk % utilization
- [ ] Azure T2 RAM conversion only attempted when `instance_ram_gb` is known (not null)

### 3c. GCP Hosts
| Metric | With Agent (T1) | With Integration (T2) |
|--------|----------------|----------------------|
| CPU | `system.cpu.idle` | `gcp.gce.instance.cpu.utilization` (0.0–1.0 fraction → ×100, clamped 0–100) |
| RAM | `system.mem.pct_usable` | `gcp.gce.instance.memory.balloon.ram_used` (needs `instance_ram_gb`) |
| Disk | `system.disk.in_use` | ❌ GCP integration gives throughput only, not % |
| Network | `system.net.bytes_rcvd/sent` | `gcp.gce.instance.network.received/sent_bytes_count` |

- [ ] GCP CPU values are in 0–100 range (not 0–1.0 fraction, not >100)
- [ ] GCP disk null is **not a bug** when agent is not installed
- [ ] GCP T2 RAM conversion only attempted when `instance_ram_gb` is known (not null)

### 3d. VMware / On-Prem Hosts
| Metric | T1 (Agent) | T2 (vSphere) |
|--------|-----------|-------------|
| CPU | `system.cpu.idle` | `vsphere.cpu.usage.avg` |
| RAM | `system.mem.pct_usable` | `vsphere.mem.usage.average` (0–100%) |
| Disk | `system.disk.in_use` | `vsphere.disk.usage.avg` (0–100) |
| Network | `system.net.bytes_rcvd/sent` | `vsphere.net.received/transmitted.avg` |

### 3e. Unknown Provider Hosts
- [ ] T1 `system.*` metrics attempted
- [ ] T2 probes for all clouds (aws, azure, gcp) already run in Step A — results reused, not re-queried
- [ ] Whatever metrics are available are used for right-sizing

---

## SECTION 4 — Known Metric Limitations (null is CORRECT, not a bug)

| Provider | Metric | Why null is correct |
|----------|--------|---------------------|
| AWS (agentless) | `ram_avg_30d` | CloudWatch does not expose RAM utilization |
| AWS (agentless) | `disk_avg_30d` | EBS metrics are I/O throughput, not disk % full |
| Azure (agentless) | `disk_avg_30d` | Azure Monitor gives throughput, not % used |
| GCP (agentless) | `disk_avg_30d` | GCP integration gives throughput, not % used |
| ECS/Fargate | All metrics | Metrics are scoped to cluster/task, not host |

- [ ] Null metrics for the above cases are accepted as correct
- [ ] Null metrics for the above cases do NOT trigger a "missing data" bug report

---

## SECTION 5 — Right-Sizing Path Validation

### PATH 1 — AWS instance_type + CPU + RAM available
- [ ] `suggest_right_sized_instance_tool` called
- [ ] `suggested_instance` populated
- [ ] `current_monthly_cost` populated
- [ ] `suggested_monthly_cost` populated
- [ ] `monthly_savings` populated (≥ 0)
- [ ] `savings_percent` populated (0–100)
- [ ] Recommendation mentions both CPU and RAM values

### PATH 2 — AWS instance_type + CPU only (no RAM)
- [ ] `suggest_universal_rightsizing_tool` called with `ram_avg_pct=null`
- [ ] `current_monthly_cost` populated (from `get_instance_on_demand_price_tool`)
- [ ] Recommendation explicitly says "RAM utilization unavailable"
- [ ] No assumed RAM value (50% or any other default)

### PATH 3 — AWS instance_type + no metrics at all
- [ ] `get_instance_on_demand_price_tool` called — `current_monthly_cost` MUST be populated
- [ ] `efficiency_label = "unknown"`
- [ ] Recommendation says "No utilization metrics available" and includes the instance type and cost
- [ ] Recommendation does NOT say just "No metric data found" (too short/vague)

### PATH 4 — Azure/GCP instance_type OR null instance_type + any metrics
- [ ] `suggest_universal_rightsizing_tool` called
- [ ] Recommendation includes actual metric values (CPU %, RAM %)
- [ ] Recommendation includes sizing suggestion (reduce vCPUs from X to ~Y)

### PATH 5 — No metrics at all
- [ ] `efficiency_label = "unknown"`
- [ ] Recommendation says "No metric data available for this host over the 30-day window"

### Unknown cloud_provider routing
- [ ] `"unknown"` + any metrics → PATH 4 (universal rightsizing)
- [ ] `"unknown"` + no metrics → PATH 5

---

## SECTION 6 — Efficiency Label Correctness

Rules (applied in order):
1. `cpu_p95 > 80%` OR `ram_avg > 85%` OR `disk_avg > 85%` → `"under-provisioned"`
2. `cpu_p95 < 20%` AND `ram_avg < 40%` → `"over-provisioned"`
3. Any metric data present but neither above → `"right-sized"`
4. cpu, ram, AND disk all null → `"unknown"`

- [ ] No host labeled `"under-provisioned"` without at least one metric exceeding the threshold
- [ ] No host labeled `"over-provisioned"` with `cpu_p95 ≥ 20%` AND `ram_avg ≥ 40%`
- [ ] Network throughput does NOT affect efficiency label (informational only)
- [ ] `efficiency_score` is in 0–100 range when not null
- [ ] `efficiency_score` is null only when both `cpu_avg_30d` and `cpu_p95_30d` are null

---

## SECTION 7 — Output Field Completeness

Every host result must have ALL these fields present (null is valid, missing/absent is a bug):

| Field | Valid Values |
|-------|-------------|
| `host_name` | string |
| `cloud_provider` | `"aws"` \| `"azure"` \| `"gcp"` \| `"on-prem"` \| `"unknown"` |
| `cpu_avg_30d` | float 0–100 or null |
| `cpu_p95_30d` | float 0–100 or null |
| `ram_avg_30d` | float 0–100 or null |
| `network_in_avg_30d` | float bytes/sec or null |
| `network_out_avg_30d` | float bytes/sec or null |
| `disk_avg_30d` | float 0–100 or null |
| `instance_type` | string or null |
| `instance_region` | string (from tags only) or null |
| `instance_cpu_count` | integer or null |
| `instance_ram_gb` | float or null |
| `has_instance_tag` | true \| false |
| `catalog_data_available` | true \| false |
| `current_monthly_cost` | float USD or null |
| `suggested_instance` | string or null |
| `suggested_monthly_cost` | float USD or null |
| `monthly_savings` | float ≥ 0 or null |
| `savings_percent` | float 0–100 or null |
| `pricing_calc_url` | URL string or null |
| `efficiency_score` | integer 0–100 or null |
| `efficiency_label` | `"over-provisioned"` \| `"right-sized"` \| `"under-provisioned"` \| `"unknown"` |
| `recommendation` | complete sentence ≥ 15 words |

- [ ] All 23 fields present on every host record
- [ ] `recommendation` is never empty when `cpu_avg_30d` or `ram_avg_30d` is not null
- [ ] `monthly_savings` is never negative
- [ ] `savings_percent` is never > 100

---

## SECTION 8 — Regression Checks (Previously Fixed Bugs)

These bugs were fixed — validate they do not reappear:

- [ ] **Bug 1 FIXED**: `system.* data + no T2 data → on-prem` — must be `"unknown"` not `"on-prem"`
- [ ] **Bug 2 FIXED**: Non-canonical `cloud_provider` values like `"unknown/on-prem"`, `"unknown (on-prem/untagged)"`, `"on-prem/untagged"` — must not appear
- [ ] **Bug 3 FIXED**: Unknown hosts skipping metric collection — unknown hosts must have metrics attempted
- [ ] **Bug 4 FIXED**: GCP CPU values > 100 (from missing clamp) — all `cpu_avg_30d` values must be 0–100
- [ ] **Bug 5 FIXED**: AWS network values inflated 17× (from KiB/min conversion) — network values must be in bytes/sec range
- [ ] **Bug 6 FIXED**: RAM assumed as 50% when unavailable — PATH 2 must say "RAM unavailable", never assume 50
- [ ] **Bug 7 FIXED**: Azure/GCP T2 RAM conversion attempted when `instance_ram_gb` is null — must skip conversion
- [ ] **Bug 8 FIXED**: PATH 3 missing `current_monthly_cost` — all PATH 3 hosts must have cost populated
- [ ] **Bug 9 FIXED**: Azure/GCP + CPU-only scenario not routed — must go to PATH 4
- [ ] **Bug 10 FIXED**: `"unknown"` cloud_provider not in PATH selection — must route to PATH 4 or PATH 5
- [ ] **Bug 11 FIXED**: VMware hosts missing T2 RAM metric — `vsphere.mem.usage.average` should be attempted
- [ ] **Bug 12 FIXED**: AWS region regex matching GCP `us-central1` — GCP hosts must not be classified as AWS from region alone
- [ ] **Bug 13 FIXED**: Min CPU suggestion was 1 vCPU — suggestions must be ≥ 2 vCPUs

---

## SECTION 9 — Automated Validation Queries

Run these PowerShell queries against the exported JSON to check the report programmatically:

```powershell
$data = Get-Content 'path/to/report.json' -Raw | ConvertFrom-Json

# Check 1: Invalid cloud_provider values
$valid = @("aws","azure","gcp","on-prem","unknown")
$invalid = $data | Where-Object { $valid -notcontains $_.cloud_provider }
Write-Host "FAIL: Invalid cloud_provider: $($invalid.Count)" # Must be 0

# Check 2: Empty recommendations with metrics
$emptyRec = $data | Where-Object { [string]::IsNullOrWhiteSpace($_.recommendation) -and ($_.cpu_avg_30d -ne $null -or $_.ram_avg_30d -ne $null) }
Write-Host "FAIL: Empty recommendations with metrics: $($emptyRec.Count)" # Must be 0

# Check 3: CPU values out of range
$badCpu = $data | Where-Object { $_.cpu_avg_30d -ne $null -and ($_.cpu_avg_30d -lt 0 -or $_.cpu_avg_30d -gt 100) }
Write-Host "FAIL: CPU out of 0-100 range: $($badCpu.Count)" # Must be 0

# Check 4: RAM values out of range
$badRam = $data | Where-Object { $_.ram_avg_30d -ne $null -and ($_.ram_avg_30d -lt 0 -or $_.ram_avg_30d -gt 100) }
Write-Host "FAIL: RAM out of 0-100 range: $($badRam.Count)" # Must be 0

# Check 5: Disk values out of range
$badDisk = $data | Where-Object { $_.disk_avg_30d -ne $null -and ($_.disk_avg_30d -lt 0 -or $_.disk_avg_30d -gt 100) }
Write-Host "FAIL: Disk out of 0-100 range: $($badDisk.Count)" # Must be 0

# Check 6: Negative savings
$negSavings = $data | Where-Object { $_.monthly_savings -ne $null -and $_.monthly_savings -lt 0 }
Write-Host "FAIL: Negative monthly_savings: $($negSavings.Count)" # Must be 0

# Check 7: Under-provisioned with no valid trigger
$underProv = $data | Where-Object { $_.efficiency_label -eq "under-provisioned" }
$underProvBad = $underProv | Where-Object {
    ($_.cpu_p95_30d -eq $null -or $_.cpu_p95_30d -le 80) -and
    ($_.ram_avg_30d -eq $null -or $_.ram_avg_30d -le 85) -and
    ($_.disk_avg_30d -eq $null -or $_.disk_avg_30d -le 85)
}
Write-Host "WARN: Under-provisioned with no trigger metric: $($underProvBad.Count)" # Should be 0

# Check 8: Over-provisioned with cpu_p95 >= 20
$overProv = $data | Where-Object { $_.efficiency_label -eq "over-provisioned" }
$overProvBadCpu = $overProv | Where-Object { $_.cpu_p95_30d -ne $null -and $_.cpu_p95_30d -ge 20 }
Write-Host "WARN: Over-provisioned with cpu_p95 >= 20%: $($overProvBadCpu.Count)" # Should be 0

# Check 9: PATH3 missing cost (AWS + instance_type + no metrics)
$awsPath3 = $data | Where-Object { $_.cloud_provider -eq "aws" -and -not [string]::IsNullOrEmpty($_.instance_type) -and $_.cpu_avg_30d -eq $null -and $_.ram_avg_30d -eq $null }
$awsPath3NoCost = $awsPath3 | Where-Object { $_.current_monthly_cost -eq $null }
Write-Host "FAIL: PATH3 missing current_monthly_cost: $($awsPath3NoCost.Count)" # Must be 0

# Check 10: Network coverage (informational)
$netCoverage = ($data | Where-Object { $_.network_in_avg_30d -ne $null }).Count
Write-Host "INFO: Hosts with network data: $netCoverage / $($data.Count)"

# Summary
Write-Host ""
Write-Host "=== DISTRIBUTION ==="
$data | Group-Object cloud_provider | Sort-Object Count -Descending | Format-Table Name, Count -AutoSize
$data | Group-Object efficiency_label | Sort-Object Count -Descending | Format-Table Name, Count -AutoSize
```

---

## SECTION 10 — Report-Level Summary Checks

- [ ] Total host count matches expected (from Datadog host list)
- [ ] No duplicate `host_name` entries in the report
- [ ] `cloud_provider` distribution is plausible for the environment
- [ ] `efficiency_label` distribution is plausible (not 100% unknown, not 100% over-provisioned)
- [ ] Network coverage is noted (low coverage is expected — most hosts don't have network metrics in Datadog)
- [ ] Disk coverage is noted (lower than CPU/RAM is expected for agentless cloud hosts)

---

*Last updated: 2026-03-24. Reflects agent implementation as of the classification & metrics overhaul.*
