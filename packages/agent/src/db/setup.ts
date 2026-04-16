/**
 * DynamoDB table setup — called once on server startup.
 * Safe to re-run: skips tables that already exist.
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";
import {
  DynamoDBClient,
  CreateTableCommand,
  ListTablesCommand,
  ResourceInUseException,
} from "@aws-sdk/client-dynamodb";

// Load env vars — safe to call multiple times (dotenv is idempotent)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, "../.env.local") });

function getRawClient(): DynamoDBClient {
  const endpoint = process.env.DYNAMODB_ENDPOINT ?? "";
  return endpoint
    ? new DynamoDBClient({
        endpoint,
        region: "us-east-1",
        credentials: { accessKeyId: "local", secretAccessKey: "local" },
      })
    : new DynamoDBClient({ region: process.env.AWS_REGION ?? "us-east-1" });
}

const TABLE_DEFINITIONS = [
  {
    TableName: "finops_runs",
    KeySchema: [
      { AttributeName: "run_id", KeyType: "HASH" as const },
      { AttributeName: "sk", KeyType: "RANGE" as const },
    ],
    AttributeDefinitions: [
      { AttributeName: "run_id", AttributeType: "S" as const },
      { AttributeName: "sk", AttributeType: "S" as const },
      { AttributeName: "status", AttributeType: "S" as const },
      { AttributeName: "started_at", AttributeType: "S" as const },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "status-started_at-index",
        KeySchema: [
          { AttributeName: "status", KeyType: "HASH" as const },
          { AttributeName: "started_at", KeyType: "RANGE" as const },
        ],
        Projection: { ProjectionType: "ALL" as const },
      },
    ],
    BillingMode: "PAY_PER_REQUEST" as const,
  },
  {
    TableName: "finops_host_lists",
    KeySchema: [
      { AttributeName: "tenant_id", KeyType: "HASH" as const },
      { AttributeName: "run_id", KeyType: "RANGE" as const },
    ],
    AttributeDefinitions: [
      { AttributeName: "tenant_id", AttributeType: "S" as const },
      { AttributeName: "run_id", AttributeType: "S" as const },
    ],
    BillingMode: "PAY_PER_REQUEST" as const,
  },
  {
    TableName: "finops_org_summary",
    KeySchema: [
      { AttributeName: "tenant_id", KeyType: "HASH" as const },
      { AttributeName: "run_id", KeyType: "RANGE" as const },
    ],
    AttributeDefinitions: [
      { AttributeName: "tenant_id", AttributeType: "S" as const },
      { AttributeName: "run_id", AttributeType: "S" as const },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "run_id-index",
        KeySchema: [{ AttributeName: "run_id", KeyType: "HASH" as const }],
        Projection: { ProjectionType: "ALL" as const },
      },
    ],
    BillingMode: "PAY_PER_REQUEST" as const,
  },
  {
    TableName: "finops_host_results",
    KeySchema: [
      { AttributeName: "tenant_id", KeyType: "HASH" as const },
      { AttributeName: "sk", KeyType: "RANGE" as const },
    ],
    AttributeDefinitions: [
      { AttributeName: "tenant_id", AttributeType: "S" as const },
      { AttributeName: "sk", AttributeType: "S" as const },
      { AttributeName: "run_id", AttributeType: "S" as const },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "run_id-index",
        KeySchema: [{ AttributeName: "run_id", KeyType: "HASH" as const }],
        Projection: { ProjectionType: "ALL" as const },
      },
    ],
    BillingMode: "PAY_PER_REQUEST" as const,
  },
  // ─── Metric Pre-fetch Cache ────────────────────────────────────────────────
  {
    TableName: "finops_metric_cache",
    KeySchema: [
      { AttributeName: "tenant_id", KeyType: "HASH" as const },
      { AttributeName: "sk", KeyType: "RANGE" as const },
    ],
    AttributeDefinitions: [
      { AttributeName: "tenant_id", AttributeType: "S" as const },
      { AttributeName: "sk", AttributeType: "S" as const },
    ],
    BillingMode: "PAY_PER_REQUEST" as const,
  },
  // ─── Host Metadata Pre-fetch Cache ────────────────────────────────────────
  // Stores aliases, tags, apps, instance_type, cloud_provider per host.
  // Populated by runHostMetadataPrefetch (GET /api/v1/hosts REST API).
  // Batch agents read via get_prefetched_host_metadata_tool — no MCP needed for Step A.
  {
    TableName: "finops_host_metadata_cache",
    KeySchema: [
      { AttributeName: "tenant_id", KeyType: "HASH" as const },
      { AttributeName: "sk", KeyType: "RANGE" as const },
    ],
    AttributeDefinitions: [
      { AttributeName: "tenant_id", AttributeType: "S" as const },
      { AttributeName: "sk", AttributeType: "S" as const },
    ],
    BillingMode: "PAY_PER_REQUEST" as const,
  },
  // ─── SLO Audit Tables ──────────────────────────────────────────────────────
  {
    TableName: "finops_slo_runs",
    KeySchema: [
      { AttributeName: "run_id", KeyType: "HASH" as const },
      { AttributeName: "sk", KeyType: "RANGE" as const },
    ],
    AttributeDefinitions: [
      { AttributeName: "run_id", AttributeType: "S" as const },
      { AttributeName: "sk", AttributeType: "S" as const },
      { AttributeName: "status", AttributeType: "S" as const },
      { AttributeName: "started_at", AttributeType: "S" as const },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "status-started_at-index",
        KeySchema: [
          { AttributeName: "status", KeyType: "HASH" as const },
          { AttributeName: "started_at", KeyType: "RANGE" as const },
        ],
        Projection: { ProjectionType: "ALL" as const },
      },
    ],
    BillingMode: "PAY_PER_REQUEST" as const,
  },
  {
    TableName: "finops_slo_results",
    KeySchema: [
      { AttributeName: "tenant_id", KeyType: "HASH" as const },
      { AttributeName: "sk", KeyType: "RANGE" as const },
    ],
    AttributeDefinitions: [
      { AttributeName: "tenant_id", AttributeType: "S" as const },
      { AttributeName: "sk", AttributeType: "S" as const },
      { AttributeName: "run_id", AttributeType: "S" as const },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "run_id-index",
        KeySchema: [{ AttributeName: "run_id", KeyType: "HASH" as const }],
        Projection: { ProjectionType: "ALL" as const },
      },
    ],
    BillingMode: "PAY_PER_REQUEST" as const,
  },
];

export async function createTables(): Promise<void> {
  const client = getRawClient();
  const { TableNames: existing = [] } = await client.send(new ListTablesCommand({}));

  for (const def of TABLE_DEFINITIONS) {
    if (existing.includes(def.TableName)) {
      console.log(`[db] Table ${def.TableName} already exists`);
      continue;
    }
    try {
      await client.send(new CreateTableCommand(def));
      console.log(`[db] Created table ${def.TableName}`);
    } catch (err) {
      if (err instanceof ResourceInUseException) {
        console.log(`[db] Table ${def.TableName} already exists (race)`);
      } else {
        throw err;
      }
    }
  }
  console.log("[db] All tables ready");
}
