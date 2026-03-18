import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import { createSummarizeServer } from "../mcp-servers/summarize-server.js";

export async function runSummarizeAgent(
  tenantId: string,
  _oktaToken: string,
  runId: string
): Promise<void> {
  const localServer = createSummarizeServer(tenantId, runId);

  const systemPrompt = `You are a FinOps org summarizer for the Datadog org '${tenantId}'.

Your task:
1. Call read_org_host_results_tool to get all host analysis results for this org.
2. Compute the org summary:
   - total_hosts: total number of host results
   - hosts_analyzed: hosts with metric data (efficiency_label != "unknown")
   - hosts_over_provisioned: count where efficiency_label == "over-provisioned"
   - hosts_right_sized: count where efficiency_label == "right-sized"
   - hosts_under_provisioned: count where efficiency_label == "under-provisioned"
   - hosts_no_tag: count where has_instance_tag == false
   - total_monthly_spend: sum of current_monthly_cost (skip nulls)
   - potential_savings: sum of monthly_savings (skip nulls)
   - savings_percent: (potential_savings / total_monthly_spend * 100) if total_monthly_spend > 0 else 0
   - avg_cpu_utilization: mean of cpu_avg_30d (skip nulls)
   - avg_ram_utilization: mean of ram_avg_30d (skip nulls)
   - top_offenders: list of top 5 host_id values sorted by monthly_savings descending (skip nulls)
   - completed_at: current UTC timestamp in ISO format
3. Call write_org_summary_tool with the computed summary as JSON.
4. Call update_tenants_done_tool to mark this org as complete.
5. Confirm completion.

Be precise with the arithmetic. Round monetary values to 2 decimal places, percentages to 1 decimal place.`;

  const options: Options = {
    systemPrompt,
    permissionMode: "bypassPermissions",
    maxTurns: 15,
    mcpServers: { "summarize-tools": localServer },
  };

  for await (const msg of query({
    prompt: `Summarize all host analysis results for Datadog org '${tenantId}' and write the org summary.`,
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
