import { runOrgAnalysis } from "./org-agent.js";
import { getTenants } from "../config/tenants.js";
import { updateRunStatus } from "../tools/dynamodb.js";

export async function runOrchestrator(
  runId: string,
  oktaToken: string
): Promise<void> {
  const tenants = getTenants();
  console.log(`[orchestrator] Starting run ${runId} for ${tenants.length} tenants`);

  try {
    await Promise.all(
      tenants.map((tenant) =>
        runOrgAnalysis(tenant.tenant_id, oktaToken, runId)
      )
    );

    await updateRunStatus(runId, "completed", new Date().toISOString());
    console.log(`[orchestrator] Run ${runId} completed successfully`);
  } catch (err) {
    console.error(`[orchestrator] Run ${runId} failed:`, err);
    await updateRunStatus(runId, "failed", new Date().toISOString());
    throw err;
  }
}
