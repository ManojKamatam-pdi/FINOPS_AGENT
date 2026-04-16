import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
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

// ─── SLO Run Management ────────────────────────────────────────────────────────

export async function createSloRun(params: {
  runId: string;
  triggerType: string;
  triggeredBy: string;
  tenantsTotal: number;
}): Promise<void> {
  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + 90 * 86400;
  await getClient().send(new PutCommand({
    TableName: "finops_slo_runs",
    Item: {
      run_id: params.runId,
      sk: "METADATA",
      trigger_type: params.triggerType,
      triggered_by: params.triggeredBy,
      status: "running",
      started_at: now,
      completed_at: null,
      tenants_total: params.tenantsTotal,
      tenants_done: 0,
      slos_total: 0,
      slos_done: 0,
      log: [],
      slo_lists: {},
      ttl,
    },
  }));
}

export async function getSloRun(runId: string): Promise<Record<string, unknown> | null> {
  const resp = await getClient().send(new GetCommand({
    TableName: "finops_slo_runs",
    Key: { run_id: runId, sk: "METADATA" },
  }));
  return (resp.Item as Record<string, unknown>) ?? null;
}

export async function getActiveSloRun(): Promise<Record<string, unknown> | null> {
  // Use the status-started_at-index GSI (same as getLatestCompletedSloRun) — avoids full table scan
  const resp = await getClient().send(new QueryCommand({
    TableName: "finops_slo_runs",
    IndexName: "status-started_at-index",
    KeyConditionExpression: "#s = :running",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":running": "running" },
    ScanIndexForward: false,
    Limit: 5,
  }));
  const items = (resp.Items ?? []) as Record<string, unknown>[];
  return items[0] ?? null;
}

export async function getLatestCompletedSloRun(): Promise<Record<string, unknown> | null> {
  const resp = await getClient().send(new QueryCommand({
    TableName: "finops_slo_runs",
    IndexName: "status-started_at-index",
    KeyConditionExpression: "#s = :s",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":s": "completed" },
    ScanIndexForward: false,
    Limit: 10,
  }));
  const items = (resp.Items ?? []) as Record<string, unknown>[];
  return items.find(r => Number(r["slos_done"] ?? 0) > 0) ?? items[0] ?? null;
}

export async function updateSloRunStatus(
  runId: string,
  status: string,
  completedAt: string
): Promise<void> {
  await getClient().send(new UpdateCommand({
    TableName: "finops_slo_runs",
    Key: { run_id: runId, sk: "METADATA" },
    UpdateExpression: "SET #s = :s, completed_at = :c",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":s": status, ":c": completedAt },
  }));
}

// ─── SLO List Storage (scratch data on run record) ────────────────────────────

export async function storeSloList(
  runId: string,
  tenantId: string,
  slos: unknown[],
  monitoringContext: {
    apm_enabled: boolean;
    synthetics_enabled: boolean;
    infra_monitoring: boolean;
  }
): Promise<void> {
  await getClient().send(new UpdateCommand({
    TableName: "finops_slo_runs",
    Key: { run_id: runId, sk: "METADATA" },
    UpdateExpression:
      "SET slo_lists.#tid = :data, slos_total = slos_total + :count",
    ExpressionAttributeNames: { "#tid": tenantId },
    ExpressionAttributeValues: {
      ":data": { slos, monitoring_context: monitoringContext },
      ":count": slos.length,
    },
  }));
}

export async function readSloList(
  runId: string,
  tenantId: string
): Promise<{ slos: unknown[]; monitoring_context: { apm_enabled: boolean; synthetics_enabled: boolean; infra_monitoring: boolean } } | null> {
  const resp = await getClient().send(new GetCommand({
    TableName: "finops_slo_runs",
    Key: { run_id: runId, sk: "METADATA" },
    ProjectionExpression: "slo_lists",
  }));
  const sloLists = resp.Item?.slo_lists as Record<string, unknown> | undefined;
  if (!sloLists) return null;
  return (sloLists[tenantId] as { slos: unknown[]; monitoring_context: { apm_enabled: boolean; synthetics_enabled: boolean; infra_monitoring: boolean } }) ?? null;
}

// ─── SLO Progress ─────────────────────────────────────────────────────────────

export async function updateSloProgress(
  runId: string,
  slosDoneIncrement: number,
  logMessage: string
): Promise<void> {
  await getClient().send(new UpdateCommand({
    TableName: "finops_slo_runs",
    Key: { run_id: runId, sk: "METADATA" },
    UpdateExpression:
      "SET slos_done = slos_done + :inc, #log = list_append(if_not_exists(#log, :empty), :msg)",
    ExpressionAttributeNames: { "#log": "log" },
    ExpressionAttributeValues: {
      ":inc": slosDoneIncrement,
      ":msg": [logMessage],
      ":empty": [],
    },
  }));
}

export async function updateSloTenantsDone(runId: string): Promise<void> {
  await getClient().send(new UpdateCommand({
    TableName: "finops_slo_runs",
    Key: { run_id: runId, sk: "METADATA" },
    UpdateExpression: "SET tenants_done = tenants_done + :one",
    ExpressionAttributeValues: { ":one": 1 },
  }));
}

// ─── SLO Results ──────────────────────────────────────────────────────────────

export async function writeSloResult(
  tenantId: string,
  runId: string,
  sloId: string,
  result: Record<string, unknown>
): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + 90 * 86400;
  await getClient().send(new PutCommand({
    TableName: "finops_slo_results",
    Item: {
      tenant_id: tenantId,
      sk: `${sloId}#${runId}`,
      run_id: runId,
      slo_id: sloId,
      ttl,
      ...result,
    },
  }));
}

export async function writeSloOrgSummary(
  tenantId: string,
  runId: string,
  summary: Record<string, unknown>
): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + 90 * 86400;
  await getClient().send(new PutCommand({
    TableName: "finops_slo_results",
    Item: {
      tenant_id: tenantId,
      sk: `SUMMARY#${runId}`,
      run_id: runId,
      ttl,
      ...summary,
    },
  }));
}

export async function readSloResultsForOrg(
  tenantId: string,
  runId: string
): Promise<Record<string, unknown>[]> {
  const allItems: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const resp = await getClient().send(new QueryCommand({
      TableName: "finops_slo_results",
      IndexName: "run_id-index",
      KeyConditionExpression: "run_id = :r",
      ExpressionAttributeValues: { ":r": runId },
      ExclusiveStartKey: lastKey,
    }));
    allItems.push(...((resp.Items ?? []) as Record<string, unknown>[]));
    lastKey = resp.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);
  // Return only per-SLO results (not summaries) for this tenant
  return allItems.filter(
    (item) => item["tenant_id"] === tenantId && !String(item["sk"] ?? "").startsWith("SUMMARY#")
  );
}

// ─── SLO History Cache ────────────────────────────────────────────────────────
// History is stored as a per-tenant attribute `slo_history_<tenantId>` on the
// METADATA item. Using per-tenant attributes (not a shared map) means concurrent
// tenant runs never overwrite each other's data, and reads project only the
// relevant tenant's attribute instead of the entire history map.

export async function storeSloHistory(
  runId: string,
  tenantId: string,
  historyMap: Record<string, { month: string; sli_value: number }[]>
): Promise<void> {
  if (Object.keys(historyMap).length === 0) return;
  // Attribute name: slo_history_<tenantId> — safe because tenant IDs are alphanumeric with hyphens.
  // DynamoDB expression attribute names handle the hyphen.
  const attrName = `slo_history_${tenantId.replace(/-/g, "_")}`;
  await getClient().send(new UpdateCommand({
    TableName: "finops_slo_runs",
    Key: { run_id: runId, sk: "METADATA" },
    UpdateExpression: "SET #h = :h",
    ExpressionAttributeNames: { "#h": attrName },
    ExpressionAttributeValues: { ":h": historyMap },
  }));
}

export async function readSloHistory(
  runId: string,
  tenantId: string,
  sloId: string
): Promise<{ month: string; sli_value: number }[] | null> {
  const attrName = `slo_history_${tenantId.replace(/-/g, "_")}`;
  const resp = await getClient().send(new GetCommand({
    TableName: "finops_slo_runs",
    Key: { run_id: runId, sk: "METADATA" },
    ProjectionExpression: "#h",
    ExpressionAttributeNames: { "#h": attrName },
  }));
  const h = resp.Item?.[attrName] as Record<string, { month: string; sli_value: number }[]> | undefined;
  return h?.[`${tenantId}#${sloId}`] ?? null;
}

export async function readAllSloResultsForRun(runId: string): Promise<{
  slo_results: Record<string, unknown>[];
  org_summaries: Record<string, unknown>[];
}> {
  const allItems: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const resp = await getClient().send(new QueryCommand({
      TableName: "finops_slo_results",
      IndexName: "run_id-index",
      KeyConditionExpression: "run_id = :r",
      ExpressionAttributeValues: { ":r": runId },
      ExclusiveStartKey: lastKey,
    }));
    allItems.push(...((resp.Items ?? []) as Record<string, unknown>[]));
    lastKey = resp.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  const slo_results = allItems.filter(
    (item) => !String(item["sk"] ?? "").startsWith("SUMMARY#")
  );
  const org_summaries = allItems.filter(
    (item) => String(item["sk"] ?? "").startsWith("SUMMARY#")
  );
  return { slo_results, org_summaries };
}
