# Classification Fixes + Hosted Env Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four classification bugs in the agent backend and add a "Hosted Env" filter + column to the infra host table in the frontend.

**Architecture:** Backend fixes are surgical edits to `host-batch-server.ts` (tags array parsing, Azure/GCP routing), `aws-instances.ts` (headroom 1.3→1.5×), and `org-agent.ts` (misleading comment). Frontend adds `envFilter` to `UtilFilters` in `HostTable.tsx`, a new `<select>` in the filter panel, an "Env" column in the table, and richer cloud/subtype display in `HostDetailRow.tsx`.

**Tech Stack:** TypeScript, React (no new dependencies), existing inline styles pattern.

---

## File Map

| File | Change |
|---|---|
| `packages/agent/src/tools/aws-instances.ts` | Fix B: headroom 1.3 → 1.5 |
| `packages/agent/src/mcp-servers/host-batch-server.ts` | Fix A: tags array parsing; Fix C: `get_instance_specs_tool` Azure/GCP signal |
| `packages/agent/src/agents/org-agent.ts` | Fix D: misleading fallback comment |
| `packages/frontend/src/components/HostTable.tsx` | Add `envFilter` to `UtilFilters`, filter logic, filter panel dropdown, Env column header |
| `packages/frontend/src/components/HostDetailRow.tsx` | Richer cloud+subtype display in Instance Info section |

---

## Task 1: Fix B — Standardize right-sizing headroom to 1.5×

**Files:**
- Modify: `packages/agent/src/tools/aws-instances.ts:125-126`

The AWS catalog path uses 1.3× headroom; the universal path uses 2×. Standardize to 1.5× — conservative enough to avoid under-sizing, aggressive enough to capture real savings.

- [ ] **Step 1: Edit `suggestRightSizedInstance` in `aws-instances.ts`**

Change lines 125–126 from `* 1.3` to `* 1.5`:

```typescript
  const requiredVcpu = (cpuP95Pct / 100) * currentSpecs.vcpu * 1.5;
  const requiredRamGb = (ramAvgPct / 100) * currentSpecs.ram_gb * 1.5;
```

- [ ] **Step 2: Edit `suggest_universal_rightsizing_tool` in `host-batch-server.ts`**

In the `suggest_universal_rightsizing_tool` handler, find the two places that use `* 2` for sizing math and change them to `* 1.5`:

```typescript
// Line ~206 — CPU suggestion
const suggestedCpu = Math.max(2, Math.ceil(instance_cpu_count * (cpuForSizing / 100) * 1.5));

// Line ~210 — RAM suggestion
const suggestedRam = Math.max(1, Math.ceil(instance_ram_gb * (ram / 100) * 1.5));
```

Also update the two matching lines in the `action` string builder (the `suggestions.push(...)` calls) — they reference `2×` in the text:

```typescript
suggestions.push(`reduce vCPUs from ${instance_cpu_count} to ~${suggestedCpu} (based on 30-day p95 with 1.5× headroom)`);
```

And the `suggestedCpuCount` / `suggestedRamGb` return values at the bottom of the handler:

```typescript
const suggestedCpuCount = (cpuForSizing !== null && instance_cpu_count && label === "over-provisioned")
  ? Math.max(2, Math.ceil(instance_cpu_count * (cpuForSizing / 100) * 1.5))
  : null;
const suggestedRamGb = (ram !== null && instance_ram_gb && label === "over-provisioned")
  ? Math.max(1, Math.ceil(instance_ram_gb * (ram / 100) * 1.5))
  : null;
```

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/tools/aws-instances.ts packages/agent/src/mcp-servers/host-batch-server.ts
git commit -m "fix: standardize right-sizing headroom to 1.5x across AWS catalog and universal paths"
```

---

## Task 2: Fix A — Tags array parsing in `write_host_result_tool`

**Files:**
- Modify: `packages/agent/src/mcp-servers/host-batch-server.ts:347-354`

Datadog returns tags as an **array of strings** like `["instance-type:m5.large", "region:us-east-1"]`. The current code does `tags["instance-type"]` treating it as an object — always returns `undefined`. Fix: use `Array.find` to parse the array.

- [ ] **Step 1: Replace the tags parsing block in `write_host_result_tool`**

Find this block (around line 347):

```typescript
          } else if (ddMeta.tags) {
            // Parse instance-type tag from Datadog tags object
            try {
              const tags = typeof ddMeta.tags === "string" ? JSON.parse(ddMeta.tags) : ddMeta.tags;
              const tagVal = (tags as Record<string, string>)["instance-type"];
              if (tagVal && tagVal.trim()) instance_type = tagVal.trim();
            } catch { /* ignore */ }
          }
```

Replace with:

```typescript
          } else if (ddMeta.tags) {
            // Parse instance-type tag from Datadog tags array (format: ["key:value", ...])
            try {
              const tags = typeof ddMeta.tags === "string" ? JSON.parse(ddMeta.tags) : ddMeta.tags;
              const tagArray: string[] = Array.isArray(tags) ? tags : Object.values(tags as Record<string, string>);
              const instanceTypeTag = tagArray.find((t: string) => t.startsWith("instance-type:"));
              if (instanceTypeTag) {
                const val = instanceTypeTag.split(":").slice(1).join(":").trim();
                if (val) instance_type = val;
              }
            } catch { /* ignore */ }
          }
```

- [ ] **Step 2: Commit**

```bash
git add packages/agent/src/mcp-servers/host-batch-server.ts
git commit -m "fix: parse Datadog tags as array of strings in write_host_result_tool"
```

---

## Task 3: Fix C — `get_instance_specs_tool` signals Azure/GCP correctly

**Files:**
- Modify: `packages/agent/src/mcp-servers/host-batch-server.ts:37-44`

Currently `get_instance_specs_tool` returns `{ error: "Instance type X not found" }` for Azure/GCP types. The agent interprets this as a generic error and may retry or stall. It should return `{ catalog_not_available: true }` — the same signal `suggest_right_sized_instance_tool` uses — so the agent immediately routes to PATH 4 (universal rightsizing) without attempting the Azure RAM formula.

Also update the tool description so the agent knows upfront not to call it for Azure/GCP.

- [ ] **Step 1: Update `get_instance_specs_tool` handler and description**

Replace the entire `get_instance_specs_tool` tool definition:

```typescript
      tool(
        "get_instance_specs_tool",
        "Get CPU count (vcpu) and RAM GB for an AWS EC2 instance type from the live AWS catalog. Returns { vcpu, ram_gb, instance_type }. NOTE: Only works for AWS EC2 instance types (e.g. m5.large, t3.medium, c5.xlarge). For Azure (Standard_*) or GCP (n1-/n2-/e2-) instance types, returns catalog_not_available=true — skip the Azure/GCP RAM formula and go directly to suggest_universal_rightsizing_tool.",
        { instance_type: z.string(), region: z.string().default("us-east-1") },
        async ({ instance_type, region }) => {
          // Detect Azure/GCP instance types before hitting the AWS catalog
          const isAzure = /^Standard_/i.test(instance_type);
          const isGcp = /^(n1|n2|n2d|e2|c2|c2d|m1|m2|a2|t2d)-/i.test(instance_type);
          if (isAzure || isGcp) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  catalog_not_available: true,
                  reason: `${instance_type} is an ${isAzure ? "Azure" : "GCP"} instance type — not in the AWS catalog. Use suggest_universal_rightsizing_tool for this host.`,
                }),
              }],
            };
          }

          const specs = await getInstanceSpecs(instance_type, region);
          const text = specs
            ? JSON.stringify(specs)
            : JSON.stringify({
                catalog_not_available: true,
                reason: `${instance_type} not found in AWS catalog for ${region}. Use suggest_universal_rightsizing_tool for this host.`,
              });
          return { content: [{ type: "text" as const, text }] };
        }
      ),
```

- [ ] **Step 2: Commit**

```bash
git add packages/agent/src/mcp-servers/host-batch-server.ts
git commit -m "fix: get_instance_specs_tool returns catalog_not_available for Azure/GCP types instead of silent null"
```

---

## Task 4: Fix D — Correct misleading fallback comment in org-agent

**Files:**
- Modify: `packages/agent/src/agents/org-agent.ts:34-43`

The comment says "batch agents will fall back to per-host queries" — no such fallback exists. Fix the comment and surface pre-fetch failure in the run log.

- [ ] **Step 1: Update the pre-fetch catch block in `org-agent.ts`**

Replace:

```typescript
  } catch (err) {
    // Non-fatal: batch agents will fall back to per-host queries
    console.warn(`[org_analysis:${tenantId}] Metric pre-fetch failed (batch agents will use per-host queries):`, err);
  }
```

With:

```typescript
  } catch (err) {
    // Non-fatal but impactful: if pre-fetch fails, get_prefetched_metrics_tool returns all-null
    // for every host, so all hosts in this org will be written with efficiency_label = "unknown".
    // No per-host fallback exists — the batch agent relies entirely on the pre-fetched cache.
    console.error(`[org_analysis:${tenantId}] Metric pre-fetch FAILED — all hosts will have unknown efficiency labels:`, err);
  }
```

- [ ] **Step 2: Commit**

```bash
git add packages/agent/src/agents/org-agent.ts
git commit -m "fix: correct misleading pre-fetch fallback comment in org-agent — no per-host fallback exists"
```

---

## Task 5: Frontend — Add `envFilter` to `UtilFilters` and filter logic in `HostTable.tsx`

**Files:**
- Modify: `packages/frontend/src/components/HostTable.tsx`

Add `envFilter: string` to the `UtilFilters` interface, update `DEFAULT_FILTERS`, `activeCount`, and the `sorted` filter logic. The env filter value is a composite string encoding `cloud_provider` and optionally `host_subtype`.

**Env filter value encoding:**
- `""` = All environments (no filter)
- `"aws:ec2"` = AWS EC2
- `"aws:ecs"` = AWS ECS
- `"aws:fargate"` = AWS Fargate
- `"aws:"` = AWS (other — subtype null or unrecognized)
- `"azure:"` = Azure (any subtype)
- `"gcp:"` = GCP (any subtype)
- `"on-prem:"` = On-Prem / VMware
- `"unknown:"` = Unknown

- [ ] **Step 1: Update `UtilFilters` interface and `DEFAULT_FILTERS`**

Change:

```typescript
interface UtilFilters {
  cpuMax: number | null;
  ramMax: number | null;
  netMax: number | null;
  diskMax: number | null;
  labelFilter: string;
}

const DEFAULT_FILTERS: UtilFilters = {
  cpuMax: null,
  ramMax: null,
  netMax: null,
  diskMax: null,
  labelFilter: '',
};
```

To:

```typescript
interface UtilFilters {
  cpuMax: number | null;
  ramMax: number | null;
  netMax: number | null;
  diskMax: number | null;
  labelFilter: string;
  envFilter: string;   // composite "provider:subtype" — "" means no filter
}

const DEFAULT_FILTERS: UtilFilters = {
  cpuMax: null,
  ramMax: null,
  netMax: null,
  diskMax: null,
  labelFilter: '',
  envFilter: '',
};
```

- [ ] **Step 2: Update `activeCount` to include `envFilter`**

Change:

```typescript
  const activeCount = [
    filters.cpuMax !== null,
    filters.ramMax !== null,
    filters.netMax !== null,
    filters.diskMax !== null,
    !!filters.labelFilter,
  ].filter(Boolean).length;
```

To:

```typescript
  const activeCount = [
    filters.cpuMax !== null,
    filters.ramMax !== null,
    filters.netMax !== null,
    filters.diskMax !== null,
    !!filters.labelFilter,
    !!filters.envFilter,
  ].filter(Boolean).length;
```

- [ ] **Step 3: Add env filter logic to the `sorted` useMemo**

After the `labelFilter` check (line ~106), add:

```typescript
      // Hosted env filter — composite "provider:subtype" encoding
      if (filters.envFilter) {
        const [filterProvider, filterSubtype] = filters.envFilter.split(':');
        if (h.cloud_provider !== filterProvider) return false;
        if (filterSubtype !== '') {
          // Specific subtype requested
          if (filterSubtype === '') {
            // "aws:" means aws with null/unrecognized subtype
            if (h.host_subtype === 'ec2' || h.host_subtype === 'ecs' || h.host_subtype === 'fargate') return false;
          } else {
            if ((h.host_subtype ?? '') !== filterSubtype) return false;
          }
        }
      }
```

Wait — the encoding needs to be cleaner. Replace the above with this correct logic:

```typescript
      // Hosted env filter — composite "provider:subtype" encoding
      // "aws:ec2" = aws + ec2 subtype; "aws:" = aws + null/other subtype; "azure:" = any azure
      if (filters.envFilter) {
        const colonIdx = filters.envFilter.indexOf(':');
        const filterProvider = filters.envFilter.slice(0, colonIdx);
        const filterSubtype = filters.envFilter.slice(colonIdx + 1); // "" means "other/null"
        if (h.cloud_provider !== filterProvider) return false;
        if (filterSubtype !== '') {
          // Specific subtype — must match exactly
          if ((h.host_subtype ?? '') !== filterSubtype) return false;
        } else {
          // "provider:" means provider + no specific subtype (null or unrecognized)
          // Only applies when the provider has named subtypes (aws)
          if (filterProvider === 'aws') {
            const namedSubtypes = ['ec2', 'ecs', 'fargate'];
            if (namedSubtypes.includes(h.host_subtype ?? '')) return false;
          }
        }
      }
```

- [ ] **Step 4: Commit**

```bash
git add packages/frontend/src/components/HostTable.tsx
git commit -m "feat: add envFilter field to UtilFilters with cloud_provider+host_subtype filter logic"
```

---

## Task 6: Frontend — Add Hosted Env dropdown to filter panel and Env column to table

**Files:**
- Modify: `packages/frontend/src/components/HostTable.tsx`

Add the `<select>` dropdown in the filter panel (next to the Efficiency Label dropdown) and an "Env" column in the table header and rows.

- [ ] **Step 1: Add the Hosted Env `<select>` to the filter panel**

In the filter panel `<div>` that contains the sliders and the Efficiency Label select, add a new `<div>` right after the Efficiency Label block:

```tsx
            <div>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6, fontWeight: 600 }}>
                HOSTED ENV
              </div>
              <select
                value={draft.envFilter}
                onChange={e => setDraftFilter('envFilter', e.target.value)}
                style={{
                  padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 6,
                  fontSize: 13, background: 'white', color: '#1e293b', cursor: 'pointer',
                }}
              >
                <option value="">All environments</option>
                <option value="aws:ec2">AWS EC2</option>
                <option value="aws:ecs">AWS ECS</option>
                <option value="aws:fargate">AWS Fargate</option>
                <option value="aws:kubernetes_node">AWS (EKS node)</option>
                <option value="aws:">AWS (other)</option>
                <option value="azure:">Azure</option>
                <option value="gcp:">GCP</option>
                <option value="on-prem:">On-Prem / VMware</option>
                <option value="unknown:">Unknown</option>
              </select>
            </div>
```

- [ ] **Step 2: Add "Env" column header to the table `<thead>`**

In the `<tr>` inside `<thead>`, add a new `<th>` after the "Org" column:

```tsx
              <th style={thStyle}>Env</th>
```

- [ ] **Step 3: Add "Env" cell to each table row**

In the `<tr>` inside `pageSlice.map(host => ...)`, add a new `<td>` after the Org cell:

```tsx
                  <td style={{ ...tdStyle }}>
                    <EnvBadge provider={host.cloud_provider} subtype={host.host_subtype ?? null} />
                  </td>
```

- [ ] **Step 4: Update `colSpan` on the empty-state row**

The "No hosts match" row has `colSpan={9}`. It now needs `colSpan={10}`:

```tsx
                <td colSpan={10} style={{ ...tdStyle, textAlign: 'center', color: '#94a3b8', padding: 32 }}>
```

- [ ] **Step 5: Add the `EnvBadge` component at the bottom of `HostTable.tsx`**

Add this after the `pageBtn` function:

```tsx
function EnvBadge({ provider, subtype }: { provider: string; subtype: string | null }) {
  const label = envLabel(provider, subtype);
  const { bg, color, icon } = envStyle(provider);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600,
      background: bg, color,
    }}>
      {icon} {label}
    </span>
  );
}

function envLabel(provider: string, subtype: string | null): string {
  if (provider === 'aws') {
    if (subtype === 'ec2') return 'AWS EC2';
    if (subtype === 'ecs') return 'AWS ECS';
    if (subtype === 'fargate') return 'Fargate';
    if (subtype === 'kubernetes_node') return 'AWS EKS';
    return 'AWS';
  }
  if (provider === 'azure') {
    if (subtype === 'kubernetes_node') return 'Azure AKS';
    return 'Azure';
  }
  if (provider === 'gcp') {
    if (subtype === 'kubernetes_node') return 'GCP GKE';
    return 'GCP';
  }
  if (provider === 'on-prem') {
    if (subtype === 'vmware') return 'VMware';
    return 'On-Prem';
  }
  return 'Unknown';
}

function envStyle(provider: string): { bg: string; color: string; icon: string } {
  if (provider === 'aws')     return { bg: '#fff7ed', color: '#c2410c', icon: '☁' };
  if (provider === 'azure')   return { bg: '#eff6ff', color: '#1d4ed8', icon: '☁' };
  if (provider === 'gcp')     return { bg: '#f0fdf4', color: '#15803d', icon: '☁' };
  if (provider === 'on-prem') return { bg: '#f5f3ff', color: '#6d28d9', icon: '🖥' };
  return { bg: '#f8fafc', color: '#64748b', icon: '?' };
}
```

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/components/HostTable.tsx
git commit -m "feat: add Hosted Env filter dropdown and Env column to host table"
```

---

## Task 7: Frontend — Richer cloud+subtype display in `HostDetailRow.tsx`

**Files:**
- Modify: `packages/frontend/src/components/HostDetailRow.tsx`

The "Cloud / region" MetricCard currently shows just `host.cloud_provider`. Update it to show the full environment label (e.g. "AWS EC2", "VMware (On-Prem)") using the same `envLabel` logic. Since `envLabel` is defined in `HostTable.tsx`, we inline a small helper here rather than importing across component files.

- [ ] **Step 1: Add `envDisplayLabel` helper at the top of `HostDetailRow.tsx`**

Add this function before the `export default` line:

```typescript
function envDisplayLabel(provider: string, subtype: string | null): string {
  if (provider === 'aws') {
    if (subtype === 'ec2') return 'AWS EC2';
    if (subtype === 'ecs') return 'AWS ECS';
    if (subtype === 'fargate') return 'AWS Fargate';
    if (subtype === 'kubernetes_node') return 'AWS (EKS node)';
    return 'AWS';
  }
  if (provider === 'azure') {
    if (subtype === 'kubernetes_node') return 'Azure (AKS node)';
    return 'Azure';
  }
  if (provider === 'gcp') {
    if (subtype === 'kubernetes_node') return 'GCP (GKE node)';
    return 'GCP';
  }
  if (provider === 'on-prem') {
    if (subtype === 'vmware') return 'VMware (On-Prem)';
    return 'On-Prem';
  }
  return provider || '—';
}
```

- [ ] **Step 2: Update the "Cloud / region" MetricCard**

Find:

```tsx
          <MetricCard
            label="Cloud / region"
            value={host.cloud_provider || '—'}
            sub={host.instance_region ?? undefined}
          />
```

Replace with:

```tsx
          <MetricCard
            label="Hosted Env"
            value={envDisplayLabel(host.cloud_provider, host.host_subtype ?? null)}
            sub={host.instance_region ?? undefined}
          />
```

- [ ] **Step 3: Commit**

```bash
git add packages/frontend/src/components/HostDetailRow.tsx
git commit -m "feat: show full hosted env label (AWS EC2, VMware, etc.) in host detail row"
```

---

## Task 8: Playwright verification

**Files:**
- Test: `packages/frontend/e2e/` (existing test directory)

Verify the filter works end-to-end: the Env dropdown appears, selecting a value filters the table, and the Env column shows correct badges.

- [ ] **Step 1: Run existing Playwright tests to confirm no regressions**

```powershell
powershell.exe -Command "Set-Location 'C:\Users\manoj.kamatam\Documents\FinOps_Agent'; & '.\node_modules\.bin\playwright.cmd' test --reporter=line 2>&1"
```

Expected: all existing tests pass.

- [ ] **Step 2: Verify the frontend builds without TypeScript errors**

```powershell
powershell.exe -Command "Set-Location 'C:\Users\manoj.kamatam\Documents\FinOps_Agent\packages\frontend'; npx tsc --noEmit 2>&1"
```

Expected: no errors.

- [ ] **Step 3: Verify the agent package builds without TypeScript errors**

```powershell
powershell.exe -Command "Set-Location 'C:\Users\manoj.kamatam\Documents\FinOps_Agent\packages\agent'; npx tsc --noEmit 2>&1"
```

Expected: no errors.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: verify classification fixes and hosted env filter — all checks pass"
```

---

## Self-Review

**Spec coverage check:**
- Fix A (tags array parsing) → Task 2 ✅
- Fix B (headroom 1.3→1.5×) → Task 1 ✅
- Fix C (Azure/GCP specs routing) → Task 3 ✅
- Fix D (org-agent comment) → Task 4 ✅
- Hosted Env filter dropdown → Task 6 ✅
- Hosted Env filter logic → Task 5 ✅
- Env column in table → Task 6 ✅
- Richer detail row display → Task 7 ✅
- `host_subtype` already in `HostResult` interface (done in previous session) ✅

**Placeholder scan:** No TBDs, no TODOs, all code blocks complete.

**Type consistency:**
- `envFilter: string` used consistently across Tasks 5 and 6
- `host_subtype: string | null` matches the `HostResult` interface already updated
- `EnvBadge` props `{ provider: string; subtype: string | null }` match usage in Task 6 Step 3
- `envDisplayLabel` signature matches usage in Task 7 Step 2
- `colSpan` updated from 9→10 in Task 6 Step 4 to match the new column count ✅
