import { runListHostsAgent } from "./list-hosts-agent.js";
import { runHostBatchAgent } from "./host-batch-agent.js";
import { runSummarizeAgent } from "./summarize-agent.js";
import { readHostList } from "../tools/dynamodb.js";
import { isAborted } from "../tools/abort-registry.js";

const BATCH_SIZE = 15;        // 15 hosts × ~13 turns/host avg = ~195 turns — fits maxTurns:200 with headroom
const BATCH_CONCURRENCY = 30; // more parallel batches → higher throughput per wave

export async function runOrgAnalysis(
  tenantId: string,
  runId: string
): Promise<void> {
  console.log(`[org_analysis:${tenantId}] Starting host discovery`);

  await runListHostsAgent(tenantId, runId);

  if (isAborted(runId)) {
    console.log(`[org_analysis:${tenantId}] Run aborted after host discovery — stopping`);
    return;
  }

  const hosts = await readHostList(tenantId, runId);
  if (hosts.length === 0) {
    console.warn(`[org_analysis:${tenantId}] No hosts found — skipping batch analysis`);
    await runSummarizeAgent(tenantId, runId);
    return;
  }

  const batches: Array<typeof hosts> = [];
  for (let i = 0; i < hosts.length; i += BATCH_SIZE) {
    batches.push(hosts.slice(i, i + BATCH_SIZE));
  }

  console.log(`[org_analysis:${tenantId}] Found ${hosts.length} hosts → ${batches.length} batches, concurrency=${BATCH_CONCURRENCY}`);

  for (let i = 0; i < batches.length; i += BATCH_CONCURRENCY) {
    // Check abort signal before each wave
    if (isAborted(runId)) {
      console.log(`[org_analysis:${tenantId}] Run aborted — stopping at wave ${Math.floor(i / BATCH_CONCURRENCY) + 1}`);
      return;
    }

    const wave = batches.slice(i, i + BATCH_CONCURRENCY);
    console.log(`[org_analysis:${tenantId}] Wave ${Math.floor(i / BATCH_CONCURRENCY) + 1}/${Math.ceil(batches.length / BATCH_CONCURRENCY)} — running ${wave.length} batches`);
    await Promise.all(
      wave.map((batch, j) =>
        runHostBatchAgent(tenantId, batch, runId, i + j, batches.length)
      )
    );
  }

  // Final abort check before summarize
  if (isAborted(runId)) {
    console.log(`[org_analysis:${tenantId}] Run aborted — skipping summarize`);
    return;
  }

  console.log(`[org_analysis:${tenantId}] All batches complete, running summarize`);
  await runSummarizeAgent(tenantId, runId);
  console.log(`[org_analysis:${tenantId}] Org analysis complete`);
}
