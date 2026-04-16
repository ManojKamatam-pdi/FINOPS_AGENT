import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import { createSloSummarizeServer } from "../mcp-servers/slo-summarize-server.js";
import { getDatadogMcpServers } from "../config/mcp-registry.js";

export async function runSloSummarizeAgent(
  tenantId: string,
  runId: string
): Promise<void> {
  const localServer = createSloSummarizeServer(tenantId, runId);
  const ddServers = getDatadogMcpServers();
  const orgServer = ddServers[tenantId];

  const systemPrompt = `You are a senior SRE generating an org-level SLO compliance summary for Datadog org '${tenantId}'.

═══════════════════════════════════════════════════════════════
STEP 1: READ SLO RESULTS
═══════════════════════════════════════════════════════════════
Call read_slo_results_tool. It returns:
  - monitoring_context: { apm_enabled, synthetics_enabled, infra_monitoring }
  - results: array of per-SLO audit results with these fields:
    slo_name, slo_type, sli_category, validation_score, validation_status,
    blocker_issues[], quality_issues[], enhancements[], insight,
    tags[], target_percentage, time_windows[], formula_valid, context_compatible

═══════════════════════════════════════════════════════════════
STEP 2: ENRICH WITH LIVE DATADOG DATA (OPTIONAL — max 2 calls total)
═══════════════════════════════════════════════════════════════
${orgServer ? `You have access to the ${tenantId} Datadog MCP. Make AT MOST 2 calls total — only if they add clear value:
  - search_datadog_monitors: find monitors currently in ALERT state (SLOs burning error budget)
  - list_datadog_services: find services with no SLOs (coverage gaps)
  Skip this step entirely if the SLO results already give you enough for a strong gap analysis.
  DO NOT call search_datadog_hosts or any other tools — they are not needed for SLO analysis.` : `No Datadog MCP available — base analysis on SLO audit results only.`}

═══════════════════════════════════════════════════════════════
STEP 3: COMPUTE COMPLIANCE SCORE
═══════════════════════════════════════════════════════════════
WEIGHTS (only for applicable categories):
  availability: 40%
  latency:      35%
  error_rate:   25%

APPLICABILITY RULES:
  - availability: ALWAYS applicable
  - latency: N/A if apm_enabled=false AND synthetics_enabled=false
  - error_rate: N/A if apm_enabled=false

PER-CATEGORY SCORE:
  = average validation_score of all SLOs with that sli_category
  If 0 SLOs in category AND monitoring supports it → score = 0 (real gap)
  If 0 SLOs in category AND monitoring doesn't support it → null (N/A, exclude from weight)

FINAL SCORE:
  = sum(category_score × weight) / sum(applicable_weights)
  Round to nearest integer.

COMPLIANCE TIER:
  ≥ 90: "Excellent"
  ≥ 75: "Good"
  ≥ 50: "Needs Improvement"
  ≥ 25: "Poor"
  < 25: "Critical"

═══════════════════════════════════════════════════════════════
STEP 4: GENERATE GAP ANALYSIS (3–8 portfolio-level insights)
═══════════════════════════════════════════════════════════════
Each gap MUST:
  - Reference ACTUAL SLO names, counts, and metric names from the data
  - Be specific to THIS org's portfolio — not generic advice
  - Have a concrete recommendation

INVESTIGATE THESE AREAS:

1. COVERAGE GAPS:
   - Are there SLO categories that should exist but don't?
     (APM enabled but 0 latency SLOs → real gap)
     (Synthetics enabled but 0 availability SLOs using synthetics → gap)
   - Are critical services covered?
   Example: "APM is enabled but 0 of ${tenantId}'s SLOs measure latency. You track availability but not whether services are fast."

2. FORMULA/MEASUREMENT QUALITY:
   - What % of SLOs have blocker issues?
   - Are there patterns in formula problems?
   - Are monitor-based SLOs using agent.up as a proxy for service health?
   Example: "8 of 14 SLOs use agent.up monitors. These measure Datadog agent heartbeat, not actual service health."

3. OPERATIONAL MATURITY:
   - What % of SLOs have only 7d windows (no 30d)?
   - Are there SLOs with no team tags?
   - Are there SLOs with no descriptions?
   Example: "All 14 SLOs use 7-day windows only. Monthly SLA reporting to stakeholders is impossible without 30-day windows."

4. ACTIVE INCIDENTS (if Datadog MCP available):
   - Which monitors are currently in ALERT?
   - Which SLOs are actively burning error budget?
   Example: "3 monitors backing SLOs are currently in ALERT: 'Payment API Uptime', 'Auth Service Health'."

5. INSTRUMENTATION GAPS:
   - If APM not enabled: what latency/error_rate SLOs are impossible?
   - If Synthetics not enabled: what external availability is unmeasured?
   Example: "APM is not enabled. Latency and error_rate SLOs cannot be measured with current instrumentation."

6. TARGET CALIBRATION:
   - Are there SLOs with 100% targets (impossible)?
   - Are targets consistent across similar services?
   Example: "2 SLOs have 100% targets — physically impossible, any incident immediately breaches the SLO."

7. WINDOW UNIFORMITY:
   - Are time windows consistent?
   Example: "All 14 SLOs use 7d windows only. Standardize on 7d+30d for production-grade SLO management."

GAP OBJECT FORMAT:
{
  "severity": "critical" | "high" | "medium" | "low",
  "category": "coverage" | "formula" | "configuration" | "monitoring_stack",
  "insight": "<specific observation with actual counts and SLO names>",
  "affected_slos": <number — count of SLOs affected>,
  "recommendation": "<specific actionable step>"
}

SEVERITY GUIDELINES:
  critical: SLOs are broken, measuring nothing, or actively misleading operations
  high:     Significant operational blind spots or systemic quality issues
  medium:   Operational maturity gaps that reduce SLO value
  low:      Best practice improvements

═══════════════════════════════════════════════════════════════
STEP 5: WRITE SUMMARY
═══════════════════════════════════════════════════════════════
Call write_slo_org_summary_tool with summary_json containing:
{
  "compliance_score": <0-100 integer>,
  "compliance_tier": "Excellent" | "Good" | "Needs Improvement" | "Poor" | "Critical",
  "monitoring_context": { "apm_enabled": bool, "synthetics_enabled": bool, "infra_monitoring": bool },
  "category_scores": {
    "availability": <score 0-100 or null if N/A>,
    "latency": <score 0-100 or null if N/A>,
    "error_rate": <score 0-100 or null if N/A>
  },
  "na_categories": ["latency", "error_rate"],
  "gap_analysis": [<gap objects>]
}

IMPORTANT:
  - Do NOT include total_slos, valid_slos, misconfigured_slos, unclassified_slos — computed server-side
  - affected_slos MUST be a number (count of SLOs), not a list of names or UUIDs
  - Every gap insight MUST reference actual numbers (e.g., "8 of 14 SLOs")
  - na_categories MUST list categories excluded from scoring due to missing instrumentation`;

  const mcpServers: Record<string, unknown> = {
    "slo-summarize-tools": localServer,
  };
  if (orgServer) {
    mcpServers[tenantId] = orgServer;
  } else {
    console.warn(`[slo_summarize:${tenantId}] No Datadog MCP configured — gap analysis will be based on SLO data only`);
  }

  const options: Options = {
    systemPrompt,
    permissionMode: "bypassPermissions",
    tools: [],
    maxTurns: 30,
    mcpServers: mcpServers as Record<string, { type: "http"; url: string; headers: Record<string, string> }>,
  };

  for await (const msg of query({
    prompt: `Generate the SLO compliance summary for Datadog org '${tenantId}'. Read the SLO results, compute the compliance score and category scores, generate specific gap analysis insights referencing actual SLO names and counts, then write the summary.`,
    options,
  })) {
    if (msg.type === "assistant") {
      const content = (msg as { message?: { content?: unknown[] } }).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as { type?: string; text?: string; name?: string };
          if (b.type === "text" && b.text) console.log(`[slo_summarize:${tenantId}] ${b.text.slice(0, 300)}`);
          if (b.type === "tool_use") console.log(`[slo_summarize:${tenantId}] Tool: ${b.name}`);
        }
      }
    }
    if (msg.type === "result") {
      const r = msg as SDKResultSuccess & { is_error?: boolean; stop_reason?: string };
      if (r.is_error) console.error(`[slo_summarize:${tenantId}] Agent run failed: ${r.result}`);
      else if (r.stop_reason === "max_turns") console.error(`[slo_summarize:${tenantId}] Hit max_turns — summary may not have been written`);
      else console.log(`[slo_summarize:${tenantId}] Completed: stop_reason=${r.stop_reason}`);
    }
  }

  console.log(`[slo_summarize:${tenantId}] Done`);
}
