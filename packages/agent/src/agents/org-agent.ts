import { runListHostsAgent } from "./list-hosts-agent.js";
import { runHostBatchAgent } from "./host-batch-agent.js";
import { runSummarizeAgent } from "./summarize-agent.js";
import { runMetricPrefetch, runHostMetadataPrefetch } from "./metric-prefetch-agent.js";
import { readHostList } from "../tools/dynamodb.js";
import { isAborted } from "../tools/abort-registry.js";

const BATCH_SIZE = 15;       // 15 hosts per batch — process_batch_tool handles all 15 in parallel server-side
const BATCH_CONCURRENCY = 5; // 5 concurrent batches — each batch is 2 LLM turns with tiny context, no rate limiting

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

  // ── Bulk pre-fetch: metrics + host metadata ────────────────────────────────
  // Both run in parallel before batch agents start.
  //
  // Metric pre-fetch: collapses N_hosts × 23 per-host Datadog calls into
  //   23 org-wide calls (≤1000 hosts) or N_chunks × 23 calls (>1000 hosts).
  //   Batch agents call get_prefetched_metrics_tool — always a cache hit.
  //
  // Host metadata pre-fetch: collapses N_hosts search_datadog_hosts MCP calls
  //   into ceil(N/1000) REST API calls (GET /api/v1/hosts, 1000/page).
  //   Batch agents call get_prefetched_host_metadata_tool — no MCP needed for Step A.
  //   Falls back to search_datadog_hosts only for individual cache misses (rare).
  //
  // If either pre-fetch fails it is non-fatal — batch agents degrade gracefully:
  //   metric failure  → all hosts get efficiency_label = "unknown"
  //   metadata failure → batch agents fall back to per-host search_datadog_hosts
  console.log(`[org_analysis:${tenantId}] Starting metric + host metadata pre-fetch for ${hosts.length} hosts`);
  const [metricResult, metadataResult] = await Promise.allSettled([
    runMetricPrefetch(tenantId, runId, hosts),
    runHostMetadataPrefetch(tenantId, runId),
  ]);

  if (metricResult.status === "fulfilled") {
    const { metricsStored, hostsWithData } = metricResult.value;
    console.log(`[org_analysis:${tenantId}] Metric pre-fetch complete — ${metricsStored} metrics, ${hostsWithData} hosts with data`);
  } else {
    console.error(`[org_analysis:${tenantId}] Metric pre-fetch FAILED — all hosts will have unknown efficiency labels:`, metricResult.reason);
  }

  if (metadataResult.status === "fulfilled") {
    const { hostsStored } = metadataResult.value;
    console.log(`[org_analysis:${tenantId}] Host metadata pre-fetch complete — ${hostsStored} hosts stored`);
  } else {
    console.error(`[org_analysis:${tenantId}] Host metadata pre-fetch FAILED — batch agents will fall back to per-host search_datadog_hosts:`, metadataResult.reason);
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
