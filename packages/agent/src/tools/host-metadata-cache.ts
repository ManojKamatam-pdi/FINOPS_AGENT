/**
 * Host metadata cache — stores pre-fetched per-host metadata from Datadog REST API.
 *
 * Layout: one DynamoDB item per (tenant_id, run_id) holding a hostname → metadata map.
 * Each metadata entry contains: aliases, tags (flat array), apps, instance_type, cloud_provider.
 *
 * This is populated once by runHostMetadataPrefetch (GET /api/v1/hosts, paginated)
 * before batch agents run. Batch agents call get_prefetched_host_metadata_tool instead
 * of search_datadog_hosts — eliminating N_hosts MCP round-trips.
 *
 * Size estimate: 3000 hosts × ~200 bytes per entry ≈ 600 KB — split into shards of
 * 500 hosts each to stay well under the DynamoDB 400 KB per-item limit.
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, "../../.env.local") });

let _client: DynamoDBDocumentClient | null = null;

function getClient(): DynamoDBDocumentClient {
  if (_client) return _client;
  const endpoint = process.env.DYNAMODB_ENDPOINT ?? "";
  const raw = new DynamoDBClient(
    endpoint
      ? { endpoint, region: "us-east-1", credentials: { accessKeyId: "local", secretAccessKey: "local" } }
      : { region: process.env.AWS_REGION ?? "us-east-1" }
  );
  _client = DynamoDBDocumentClient.from(raw);
  return _client;
}

const TABLE = "finops_host_metadata_cache";

/** Max hosts per DynamoDB shard item — keeps each item well under 400 KB. */
const SHARD_SIZE = 500;

export interface HostMetadata {
  /** Flat array of all tags across all sources: ["instance-type:m5.large", "region:us-east-1", ...] */
  tags: string[];
  /** Hostname aliases — EC2 instance IDs (i-0abc123), internal DNS names, etc. */
  aliases: string[];
  /** Integration source names: ["ecs", "fargate", "vsphere", "kubernetes", "aws", ...] */
  apps: string[];
  /** Instance type from Datadog's own catalog column (e.g. "m5.large", "Standard_D2s_v3") */
  instance_type: string | null;
  /** Cloud provider from Datadog's catalog column ("aws", "azure", "gcp", or null) */
  cloud_provider: string | null;
  /**
   * Total RAM in MiB from Datadog's DDSQL hosts table (memory_mib column).
   * Populated from the MCP SELECT query at list-hosts time.
   * Used as a fallback instance_ram_gb when the AWS pricing catalog has no entry
   * (e.g. Azure/GCP hosts with no instance-type tag, or AWS hosts with unknown type).
   * Conversion: memory_mib / 1024 = instance_ram_gb.
   */
  memory_mib: number | null;
  /**
   * Logical CPU count from Datadog's DDSQL hosts table (cpu.logical_processors column).
   * Populated from the MCP SELECT query at list-hosts time.
   * Used as a fallback instance_cpu_count when the AWS pricing catalog has no entry.
   */
  cpu_logical_processors: number | null;
}

/**
 * In-process cache: avoids re-querying DynamoDB for every host in a batch.
 * Key: `${tenantId}#${runId}` → full hostname → metadata map.
 */
const _memCache = new Map<string, Record<string, HostMetadata>>();

/**
 * Write pre-fetched host metadata for all hosts in this org/run.
 * Shards the map into chunks of SHARD_SIZE to stay under DynamoDB's 400 KB item limit.
 */
export async function writeHostMetadataCache(
  tenantId: string,
  runId: string,
  hostMap: Record<string, HostMetadata>
): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + 7 * 86400; // 7-day TTL
  const entries = Object.entries(hostMap);

  // Shard into chunks
  for (let i = 0; i < entries.length; i += SHARD_SIZE) {
    const shardIndex = Math.floor(i / SHARD_SIZE);
    const shardEntries = entries.slice(i, i + SHARD_SIZE);
    const shardMap = Object.fromEntries(shardEntries);

    await getClient().send(new PutCommand({
      TableName: TABLE,
      Item: {
        tenant_id: tenantId,
        sk: `${runId}#shard${shardIndex}`,
        run_id: runId,
        shard_index: shardIndex,
        host_metadata: shardMap,
        host_count: shardEntries.length,
        ttl,
      },
    }));
  }
}

/**
 * Read all pre-fetched host metadata for a tenant/run.
 * Merges all shards into a single hostname → metadata map.
 */
export async function readHostMetadataCache(
  tenantId: string,
  runId: string
): Promise<Record<string, HostMetadata>> {
  const result: Record<string, HostMetadata> = {};
  let lastKey: Record<string, unknown> | undefined;

  do {
    const resp = await getClient().send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "tenant_id = :t AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":t": tenantId,
        ":prefix": `${runId}#shard`,
      },
      ExclusiveStartKey: lastKey,
    }));

    for (const item of (resp.Items ?? []) as Record<string, unknown>[]) {
      const shardMap = (item["host_metadata"] ?? {}) as Record<string, HostMetadata>;
      Object.assign(result, shardMap);
    }

    lastKey = resp.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  return result;
}

/**
 * Look up pre-fetched metadata for a single host.
 * Uses an in-process cache so the full DynamoDB query only runs once per (tenantId, runId).
 * Returns null if the host was not found in the pre-fetched data.
 */
export async function getHostMetadataFromCache(
  tenantId: string,
  runId: string,
  hostname: string
): Promise<HostMetadata | null> {
  const cacheKey = `${tenantId}#${runId}`;
  let allMetadata = _memCache.get(cacheKey);
  if (!allMetadata) {
    allMetadata = await readHostMetadataCache(tenantId, runId);
    _memCache.set(cacheKey, allMetadata);
  }
  return allMetadata[hostname] ?? null;
}
