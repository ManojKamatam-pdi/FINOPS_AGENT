/**
 * Metric pre-fetch — fetches ALL metrics for ALL known hosts before batch agents run.
 *
 * Strategy (decided at runtime based on org size):
 *
 *   hosts.length <= 1000
 *     → ONE call per metric using {*} by {host} wildcard scope.
 *       Datadog's ~1000 series limit is not hit. 23 calls total. Zero complexity.
 *
 *   hosts.length > 1000
 *     → Explicit host-scoped queries chunked from the known host list:
 *         avg:system.cpu.idle{host:h1 OR host:h2 OR ...} by {host}
 *       Chunk size is computed from actual hostname lengths so the query string
 *       always fits within safe URL limits (~3000 chars for the scope portion).
 *       Every host is explicitly named → 100% coverage, zero cache misses.
 *
 * Call count examples:
 *   500  hosts  →  23 calls  (wildcard path)
 *   3406 hosts  →  ~35 chunks × 23 metrics = ~805 calls  (chunked path)
 *   vs old per-host approach: 3406 × 17 = ~57 902 calls  (36× reduction)
 *
 * Results are stored in DynamoDB (finops_metric_cache) keyed by metric name.
 * Batch agents call get_prefetched_metrics_tool to look up their hosts — always
 * a cache hit, no per-host Datadog queries needed.
 */
import { getTenants } from "../config/tenants.js";
import type { TenantConfig } from "../config/tenants.js";
import { writeMetricCache } from "../tools/metric-cache.js";
import { writeHostMetadataCache, readHostMetadataCache } from "../tools/host-metadata-cache.js";
import type { HostMetadata } from "../tools/host-metadata-cache.js";

const DD_API_BASE: Record<string, string> = {
  "datadoghq.com":     "https://api.datadoghq.com",
  "datadoghq.eu":      "https://api.datadoghq.eu",
  "us3.datadoghq.com": "https://api.us3.datadoghq.com",
  "us5.datadoghq.com": "https://api.us5.datadoghq.com",
  "ap1.datadoghq.com": "https://api.ap1.datadoghq.com",
};

/** Orgs at or below this size use a single {*} by {host} call per metric. */
const WILDCARD_THRESHOLD = 1000;

/**
 * Safe character budget for the scope portion of the query string.
 * Leaves room for the metric name, aggregation, "by {host}", and URL encoding overhead.
 */
const SCOPE_CHAR_BUDGET = 3000;

/** Hard cap on hosts per chunk regardless of hostname length. */
const MAX_CHUNK_SIZE = 100;

/**
 * Max concurrent HTTP requests to Datadog REST API.
 * 10 concurrent calls is safe for Datadog's public API rate limits (300 req/min per org).
 * At 10 concurrency, 1173 calls for a 3400-host org completes in ~2 min vs ~6 min at 3.
 * Retries with exponential backoff handle any transient 429s.
 */
const MAX_CONCURRENCY = 10;

/** Max retry attempts on transient network/server errors (429, 5xx, ECONNRESET). */
const MAX_RETRIES = 5;
/** Base delay in ms for exponential backoff between retries. 2s → 4s → 8s → 16s → 32s */
const RETRY_BASE_MS = 2000;

interface MetricSpec {
  /** Query template — {SCOPE} replaced with the actual scope string at call time */
  queryTemplate: string;
  /** Cache key — matches what batch agents expect */
  name: string;
}

const METRICS_TO_PREFETCH: MetricSpec[] = [
  // ── T1: Datadog Agent (system.*) ──────────────────────────────────────────
  // system.cpu.idle        → percentage (0-100); cpu_avg_30d  = 100 - value
  // system.cpu.idle p95    → rollup p95 over window; cpu_p95_30d = 100 - value
  // system.mem.pct_usable  → percentage (0-100); ram_avg_30d  = 100 - value
  // system.disk.in_use     → fraction (0-1);     disk_avg_30d = value * 100
  // system.net.bytes_rcvd/sent → bytes/sec; no transform
  { queryTemplate: "avg:system.cpu.idle{SCOPE} by {host}",                    name: "system.cpu.idle"            },
  { queryTemplate: "avg:system.cpu.idle{SCOPE} by {host}.rollup(p95, 3600)",  name: "system.cpu.idle.p95"        },
  { queryTemplate: "avg:system.mem.pct_usable{SCOPE} by {host}",              name: "system.mem.pct_usable"      },
  { queryTemplate: "avg:system.disk.in_use{SCOPE} by {host}",                 name: "system.disk.in_use"         },
  { queryTemplate: "avg:system.net.bytes_rcvd{SCOPE} by {host}",              name: "system.net.bytes_rcvd"      },
  { queryTemplate: "avg:system.net.bytes_sent{SCOPE} by {host}",              name: "system.net.bytes_sent"      },

  // ── T2: AWS EC2 ───────────────────────────────────────────────────────────
  // aws.ec2.cpuutilization → percentage (0-100); no transform
  // aws.ec2.cpuutilization p95 → rollup p95 over window
  // aws.ec2.network_in/out → bytes; no transform
  { queryTemplate: "avg:aws.ec2.cpuutilization{SCOPE} by {host}",                    name: "aws.ec2.cpuutilization"     },
  { queryTemplate: "avg:aws.ec2.cpuutilization{SCOPE} by {host}.rollup(p95, 3600)",  name: "aws.ec2.cpuutilization.p95" },
  { queryTemplate: "avg:aws.ec2.network_in{SCOPE} by {host}",                        name: "aws.ec2.network_in"         },
  { queryTemplate: "avg:aws.ec2.network_out{SCOPE} by {host}",                       name: "aws.ec2.network_out"        },

  // ── T2: Azure VM ──────────────────────────────────────────────────────────
  // azure.vm.percentage_cpu         → percentage (0-100); no transform
  // azure.vm.available_memory_bytes → bytes remaining; ram% = 100 - (value / total_bytes * 100) after Step C
  // azure.vm.network_in/out_total   → bytes; no transform
  { queryTemplate: "avg:azure.vm.percentage_cpu{SCOPE} by {host}",                name: "azure.vm.percentage_cpu"         },
  { queryTemplate: "avg:azure.vm.available_memory_bytes{SCOPE} by {host}",        name: "azure.vm.available_memory_bytes" },
  { queryTemplate: "avg:azure.vm.network_in_total{SCOPE} by {host}",              name: "azure.vm.network_in_total"       },
  { queryTemplate: "avg:azure.vm.network_out_total{SCOPE} by {host}",             name: "azure.vm.network_out_total"      },

  // ── T2: GCP GCE ───────────────────────────────────────────────────────────
  // gcp.gce.instance.cpu.utilization          → fraction (0-1); cpu% = value * 100
  // gcp.gce.instance.memory.balloon.ram_used  → bytes used; ram% = (value / total_bytes * 100) after Step C
  // gcp.gce.instance.network.*_bytes_count    → bytes; no transform
  { queryTemplate: "avg:gcp.gce.instance.cpu.utilization{SCOPE} by {host}",                    name: "gcp.gce.instance.cpu.utilization"              },
  { queryTemplate: "avg:gcp.gce.instance.memory.balloon.ram_used{SCOPE} by {host}",            name: "gcp.gce.instance.memory.balloon.ram_used"      },
  { queryTemplate: "avg:gcp.gce.instance.network.received_bytes_count{SCOPE} by {host}",       name: "gcp.gce.instance.network.received_bytes_count" },
  { queryTemplate: "avg:gcp.gce.instance.network.sent_bytes_count{SCOPE} by {host}",           name: "gcp.gce.instance.network.sent_bytes_count"     },

  // ── T2: VMware vSphere ────────────────────────────────────────────────────
  // vsphere.cpu.usage.avg       → percentage (0-100); no transform
  // vsphere.mem.usage.average   → percentage (0-100); no transform
  // vsphere.disk.usage.avg      → KBps (I/O throughput, NOT disk space %) — stored as-is, informational only
  //                               NOTE: No vSphere metric provides disk space %; disk_avg_30d stays null for VMware-only hosts
  // vsphere.net.received/transmitted.avg → KBps; transform: * 1024 to get bytes/sec for consistency with T1
  { queryTemplate: "avg:vsphere.cpu.usage.avg{SCOPE} by {host}",       name: "vsphere.cpu.usage.avg"       },
  { queryTemplate: "avg:vsphere.mem.usage.average{SCOPE} by {host}",   name: "vsphere.mem.usage.average"   },
  { queryTemplate: "avg:vsphere.disk.usage.avg{SCOPE} by {host}",      name: "vsphere.disk.usage.avg"      },
  { queryTemplate: "avg:vsphere.net.received.avg{SCOPE} by {host}",    name: "vsphere.net.received.avg"    },
  { queryTemplate: "avg:vsphere.net.transmitted.avg{SCOPE} by {host}", name: "vsphere.net.transmitted.avg" },
];

/**
 * Compute chunk size from actual hostname lengths.
 * Uses the longest hostname in the list so every chunk is guaranteed to fit.
 * "host:<name> OR " = 5 + len + 4 = len + 9 chars per host (last host has no " OR ").
 */
function computeChunkSize(hostnames: string[]): number {
  const maxLen = hostnames.reduce((m, h) => Math.max(m, h.length), 0);
  const charsPerHost = maxLen + 9; // "host:" + name + " OR "
  const size = Math.floor(SCOPE_CHAR_BUDGET / charsPerHost);
  return Math.min(Math.max(size, 1), MAX_CHUNK_SIZE);
}

/** Split an array into chunks of at most `size` elements. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Build Datadog scope string from a hostname chunk. */
function buildScope(hostnames: string[]): string {
  return hostnames.map(h => `host:${h}`).join(" OR ");
}

/** Fetch one metric query and return hostname → average-over-window map. Retries on transient errors. */
async function fetchMetricQuery(
  apiBase: string,
  apiKey: string,
  appKey: string,
  query: string,
  fromTs: number,
  toTs: number
): Promise<Record<string, number>> {
  const url = `${apiBase}/api/v1/query?from=${fromTs}&to=${toTs}&query=${encodeURIComponent(query)}`;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, delay));
      console.log(`[metric_prefetch] Retry ${attempt}/${MAX_RETRIES} for query "${query.slice(0, 80)}"`);
    }
    try {
      const resp = await fetch(url, {
        method: "GET",
        headers: {
          "DD-API-KEY": apiKey,
          "DD-APPLICATION-KEY": appKey,
          "Accept": "application/json",
        },
      });

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "(unreadable)");
        // 429 = rate limited, 500/502/503/504 = transient server error — retry with backoff
        if (resp.status === 429 || resp.status >= 500) {
          lastErr = new Error(`HTTP ${resp.status}`);
          console.warn(`[metric_prefetch] HTTP ${resp.status} (transient) — will retry with backoff`);
          continue;
        }
        // 4xx other than 429 = permanent client error (bad query, auth) — don't retry
        console.error(
          `[metric_prefetch] HTTP ${resp.status} for query "${query.slice(0, 120)}": ${errBody.slice(0, 300)}`
        );
        return {};
      }

      const data = await resp.json() as {
        series?: Array<{
          scope?: string;
          pointlist?: Array<[number, number | null]>;
        }>;
      };

      const result: Record<string, number> = {};
      for (const series of (data.series ?? [])) {
        const scope = series.scope ?? "";
        const m = scope.match(/(?:^|,)\s*host:([^,]+)/);
        if (!m) continue;
        const hostname = m[1].trim();
        const points = (series.pointlist ?? [])
          .map(([, v]) => v)
          .filter((v): v is number => v !== null && isFinite(v));
        if (points.length === 0) continue;
        result[hostname] = points.reduce((a, b) => a + b, 0) / points.length;
      }
      return result;
    } catch (err) {
      lastErr = err;
      // Only retry on transient network errors
      const msg = String(err);
      const isTransient = msg.includes("ECONNRESET") || msg.includes("TIMEOUT") ||
        msg.includes("UND_ERR_CONNECT_TIMEOUT") || msg.includes("terminated") ||
        msg.includes("fetch failed");
      if (!isTransient) throw err;
    }
  }
  throw lastErr;
}

/** Run tasks with bounded concurrency. */
async function withConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number
): Promise<Array<PromiseSettledResult<T>>> {
  const results: Array<PromiseSettledResult<T>> = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await tasks[i]() };
      } catch (err) {
        results[i] = { status: "rejected", reason: err };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/**
 * Pre-fetch all metrics for all known hosts and store in DynamoDB.
 *
 * @param tenantId  Org identifier
 * @param runId     Run identifier
 * @param hosts     Full host list from runListHostsAgent
 */
export async function runMetricPrefetch(
  tenantId: string,
  runId: string,
  hosts: Array<{ host_id: string; host_name: string }>
): Promise<{ metricsStored: number; hostsWithData: number }> {
  const tenants = getTenants();
  const tenant = tenants.find((t: TenantConfig) => t.tenant_id === tenantId);
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);

  const site = tenant.dd_site ?? "datadoghq.com";
  const apiBase = DD_API_BASE[site] ?? DD_API_BASE["datadoghq.com"];
  const apiKey = tenant.dd_api_key;
  const appKey = tenant.dd_app_key;

  const toTs = Math.floor(Date.now() / 1000);
  const fromTs = toTs - 30 * 24 * 60 * 60;

  const hostnames = [...new Set(hosts.map(h => h.host_name).filter(Boolean))];
  const useWildcard = hostnames.length <= WILDCARD_THRESHOLD;

  // ── Build fetch tasks ──────────────────────────────────────────────────────
  // Each task is a () => Promise<{specName, chunkValues}> closure.
  // Wildcard path: one task per metric (scope = "*").
  // Chunked path:  one task per (metric × chunk).
  const accumulated: Record<string, Record<string, number>> = {};
  for (const spec of METRICS_TO_PREFETCH) accumulated[spec.name] = {};

  let tasks: Array<() => Promise<{ specName: string; chunkValues: Record<string, number> }>>;

  if (useWildcard) {
    console.log(
      `[metric_prefetch:${tenantId}] ${hostnames.length} hosts ≤ ${WILDCARD_THRESHOLD} — ` +
      `wildcard path: ${METRICS_TO_PREFETCH.length} calls total`
    );
    tasks = METRICS_TO_PREFETCH.map(spec => async () => {
      const query = spec.queryTemplate.replace("{SCOPE}", "{*}");
      const chunkValues = await fetchMetricQuery(apiBase, apiKey, appKey, query, fromTs, toTs);
      return { specName: spec.name, chunkValues };
    });
  } else {
    const chunkSize = computeChunkSize(hostnames);
    const chunks = chunk(hostnames, chunkSize);
    const totalCalls = chunks.length * METRICS_TO_PREFETCH.length;
    console.log(
      `[metric_prefetch:${tenantId}] ${hostnames.length} hosts > ${WILDCARD_THRESHOLD} — ` +
      `chunked path: ${chunks.length} chunks × ${METRICS_TO_PREFETCH.length} metrics = ` +
      `${totalCalls} calls (chunk size=${chunkSize}, concurrency=${MAX_CONCURRENCY})`
    );
    tasks = METRICS_TO_PREFETCH.flatMap(spec =>
      chunks.map(ch => async () => {
        const scope = buildScope(ch);
        const query = spec.queryTemplate.replace("{SCOPE}", `{${scope}}`);
        const chunkValues = await fetchMetricQuery(apiBase, apiKey, appKey, query, fromTs, toTs);
        return { specName: spec.name, chunkValues };
      })
    );
  }

  // ── Execute with bounded concurrency ──────────────────────────────────────
  const results = await withConcurrency(tasks, MAX_CONCURRENCY);

  let failedTasks = 0;
  for (const result of results) {
    if (result.status === "rejected") {
      failedTasks++;
      console.error(`[metric_prefetch:${tenantId}] Task rejected:`, result.reason);
      continue;
    }
    const { specName, chunkValues } = result.value;
    Object.assign(accumulated[specName], chunkValues);
  }
  if (failedTasks > 0) {
    console.warn(`[metric_prefetch:${tenantId}] ${failedTasks} fetch tasks failed`);
  }

  // ── Persist non-empty metric maps to DynamoDB ──────────────────────────────
  let metricsStored = 0;
  const allHostnames = new Set<string>();

  for (const spec of METRICS_TO_PREFETCH) {
    const hostValues = accumulated[spec.name];
    const count = Object.keys(hostValues).length;
    if (count === 0) {
      console.log(`[metric_prefetch:${tenantId}] ${spec.name}: no data (integration not active)`);
      continue;
    }
    await writeMetricCache(tenantId, runId, spec.name, hostValues);
    metricsStored++;
    for (const h of Object.keys(hostValues)) allHostnames.add(h);
    console.log(`[metric_prefetch:${tenantId}] ${spec.name}: ${count} hosts`);
  }

  const hostsWithData = allHostnames.size;
  console.log(
    `[metric_prefetch:${tenantId}] Done — ${metricsStored} metrics stored, ` +
    `${hostsWithData}/${hostnames.length} hosts have at least one metric`
  );
  return { metricsStored, hostsWithData };
}

// ─── Host Metadata Pre-fetch ──────────────────────────────────────────────────

/** Datadog GET /api/v1/hosts response shape (fields we care about). */
interface DdHostListResponse {
  host_list?: DdHostEntry[];
  total_matching?: number;
  total_returned?: number;
}

interface DdHostEntry {
  name?: string;
  host_name?: string;
  aliases?: string[];
  apps?: string[];
  sources?: string[];
  tags_by_source?: Record<string, string[]>;
  meta?: {
    "instance-type"?: string;
    platform?: string;
    [key: string]: unknown;
  };
}

/** Max hosts per page for GET /api/v1/hosts. Datadog supports up to 1000. */
const HOST_PAGE_SIZE = 1000;

/**
 * Pre-fetch host metadata (aliases, tags, apps, instance_type, cloud_provider)
 * for all hosts in an org using the Datadog REST API GET /api/v1/hosts.
 *
 * This collapses N_hosts MCP search_datadog_hosts calls into ceil(N/1000) REST calls.
 * Results are stored in DynamoDB (finops_host_metadata_cache) so batch agents can
 * call get_prefetched_host_metadata_tool instead of search_datadog_hosts.
 *
 * @param tenantId  Org identifier
 * @param runId     Run identifier
 */
export async function runHostMetadataPrefetch(
  tenantId: string,
  runId: string
): Promise<{ hostsStored: number }> {
  const tenants = getTenants();
  const tenant = tenants.find((t: TenantConfig) => t.tenant_id === tenantId);
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);

  const site = tenant.dd_site ?? "datadoghq.com";
  const apiBase = DD_API_BASE[site] ?? DD_API_BASE["datadoghq.com"];
  const apiKey = tenant.dd_api_key;
  const appKey = tenant.dd_app_key;

  const hostMap: Record<string, HostMetadata> = {};
  let start = 0;
  let totalMatching = 0;

  console.log(`[host_metadata_prefetch:${tenantId}] Starting bulk host metadata fetch`);

  // Paginate through all hosts
  while (true) {
    const url = `${apiBase}/api/v1/hosts?count=${HOST_PAGE_SIZE}&start=${start}&include_muted_hosts_data=false&include_hosts_metadata=true`;

    // Retry on transient network errors
    let resp: Response | undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, RETRY_BASE_MS * Math.pow(2, attempt - 1)));
        console.log(`[host_metadata_prefetch:${tenantId}] Retry ${attempt}/${MAX_RETRIES} for page start=${start}`);
      }
      try {
        resp = await fetch(url, {
          method: "GET",
          headers: {
            "DD-API-KEY": apiKey,
            "DD-APPLICATION-KEY": appKey,
            "Accept": "application/json",
          },
        });
        break; // success
      } catch (err) {
        lastErr = err;
        const msg = String(err);
        const isTransient = msg.includes("ECONNRESET") || msg.includes("TIMEOUT") ||
          msg.includes("UND_ERR_CONNECT_TIMEOUT") || msg.includes("terminated") ||
          msg.includes("fetch failed");
        if (!isTransient) throw err;
      }
    }
    if (!resp) throw lastErr;

    if (!resp.ok) {
      throw new Error(`GET /api/v1/hosts returned ${resp.status}: ${await resp.text()}`);
    }

    const data = await resp.json() as DdHostListResponse;
    const page = data.host_list ?? [];
    totalMatching = data.total_matching ?? totalMatching;

    for (const entry of page) {
      const hostname = entry.name ?? entry.host_name ?? "";
      if (!hostname) continue;

      // Flatten tags_by_source into a single array (same format as search_datadog_hosts tags column)
      const allTags: string[] = [];
      for (const tagList of Object.values(entry.tags_by_source ?? {})) {
        allTags.push(...tagList);
      }
      // Deduplicate tags
      const tags = [...new Set(allTags)];

      // instance_type: prefer meta["instance-type"], fall back to instance-type tag
      let instance_type: string | null = entry.meta?.["instance-type"] ?? null;
      if (!instance_type) {
        const itTag = tags.find(t => t.startsWith("instance-type:"));
        if (itTag) instance_type = itTag.split(":").slice(1).join(":").trim() || null;
      }

      // cloud_provider: from explicit tag, fall back to null (batch agent classifies)
      let cloud_provider: string | null = null;
      const cpTag = tags.find(t => t.startsWith("cloud_provider:"));
      if (cpTag) cloud_provider = cpTag.split(":")[1]?.trim() ?? null;

      // apps: union of apps + sources arrays
      const apps = [...new Set([...(entry.apps ?? []), ...(entry.sources ?? [])])];

      hostMap[hostname] = {
        tags,
        aliases: entry.aliases ?? [],
        apps,
        instance_type,
        cloud_provider,
        // REST API does not return hardware specs — these are seeded from DDSQL in runListHostsAgent
        // and preserved below when we merge with the existing cache.
        memory_mib: null,
        cpu_logical_processors: null,
      };
    }

    console.log(
      `[host_metadata_prefetch:${tenantId}] Page start=${start}: got ${page.length} hosts ` +
      `(accumulated=${Object.keys(hostMap).length}, total_matching=${totalMatching})`
    );

    start += page.length;

    // Stop when page is empty or we've fetched all hosts
    if (page.length === 0 || (totalMatching > 0 && Object.keys(hostMap).length >= totalMatching)) break;
  }

  const hostsStored = Object.keys(hostMap).length;

  if (hostsStored > 0) {
    // Preserve memory_mib and cpu_logical_processors seeded by runListHostsAgent from DDSQL.
    // The REST API /api/v1/hosts does NOT return these fields — they come only from the
    // DDSQL SELECT query run at list-hosts time. Read the existing cache and carry them forward.
    let existingCache: Record<string, HostMetadata> = {};
    try {
      existingCache = await readHostMetadataCache(tenantId, runId);
    } catch {
      // If the cache doesn't exist yet (first run), that's fine — no hardware specs to preserve.
    }

    let hardwarePreserved = 0;
    for (const [hostname, meta] of Object.entries(hostMap)) {
      const existing = existingCache[hostname];
      if (existing) {
        // Carry forward DDSQL hardware specs if the REST API entry doesn't have them
        if (meta.memory_mib === null && existing.memory_mib !== null) {
          meta.memory_mib = existing.memory_mib;
          hardwarePreserved++;
        }
        if (meta.cpu_logical_processors === null && existing.cpu_logical_processors !== null) {
          meta.cpu_logical_processors = existing.cpu_logical_processors;
        }
      }
    }

    if (hardwarePreserved > 0) {
      console.log(
        `[host_metadata_prefetch:${tenantId}] Preserved memory_mib/cpu_logical_processors ` +
        `for ${hardwarePreserved} hosts from DDSQL seed`
      );
    }

    await writeHostMetadataCache(tenantId, runId, hostMap);
  }

  console.log(
    `[host_metadata_prefetch:${tenantId}] Done — ${hostsStored} hosts stored ` +
    `(${Math.ceil(hostsStored / HOST_PAGE_SIZE)} REST pages)`
  );

  return { hostsStored };
}
