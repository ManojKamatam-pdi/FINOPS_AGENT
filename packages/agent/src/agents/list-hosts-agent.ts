import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import { createListHostsServer } from "../mcp-servers/list-hosts-server.js";

export async function runListHostsAgent(
  tenantId: string,
  runId: string
): Promise<void> {
  const localServer = createListHostsServer(tenantId, runId);

  const systemPrompt = `You are a host discovery agent for the Datadog org '${tenantId}'.

You have ONE tool: fetch_and_store_all_hosts_tool

Call it once. It fetches all hosts from Datadog (handling pagination internally), writes them to DynamoDB, and updates the run total.
After it returns successfully, stop.`;

  const options: Options = {
    systemPrompt,
    permissionMode: "bypassPermissions",
    tools: [],
    maxTurns: 10,
    mcpServers: {
      "list-hosts-tools": localServer,
      // No Datadog MCP needed — the tool calls the REST API directly
    },
  };

  for await (const msg of query({
    prompt: `Fetch and store all hosts for Datadog org '${tenantId}' by calling fetch_and_store_all_hosts_tool.`,
    options,
  })) {
    if (msg.type === "assistant") {
      const content = (msg as { message?: { content?: unknown[] } }).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as { type?: string; text?: string; name?: string };
          if (b.type === "text" && b.text) console.log(`[list_hosts:${tenantId}] ${b.text.slice(0, 200)}`);
          if (b.type === "tool_use") console.log(`[list_hosts:${tenantId}] Tool: ${b.name}`);
        }
      }
    }
    if (msg.type === "result") {
      const r = msg as SDKResultSuccess & { is_error?: boolean; stop_reason?: string };
      if (r.is_error) console.error(`[list_hosts:${tenantId}] Agent run failed: ${r.result}`);
      else console.log(`[list_hosts:${tenantId}] Completed: stop_reason=${r.stop_reason}`);
    }
  }

  console.log(`[list_hosts:${tenantId}] Done`);
}
