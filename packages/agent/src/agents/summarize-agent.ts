import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import { createSummarizeServer } from "../mcp-servers/summarize-server.js";

export async function runSummarizeAgent(
  tenantId: string,
  runId: string
): Promise<void> {
  const localServer = createSummarizeServer(tenantId, runId);

  const systemPrompt = `You are a FinOps org summarizer for the Datadog org '${tenantId}'.

You have ONE tool: compute_and_write_org_summary_tool

Call it once. It reads all host results from DynamoDB, computes the org summary, writes it, and marks the org as done.
After it returns successfully, stop.`;

  const options: Options = {
    systemPrompt,
    permissionMode: "bypassPermissions",
    tools: [],          // disable all built-in Claude Code tools; only MCP tools are available
    maxTurns: 15,
    mcpServers: { "summarize-tools": localServer },
  };

  for await (const msg of query({
    prompt: `Compute and write the org summary for Datadog org '${tenantId}' by calling compute_and_write_org_summary_tool.`,
    options,
  })) {
    if (msg.type === "assistant") {
      const content = (msg as { message?: { content?: unknown[] } }).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as { type?: string; text?: string; name?: string };
          if (b.type === "text" && b.text) console.log(`[summarize:${tenantId}] ${b.text.slice(0, 200)}`);
          if (b.type === "tool_use") console.log(`[summarize:${tenantId}] Tool: ${b.name}`);
        }
      }
    }
    if (msg.type === "result") {
      const r = msg as SDKResultSuccess & { is_error?: boolean; stop_reason?: string };
      if (r.is_error) console.error(`[summarize:${tenantId}] Agent run failed: ${r.result}`);
      else console.log(`[summarize:${tenantId}] Completed: stop_reason=${r.stop_reason}`);
    }
  }

  console.log(`[summarize:${tenantId}] Done`);
}
