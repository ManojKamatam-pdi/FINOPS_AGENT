import { runSloListAgent } from "./slo-list-agent.js";
import { runSloBatchAgent } from "./slo-batch-agent.js";
import { runSloSummarizeAgent } from "./slo-summarize-agent.js";
import {
  readSloList,
  readSloResultsForOrg,
  writeSloOrgSummary,
  updateSloTenantsDone,
} from "../tools/slo-dynamodb.js";
import { isAborted } from "../tools/abort-registry.js";
import { prefetchSloHistory } from "../mcp-servers/slo-list-server.js";

const SLO_BATCH_SIZE = 20;       // 20 SLOs per batch — fits maxTurns:200 with headroom
const SLO_BATCH_CONCURRENCY = 10; // 10 concurrent batch agents

export async function runSloOrgAnalysis(
  tenantId: string,
  runId: string
): Promise<void> {
  console.log(`[slo_org:${tenantId}] Starting SLO discovery`);

  await runSloListAgent(tenantId, runId);

  if (isAborted(runId)) {
    console.log(`[slo_org:${tenantId}] Run aborted after SLO discovery — stopping`);
    return;
  }

  const sloData = await readSloList(runId, tenantId);
  if (!sloData || sloData.slos.length === 0) {
    console.warn(`[slo_org:${tenantId}] No SLOs found — running summarize with empty portfolio`);
    await runSloSummarizeAgent(tenantId, runId);
    return;
  }

  const { slos, monitoring_context } = sloData;

  // Fire history pre-fetch as background — runs concurrently with batch audit, never blocks it
  prefetchSloHistory(tenantId, runId, slos as never[]).catch(err =>
    console.warn(`[slo_org:${tenantId}] History pre-fetch failed (non-fatal):`, err)
  );

  const batches: unknown[][] = [];
  for (let i = 0; i < slos.length; i += SLO_BATCH_SIZE) {
    batches.push(slos.slice(i, i + SLO_BATCH_SIZE));
  }

  console.log(`[slo_org:${tenantId}] Found ${slos.length} SLOs → ${batches.length} batches, concurrency=${SLO_BATCH_CONCURRENCY}`);
  console.log(`[slo_org:${tenantId}] Monitoring context: APM=${monitoring_context.apm_enabled}, Synthetics=${monitoring_context.synthetics_enabled}`);

  for (let i = 0; i < batches.length; i += SLO_BATCH_CONCURRENCY) {
    if (isAborted(runId)) {
      console.log(`[slo_org:${tenantId}] Run aborted — stopping at wave ${Math.floor(i / SLO_BATCH_CONCURRENCY) + 1}`);
      return;
    }

    const wave = batches.slice(i, i + SLO_BATCH_CONCURRENCY);
    console.log(`[slo_org:${tenantId}] Wave ${Math.floor(i / SLO_BATCH_CONCURRENCY) + 1}/${Math.ceil(batches.length / SLO_BATCH_CONCURRENCY)} — running ${wave.length} batches`);
    await Promise.all(
      wave.map((batch, j) =>
        runSloBatchAgent(tenantId, batch, runId, monitoring_context, i + j, batches.length)
      )
    );
  }

  if (isAborted(runId)) {
    console.log(`[slo_org:${tenantId}] Run aborted — skipping summarize`);
    return;
  }

  console.log(`[slo_org:${tenantId}] All batches complete, running summarize`);
  await runSloSummarizeAgent(tenantId, runId);

  // Fallback: if the summarize agent didn't write a summary (e.g. hit max_turns),
  // compute and write one server-side so the org always appears in the UI
  await ensureOrgSummaryExists(tenantId, runId, monitoring_context);

  console.log(`[slo_org:${tenantId}] Org SLO analysis complete`);
}

/**
 * Checks if an org summary was written for this run. If not, computes and writes
 * one directly from the stored SLO results. This guarantees the org card always
 * appears in the UI even if the summarize agent hit max_turns or failed silently.
 */
async function ensureOrgSummaryExists(
  tenantId: string,
  runId: string,
  monitoringContext: { apm_enabled: boolean; synthetics_enabled: boolean; infra_monitoring: boolean }
): Promise<void> {
  const results = await readSloResultsForOrg(tenantId, runId);
  if (results.length === 0) return;

  // Check if the agent already wrote a summary — only write fallback if it didn't
  const { readAllSloResultsForRun } = await import("../tools/slo-dynamodb.js");
  const { org_summaries } = await readAllSloResultsForRun(runId);
  const hasSummary = org_summaries.some(s => String(s["tenant_id"]) === tenantId);
  if (hasSummary) return;

  console.log(`[slo_org:${tenantId}] No summary written by agent — writing server-side fallback`);

  function normalizeCategory(raw: unknown): string {
    const s = String(raw ?? "").toLowerCase().trim();
    if (s.includes("availability") || s.includes("uptime")) return "availability";
    if (s.includes("latency") || s.includes("response time") || s.includes("duration")) return "latency";
    if (s.includes("error") || s.includes("error_rate") || s.includes("success rate")) return "error_rate";
    if (s.includes("throughput") || s.includes("request rate")) return "throughput";
    if (s.includes("saturation") || s.includes("cpu") || s.includes("memory") || s.includes("disk")) return "saturation";
    return "unclassified";
  }

  const TRACKED = ["availability", "latency", "error_rate"] as const;
  const byCategory: Record<string, number[]> = { availability: [], latency: [], error_rate: [] };
  for (const r of results) {
    const cat = normalizeCategory(r["sli_category"]);
    if (cat in byCategory) byCategory[cat].push(Number(r["validation_score"] ?? 0));
  }

  const categoryScores: Record<string, number | null> = {};
  const naCategories: string[] = [];
  for (const cat of TRACKED) {
    const scores = byCategory[cat];
    if (scores.length === 0) {
      categoryScores[cat] = null;
      naCategories.push(cat);
    } else {
      categoryScores[cat] = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    }
  }

  const allScores = results.map(r => Number(r["validation_score"] ?? 0));
  const complianceScore = allScores.length > 0
    ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length)
    : 0;

  let complianceTier: string;
  if (complianceScore >= 90) complianceTier = "excellent";
  else if (complianceScore >= 75) complianceTier = "good";
  else if (complianceScore >= 50) complianceTier = "needs_improvement";
  else if (complianceScore >= 25) complianceTier = "poor";
  else complianceTier = "critical";

  const validSlos = results.filter(r => Number(r["validation_score"] ?? 0) >= 75).length;
  const misconfiguredSlos = results.filter(r => Array.isArray(r["blocker_issues"]) && (r["blocker_issues"] as unknown[]).length > 0).length;
  const unclassifiedSlos = results.filter(r => normalizeCategory(r["sli_category"]) === "unclassified").length;

  await writeSloOrgSummary(tenantId, runId, {
    tenant_id: tenantId,
    run_id: runId,
    total_slos: results.length,
    valid_slos: validSlos,
    misconfigured_slos: misconfiguredSlos,
    unclassified_slos: unclassifiedSlos,
    compliance_score: complianceScore,
    compliance_tier: complianceTier,
    monitoring_context: monitoringContext,
    category_scores: categoryScores,
    na_categories: naCategories,
    gap_analysis: [],
    completed_at: new Date().toISOString(),
  });
  await updateSloTenantsDone(runId);
}
