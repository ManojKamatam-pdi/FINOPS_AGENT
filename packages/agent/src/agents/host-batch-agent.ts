import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import { getMcpServers } from "../config/mcp-registry.js";
import { createHostBatchServer } from "../mcp-servers/host-batch-server.js";

export async function runHostBatchAgent(
  tenantId: string,
  hosts: Array<{ host_id: string; host_name: string }>,
  oktaToken: string,
  runId: string,
  batchIndex = 0,
  totalBatches = 1
): Promise<void> {
  const localServer = createHostBatchServer(tenantId, runId, batchIndex, totalBatches, hosts.length);

  const systemPrompt = `You are a FinOps host analyzer for the Datadog org '${tenantId}'.
You will analyze a batch of ${hosts.length} hosts for CPU, RAM, and Network utilization over 30 days.

The Datadog MCP exposes 3 tools:
- query-datadog(tenant_id, query): triggers a Datadog Workflow → AI Agent, returns {instance_id, status: "running"}
- check-status(tenant_id, instance_id): polls the workflow; when completed returns the agent's answer
- list-tenants(): lists available orgs

FOR EACH HOST, follow this process:

STEP 1 — Query Datadog for 30-day metrics:
  Call query-datadog with tenant_id="${tenantId}" and a query like:
  "For host <host_name> (host_id: <host_id>), give me the 30-day averages for:
   - CPU utilization (avg and p95 as % of total vCPUs, 0-100)
   - RAM: system.mem.usable average in bytes
   - Network: system.net.bytes_rcvd and system.net.bytes_sent averages in bytes/sec
   Also return the instance_type tag and region tag if present."
  Then poll check-status until completed. Extract the metrics from the response.

STEP 2 — Compute right-sizing (if instance_type tag found):
  - Call get_instance_specs_tool(instance_type) to get vcpu and ram_gb
  - Convert RAM: ram_avg_pct = ((ram_gb - mem_usable_bytes/1e9) / ram_gb) * 100
  - Call suggest_right_sized_instance_tool(cpu_p95_pct, ram_avg_pct, current_instance, region)
  - If not already_right_sized: call build_pricing_calculator_url_tool

STEP 3 — Write result:
  Call write_host_result_tool(host_id, result_json) with:
  {
    "host_name": "...", "cloud_provider": "aws",
    "cpu_avg_30d": <float>, "cpu_p95_30d": <float>, "ram_avg_30d": <float>,
    "network_in_avg_30d": <float>, "network_out_avg_30d": <float>,
    "instance_type": "..." or null, "instance_region": "..." or null,
    "instance_cpu_count": <int> or null, "instance_ram_gb": <float> or null,
    "has_instance_tag": true/false, "catalog_data_available": true/false,
    "current_monthly_cost": <float> or null, "suggested_instance": "..." or null,
    "suggested_monthly_cost": <float> or null, "monthly_savings": <float> or null,
    "savings_percent": <float> or null,
    "pricing_calc_url": "<url>" or null,
    "efficiency_score": <int 0-100>, "efficiency_label": "over-provisioned"|"right-sized"|"under-provisioned"|"unknown",
    "recommendation": "<explanation of finding>"
  }

  If Datadog returns no data: set efficiency_score=0, efficiency_label="unknown", write result anyway.

AFTER ALL HOSTS:
  Call update_run_progress_tool(hosts_done=${hosts.length}, log_message="batch ${batchIndex + 1}/${totalBatches} complete (${hosts.length} hosts) for ${tenantId}")

Important:
- Always poll check-status until completed/failed before moving to the next step.
- Write each host result before moving to the next host.
- Never skip a host — always write a result row even if data is unavailable.`;

  const options: Options = {
    systemPrompt,
    permissionMode: "bypassPermissions",
    maxTurns: 500,
    mcpServers: {
      "host-batch-tools": localServer,
      ...getMcpServers(["datadog"], oktaToken),
    },
  };

  const userMessage = `Analyze these ${hosts.length} hosts from Datadog org '${tenantId}':\n${JSON.stringify(hosts)}`;

  for await (const msg of query({ prompt: userMessage, options })) {
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
      else if (r.stop_reason === "max_turns") console.warn(`[host_batch:${tenantId}:batch${batchIndex}] Hit max_turns (200)`);
      else console.log(`[host_batch:${tenantId}:batch${batchIndex}] Completed: stop_reason=${r.stop_reason}`);
    }
  }

  console.log(`[host_batch:${tenantId}:batch${batchIndex}] Done`);
}
