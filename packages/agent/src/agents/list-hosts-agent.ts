import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import { getMcpServers } from "../config/mcp-registry.js";
import { createListHostsServer } from "../mcp-servers/list-hosts-server.js";

export async function runListHostsAgent(
  tenantId: string,
  oktaToken: string,
  runId: string
): Promise<void> {
  const localServer = createListHostsServer(tenantId, runId);

  const systemPrompt = `You are a host discovery agent for the Datadog org '${tenantId}'.

The Datadog MCP exposes 3 tools:
- query-datadog(tenant_id, query): triggers a Datadog Workflow → AI Agent, returns {instance_id, status: "running"}
- check-status(tenant_id, instance_id): polls the workflow; returns status "running"|"completed"|"failed", and when completed returns the agent's answer
- list-tenants(): lists available orgs

Your task:
1. Call query-datadog with tenant_id="${tenantId}" and query:
   "List ALL monitored hosts in this org. For each host return: host_id, host_name, and any tags including instance_type and region. Return as a JSON array."
2. You will receive an instance_id immediately. The workflow is now running.
3. Call check-status(tenant_id="${tenantId}", instance_id=<the id you got>) repeatedly until status is "completed" or "failed".
4. When completed, parse the agent's response to extract the host list as a JSON array of {host_id, host_name} objects.
5. Call write_host_list_tool with the JSON array.
6. Call update_hosts_total_tool with the total count.
7. Confirm completion.

Important:
- Keep polling check-status until you get a completed/failed status — do not stop after the first "running" response.
- If the response is a string (not JSON), extract host information from the text as best you can.
- If status is "failed", write an empty host list and log the failure.`;

  const options: Options = {
    systemPrompt,
    permissionMode: "bypassPermissions",
    maxTurns: 30,
    mcpServers: {
      "list-hosts-tools": localServer,
      ...getMcpServers(["datadog"], oktaToken),
    },
  };

  for await (const msg of query({ prompt: `List all hosts in Datadog org '${tenantId}' and write them to DynamoDB.`, options })) {
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
      else if (r.stop_reason === "max_turns") console.warn(`[list_hosts:${tenantId}] Hit max_turns limit`);
      else console.log(`[list_hosts:${tenantId}] Completed: stop_reason=${r.stop_reason}`);
    }
  }

  console.log(`[list_hosts:${tenantId}] Done`);
}
