import { fetchAllHostsViaMcp } from "../mcp-servers/list-hosts-server.js";
import { writeHostList, updateHostsTotal } from "../tools/dynamodb.js";
import { writeHostMetadataCache } from "../tools/host-metadata-cache.js";
import type { HostMetadata } from "../tools/host-metadata-cache.js";

/**
 * Fetches all hosts for a tenant from Datadog and writes them to DynamoDB.
 * Calls the fetch function directly — no LLM agent loop needed for a single
 * deterministic operation. Using an agent here introduced non-deterministic
 * failures where the model would acknowledge the request without calling the tool.
 *
 * Also seeds the host metadata cache with memory_mib and cpu_logical_processors
 * from the DDSQL SELECT query. These are used as fallback instance_ram_gb /
 * instance_cpu_count in processOneHost() when the AWS pricing catalog has no entry
 * (Azure/GCP hosts, or AWS hosts with no instance-type tag).
 * This adds zero extra MCP calls — the data comes from the same SELECT query.
 */
export async function runListHostsAgent(
  tenantId: string,
  runId: string
): Promise<void> {
  console.log(`[list_hosts:${tenantId}] Fetching all hosts from Datadog`);

  const hosts = await fetchAllHostsViaMcp(tenantId);

  console.log(`[list_hosts:${tenantId}] Fetched ${hosts.length} hosts — writing to DynamoDB`);

  await writeHostList(tenantId, runId, hosts.map(h => ({ host_id: h.host_id, host_name: h.host_name })));
  await updateHostsTotal(runId, hosts.length);

  // Seed the metadata cache with hardware specs from DDSQL.
  // runHostMetadataPrefetch (REST API) will overwrite these entries with full tag/alias data,
  // but memory_mib and cpu_logical_processors are NOT available from the REST API — only from
  // DDSQL. We write them here first so the merge in runHostMetadataPrefetch can preserve them.
  const hostsWithHardware = hosts.filter(h => h.memory_mib !== null || h.cpu_logical_processors !== null);
  if (hostsWithHardware.length > 0) {
    const seedMap: Record<string, HostMetadata> = {};
    for (const h of hostsWithHardware) {
      seedMap[h.host_name] = {
        tags: [],
        aliases: [],
        apps: [],
        instance_type: null,
        cloud_provider: null,
        memory_mib: h.memory_mib,
        cpu_logical_processors: h.cpu_logical_processors,
      };
    }
    await writeHostMetadataCache(tenantId, runId, seedMap);
    console.log(
      `[list_hosts:${tenantId}] Seeded metadata cache with hardware specs for ` +
      `${hostsWithHardware.length} hosts (memory_mib/cpu_logical_processors from DDSQL)`
    );
  }

  console.log(`[list_hosts:${tenantId}] Done — ${hosts.length} hosts stored`);
}
