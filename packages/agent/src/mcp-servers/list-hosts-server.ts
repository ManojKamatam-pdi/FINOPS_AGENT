import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { writeHostList, updateHostsTotal } from "../tools/dynamodb.js";
import { getTenants } from "../config/tenants.js";

const DD_MCP_BASE: Record<string, string> = {
  "datadoghq.com":    "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp",
  "datadoghq.eu":     "https://mcp.datadoghq.eu/api/unstable/mcp-server/mcp",
  "us3.datadoghq.com":"https://mcp.us3.datadoghq.com/api/unstable/mcp-server/mcp",
  "us5.datadoghq.com":"https://mcp.us5.datadoghq.com/api/unstable/mcp-server/mcp",
  "ap1.datadoghq.com":"https://mcp.ap1.datadoghq.com/api/unstable/mcp-server/mcp",
};

// Parse the TSV_DATA block from a search_datadog_hosts response.
// Returns an array of objects keyed by the header row.
function parseTsv(text: string): Record<string, string>[] {
  const match = text.match(/<TSV_DATA>\n([\s\S]*?)\n<\/TSV_DATA>/);
  if (!match) return [];
  const lines = match[1].split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split("\t");
  return lines.slice(1).map(line => {
    const cols = line.split("\t");
    return Object.fromEntries(headers.map((h, i) => [h, cols[i] ?? ""]));
  });
}

// Extract total_rows from the METADATA block.
function parseTotalRows(text: string): number {
  const match = text.match(/<total_rows>(\d+)<\/total_rows>/);
  return match ? parseInt(match[1], 10) : 0;
}

// Extract displayed_rows from the METADATA block.
function parseDisplayedRows(text: string): number {
  const match = text.match(/<displayed_rows>(\d+)<\/displayed_rows>/);
  return match ? parseInt(match[1], 10) : 0;
}

async function callDdMcp(
  mcpUrl: string,
  apiKey: string,
  appKey: string,
  sessionId: string,
  query: string,
  startAt: number
): Promise<string> {
  const resp = await fetch(mcpUrl + "?toolsets=core", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "DD-API-KEY": apiKey,
      "DD-APPLICATION-KEY": appKey,
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: startAt + 1,
      method: "tools/call",
      params: {
        name: "search_datadog_hosts",
        arguments: {
          query,
          start_at: startAt,
          max_tokens: 100000,
          telemetry: { intent: "fetch all hosts for FinOps analysis" },
        },
      },
    }),
  });

  if (!resp.ok) throw new Error(`Datadog MCP returned ${resp.status}: ${await resp.text()}`);
  const data = await resp.json() as { result?: { content?: Array<{ text: string }>; isError?: boolean }; error?: { message: string } };
  if (data.error) throw new Error(`Datadog MCP error: ${data.error.message}`);
  const text = data.result?.content?.[0]?.text ?? "";
  if (data.result?.isError) throw new Error(`Datadog MCP tool error: ${text}`);
  return text;
}

async function initDdMcpSession(mcpUrl: string, apiKey: string, appKey: string): Promise<string> {
  const resp = await fetch(mcpUrl + "?toolsets=core", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "DD-API-KEY": apiKey,
      "DD-APPLICATION-KEY": appKey,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "finops-agent", version: "1.0" },
      },
    }),
  });

  if (!resp.ok) throw new Error(`Datadog MCP init failed: ${resp.status}`);
  const sessionId = resp.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("Datadog MCP did not return a session ID");
  return sessionId;
}

async function fetchAllHostsViaMcp(tenantId: string): Promise<Array<{ host_id: string; host_name: string }>> {
  const tenants = getTenants();
  const tenant = tenants.find((t: { tenant_id: string }) => t.tenant_id === tenantId);
  if (!tenant) throw new Error(`Tenant ${tenantId} not found in registry`);

  const site = tenant.dd_site ?? "datadoghq.com";
  const mcpUrl = DD_MCP_BASE[site] ?? DD_MCP_BASE["datadoghq.com"];

  const sessionId = await initDdMcpSession(mcpUrl, tenant.dd_api_key, tenant.dd_app_key);

  // Query: fetch hostname only — aliases column is not available in DDSQL.
  // Aliases are fetched per-host by the batch agent via search_datadog_hosts.
  const query = "SELECT hostname FROM hosts";
  const allHosts: Array<{ host_id: string; host_name: string }> = [];
  let startAt = 0;

  while (true) {
    const text = await callDdMcp(mcpUrl, tenant.dd_api_key, tenant.dd_app_key, sessionId, query, startAt);
    const rows = parseTsv(text);
    const displayedRows = parseDisplayedRows(text);
    const totalRows = parseTotalRows(text);

    for (const row of rows) {
      const name = row["hostname"] ?? "";
      if (name) {
        allHosts.push({ host_id: name, host_name: name });
      }
    }

    console.log(`[list_hosts:${tenantId}] Page at start_at=${startAt}: got ${rows.length} rows (displayed=${displayedRows}, total=${totalRows}, accumulated=${allHosts.length})`);

    // Stop when this page returned no rows
    if (rows.length === 0 || displayedRows === 0) break;

    startAt += rows.length;

    // Stop when we've accumulated all rows (total_rows is the grand total if available)
    if (totalRows > 0 && allHosts.length >= totalRows) break;
  }

  return allHosts;
}

export function createListHostsServer(tenantId: string, runId: string) {
  return createSdkMcpServer({
    name: "list-hosts-tools",
    version: "1.0.0",
    tools: [
      tool(
        "fetch_and_store_all_hosts_tool",
        "Fetch ALL hosts from Datadog via MCP (handles pagination internally), write them to DynamoDB in chunks, and update the run total. Call this once — it does everything.",
        {},
        async (_input) => {
          const hosts = await fetchAllHostsViaMcp(tenantId);
          await writeHostList(tenantId, runId, hosts);
          await updateHostsTotal(runId, hosts.length);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ success: true, tenant_id: tenantId, total_hosts: hosts.length }),
            }],
          };
        }
      ),
    ],
  });
}
