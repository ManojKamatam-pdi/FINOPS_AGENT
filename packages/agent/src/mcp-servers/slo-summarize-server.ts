import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  readSloResultsForOrg,
  writeSloOrgSummary,
  updateSloTenantsDone,
  readSloList,
} from "../tools/slo-dynamodb.js";

export function createSloSummarizeServer(tenantId: string, runId: string) {
  return createSdkMcpServer({
    name: "slo-summarize-tools",
    version: "1.0.0",
    tools: [
      tool(
        "read_slo_results_tool",
        "Read all per-SLO audit results for this org from DynamoDB. Returns the full list for portfolio analysis.",
        {},
        async (_input) => {
          const results = await readSloResultsForOrg(tenantId, runId);
          const sloListData = await readSloList(runId, tenantId);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                tenant_id: tenantId,
                total_results: results.length,
                monitoring_context: sloListData?.monitoring_context ?? {
                  apm_enabled: false,
                  synthetics_enabled: false,
                  infra_monitoring: true,
                },
                results,
              }),
            }],
          };
        }
      ),
      tool(
        "write_slo_org_summary_tool",
        "Write the org-level SLO compliance summary to DynamoDB. Call this after generating the gap analysis.",
        {
          summary_json: z.string().describe("JSON string of the full org summary including gap_analysis array"),
        },
        async ({ summary_json }) => {
          let raw: Record<string, unknown>;
          try {
            raw = JSON.parse(summary_json) as Record<string, unknown>;
          } catch (e) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({ error: `Invalid JSON in summary_json: ${String(e)}` }),
              }],
            };
          }

          // Re-read results authoritatively — compute counts server-side, never trust agent arithmetic
          const results = await readSloResultsForOrg(tenantId, runId);
          const sloListData = await readSloList(runId, tenantId);
          const totalSlos = results.length;
          const validSlos = results.filter(r => Number(r["validation_score"] ?? 0) >= 75).length;
          const misconfiguredSlos = results.filter(r => Array.isArray(r["blocker_issues"]) && (r["blocker_issues"] as unknown[]).length > 0).length;

          // Normalize sli_category: lowercase + map agent free-text to canonical values
          function normalizeCategory(raw: unknown): string {
            const s = String(raw ?? "").toLowerCase().trim();
            if (s.includes("availability") || s.includes("uptime") || s.includes("web uptime")) return "availability";
            if (s.includes("latency") || s.includes("response time") || s.includes("duration")) return "latency";
            if (s.includes("error") || s.includes("error_rate") || s.includes("success rate") || s.includes("request success")) return "error_rate";
            if (s.includes("throughput") || s.includes("request rate")) return "throughput";
            if (s.includes("saturation") || s.includes("cpu") || s.includes("memory") || s.includes("disk") || s.includes("infrastructure")) return "saturation";
            if (s === "" || s === "unclassified") return "unclassified";
            return "unclassified";
          }

          const unclassifiedSlos = results.filter(r => normalizeCategory(r["sli_category"]) === "unclassified").length;

          // Compute category scores server-side — group by normalized sli_category, average validation_score
          const TRACKED_CATEGORIES = ["availability", "latency", "error_rate"] as const;
          type TrackedCategory = typeof TRACKED_CATEGORIES[number];

          const byCategory: Record<TrackedCategory, number[]> = {
            availability: [],
            latency: [],
            error_rate: [],
          };
          for (const r of results) {
            const cat = normalizeCategory(r["sli_category"]);
            if (cat === "availability" || cat === "latency" || cat === "error_rate") {
              byCategory[cat as TrackedCategory].push(Number(r["validation_score"] ?? 0));
            }
          }

          const computedCategoryScores: Record<string, number | null> = {};
          const computedNaCategories: string[] = [];
          for (const cat of TRACKED_CATEGORIES) {
            const scores = byCategory[cat];
            if (scores.length === 0) {
              computedCategoryScores[cat] = null;
              computedNaCategories.push(cat);
            } else {
              computedCategoryScores[cat] = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
            }
          }

          // Compute overall compliance_score server-side — weighted average of all SLO validation_scores
          const allScores = results.map(r => Number(r["validation_score"] ?? 0));
          const computedComplianceScore = allScores.length > 0
            ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length)
            : 0;

          // Derive compliance_tier from computed score
          let computedComplianceTier: string;
          if (computedComplianceScore >= 90) computedComplianceTier = "excellent";
          else if (computedComplianceScore >= 75) computedComplianceTier = "good";
          else if (computedComplianceScore >= 50) computedComplianceTier = "needs_improvement";
          else if (computedComplianceScore >= 25) computedComplianceTier = "poor";
          else computedComplianceTier = "critical";

          // Use monitoring_context from slo_lists (authoritative) — not from agent
          const monitoringContext = sloListData?.monitoring_context ?? (raw["monitoring_context"] as Record<string, unknown>) ?? {
            apm_enabled: false,
            synthetics_enabled: false,
            infra_monitoring: true,
          };

          const summary: Record<string, unknown> = {
            tenant_id: tenantId,
            run_id: runId,
            total_slos: totalSlos,
            valid_slos: validSlos,
            misconfigured_slos: misconfiguredSlos,
            unclassified_slos: unclassifiedSlos,
            compliance_score: computedComplianceScore,
            compliance_tier: computedComplianceTier,
            monitoring_context: monitoringContext,
            category_scores: computedCategoryScores,
            na_categories: computedNaCategories,
            gap_analysis: Array.isArray(raw["gap_analysis"]) ? raw["gap_analysis"] : [],
            completed_at: new Date().toISOString(),
          };

          await writeSloOrgSummary(tenantId, runId, summary);
          await updateSloTenantsDone(runId);

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                tenant_id: tenantId,
                compliance_score: computedComplianceScore,
                compliance_tier: computedComplianceTier,
                total_slos: totalSlos,
                valid_slos: validSlos,
                misconfigured_slos: misconfiguredSlos,
                unclassified_slos: unclassifiedSlos,
                gap_analysis_count: (summary["gap_analysis"] as unknown[]).length,
              }),
            }],
          };
        }
      ),
    ],
  });
}
