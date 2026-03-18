import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { readOrgHostResults, writeOrgSummary, updateTenantsDone } from "../tools/dynamodb.js";

export function createSummarizeServer(tenantId: string, runId: string) {
  return createSdkMcpServer({
    name: "summarize-tools",
    version: "1.0.0",
    tools: [
      tool(
        "read_org_host_results_tool",
        "Read all host analysis results for this org from DynamoDB.",
        {},
        async (_input) => {
          const results = await readOrgHostResults(tenantId, runId);
          return { content: [{ type: "text" as const, text: JSON.stringify(results) }] };
        }
      ),
      tool(
        "write_org_summary_tool",
        "Write the org summary to DynamoDB.",
        { summary_json: z.string() },
        async ({ summary_json }) => {
          const summary = JSON.parse(summary_json) as Record<string, unknown>;
          await writeOrgSummary(tenantId, runId, summary);
          return { content: [{ type: "text" as const, text: `Wrote org summary for ${tenantId}` }] };
        }
      ),
      tool(
        "update_tenants_done_tool",
        "Increment tenants_done on the run record after this org completes.",
        {},
        async (_input) => {
          await updateTenantsDone(runId);
          return { content: [{ type: "text" as const, text: `Incremented tenants_done for run ${runId}` }] };
        }
      ),
    ],
  });
}
