/**
 * SLO Audit API routes
 * POST /api/slo/trigger     — start a new SLO audit run
 * GET  /api/slo/status      — poll run progress
 * GET  /api/slo/results     — fetch completed run results
 * GET  /api/slo/active-run  — check if SLO run is active
 * POST /api/slo/abort       — abort running SLO run
 */
import { Router } from "express";
import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { getTenants } from "../config/tenants.js";
import {
  createSloRun,
  getSloRun,
  getActiveSloRun,
  getLatestCompletedSloRun,
  updateSloRunStatus,
  readAllSloResultsForRun,
  readSloHistory,
} from "../tools/slo-dynamodb.js";
import { runSloOrchestrator } from "../agents/slo-orchestrator.js";
import { markAborted } from "../tools/abort-registry.js";

export const sloApiRouter = Router();

const STALE_RUN_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours

// POST /api/slo/trigger
sloApiRouter.post("/trigger", async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const tenants = getTenants();
  const user = req.user!;

  const latest = await getActiveSloRun();
  if (latest) {
    const startedAt = String(latest["started_at"] ?? "");
    const ageMs = startedAt ? Date.now() - new Date(startedAt).getTime() : 0;

    if (ageMs > STALE_RUN_THRESHOLD_MS) {
      await updateSloRunStatus(
        String(latest["run_id"]),
        "failed",
        new Date().toISOString()
      );
      console.log(`[slo_api] Auto-reset stale SLO run ${latest["run_id"]} (age: ${Math.round(ageMs / 3600000)}h)`);
    } else {
      const slosTotal = Number(latest["slos_total"] ?? 0);
      const slosDone = Number(latest["slos_done"] ?? 0);
      const progressPct = slosTotal > 0 ? Math.round((slosDone / slosTotal) * 100) : 0;

      res.status(409).json({
        error: "An SLO audit run is already in progress",
        run_id: latest["run_id"],
        triggered_by: latest["triggered_by"],
        started_at: latest["started_at"],
        progress_pct: progressPct,
        slos_done: slosDone,
        slos_total: slosTotal,
      });
      return;
    }
  }

  const runId = `slo_run_${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}`;
  const triggerType = user.email === "scheduler" ? "scheduled" : "manual";

  await createSloRun({
    runId,
    triggerType,
    triggeredBy: user.email,
    tenantsTotal: tenants.length,
  });

  res.status(202).json({ run_id: runId, status: "running" });

  runSloOrchestrator(runId).catch((err: unknown) => {
    console.error(`[slo_api] SLO Orchestrator failed for run ${runId}:`, err);
  });
});

// GET /api/slo/status
sloApiRouter.get("/status", async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const runId = req.query["run_id"] as string | undefined;
  const run = runId ? await getSloRun(runId) : await getActiveSloRun();

  if (!run) {
    res.status(404).json({ error: "No SLO run found" });
    return;
  }

  const slosTotal = Number(run["slos_total"] ?? 0);
  const slosDone = Number(run["slos_done"] ?? 0);
  const progressPct = slosTotal > 0 ? Math.round((slosDone / slosTotal) * 100) : 0;

  res.json({
    run_id: run["run_id"],
    status: run["status"],
    trigger_type: run["trigger_type"],
    triggered_by: run["triggered_by"],
    started_at: run["started_at"],
    completed_at: run["completed_at"],
    tenants_total: run["tenants_total"] ?? 0,
    tenants_done: run["tenants_done"] ?? 0,
    slos_total: slosTotal,
    slos_done: slosDone,
    progress_pct: progressPct,
    log: run["log"] ?? [],
  });
});

// GET /api/slo/results
sloApiRouter.get("/results", async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const runId = req.query["run_id"] as string | undefined;
  let run: Record<string, unknown> | null;

  if (runId) {
    run = await getSloRun(runId);
    if (!run) {
      res.status(404).json({ error: "SLO run not found" });
      return;
    }
  } else {
    run = await getLatestCompletedSloRun();
    if (!run) {
      res.status(404).json({ error: "No completed SLO run found" });
      return;
    }
  }

  const rid = String(run["run_id"]);
  const { slo_results, org_summaries } = await readAllSloResultsForRun(rid);

  // Helper: normalize agent free-text sli_category to canonical values
  function normalizeCategory(raw: unknown): string {
    const s = String(raw ?? "").toLowerCase().trim();
    if (s.includes("availability") || s.includes("uptime") || s.includes("web uptime")) return "availability";
    if (s.includes("latency") || s.includes("response time") || s.includes("duration")) return "latency";
    if (s.includes("error") || s.includes("error_rate") || s.includes("success rate") || s.includes("request success")) return "error_rate";
    if (s.includes("throughput") || s.includes("request rate")) return "throughput";
    if (s.includes("saturation") || s.includes("cpu") || s.includes("memory") || s.includes("disk") || s.includes("infrastructure")) return "saturation";
    return "unclassified";
  }

  // Pre-group slo_results by tenant for recomputing org summary fields live
  const resultsByTenant = new Map<string, Record<string, unknown>[]>();
  for (const r of slo_results) {
    const tid = String(r["tenant_id"] ?? "");
    if (!resultsByTenant.has(tid)) resultsByTenant.set(tid, []);
    resultsByTenant.get(tid)!.push(r);
  }

  // Normalize org summaries — recompute all numeric/score fields live from slo_results
  // so stale stored values never show wrong data
  const normalizedSummaries = org_summaries.map(s => {
    const tid = String(s["tenant_id"] ?? "");
    const tenantResults = resultsByTenant.get(tid) ?? [];

    // Recompute counts from actual results
    const totalSlos = tenantResults.length;
    const validSlos = tenantResults.filter(r => Number(r["validation_score"] ?? 0) >= 75).length;
    const misconfiguredSlos = tenantResults.filter(r => Array.isArray(r["blocker_issues"]) && (r["blocker_issues"] as unknown[]).length > 0).length;
    const unclassifiedSlos = tenantResults.filter(r => normalizeCategory(r["sli_category"]) === "unclassified").length;

    // Recompute compliance score as average of all validation_scores
    const allScores = tenantResults.map(r => Number(r["validation_score"] ?? 0));
    const complianceScore = allScores.length > 0
      ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length)
      : 0;

    // Derive tier from computed score
    let complianceTier: string;
    if (complianceScore >= 90) complianceTier = "excellent";
    else if (complianceScore >= 75) complianceTier = "good";
    else if (complianceScore >= 50) complianceTier = "needs_improvement";
    else if (complianceScore >= 25) complianceTier = "poor";
    else complianceTier = "critical";

    // Recompute category scores from actual results
    const TRACKED = ["availability", "latency", "error_rate"] as const;
    const byCategory: Record<string, number[]> = { availability: [], latency: [], error_rate: [] };
    for (const r of tenantResults) {
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

    return {
      tenant_id: tid,
      run_id: s["run_id"] ?? rid,
      total_slos: totalSlos,
      valid_slos: validSlos,
      misconfigured_slos: misconfiguredSlos,
      unclassified_slos: unclassifiedSlos,
      compliance_score: complianceScore,
      compliance_tier: complianceTier,
      monitoring_context: (s["monitoring_context"] as Record<string, unknown>) ?? {
        apm_enabled: false,
        synthetics_enabled: false,
        infra_monitoring: true,
      },
      category_scores: categoryScores,
      na_categories: naCategories,
      gap_analysis: (Array.isArray(s["gap_analysis"]) ? s["gap_analysis"] : []).map((g: Record<string, unknown>) => {
        // Issue text: agents use different field names
        const issueText = String(g["insight"] ?? g["description"] ?? g["detail"] ?? "");
        // Gap type label: theme (PDI-Orbis) or title (PDI-Enterprise)
        const gapType = String(g["theme"] ?? g["title"] ?? "");
        // Severity: explicit field (PDI-Enterprise) or derive from priority/theme (PDI-Orbis)
        let sev = String(g["severity"] ?? "").toLowerCase();
        if (!sev || sev === "undefined") {
          const priority = Number(g["priority"] ?? 99);
          if (priority === 1) sev = "critical";
          else if (priority <= 3) sev = "high";
          else sev = "medium";
        }
        // Normalize "warning" → "medium" for display consistency
        if (sev === "warning") sev = "medium";
        // Affected SLO names: PDI-Orbis uses affected_slos[], PDI-Enterprise uses affected_slo_names[]
        const rawNames = g["affected_slo_names"] ?? g["affected_slos"];
        const affectedSloNames: string[] = Array.isArray(rawNames)
          ? (rawNames as unknown[]).map(String)
          : [];
        return {
          severity: sev,
          gap_type: gapType,
          issue: issueText,
          affected_slo_names: affectedSloNames,
          recommendation: g["recommendation"] ? String(g["recommendation"]) : undefined,
        };
      }),
      completed_at: String(s["completed_at"] ?? run["completed_at"] ?? ""),
    };
  });

  // Normalize slo_results — ensure all rendered fields are primitives, never objects
  const normalizedSloResults = slo_results.map((r: Record<string, unknown>) => ({
    slo_id: String(r["slo_id"] ?? ""),
    tenant_id: String(r["tenant_id"] ?? ""),
    slo_name: String(r["slo_name"] ?? r["name"] ?? r["slo_id"] ?? ""),
    slo_type: String(r["slo_type"] ?? r["type"] ?? "unknown"),
    sli_category: String(r["sli_category"] ?? "unclassified"),
    formula_valid: r["formula_valid"] !== false,
    formula_issue: r["formula_issue"] ? String(r["formula_issue"]) : null,
    context_compatible: r["context_compatible"] !== false,
    validation_score: Number(r["validation_score"] ?? 0),
    validation_status: String(r["validation_status"] ?? "critical"),
    blocker_issues: (Array.isArray(r["blocker_issues"]) ? r["blocker_issues"] : []).map(String),
    quality_issues: (Array.isArray(r["quality_issues"]) ? r["quality_issues"] : []).map(String),
    enhancements: (Array.isArray(r["enhancements"]) ? r["enhancements"] : []).map(String),
    insight: String(r["insight"] ?? ""),
    // tags: ensure every element is a string, never an object
    tags: (Array.isArray(r["tags"]) ? r["tags"] : [])
      .map((t: unknown) => typeof t === "string" ? t : typeof t === "object" && t !== null ? JSON.stringify(t) : String(t ?? "")),
    target_percentage: typeof r["target_percentage"] === "number" ? r["target_percentage"] : null,
    time_windows: (Array.isArray(r["time_windows"]) ? r["time_windows"] : []).map(String),
    analyzed_at: String(r["analyzed_at"] ?? ""),
  }));

  res.json({
    run_id: rid,
    completed_at: run["completed_at"],
    trigger_type: run["trigger_type"],
    org_summaries: normalizedSummaries,
    slo_results: normalizedSloResults,
  });
});

// GET /api/slo/active-run
sloApiRouter.get("/active-run", async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const run = await getActiveSloRun();

  if (!run) {
    res.status(404).json({ error: "No active SLO run" });
    return;
  }

  const slosTotal = Number(run["slos_total"] ?? 0);
  const slosDone = Number(run["slos_done"] ?? 0);
  const progressPct = slosTotal > 0 ? Math.round((slosDone / slosTotal) * 100) : 0;

  res.json({
    run_id: run["run_id"],
    status: run["status"],
    triggered_by: run["triggered_by"],
    started_at: run["started_at"],
    progress_pct: progressPct,
    slos_done: slosDone,
    slos_total: slosTotal,
  });
});

// GET /api/slo/history — served exclusively from DynamoDB cache (pre-fetched during audit run)
sloApiRouter.get("/history", async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const sloId = req.query["slo_id"] as string | undefined;
  const tenantId = req.query["tenant_id"] as string | undefined;

  if (!sloId || !tenantId) {
    res.status(400).json({ error: "slo_id and tenant_id are required" });
    return;
  }

  const latestRun = await getLatestCompletedSloRun();
  if (!latestRun) {
    res.status(404).json({ error: "No completed SLO run found — trigger an audit run first" });
    return;
  }

  const cached = await readSloHistory(String(latestRun["run_id"]), tenantId, sloId);
  if (!cached || cached.length === 0) {
    res.status(404).json({ error: "No history data for this SLO — trigger a new audit run to pre-fetch" });
    return;
  }

  const overallSli = Math.round(
    (cached.reduce((s, p) => s + p.sli_value, 0) / cached.length) * 10000
  ) / 10000;

  res.json({
    slo_id: sloId,
    tenant_id: tenantId,
    overall_sli: overallSli,
    data_points: cached.map(p => ({ month: p.month, timestamp: 0, sli_value: p.sli_value })),
  });
});

// POST /api/slo/abort
sloApiRouter.post("/abort", async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const user = req.user!;
  const { run_id } = req.body as { run_id?: string };

  if (!run_id) {
    res.status(400).json({ error: "run_id is required" });
    return;
  }

  const run = await getSloRun(run_id);
  if (!run) {
    res.status(404).json({ error: "SLO run not found" });
    return;
  }

  if (run["status"] !== "running") {
    res.status(409).json({ error: "SLO run is not currently running", status: run["status"] });
    return;
  }

  const completedAt = new Date().toISOString();
  await updateSloRunStatus(run_id, "failed", completedAt);
  markAborted(run_id);

  console.log(`[slo_api] SLO run ${run_id} aborted by ${user.email}`);

  res.json({
    run_id,
    status: "failed",
    aborted_by: user.email,
    completed_at: completedAt,
  });
});
