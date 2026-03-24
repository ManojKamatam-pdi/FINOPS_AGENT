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
    await Promise.all(
      tenants.map((tenant) =>
        runOrgAnalysis(tenant.tenant_id, runId)
      )
    );

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

    await updateRunStatus(runId, "completed", new Date().toISOString());
    console.log(`[orchestrator] Run ${runId} completed successfully (${hostsDone} hosts processed)`);
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
