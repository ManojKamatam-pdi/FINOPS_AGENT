/**
 * Metric cache — stores pre-fetched org-wide metric data in DynamoDB.
 *
 * Layout: one item per (tenant_id, run_id, metric_name).
 * Each item holds a hostname→value map for all hosts that reported that metric.
 *
 * This keeps each DynamoDB item well under the 400 KB limit even for large orgs
 * (3 000 hosts × ~30 bytes per entry ≈ 90 KB per metric item).
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
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

const TABLE = "finops_metric_cache";

/**
 * In-process cache: avoids re-querying DynamoDB for every host in a batch.
 * Key: `${tenantId}#${runId}` → full metric map.
 * Each batch agent process loads the full map once on first call, then serves
 * all subsequent host lookups from memory.
 */
const _memCache = new Map<string, Record<string, Record<string, number>>>();

/**
 * Write pre-fetched metric data for one metric across all hosts.
 * @param tenantId  Org identifier
 * @param runId     Run identifier
 * @param metricName  e.g. "system.cpu.idle"
 * @param hostValues  Map of hostname → numeric value (already averaged/p95'd over the window)
 */
export async function writeMetricCache(
  tenantId: string,
  runId: string,
  metricName: string,
  hostValues: Record<string, number>
): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + 7 * 86400; // 7-day TTL
  await getClient().send(new PutCommand({
    TableName: TABLE,
    Item: {
      tenant_id: tenantId,
      sk: `${runId}#${metricName}`,
      run_id: runId,
      metric_name: metricName,
      host_values: hostValues,
      host_count: Object.keys(hostValues).length,
      ttl,
    },
  }));
}

/**
 * Read all pre-fetched metrics for a tenant/run.
 * Returns a map of metricName → {hostname → value}.
 */
export async function readMetricCache(
  tenantId: string,
  runId: string
): Promise<Record<string, Record<string, number>>> {
  const result: Record<string, Record<string, number>> = {};
  let lastKey: Record<string, unknown> | undefined;

  do {
    const resp = await getClient().send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "tenant_id = :t AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":t": tenantId,
        ":prefix": `${runId}#`,
      },
      ExclusiveStartKey: lastKey,
    }));

    for (const item of (resp.Items ?? []) as Record<string, unknown>[]) {
      const metricName = String(item["metric_name"] ?? "");
      const hostValues = (item["host_values"] ?? {}) as Record<string, number>;
      if (metricName) result[metricName] = hostValues;
    }

    lastKey = resp.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  return result;
}

/**
 * Look up all pre-fetched metrics for a single host.
 * Returns a map of metricName → value (null if metric had no data for this host).
 * Uses an in-process cache so the full DynamoDB query only runs once per (tenantId, runId).
 */
export async function getHostMetricsFromCache(
  tenantId: string,
  runId: string,
  hostname: string
): Promise<Record<string, number | null>> {
  const cacheKey = `${tenantId}#${runId}`;
  let allMetrics = _memCache.get(cacheKey);
  if (!allMetrics) {
    allMetrics = await readMetricCache(tenantId, runId);
    _memCache.set(cacheKey, allMetrics);
  }
  const result: Record<string, number | null> = {};
  for (const [metricName, hostValues] of Object.entries(allMetrics)) {
    result[metricName] = hostValues[hostname] ?? null;
  }
  return result;
}
