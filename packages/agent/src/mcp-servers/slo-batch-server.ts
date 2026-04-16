import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { writeSloResult, updateSloProgress } from "../tools/slo-dynamodb.js";

export function createSloBatchServer(
  tenantId: string,
  runId: string,
  batchIndex: number,
  totalBatches: number,
  batchSize: number
) {
  return createSdkMcpServer({
    name: "slo-batch-tools",
    version: "1.0.0",
    tools: [
      tool(
        "write_slo_result_tool",
        "Write a per-SLO audit result to DynamoDB. Call this after auditing each SLO.",
        {
          slo_id: z.string().describe("The SLO ID from Datadog"),
          result_json: z.string().describe("JSON string of the full SLO audit result"),
        },
        async ({ slo_id, result_json }) => {
          let raw: Record<string, unknown>;
          try {
            raw = JSON.parse(result_json) as Record<string, unknown>;
          } catch (e) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({ error: `Invalid JSON in result_json: ${String(e)}` }),
              }],
            };
          }

          // Validate and normalize score
          let score = typeof raw["validation_score"] === "number" ? raw["validation_score"] as number : 0;
          score = Math.max(0, Math.min(100, Math.round(score)));

          // Detect 0-10 scale mistake: if score ≤ 10 and no blockers, the LLM likely wrote
          // on a 0-10 scale instead of 0-100. Multiply by 10 to correct.
          const blockerCount = Array.isArray(raw["blocker_issues"]) ? (raw["blocker_issues"] as unknown[]).length : 0;
          if (score <= 10 && blockerCount === 0) {
            score = Math.min(100, score * 10);
          }

          // Derive status from score
          let status: string;
          if (score >= 90) status = "excellent";
          else if (score >= 75) status = "good";
          else if (score >= 50) status = "needs_improvement";
          else if (score >= 25) status = "poor";
          else status = "critical";

          // Normalize all string arrays — ensure every element is a primitive string, never an object
          const toStringArray = (v: unknown): string[] =>
            (Array.isArray(v) ? v : []).map((x: unknown) =>
              typeof x === "string" ? x : typeof x === "object" && x !== null ? JSON.stringify(x) : String(x ?? "")
            );

          const canonical: Record<string, unknown> = {
            slo_id,
            slo_name: String(raw["slo_name"] ?? raw["name"] ?? slo_id),
            slo_type: String(raw["slo_type"] ?? raw["type"] ?? "unknown"),
            sli_category: String(raw["sli_category"] ?? "unclassified"),
            formula_valid: raw["formula_valid"] !== false,
            formula_issue: raw["formula_issue"] ? String(raw["formula_issue"]) : null,
            context_compatible: raw["context_compatible"] !== false,
            validation_score: score,
            validation_status: status,
            blocker_issues: toStringArray(raw["blocker_issues"]),
            quality_issues: toStringArray(raw["quality_issues"]),
            enhancements: toStringArray(raw["enhancements"]),
            insight: String(raw["insight"] ?? ""),
            tags: toStringArray(raw["tags"]),
            target_percentage: typeof raw["target_percentage"] === "number" ? raw["target_percentage"] : null,
            time_windows: toStringArray(raw["time_windows"]),
            analyzed_at: new Date().toISOString(),
          };

          await writeSloResult(tenantId, runId, slo_id, canonical);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ success: true, slo_id, score, status }),
            }],
          };
        }
      ),
      tool(
        "update_slo_progress_tool",
        "Update run progress after completing SLOs in this batch.",
        {
          slos_done: z.number().describe("Number of SLOs completed in this batch"),
          log_message: z.string().describe("Progress log message"),
        },
        async ({ slos_done, log_message }) => {
          await updateSloProgress(runId, slos_done, log_message);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ success: true, message: log_message }),
            }],
          };
        }
      ),
    ],
  });
}
