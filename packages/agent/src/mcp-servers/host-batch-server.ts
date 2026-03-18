import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { writeHostResult, updateRunProgress } from "../tools/dynamodb.js";
import { getInstanceSpecs, suggestRightSizedInstance, getAllInstancesSortedByPrice, CANDIDATE_FAMILIES_V1 } from "../tools/aws-instances.js";
import { getPricesForInstances, getInstanceOnDemandPrice } from "../tools/aws-pricing.js";

export function createHostBatchServer(
  tenantId: string,
  runId: string,
  batchIndex: number,
  totalBatches: number,
  batchSize: number
) {
  return createSdkMcpServer({
    name: "host-batch-tools",
    version: "1.0.0",
    tools: [
      tool(
        "get_instance_specs_tool",
        "Get CPU count and RAM GB for an EC2 instance type from the local catalog.",
        { instance_type: z.string() },
        async ({ instance_type }) => {
          const specs = getInstanceSpecs(instance_type);
          const text = specs
            ? JSON.stringify(specs)
            : JSON.stringify({ error: `Instance type ${instance_type} not in catalog` });
          return { content: [{ type: "text" as const, text }] };
        }
      ),
      tool(
        "get_instance_on_demand_price_tool",
        "Get monthly on-demand price (USD) for an EC2 instance type.",
        { instance_type: z.string(), region: z.string().default("us-east-1") },
        async ({ instance_type, region }) => {
          const price = await getInstanceOnDemandPrice(instance_type, region);
          const text = price !== null
            ? JSON.stringify({ monthly_usd: price })
            : JSON.stringify({ error: `Price unavailable for ${instance_type}` });
          return { content: [{ type: "text" as const, text }] };
        }
      ),
      tool(
        "suggest_right_sized_instance_tool",
        "Suggest the best-fit right-sized EC2 instance. cpu_p95_pct: 95th percentile CPU % (0-100). ram_avg_pct: average RAM used as % of current instance total RAM.",
        {
          cpu_p95_pct: z.number(),
          ram_avg_pct: z.number(),
          current_instance: z.string(),
          region: z.string().default("us-east-1"),
        },
        async ({ cpu_p95_pct, ram_avg_pct, current_instance, region }) => {
          const catalogInstances = getAllInstancesSortedByPrice(CANDIDATE_FAMILIES_V1, {});
          const prices = await getPricesForInstances(catalogInstances, region);
          const result = suggestRightSizedInstance(cpu_p95_pct, ram_avg_pct, current_instance, prices);
          const currentPrice = prices[current_instance] ?? null;
          const suggestedPrice = prices[result.suggested] ?? null;
          let monthlySavings = 0;
          let savingsPct = 0;
          if (currentPrice && suggestedPrice && !result.already_right_sized) {
            monthlySavings = Math.round((currentPrice - suggestedPrice) * 100) / 100;
            savingsPct = Math.round((monthlySavings / currentPrice) * 1000) / 10;
          }
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                suggested: result.suggested,
                already_right_sized: result.already_right_sized,
                suggested_monthly_usd: suggestedPrice,
                current_monthly_usd: currentPrice,
                monthly_savings: monthlySavings,
                savings_percent: savingsPct,
              }),
            }],
          };
        }
      ),
      tool(
        "build_pricing_calculator_url_tool",
        "Build an AWS Pricing Calculator URL for comparing current vs. suggested instance.",
        { current_instance: z.string(), suggested_instance: z.string(), region: z.string().default("us-east-1") },
        async (_input) => ({
          content: [{ type: "text" as const, text: "https://calculator.aws/#/addService/EC2" }],
        })
      ),
      tool(
        "write_host_result_tool",
        "Write a per-host analysis result to DynamoDB.",
        { host_id: z.string(), result_json: z.string() },
        async ({ host_id, result_json }) => {
          const result = JSON.parse(result_json) as Record<string, unknown>;
          result.analyzed_at = new Date().toISOString();
          await writeHostResult(tenantId, runId, host_id, result);
          return { content: [{ type: "text" as const, text: `Wrote result for host ${host_id}` }] };
        }
      ),
      tool(
        "update_run_progress_tool",
        "Update run progress after completing hosts in this batch.",
        { hosts_done: z.number(), log_message: z.string() },
        async ({ hosts_done, log_message }) => {
          await updateRunProgress(runId, tenantId, hosts_done, log_message);
          return { content: [{ type: "text" as const, text: `Progress updated: ${log_message}` }] };
        }
      ),
    ],
  });
}
