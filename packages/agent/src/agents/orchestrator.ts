import { runOrgAnalysis } from "./org-agent.js";
import { getTenants } from "../config/tenants.js";
import { updateRunStatus, getRun } from "../tools/dynamodb.js";
import { isAborted, clearAborted } from "../tools/abort-registry.js";

export async function runOrchestrator(
  runId: string,
  _oktaToken: string
): Promise<void> {
  const tenants = getTenants();
  console.log(`[orchestrator] Starting run ${runId} for ${tenants.length} tenants`);

  try {
    // Run all orgs in parallel — use allSettled so one org failing doesn't abort others.
    const orgResults = await Promise.allSettled(
      tenants.map((tenant) =>
        runOrgAnalysis(tenant.tenant_id, runId)
      )
    );

    // Log per-org outcomes
    for (let i = 0; i < orgResults.length; i++) {
      const r = orgResults[i];
      const tid = tenants[i].tenant_id;
      if (r.status === "rejected") {
        console.error(`[orchestrator] Org ${tid} failed:`, r.reason);
      } else {
        console.log(`[orchestrator] Org ${tid} completed`);
      }
    }

    // Don't mark completed if aborted mid-run
    if (isAborted(runId)) {
      console.log(`[orchestrator] Run ${runId} was aborted — skipping completion`);
      clearAborted(runId);
      return;
    }

    // Guard: never promote a zero-host run to "completed" — it means something
    // went wrong upstream (e.g. DDSQL query failed, credentials invalid, etc.).
    // Mark it failed so it never overwrites a previous good report.
    const runRecord = await getRun(runId);
    const hostsDone = Number(runRecord?.["hosts_done"] ?? 0);
    if (hostsDone === 0) {
      console.error(`[orchestrator] Run ${runId} produced 0 hosts — marking failed to protect last good report`);
      await updateRunStatus(runId, "failed", new Date().toISOString());
      return;
    }

    // If any org failed but we still have hosts, mark completed (partial success is still useful).
    const anyFailed = orgResults.some((r) => r.status === "rejected");
    if (anyFailed) {
      console.warn(`[orchestrator] Run ${runId} completed with partial failures — ${hostsDone} hosts processed`);
    } else {
      console.log(`[orchestrator] Run ${runId} completed successfully (${hostsDone} hosts processed)`);
    }
    await updateRunStatus(runId, "completed", new Date().toISOString());
  } catch (err) {
    if (isAborted(runId)) {
      console.log(`[orchestrator] Run ${runId} aborted (caught error during abort)`);
      clearAborted(runId);
      return;
    }
    console.error(`[orchestrator] Run ${runId} failed:`, err);
    await updateRunStatus(runId, "failed", new Date().toISOString());
    throw err;
  }
}
