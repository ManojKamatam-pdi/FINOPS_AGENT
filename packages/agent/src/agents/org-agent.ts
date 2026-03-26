import { runListHostsAgent } from "./list-hosts-agent.js";
import { runHostBatchAgent } from "./host-batch-agent.js";
import { runSummarizeAgent } from "./summarize-agent.js";
import { runMetricPrefetch } from "./metric-prefetch-agent.js";
import { readHostList } from "../tools/dynamodb.js";
import { isAborted } from "../tools/abort-registry.js";

const BATCH_SIZE = 15;        // 15 hosts per batch — agent processes them in parallel phases (see host-batch-agent.ts)
const BATCH_CONCURRENCY = 30; // 30 parallel batches per wave → high throughput across large orgs

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

  // ── Bulk metric pre-fetch ──────────────────────────────────────────────────
  // Fetch all metrics org-wide in one pass before dispatching batch agents.
  // This collapses N_hosts × 17 per-host Datadog calls into 17 org-wide calls.
  // Batch agents look up pre-fetched data; hosts not in cache fall back to
  // per-host queries automatically (graceful degradation for large orgs).
  console.log(`[org_analysis:${tenantId}] Starting metric pre-fetch for ${hosts.length} hosts`);
  try {
    const { metricsStored, hostsWithData } = await runMetricPrefetch(tenantId, runId, hosts);
    console.log(`[org_analysis:${tenantId}] Metric pre-fetch complete — ${metricsStored} metrics, ${hostsWithData} hosts with data`);
  } catch (err) {
    // Non-fatal but impactful: if pre-fetch fails, get_prefetched_metrics_tool returns all-null
    // for every host, so all hosts in this org will be written with efficiency_label = "unknown".
    // No per-host fallback exists — the batch agent relies entirely on the pre-fetched cache.
    console.error(`[org_analysis:${tenantId}] Metric pre-fetch FAILED — all hosts will have unknown efficiency labels:`, err);
  }

  if (isAborted(runId)) {
    console.log(`[org_analysis:${tenantId}] Run aborted after metric pre-fetch — stopping`);
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
