/**
 * Central MCP registry — reads from MCP_REGISTRY env var (JSON array).
 * Each entry: { name, url, transport, auth }
 * auth modes: "okta_forward" | "none" | "env:MY_VAR"
 */

interface RegistryEntry {
  name: string;
  url: string;
  transport?: string;
  auth?: string;
}

interface McpServerConfig {
  type: string;
  url: string;
  headers?: Record<string, string>;
}

function loadRegistry(): RegistryEntry[] {
  const raw = process.env.MCP_REGISTRY ?? "";
  if (!raw) {
    const legacyUrl = process.env.DATADOG_MCP_URL ?? "";
    if (legacyUrl) return [{ name: "datadog", url: legacyUrl, transport: "http", auth: "okta_forward" }];
    return [];
  }
  try {
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) throw new Error("MCP_REGISTRY must be a JSON array");
    return entries as RegistryEntry[];
  } catch (e) {
    console.error("[mcp_registry] Failed to parse MCP_REGISTRY:", e);
    const legacyUrl = process.env.DATADOG_MCP_URL ?? "";
    return legacyUrl ? [{ name: "datadog", url: legacyUrl, transport: "http", auth: "okta_forward" }] : [];
  }
}

export function getMcpServers(
  names: string[],
  oktaToken = ""
): Record<string, McpServerConfig> {
  const registry = loadRegistry();
  const byName = Object.fromEntries(registry.map((e) => [e.name, e]));
  const result: Record<string, McpServerConfig> = {};

  for (const name of names) {
    const entry = byName[name];
    if (!entry) {
      console.warn(`[mcp_registry] MCP '${name}' not found in registry — skipping`);
      continue;
    }
    const server: McpServerConfig = { type: entry.transport ?? "http", url: entry.url };
    const auth = entry.auth ?? "none";

    if (auth === "okta_forward") {
      if (oktaToken) server.headers = { Authorization: `Bearer ${oktaToken}` };
    } else if (auth.startsWith("env:")) {
      const varName = auth.slice(4);
      const apiKey = process.env[varName] ?? "";
      if (apiKey) server.headers = { Authorization: `Bearer ${apiKey}` };
      else console.warn(`[mcp_registry] MCP '${name}' auth env var '${varName}' not set`);
    }

    result[name] = server;
  }
  return result;
}
