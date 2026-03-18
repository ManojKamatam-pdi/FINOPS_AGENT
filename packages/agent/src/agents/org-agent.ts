import { runListHostsAgent } from "./list-hosts-agent.js";
import { runHostBatchAgent } from "./host-batch-agent.js";
import { runSummarizeAgent } from "./summarize-agent.js";
import { readHostList } from "../tools/dynamodb.js";

const BATCH_SIZE = 50;       // hosts per batch agent (50 → ~70 batches for 3,500 hosts)
const BATCH_CONCURRENCY = 10; // max parallel batch agents at once

export async function runOrgAnalysis(
  tenantId: string,
  oktaToken: string,
  runId: string
): Promise<void> {
  console.log(`[org_analysis:${tenantId}] Starting host discovery`);

  await runListHostsAgent(tenantId, oktaToken, runId);

  const hosts = await readHostList(tenantId, runId);
  if (hosts.length === 0) {
    console.warn(`[org_analysis:${tenantId}] No hosts found — skipping batch analysis`);
    await runSummarizeAgent(tenantId, oktaToken, runId);
    return;
  }

  const batches: Array<typeof hosts> = [];
  for (let i = 0; i < hosts.length; i += BATCH_SIZE) {
    batches.push(hosts.slice(i, i + BATCH_SIZE));
  }

  console.log(`[org_analysis:${tenantId}] Found ${hosts.length} hosts → ${batches.length} batches, concurrency=${BATCH_CONCURRENCY}`);

  // Run batches in waves of BATCH_CONCURRENCY to avoid overwhelming AgentCore
  for (let i = 0; i < batches.length; i += BATCH_CONCURRENCY) {
    const wave = batches.slice(i, i + BATCH_CONCURRENCY);
    console.log(`[org_analysis:${tenantId}] Wave ${Math.floor(i / BATCH_CONCURRENCY) + 1}/${Math.ceil(batches.length / BATCH_CONCURRENCY)} — running ${wave.length} batches`);
    await Promise.all(
      wave.map((batch, j) =>
        runHostBatchAgent(tenantId, batch, oktaToken, runId, i + j, batches.length)
      )
    );
  }

  console.log(`[org_analysis:${tenantId}] All batches complete, running summarize`);
  await runSummarizeAgent(tenantId, oktaToken, runId);
  console.log(`[org_analysis:${tenantId}] Org analysis complete`);
}
