/**
 * REST API routes — mirrors the Python FastAPI endpoints exactly.
 * POST /api/trigger      — start a new analysis run
 * GET  /api/status       — poll run progress
 * GET  /api/results      — fetch completed run results
 * GET  /api/active-run   — get currently running run (if any)
 * POST /api/abort        — explicitly abort a running run
 */
import { Router } from "express";
import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { getTenants } from "../config/tenants.js";
import {
  createRun,
  getRun,
  getLatestCompletedRun,
  getActiveRun,
  getOrgSummariesForRun,
  getHostResultsForRun,
  updateRunStatus,
} from "../tools/dynamodb.js";
import { runOrchestrator } from "../agents/orchestrator.js";
import { markAborted } from "../tools/abort-registry.js";

export const apiRouter = Router();

const STALE_RUN_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours

// POST /api/trigger
apiRouter.post("/trigger", async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const tenants = getTenants();
  const user = req.user!;

  // Check if a run is already in progress
  const latest = await getActiveRun();
  if (latest) {
    const startedAt = String(latest["started_at"] ?? "");
    const ageMs = startedAt ? Date.now() - new Date(startedAt).getTime() : 0;

    // Auto-reset stale runs older than 4 hours (handles server restarts)
    if (ageMs > STALE_RUN_THRESHOLD_MS) {
      await updateRunStatus(
        String(latest["run_id"]),
        "failed",
        new Date().toISOString()
      );
      console.log(`[api] Auto-reset stale run ${latest["run_id"]} (age: ${Math.round(ageMs / 3600000)}h)`);
    } else {
      // Active run — return rich 409 with full conflict info
      const hostsTotal = Number(latest["hosts_total"] ?? 0);
      const hostsDone = Number(latest["hosts_done"] ?? 0);
      const progressPct = hostsTotal > 0 ? Math.round((hostsDone / hostsTotal) * 100) : 0;

      res.status(409).json({
        error: "A run is already in progress",
        run_id: latest["run_id"],
        triggered_by: latest["triggered_by"],
        started_at: latest["started_at"],
        progress_pct: progressPct,
        hosts_done: hostsDone,
        hosts_total: hostsTotal,
      });
      return;
    }
  }

  // Generate run_id matching Python format: run_2026-03-18T12:00:00Z
  const runId = `run_${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}`;
  const triggerType = user.email === "scheduler" ? "scheduled" : "manual";

  await createRun({
    runId,
    triggerType,
    triggeredBy: user.email,
    oktaToken: user.rawToken,
    tenantsTotal: tenants.length,
  });

  // Respond immediately — orchestrator runs in background
  res.status(202).json({ run_id: runId, status: "running" });

  // Fire and forget
  runOrchestrator(runId, user.rawToken).catch((err: unknown) => {
    console.error(`[api] Orchestrator failed for run ${runId}:`, err);
  });
});

// GET /api/status
apiRouter.get("/status", async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const runId = req.query["run_id"] as string | undefined;
  const run = runId ? await getRun(runId) : await getActiveRun();

  if (!run) {
    res.status(404).json({ error: "No run found" });
    return;
  }

  const hostsTotal = Number(run["hosts_total"] ?? 0);
  const hostsDone = Number(run["hosts_done"] ?? 0);
  const progressPct = hostsTotal > 0 ? Math.round((hostsDone / hostsTotal) * 100) : 0;

  res.json({
    run_id: run["run_id"],
    status: run["status"],
    trigger_type: run["trigger_type"],
    triggered_by: run["triggered_by"],
    started_at: run["started_at"],
    completed_at: run["completed_at"],
    tenants_total: run["tenants_total"] ?? 0,
    tenants_done: run["tenants_done"] ?? 0,
    hosts_total: hostsTotal,
    hosts_done: hostsDone,
    progress_pct: progressPct,
    log: run["log"] ?? [],
  });
});

// GET /api/results
apiRouter.get("/results", async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const runId = req.query["run_id"] as string | undefined;
  let run: Record<string, unknown> | null;

  if (runId) {
    run = await getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
  } else {
    run = await getLatestCompletedRun();
    if (!run) {
      res.status(404).json({ error: "No completed run found" });
      return;
    }
  }

  const rid = String(run["run_id"]);
  const [orgSummaries, hostResults] = await Promise.all([
    getOrgSummariesForRun(rid),
    getHostResultsForRun(rid),
  ]);

  // Recompute org summaries from the full paginated host_results so the card
  // numbers always match the host table exactly (the stored summaries may have
  // been written before the DynamoDB pagination fix was in place).
  const summaryMap = new Map<string, Record<string, unknown>>();
  for (const h of hostResults) {
    const tid = String(h["tenant_id"] ?? "unknown");
    if (!summaryMap.has(tid)) {
      summaryMap.set(tid, {
        tenant_id: tid,
        total_hosts: 0,
        hosts_analyzed: 0,
        hosts_over_provisioned: 0,
        hosts_right_sized: 0,
        hosts_under_provisioned: 0,
        hosts_no_tag: 0,
        total_monthly_spend: 0,
        potential_savings: 0,
        cpu_sum: 0, cpu_count: 0,
        ram_sum: 0, ram_count: 0,
        top_offenders_raw: [] as Array<{ host_id: string; savings: number }>,
      });
    }
    const s = summaryMap.get(tid)!;
    s["total_hosts"] = (s["total_hosts"] as number) + 1;
    const label = String(h["efficiency_label"] ?? "unknown");
    if (label !== "unknown") s["hosts_analyzed"] = (s["hosts_analyzed"] as number) + 1;
    if (label === "over-provisioned") s["hosts_over_provisioned"] = (s["hosts_over_provisioned"] as number) + 1;
    if (label === "right-sized") s["hosts_right_sized"] = (s["hosts_right_sized"] as number) + 1;
    if (label === "under-provisioned") s["hosts_under_provisioned"] = (s["hosts_under_provisioned"] as number) + 1;
    if (!h["has_instance_tag"]) s["hosts_no_tag"] = (s["hosts_no_tag"] as number) + 1;
    if (typeof h["current_monthly_cost"] === "number") s["total_monthly_spend"] = (s["total_monthly_spend"] as number) + h["current_monthly_cost"];
    if (typeof h["monthly_savings"] === "number" && (h["monthly_savings"] as number) > 0) {
      s["potential_savings"] = (s["potential_savings"] as number) + (h["monthly_savings"] as number);
      (s["top_offenders_raw"] as Array<{ host_id: string; savings: number }>).push({ host_id: String(h["host_id"] ?? ""), savings: h["monthly_savings"] as number });
    }
    if (typeof h["cpu_avg_30d"] === "number") { s["cpu_sum"] = (s["cpu_sum"] as number) + h["cpu_avg_30d"]; s["cpu_count"] = (s["cpu_count"] as number) + 1; }
    if (typeof h["ram_avg_30d"] === "number") { s["ram_sum"] = (s["ram_sum"] as number) + h["ram_avg_30d"]; s["ram_count"] = (s["ram_count"] as number) + 1; }
  }

  // Build final summaries — merge with stored summaries for fields we don't recompute (completed_at)
  const storedByTenant = new Map(orgSummaries.map(s => [String(s["tenant_id"]), s]));
  const recomputedSummaries = Array.from(summaryMap.values()).map(s => {
    const stored = storedByTenant.get(String(s["tenant_id"])) ?? {};
    const spend = Math.round((s["total_monthly_spend"] as number) * 100) / 100;
    const savings = Math.round((s["potential_savings"] as number) * 100) / 100;
    const topOffenders = (s["top_offenders_raw"] as Array<{ host_id: string; savings: number }>)
      .sort((a, b) => b.savings - a.savings).slice(0, 5).map(x => x.host_id);
    return {
      tenant_id: s["tenant_id"],
      total_hosts: s["total_hosts"],
      hosts_analyzed: s["hosts_analyzed"],
      hosts_over_provisioned: s["hosts_over_provisioned"],
      hosts_right_sized: s["hosts_right_sized"],
      hosts_under_provisioned: s["hosts_under_provisioned"],
      hosts_no_tag: s["hosts_no_tag"],
      total_monthly_spend: spend,
      potential_savings: savings,
      savings_percent: spend > 0 ? Math.round((savings / spend) * 1000) / 10 : 0,
      avg_cpu_utilization: (s["cpu_count"] as number) > 0 ? Math.round(((s["cpu_sum"] as number) / (s["cpu_count"] as number)) * 10) / 10 : 0,
      avg_ram_utilization: (s["ram_count"] as number) > 0 ? Math.round(((s["ram_sum"] as number) / (s["ram_count"] as number)) * 10) / 10 : 0,
      top_offenders: topOffenders,
      completed_at: stored["completed_at"] ?? run["completed_at"],
    };
  });

  res.json({
    run_id: rid,
    completed_at: run["completed_at"],
    trigger_type: run["trigger_type"],
    org_summaries: recomputedSummaries,
    host_results: hostResults.map(h => {
      // Recover savings_percent when agent omitted it but we have the raw numbers
      const savings = typeof h["monthly_savings"] === "number" ? h["monthly_savings"] as number : null;
      const cost    = typeof h["current_monthly_cost"] === "number" ? h["current_monthly_cost"] as number : null;
      const pct     = h["savings_percent"] != null
        ? h["savings_percent"]
        : (savings != null && cost != null && cost > 0)
          ? Math.round((savings / cost) * 1000) / 10
          : null;

      // Normalize cloud_provider: "unknown (on-prem/bare-metal)" → "on-prem",
      // and "unknown" with no instance_type/region → "on-prem"
      const providerNormMap: Record<string, string> = {
        "on-premise": "on-prem", "on-premises": "on-prem",
        "on-prem/unknown": "on-prem", "onprem": "on-prem", "on_prem": "on-prem",
        "bare-metal": "on-prem", "baremetal": "on-prem", "vmware": "on-prem",
        "unknown (on-prem/bare-metal)": "on-prem", "unknown (on-prem)": "on-prem",
      };
      const rawProvider = String(h["cloud_provider"] ?? "unknown").toLowerCase();
      let cloud_provider = providerNormMap[rawProvider] ?? h["cloud_provider"];

      return { ...h, savings_percent: pct, cloud_provider };
    }),
  });
});

// GET /api/active-run
apiRouter.get("/active-run", async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const run = await getActiveRun();

  if (!run) {
    res.status(404).json({ error: "No active run" });
    return;
  }

  const hostsTotal = Number(run["hosts_total"] ?? 0);
  const hostsDone = Number(run["hosts_done"] ?? 0);
  const progressPct = hostsTotal > 0 ? Math.round((hostsDone / hostsTotal) * 100) : 0;

  res.json({
    run_id: run["run_id"],
    status: run["status"],
    triggered_by: run["triggered_by"],
    started_at: run["started_at"],
    progress_pct: progressPct,
    hosts_done: hostsDone,
    hosts_total: hostsTotal,
  });
});

// POST /api/abort
apiRouter.post("/abort", async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const user = req.user!;
  const { run_id } = req.body as { run_id?: string };

  if (!run_id) {
    res.status(400).json({ error: "run_id is required" });
    return;
  }

  const run = await getRun(run_id);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  if (run["status"] !== "running") {
    res.status(409).json({ error: "Run is not currently running", status: run["status"] });
    return;
  }

  const completedAt = new Date().toISOString();
  await updateRunStatus(run_id, "failed", completedAt);
  markAborted(run_id); // Signal in-memory agents to stop

  console.log(`[api] Run ${run_id} aborted by ${user.email}`);

  res.json({
    run_id,
    status: "failed",
    aborted_by: user.email,
    completed_at: completedAt,
  });
});
