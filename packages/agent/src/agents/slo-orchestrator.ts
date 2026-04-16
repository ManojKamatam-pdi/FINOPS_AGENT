import { runSloOrgAnalysis } from "./slo-org-agent.js";
import { getTenants } from "../config/tenants.js";
import { updateSloRunStatus, getSloRun } from "../tools/slo-dynamodb.js";
import { isAborted, clearAborted } from "../tools/abort-registry.js";

export async function runSloOrchestrator(runId: string): Promise<void> {
  const tenants = getTenants();
  console.log(`[slo_orchestrator] Starting run ${runId} for ${tenants.length} tenants`);

  try {
    await Promise.all(
      tenants.map((tenant) =>
        runSloOrgAnalysis(tenant.tenant_id, runId)
      )
    );

    if (isAborted(runId)) {
      console.log(`[slo_orchestrator] Run ${runId} was aborted — skipping completion`);
      clearAborted(runId);
      return;
    }

    // Guard: never promote a zero-SLO run to "completed"
    const runRecord = await getSloRun(runId);
    const slosDone = Number(runRecord?.["slos_done"] ?? 0);
    const slosTotal = Number(runRecord?.["slos_total"] ?? 0);

    // If no SLOs were found at all (empty org), still mark completed
    // Only fail if we expected SLOs but wrote none
    if (slosTotal > 0 && slosDone === 0) {
      console.error(`[slo_orchestrator] Run ${runId} found ${slosTotal} SLOs but wrote 0 results — marking failed`);
      await updateSloRunStatus(runId, "failed", new Date().toISOString());
      return;
    }

    await updateSloRunStatus(runId, "completed", new Date().toISOString());
    console.log(`[slo_orchestrator] Run ${runId} completed successfully (${slosDone} SLOs processed)`);
  } catch (err) {
    if (isAborted(runId)) {
      console.log(`[slo_orchestrator] Run ${runId} aborted (caught error during abort)`);
      clearAborted(runId);
      return;
    }
    console.error(`[slo_orchestrator] Run ${runId} failed:`, err);
    await updateSloRunStatus(runId, "failed", new Date().toISOString());
    throw err;
  }
}
