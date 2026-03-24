import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { readOrgHostResults, writeOrgSummary, updateTenantsDone } from "../tools/dynamodb.js";

export function createSummarizeServer(tenantId: string, runId: string) {
  return createSdkMcpServer({
    name: "summarize-tools",
    version: "1.0.0",
    tools: [
      tool(
        "compute_and_write_org_summary_tool",
        "Read all host results for this org from DynamoDB, compute the org-level summary metrics, write the summary, and mark the org as done. Call this once — it does everything.",
        {},
        async (_input) => {
          const results = await readOrgHostResults(tenantId, runId);

          const totalHosts = results.length;
          const hostsAnalyzed = results.filter(r => r["efficiency_label"] !== "unknown").length;
          const hostsOverProvisioned = results.filter(r => r["efficiency_label"] === "over-provisioned").length;
          const hostsRightSized = results.filter(r => r["efficiency_label"] === "right-sized").length;
          const hostsUnderProvisioned = results.filter(r => r["efficiency_label"] === "under-provisioned").length;
          const hostsNoTag = results.filter(r => !r["has_instance_tag"]).length;

          const costs = results.map(r => r["current_monthly_cost"]).filter((v): v is number => typeof v === "number");
          const savings = results.map(r => r["monthly_savings"]).filter((v): v is number => typeof v === "number" && v > 0);
          const cpus = results.map(r => r["cpu_avg_30d"]).filter((v): v is number => typeof v === "number");
          const rams = results.map(r => r["ram_avg_30d"]).filter((v): v is number => typeof v === "number");

          const totalMonthlySpend = Math.round(costs.reduce((a, b) => a + b, 0) * 100) / 100;
          const potentialSavings = Math.round(savings.reduce((a, b) => a + b, 0) * 100) / 100;
          const savingsPercent = totalMonthlySpend > 0
            ? Math.round((potentialSavings / totalMonthlySpend) * 1000) / 10
            : 0;
          const avgCpu = cpus.length > 0
            ? Math.round((cpus.reduce((a, b) => a + b, 0) / cpus.length) * 10) / 10
            : 0;
          const avgRam = rams.length > 0
            ? Math.round((rams.reduce((a, b) => a + b, 0) / rams.length) * 10) / 10
            : 0;

          // Top 5 hosts by monthly_savings descending
          const topOffenders = results
            .filter(r => typeof r["monthly_savings"] === "number" && (r["monthly_savings"] as number) > 0)
            .sort((a, b) => (b["monthly_savings"] as number) - (a["monthly_savings"] as number))
            .slice(0, 5)
            .map(r => String(r["host_id"] ?? ""));

          const summary = {
            tenant_id: tenantId,
            total_hosts: totalHosts,
            hosts_analyzed: hostsAnalyzed,
            hosts_over_provisioned: hostsOverProvisioned,
            hosts_right_sized: hostsRightSized,
            hosts_under_provisioned: hostsUnderProvisioned,
            hosts_no_tag: hostsNoTag,
            total_monthly_spend: totalMonthlySpend,
            potential_savings: potentialSavings,
            savings_percent: savingsPercent,
            avg_cpu_utilization: avgCpu,
            avg_ram_utilization: avgRam,
            top_offenders: topOffenders,
            completed_at: new Date().toISOString(),
          };

          await writeOrgSummary(tenantId, runId, summary);
          await updateTenantsDone(runId);

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                tenant_id: tenantId,
                total_hosts: totalHosts,
                hosts_analyzed: hostsAnalyzed,
                hosts_over_provisioned: hostsOverProvisioned,
                hosts_right_sized: hostsRightSized,
                hosts_under_provisioned: hostsUnderProvisioned,
                potential_savings: potentialSavings,
                savings_percent: savingsPercent,
              }),
            }],
          };
        }
      ),
    ],
  });
}
