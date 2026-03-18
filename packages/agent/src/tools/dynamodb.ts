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
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

// Load env vars — safe to call multiple times (dotenv is idempotent)
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

// ─── Host Lists ───────────────────────────────────────────────────────────────

export async function writeHostList(
  tenantId: string,
  runId: string,
  hosts: Array<{ host_id: string; host_name: string }>
): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + 7 * 86400;
  await getClient().send(new PutCommand({
    TableName: "finops_host_lists",
    Item: { tenant_id: tenantId, run_id: runId, hosts, ttl },
  }));
}

export async function readHostList(
  tenantId: string,
  runId: string
): Promise<Array<{ host_id: string; host_name: string }>> {
  const resp = await getClient().send(new GetCommand({
    TableName: "finops_host_lists",
    Key: { tenant_id: tenantId, run_id: runId },
  }));
  return (resp.Item?.hosts as Array<{ host_id: string; host_name: string }>) ?? [];
}

// ─── Run Progress ─────────────────────────────────────────────────────────────

export async function updateHostsTotal(runId: string, count: number): Promise<void> {
  await getClient().send(new UpdateCommand({
    TableName: "finops_runs",
    Key: { run_id: runId, sk: "METADATA" },
    UpdateExpression: "SET hosts_total = hosts_total + :n",
    ExpressionAttributeValues: { ":n": count },
  }));
}

export async function updateRunProgress(
  runId: string,
  _tenantId: string,
  hostsDoneIncrement: number,
  logMessage: string
): Promise<void> {
  // Append log entry and increment hosts_done
  await getClient().send(new UpdateCommand({
    TableName: "finops_runs",
    Key: { run_id: runId, sk: "METADATA" },
    UpdateExpression:
      "SET hosts_done = hosts_done + :inc, #log = list_append(if_not_exists(#log, :empty), :msg)",
    ExpressionAttributeNames: { "#log": "log" },
    ExpressionAttributeValues: {
      ":inc": hostsDoneIncrement,
      ":msg": [logMessage],
      ":empty": [],
    },
  }));
  // Trim log to last 20
  const resp = await getClient().send(new GetCommand({
    TableName: "finops_runs",
    Key: { run_id: runId, sk: "METADATA" },
    ProjectionExpression: "#log",
    ExpressionAttributeNames: { "#log": "log" },
  }));
  const log: string[] = (resp.Item?.log as string[]) ?? [];
  if (log.length > 20) {
    await getClient().send(new UpdateCommand({
      TableName: "finops_runs",
      Key: { run_id: runId, sk: "METADATA" },
      UpdateExpression: "SET #log = :trimmed",
      ExpressionAttributeNames: { "#log": "log" },
      ExpressionAttributeValues: { ":trimmed": log.slice(-20) },
    }));
  }
}

export async function updateTenantsDone(runId: string): Promise<void> {
  await getClient().send(new UpdateCommand({
    TableName: "finops_runs",
    Key: { run_id: runId, sk: "METADATA" },
    UpdateExpression: "SET tenants_done = tenants_done + :one",
    ExpressionAttributeValues: { ":one": 1 },
  }));
}

// ─── Host Results ─────────────────────────────────────────────────────────────

export async function writeHostResult(
  tenantId: string,
  runId: string,
  hostId: string,
  result: Record<string, unknown>
): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + 90 * 86400;
  await getClient().send(new PutCommand({
    TableName: "finops_host_results",
    Item: {
      tenant_id: tenantId,
      sk: `${hostId}#${runId}`,
      run_id: runId,
      host_id: hostId,
      ttl,
      ...result,
    },
  }));
}

export async function readOrgHostResults(
  tenantId: string,
  runId: string
): Promise<Record<string, unknown>[]> {
  const resp = await getClient().send(new QueryCommand({
    TableName: "finops_host_results",
    IndexName: "run_id-index",
    KeyConditionExpression: "run_id = :r",
    ExpressionAttributeValues: { ":r": runId },
  }));
  const items = (resp.Items ?? []) as Record<string, unknown>[];
  return items.filter((item) => item["tenant_id"] === tenantId);
}

// ─── Org Summary ──────────────────────────────────────────────────────────────

export async function writeOrgSummary(
  tenantId: string,
  runId: string,
  summary: Record<string, unknown>
): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + 90 * 86400;
  await getClient().send(new PutCommand({
    TableName: "finops_org_summary",
    Item: { tenant_id: tenantId, run_id: runId, ttl, ...summary },
  }));
}

// ─── Run Status ───────────────────────────────────────────────────────────────

export async function updateRunStatus(
  runId: string,
  status: string,
  completedAt: string
): Promise<void> {
  await getClient().send(new UpdateCommand({
    TableName: "finops_runs",
    Key: { run_id: runId, sk: "METADATA" },
    UpdateExpression: "SET #s = :s, completed_at = :c",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":s": status, ":c": completedAt },
  }));
}

// ─── Run Management (API layer) ───────────────────────────────────────────────

export async function createRun(params: {
  runId: string;
  triggerType: string;
  triggeredBy: string;
  oktaToken: string;
  tenantsTotal: number;
}): Promise<void> {
  const now = new Date().toISOString();
  await getClient().send(new PutCommand({
    TableName: "finops_runs",
    Item: {
      run_id: params.runId,
      sk: "METADATA",
      trigger_type: params.triggerType,
      triggered_by: params.triggeredBy,
      okta_token: params.oktaToken,
      status: "running",
      started_at: now,
      completed_at: null,
      tenants_total: params.tenantsTotal,
      tenants_done: 0,
      hosts_total: 0,
      hosts_done: 0,
      log: [],
    },
  }));
}

export async function getRun(runId: string): Promise<Record<string, unknown> | null> {
  const resp = await getClient().send(new GetCommand({
    TableName: "finops_runs",
    Key: { run_id: runId, sk: "METADATA" },
  }));
  return (resp.Item as Record<string, unknown>) ?? null;
}

export async function getLatestRun(): Promise<Record<string, unknown> | null> {
  const resp = await getClient().send(new ScanCommand({
    TableName: "finops_runs",
    FilterExpression: "sk = :sk",
    ExpressionAttributeValues: { ":sk": "METADATA" },
  }));
  const items = (resp.Items ?? []) as Record<string, unknown>[];
  if (!items.length) return null;
  return items.sort((a, b) =>
    String(b["started_at"] ?? "").localeCompare(String(a["started_at"] ?? ""))
  )[0];
}

export async function getLatestCompletedRun(): Promise<Record<string, unknown> | null> {
  const resp = await getClient().send(new QueryCommand({
    TableName: "finops_runs",
    IndexName: "status-started_at-index",
    KeyConditionExpression: "#s = :s",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":s": "completed" },
    ScanIndexForward: false,
    Limit: 1,
  }));
  const items = (resp.Items ?? []) as Record<string, unknown>[];
  return items[0] ?? null;
}

export async function getOrgSummariesForRun(runId: string): Promise<Record<string, unknown>[]> {
  const resp = await getClient().send(new QueryCommand({
    TableName: "finops_org_summary",
    IndexName: "run_id-index",
    KeyConditionExpression: "run_id = :r",
    ExpressionAttributeValues: { ":r": runId },
  }));
  return (resp.Items ?? []) as Record<string, unknown>[];
}

export async function getHostResultsForRun(runId: string): Promise<Record<string, unknown>[]> {
  const resp = await getClient().send(new QueryCommand({
    TableName: "finops_host_results",
    IndexName: "run_id-index",
    KeyConditionExpression: "run_id = :r",
    ExpressionAttributeValues: { ":r": runId },
  }));
  const items = (resp.Items ?? []) as Record<string, unknown>[];
  // Split composite SK "host_id#run_id" → expose host_id field
  return items.map((item) => {
    const sk = String(item["sk"] ?? "");
    if (sk.includes("#")) {
      return { ...item, host_id: sk.split("#")[0] };
    }
    return item;
  });
}
