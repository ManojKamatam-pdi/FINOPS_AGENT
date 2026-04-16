import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import { createSloListServer } from "../mcp-servers/slo-list-server.js";

export async function runSloListAgent(
  tenantId: string,
  runId: string
): Promise<void> {
  const localServer = createSloListServer(tenantId, runId);

  const systemPrompt = `You are an SLO discovery agent for the Datadog org '${tenantId}'.

You have ONE tool: fetch_and_store_all_slos_tool

Call it once. It fetches all SLOs from the Datadog REST API (handling pagination internally), derives monitoring context from the SLO portfolio, writes them to DynamoDB, and updates the run total.
After it returns successfully, stop.`;

  const options: Options = {
    systemPrompt,
    permissionMode: "bypassPermissions",
    tools: [],
    maxTurns: 15,
    mcpServers: {
      "slo-list-tools": localServer,
    },
  };

  for await (const msg of query({
    prompt: `Fetch and store all SLOs for Datadog org '${tenantId}' by calling fetch_and_store_all_slos_tool.`,
    options,
  })) {
    if (msg.type === "assistant") {
      const content = (msg as { message?: { content?: unknown[] } }).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as { type?: string; text?: string; name?: string };
          if (b.type === "text" && b.text) console.log(`[slo_list:${tenantId}] ${b.text.slice(0, 200)}`);
          if (b.type === "tool_use") console.log(`[slo_list:${tenantId}] Tool: ${b.name}`);
        }
      }
    }
    if (msg.type === "result") {
      const r = msg as SDKResultSuccess & { is_error?: boolean; stop_reason?: string };
      if (r.is_error) console.error(`[slo_list:${tenantId}] Agent run failed: ${r.result}`);
      else console.log(`[slo_list:${tenantId}] Completed: stop_reason=${r.stop_reason}`);
    }
  }

  console.log(`[slo_list:${tenantId}] Done`);
}
