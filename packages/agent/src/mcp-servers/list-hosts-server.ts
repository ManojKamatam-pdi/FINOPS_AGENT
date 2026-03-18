import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { writeHostList, updateHostsTotal } from "../tools/dynamodb.js";

export function createListHostsServer(tenantId: string, runId: string) {
  return createSdkMcpServer({
    name: "list-hosts-tools",
    version: "1.0.0",
    tools: [
      tool(
        "write_host_list_tool",
        "Write the discovered host list to DynamoDB. hosts_json: JSON array of {host_id, host_name} objects.",
        { hosts_json: z.string().describe("JSON array of {host_id, host_name} objects") },
        async ({ hosts_json }) => {
          const hosts = JSON.parse(hosts_json) as Array<{ host_id: string; host_name: string }>;
          await writeHostList(tenantId, runId, hosts);
          return { content: [{ type: "text" as const, text: `Wrote ${hosts.length} hosts to DynamoDB for ${tenantId}` }] };
        }
      ),
      tool(
        "update_hosts_total_tool",
        "Update the total host count on the run record.",
        { count: z.number().describe("Number of hosts discovered for this org") },
        async ({ count }) => {
          await updateHostsTotal(runId, count);
          return { content: [{ type: "text" as const, text: `Updated hosts_total by ${count} for run ${runId}` }] };
        }
      ),
    ],
  });
}
