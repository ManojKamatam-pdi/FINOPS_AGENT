/**
 * REST API routes — mirrors the Python FastAPI endpoints exactly.
 * POST /api/trigger  — start a new analysis run
 * GET  /api/status   — poll run progress
 * GET  /api/results  — fetch completed run results
 */
import { Router } from "express";
import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { getTenants } from "../config/tenants.js";
import {
  createRun,
  getRun,
  getLatestRun,
  getLatestCompletedRun,
  getOrgSummariesForRun,
  getHostResultsForRun,
} from "../tools/dynamodb.js";
import { runOrchestrator } from "../agents/orchestrator.js";

export const apiRouter = Router();

// POST /api/trigger
apiRouter.post("/trigger", async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const tenants = getTenants();
  const user = req.user!;

  // Reject if a run is already in progress
  const latest = await getLatestRun();
  if (latest && latest["status"] === "running") {
    res.status(409).json({
      error: "A run is already in progress",
      run_id: latest["run_id"],
    });
    return;
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
  const run = runId ? await getRun(runId) : await getLatestRun();

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

  res.json({
    run_id: rid,
    completed_at: run["completed_at"],
    trigger_type: run["trigger_type"],
    org_summaries: orgSummaries,
    host_results: hostResults,
  });
});
