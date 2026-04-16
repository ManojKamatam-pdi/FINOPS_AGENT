import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import { createHostBatchServer } from "../mcp-servers/host-batch-server.js";
import { isAborted } from "../tools/abort-registry.js";

export async function runHostBatchAgent(
  tenantId: string,
  hosts: Array<{ host_id: string; host_name: string; aliases?: string | string[] }>,
  runId: string,
  batchIndex = 0,
  totalBatches = 1
): Promise<void> {
  if (isAborted(runId)) {
    console.log(`[host_batch:${tenantId}:batch${batchIndex}] Run aborted — skipping batch`);
    return;
  }

  const localServer = createHostBatchServer(tenantId, runId, batchIndex, totalBatches, hosts.length);
  const hostNames = hosts.map(h => h.host_name);

  const systemPrompt = `You are a FinOps batch processor for Datadog org '${tenantId}'.
Call process_batch_tool once with the complete host_names list. That's all.`;

  const options: Options = {
    systemPrompt,
    permissionMode: "bypassPermissions",
    tools: [],
    maxTurns: 5,
    mcpServers: { "host-batch-tools": localServer },
  };

  const userMessage = `Process these ${hosts.length} hosts: ${JSON.stringify(hostNames)}`;

  for await (const msg of query({ prompt: userMessage, options })) {
    if (isAborted(runId)) {
      console.log(`[host_batch:${tenantId}:batch${batchIndex}] Abort signaled — stopping mid-batch`);
      break;
    }
    if (msg.type === "assistant") {
      const content = (msg as { message?: { content?: unknown[] } }).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as { type?: string; text?: string; name?: string };
          if (b.type === "text" && b.text) console.log(`[host_batch:${tenantId}:batch${batchIndex}] ${b.text.slice(0, 200)}`);
          if (b.type === "tool_use") console.log(`[host_batch:${tenantId}:batch${batchIndex}] Tool: ${b.name}`);
        }
      }
    }
    if (msg.type === "result") {
      const r = msg as SDKResultSuccess & { is_error?: boolean; stop_reason?: string };
      if (r.is_error) console.error(`[host_batch:${tenantId}:batch${batchIndex}] Agent run failed: ${r.result}`);
      else if (r.stop_reason === "max_turns") console.warn(`[host_batch:${tenantId}:batch${batchIndex}] Hit max_turns`);
      else console.log(`[host_batch:${tenantId}:batch${batchIndex}] Completed: stop_reason=${r.stop_reason}`);
    }
  }

  console.log(`[host_batch:${tenantId}:batch${batchIndex}] Done`);
}
