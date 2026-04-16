import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { storeSloList } from "../tools/slo-dynamodb.js";
import { getTenants } from "../config/tenants.js";

/**
 * Fetches all SLOs from the Datadog REST API directly (GET /api/v1/slo).
 * For monitor-type SLOs, bulk-fetches monitor details and embeds them so the
 * batch agent has everything it needs without making extra Datadog API calls.
 */

const DD_API_BASE: Record<string, string> = {
  "datadoghq.com":     "https://api.datadoghq.com",
  "datadoghq.eu":      "https://api.datadoghq.eu",
  "us3.datadoghq.com": "https://api.us3.datadoghq.com",
  "us5.datadoghq.com": "https://api.us5.datadoghq.com",
  "ap1.datadoghq.com": "https://api.ap1.datadoghq.com",
};

interface MonitorSummary {
  id: number;
  name: string;
  type: string;
  query?: string;
  tags?: string[];
}

interface SloObject {
  id: string;
  name: string;
  description?: string;
  type: string;
  tags?: string[];
  query?: { numerator?: string; denominator?: string };
  monitor_ids?: number[];
  monitor_details?: MonitorSummary[];  // enriched — embedded by list server
  thresholds?: Array<{ timeframe: string; target: number }>;
  target_threshold?: number;
}

async function ddGet(apiBase: string, apiKey: string, appKey: string, path: string): Promise<unknown> {
  const resp = await fetch(`${apiBase}${path}`, {
    method: "GET",
    headers: {
      "DD-API-KEY": apiKey,
      "DD-APPLICATION-KEY": appKey,
      "Accept": "application/json",
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Datadog API ${path} returned ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function fetchAllSlosViaRestApi(tenantId: string): Promise<{
  slos: SloObject[];
  monitoring_context: { apm_enabled: boolean; synthetics_enabled: boolean; infra_monitoring: boolean };
}> {
  const tenants = getTenants();
  const tenant = tenants.find((t: { tenant_id: string }) => t.tenant_id === tenantId);
  if (!tenant) throw new Error(`Tenant ${tenantId} not found in registry`);

  const site = tenant.dd_site ?? "datadoghq.com";
  const apiBase = DD_API_BASE[site] ?? DD_API_BASE["datadoghq.com"];

  // ── Step 1: Fetch all SLOs with pagination ──────────────────────────────────
  const allSlos: SloObject[] = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const data = await ddGet(apiBase, tenant.dd_api_key, tenant.dd_app_key, `/api/v1/slo?limit=${limit}&offset=${offset}`) as {
      data?: SloObject[];
      metadata?: { page?: { total_count?: number } };
    };

    const page = data?.data ?? [];
    allSlos.push(...page);

    console.log(`[slo_list:${tenantId}] Page at offset=${offset}: got ${page.length} SLOs (accumulated=${allSlos.length})`);

    if (page.length < limit) break;
    offset += page.length;

    const total = data?.metadata?.page?.total_count;
    if (total !== undefined && allSlos.length >= total) break;
  }

  // ── Step 2: Bulk-fetch monitor details for all monitor-type SLOs ────────────
  // Collect all unique monitor IDs referenced by monitor SLOs
  const monitorIds = new Set<number>();
  for (const slo of allSlos) {
    if (slo.type === "monitor" && Array.isArray(slo.monitor_ids)) {
      for (const id of slo.monitor_ids) monitorIds.add(id);
    }
  }

  // Fetch monitors in batches of 100 (Datadog API limit per request)
  const monitorMap = new Map<number, MonitorSummary>();
  if (monitorIds.size > 0) {
    const idChunks: number[][] = [];
    const idArray = Array.from(monitorIds);
    for (let i = 0; i < idArray.length; i += 100) {
      idChunks.push(idArray.slice(i, i + 100));
    }

    await Promise.all(idChunks.map(async (chunk) => {
      try {
        const idList = chunk.join(",");
        const data = await ddGet(apiBase, tenant.dd_api_key, tenant.dd_app_key, `/api/v1/monitor?monitor_ids=${idList}`) as MonitorSummary[];
        for (const m of (Array.isArray(data) ? data : [])) {
          monitorMap.set(m.id, { id: m.id, name: m.name, type: m.type, query: m.query, tags: m.tags });
        }
      } catch (err) {
        console.warn(`[slo_list:${tenantId}] Monitor fetch chunk failed:`, err);
      }
    }));

    console.log(`[slo_list:${tenantId}] Fetched ${monitorMap.size}/${monitorIds.size} monitor details`);
  }

  // ── Step 3: Embed monitor details into each monitor SLO ────────────────────
  for (const slo of allSlos) {
    if (slo.type === "monitor" && Array.isArray(slo.monitor_ids)) {
      slo.monitor_details = slo.monitor_ids
        .map(id => monitorMap.get(id))
        .filter((m): m is MonitorSummary => m !== undefined);
    }
  }

  // ── Step 4: Derive monitoring context from the enriched SLO portfolio ───────
  let apm_enabled = false;
  let synthetics_enabled = false;

  for (const slo of allSlos) {
    // Metric SLOs: check query for APM traces
    if (slo.query?.numerator?.includes("trace.") || slo.query?.denominator?.includes("trace.")) {
      apm_enabled = true;
    }
    // Monitor SLOs: check embedded monitor type/name for synthetics
    if (slo.monitor_details?.some(m =>
      m.type === "synthetics alert" ||
      m.name?.toLowerCase().includes("synthetic") ||
      m.tags?.some(t => t.includes("synthetic"))
    )) {
      synthetics_enabled = true;
    }
    // SLO-level tags as fallback
    if (slo.tags?.some(t => t.includes("synthetics") || t.includes("synthetic"))) {
      synthetics_enabled = true;
    }
  }

  return {
    slos: allSlos,
    monitoring_context: { apm_enabled, synthetics_enabled, infra_monitoring: true },
  };
}

// ── Step 5: Pre-fetch 12-month monthly SLI history ──────────────────────────
// Strategy: 12 sequential monthly calls per SLO (one per calendar month),
// 20 SLOs concurrently. Matches reference approach for accurate monthly SLI values.
const HISTORY_CONCURRENCY = 20;

async function fetchMonthlyHistory(
  apiBase: string,
  apiKey: string,
  appKey: string,
  sloId: string
): Promise<{ month: string; sli_value: number }[]> {
  const results: { month: string; sli_value: number }[] = [];
  for (let i = 11; i >= 0; i--) {  // oldest first (11 months ago → current month)
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    d.setMonth(d.getMonth() - i);
    const fromTs = Math.floor(d.getTime() / 1000);
    const toD = new Date(d);
    toD.setMonth(toD.getMonth() + 1);
    const toTs = Math.floor(toD.getTime() / 1000);
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    try {
      const data = await ddGet(
        apiBase, apiKey, appKey,
        `/api/v1/slo/${encodeURIComponent(sloId)}/history?from_ts=${fromTs}&to_ts=${toTs}`
      );
      const overall = (data as { data?: { overall?: { sli_value?: number | null } } })?.data?.overall;
      const sliValue = overall?.sli_value;
      if (typeof sliValue === "number") {
        results.push({ month, sli_value: Math.round(sliValue * 10000) / 10000 });
      }
    } catch {
      // Skip this month — don't fail the whole SLO
    }
  }
  return results;
}

/**
 * Pre-fetches 12-month monthly SLI history for all SLOs concurrently.
 * Designed to be fired as a background promise — does NOT block the batch audit phase.
 */
export async function prefetchSloHistory(
  tenantId: string,
  runId: string,
  slos: SloObject[]
): Promise<void> {
  const { storeSloHistory } = await import("../tools/slo-dynamodb.js");
  const tenants = getTenants();
  const tenant = tenants.find((t: { tenant_id: string }) => t.tenant_id === tenantId);
  if (!tenant) return;

  const site = tenant.dd_site ?? "datadoghq.com";
  const apiBase = DD_API_BASE[site] ?? DD_API_BASE["datadoghq.com"];
  const historyMap: Record<string, { month: string; sli_value: number }[]> = {};

  for (let i = 0; i < slos.length; i += HISTORY_CONCURRENCY) {
    const batch = slos.slice(i, i + HISTORY_CONCURRENCY);
    await Promise.all(batch.map(async (slo) => {
      try {
        const pts = await fetchMonthlyHistory(apiBase, tenant.dd_api_key, tenant.dd_app_key, slo.id);
        if (pts.length > 0) {
          historyMap[`${tenantId}#${slo.id}`] = pts;
        } else {
          console.log(`[slo_list:${tenantId}] No history data for SLO ${slo.id} (${slo.name}) — all 12 months returned null sli_value`);
        }
      } catch (err) {
        console.warn(`[slo_list:${tenantId}] History fetch failed for SLO ${slo.id}:`, err);
      }
    }));
  }

  console.log(`[slo_list:${tenantId}] Pre-fetched history for ${Object.keys(historyMap).length}/${slos.length} SLOs`);
  await storeSloHistory(runId, tenantId, historyMap);
}

export function createSloListServer(tenantId: string, runId: string) {
  return createSdkMcpServer({
    name: "slo-list-tools",
    version: "1.0.0",
    tools: [
      tool(
        "fetch_and_store_all_slos_tool",
        "Fetch ALL SLOs from the Datadog REST API (handles pagination internally), enrich monitor SLOs with their monitor details, derive monitoring context, write everything to DynamoDB, and update the run total. Call this once — it does everything.",
        {},
        async (_input) => {
          const { slos, monitoring_context } = await fetchAllSlosViaRestApi(tenantId);
          await storeSloList(runId, tenantId, slos, monitoring_context);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                tenant_id: tenantId,
                total_slos: slos.length,
                monitoring_context,
              }),
            }],
          };
        }
      ),
    ],
  });
}
