/**
 * Builds per-org Datadog MCP servers (HTTP) from dd-org-registry.json.
 * Uses the official Datadog MCP Server at mcp.datadoghq.com with API key
 * authentication via headers — no OAuth, no stdio binary needed.
 * The agent discovers tools at runtime — no hardcoded tool names needed.
 */
import { getTenants } from "./tenants.js";

interface HttpMcpServer {
  type: "http";
  url: string;
  headers: Record<string, string>;
}

const DD_MCP_BASE: Record<string, string> = {
  "datadoghq.com": "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp",
  "datadoghq.eu": "https://mcp.datadoghq.eu/api/unstable/mcp-server/mcp",
  "us3.datadoghq.com": "https://mcp.us3.datadoghq.com/api/unstable/mcp-server/mcp",
  "us5.datadoghq.com": "https://mcp.us5.datadoghq.com/api/unstable/mcp-server/mcp",
  "ap1.datadoghq.com": "https://mcp.ap1.datadoghq.com/api/unstable/mcp-server/mcp",
};

/**
 * Returns one HTTP Datadog MCP server per enabled org.
 * Server name = tenant_id (e.g. "PDI-Enterprise")
 * Tools visible to agent: mcp__PDI-Enterprise__<tool_name>
 *
 * Uses the "core" toolset which includes: hosts, metrics, logs, monitors,
 * dashboards, incidents, services, events, notebooks, traces, spans, RUM.
 */
export function getDatadogMcpServers(): Record<string, HttpMcpServer> {
  const tenants = getTenants();
  const servers: Record<string, HttpMcpServer> = {};

  for (const tenant of tenants) {
    if (!tenant.dd_api_key || tenant.dd_api_key === "REPLACE_ME") {
      console.warn(`[mcp_registry] Skipping '${tenant.tenant_id}' — dd_api_key not configured`);
      continue;
    }

    const site = tenant.dd_site ?? "datadoghq.com";
    const baseUrl = DD_MCP_BASE[site] ?? DD_MCP_BASE["datadoghq.com"];

    servers[tenant.tenant_id] = {
      type: "http",
      url: `${baseUrl}?toolsets=core`,
      headers: {
        DD_API_KEY: tenant.dd_api_key,
        DD_APPLICATION_KEY: tenant.dd_app_key,
      },
    };
  }

  return servers;
}
