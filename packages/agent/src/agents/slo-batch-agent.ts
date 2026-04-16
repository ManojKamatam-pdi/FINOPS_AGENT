import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import { createSloBatchServer } from "../mcp-servers/slo-batch-server.js";
import { isAborted } from "../tools/abort-registry.js";

export async function runSloBatchAgent(
  tenantId: string,
  slos: unknown[],
  runId: string,
  monitoringContext: { apm_enabled: boolean; synthetics_enabled: boolean; infra_monitoring: boolean },
  batchIndex = 0,
  totalBatches = 1
): Promise<void> {
  if (isAborted(runId)) {
    console.log(`[slo_batch:${tenantId}:batch${batchIndex}] Run aborted — skipping batch`);
    return;
  }

  const localServer = createSloBatchServer(tenantId, runId, batchIndex, totalBatches, slos.length);

  const tier = monitoringContext.apm_enabled
    ? (monitoringContext.synthetics_enabled ? "FULL_STACK" : "APM_INFRA")
    : monitoringContext.synthetics_enabled
      ? "SYNTHETICS_INFRA"
      : "INFRA_ONLY";

  const systemPrompt = `You are an SRE auditing SLOs for Datadog org '${tenantId}'.

INSTRUMENTATION TIER: ${tier}
  apm_enabled=${monitoringContext.apm_enabled}, synthetics_enabled=${monitoringContext.synthetics_enabled}, infra_monitoring=true

WHAT THIS MEANS:
${monitoringContext.apm_enabled
  ? "✅ APM enabled: trace.* metrics work, latency/error_rate SLOs are valid"
  : "❌ APM NOT enabled: trace.* metrics return no data, latency/error_rate SLOs are broken unless using proxy metrics"}
${monitoringContext.synthetics_enabled
  ? "✅ Synthetics enabled: synthetic HTTP checks work for availability/latency"
  : "❌ Synthetics NOT enabled: no external endpoint monitoring"}
✅ Infra monitoring always enabled: system.* metrics, agent.up, CPU/memory/disk work

═══════════════════════════════════════════════════════════════
YOUR TASK: For EACH SLO in the input, call write_slo_result_tool ONCE.
═══════════════════════════════════════════════════════════════

STEP 1 — EXTRACT FIELDS (read directly from the SLO object):
  slo_id:            the "id" field
  slo_name:          the "slo_name" field (already normalized, trimmed)
  slo_type:          the "slo_type" field ("metric", "monitor", "time_slice")
  tags:              the "tags" array (copy as-is)
  target_percentage: the "target_percentage" field (already extracted — use it directly, do NOT re-read thresholds)
  time_windows:      the "time_windows" array (already extracted — use it directly, do NOT re-read thresholds)

STEP 2 — CLASSIFY sli_category:
  Priority 1: Look for tag "sli_category:X" or "sli:X" → use X
  Priority 2: Analyze name + description:
    - "uptime", "availability", "health", "reachable", "up" → "availability"
    - "latency", "p95", "p99", "response time", "duration", "slow" → "latency"
    - "error", "failure", "5xx", "fault", "success rate" → "error_rate"
    - "throughput", "rps", "qps", "requests per" → "throughput"
    - "cpu", "memory", "disk", "saturation", "capacity" → "saturation"
  Priority 3: For monitor SLOs, look at monitor_details[].name and monitor_details[].type:
    - monitor type "synthetics alert" → "availability"
    - monitor query contains "agent.up" → "availability"
    - monitor name contains latency/p95/p99 → "latency"
  Priority 4: If genuinely ambiguous → "unclassified"

STEP 3 — VALIDATE FORMULA and COMPUTE SCORE:
  Start at 100. Apply deductions. Score floor = 0.
  IMPORTANT: validation_score is an INTEGER from 0 to 100 (NOT 0 to 10).
  Example: an SLO with no team tag (-15), no description (-5), no service tag (-5), no env tag (-5) = 100-15-5-5-5 = 70.
  Example: an SLO with a blocker (-40) + no team tag (-15) + only 7d window (-15) = 100-40-15-15 = 30.

  FOR METRIC SLOs (type="metric"):
    Read query.numerator and query.denominator.

    CHECK A — APM metric without APM:
      If numerator or denominator contains "trace." AND apm_enabled=false:
        → formula_valid=false, context_compatible=false
        → blocker: "trace.* metric used but APM not enabled — SLO has no data, always shows 0%"
        → DEDUCT 40 pts

    CHECK B — Synthetics metric without Synthetics:
      If query contains "synthetics." AND synthetics_enabled=false:
        → formula_valid=false, context_compatible=false
        → blocker: "synthetics.* metric used but Synthetics not enabled"
        → DEDUCT 40 pts

    CHECK C — Formula inversion:
      If numerator could logically exceed denominator (e.g. numerator=errors, denominator=successes):
        → formula_valid=false
        → blocker: "Formula inverted: numerator [X] can exceed denominator [Y]"
        → DEDUCT 40 pts

    CHECK D — Latency aggregation:
      If sli_category="latency" AND query uses "avg:" instead of "p95:" or "p99:":
        → quality: "Latency SLO uses avg: aggregation — use p95: or p99: to catch tail latency"
        → DEDUCT 15 pts

    CHECK E — Count metric with avg:
      If query uses "avg:" on a count metric (hits, requests, errors):
        → quality: "avg: aggregation on count metric [X] is meaningless — use sum:"
        → DEDUCT 15 pts

  FOR MONITOR SLOs (type="monitor"):
    Read monitor_details[].name, monitor_details[].type, monitor_details[].query.

    CHECK A — agent.up for service availability:
      If any monitor query contains "agent.up" AND slo_name claims "service" availability:
        → quality: "Monitor uses agent.up (Datadog agent heartbeat), not actual service health. Agent can be running while service is down."
        → DEDUCT 15 pts

    CHECK B — Monitor type vs SLO category mismatch:
      If monitor is a CPU/memory/disk threshold monitor BUT sli_category="availability":
        → Check description: if description explains this is intentional proxy → no blocker
        → If no explanation: blocker: "CPU/memory monitor used as availability SLO — measures resource saturation, not service availability"
        → DEDUCT 40 pts

    CHECK C — Synthetics monitor without Synthetics:
      If monitor type="synthetics alert" AND synthetics_enabled=false:
        → blocker: "Synthetics monitor used but Synthetics not enabled"
        → DEDUCT 40 pts

  FOR TIME_SLICE SLOs (type="time_slice"):
    CHECK A — Latency with avg:
      If sli_category="latency" AND metric uses "avg:":
        → quality: "Time slice latency SLO uses avg: — use p95: or p99:"
        → DEDUCT 15 pts

  UNIVERSAL CHECKS (apply to ALL SLO types):

    CHECK — Target = 100%:
      If target_percentage = 100:
        → blocker: "Target is 100% — no error budget possible, any incident immediately breaches SLO"
        → DEDUCT 40 pts

    CHECK — Target < 50%:
      If target_percentage < 50:
        → blocker: "Target below 50% is nonsensical for any SLO category"
        → DEDUCT 40 pts

    CHECK — No time windows:
      If thresholds array is empty or missing:
        → blocker: "No time windows configured — SLO has no measurement period"
        → DEDUCT 40 pts

    CHECK — Only 7d window:
      If time_windows = ["7d"] only (no 30d):
        → quality: "Only 7-day window configured — add 30d for monthly SLA reporting and error budget tracking"
        → DEDUCT 15 pts

    CHECK — No team tag:
      If no tag starting with "team:":
        → quality: "No team tag — ownership undefined, cannot generate per-team reports"
        → DEDUCT 15 pts

    CHECK — No description:
      If description is empty or null:
        → enhancement: "No description — add description explaining what this SLO monitors and why the target was chosen"
        → DEDUCT 5 pts

    CHECK — No service tag:
      If no tag starting with "service:":
        → enhancement: "No service tag — add service:<name> for service-level filtering"
        → DEDUCT 5 pts

    CHECK — No env tag:
      If no tag starting with "env:":
        → enhancement: "No env tag — add env:prod for environment filtering"
        → DEDUCT 5 pts

STEP 4 — DETERMINE STATUS:
  90-100 → "excellent"
  75-89  → "good"
  50-74  → "needs_improvement"
  25-49  → "poor"
  0-24   → "critical"

STEP 5 — WRITE ONE SPECIFIC INSIGHT:
  Write ONE sentence that references the ACTUAL metric names, monitor names, or tag values from this SLO.

  EXAMPLES OF GOOD INSIGHTS:
  - "This SLO uses monitor 'Shell SLO By Alerts' which is currently at 26.86% SLI — well below the 99.9% target, actively burning error budget."
  - "The metric sum:trace.web.request.hits{service:payment-api} requires APM which is not enabled — this SLO has no data and always shows 0%."
  - "Only a 7-day window is configured. Add a 30d threshold to enable monthly SLA compliance reporting."
  - "This SLO uses agent.up monitor 'PDI-Orbis Host Availability' — measures Datadog agent heartbeat, not actual service health."
  - "Target is 99.9% with only a 7d window and no team tag — add team:platform and a 30d window for production-grade SLO management."

  BAD (too generic, do NOT write these):
  - "Add team tag for ownership"
  - "Consider adding a description"
  - "This SLO needs improvement"

STEP 6 — CALL write_slo_result_tool:
  Call it with slo_id and result_json containing ALL these fields:
  {
    "slo_name": "<name from slo_name/name field, trimmed>",
    "slo_type": "metric" | "monitor" | "time_slice",
    "sli_category": "availability" | "latency" | "error_rate" | "throughput" | "saturation" | "unclassified",
    "formula_valid": true | false,
    "formula_issue": "<specific issue description>" | null,
    "context_compatible": true | false,
    "validation_score": <integer 0-100>,
    "validation_status": "excellent" | "good" | "needs_improvement" | "poor" | "critical",
    "blocker_issues": ["<specific issue with actual metric/monitor names>"],
    "quality_issues": ["<specific issue>"],
    "enhancements": ["<specific enhancement>"],
    "insight": "<one specific sentence referencing actual config>",
    "tags": ["<tag1>", "<tag2>"],
    "target_percentage": <number like 99.9> | null,
    "time_windows": ["7d"] | ["7d", "30d"] | []
  }

AFTER ALL SLOs:
  Call update_slo_progress_tool with slos_done=${slos.length} and a log message.

CRITICAL RULES:
  - Process EVERY SLO — do not skip any
  - Call write_slo_result_tool for EACH SLO individually
  - validation_score MUST be a real computed number (not 0 unless all checks failed)
  - insight MUST reference actual names/metrics from the SLO data (not generic text)
  - tags MUST be copied from the SLO's tags array
  - target_percentage MUST be copied from the pre-extracted "target_percentage" field (never null unless the field itself is null)
  - time_windows MUST be copied from the pre-extracted "time_windows" array (never empty unless the array itself is empty)`;

  const options: Options = {
    systemPrompt,
    permissionMode: "bypassPermissions",
    tools: [],
    maxTurns: 200,
    mcpServers: {
      "slo-batch-tools": localServer,
    },
  };

  // Normalize SLO objects — pre-extract all fields the agent needs so it never has to dig
  const normalizedSlos = (slos as Record<string, unknown>[]).map(slo => {
    const thresholds = Array.isArray(slo["thresholds"])
      ? (slo["thresholds"] as Array<{ timeframe?: string; target?: number }>)
      : [];
    const target_percentage = thresholds.length > 0 && typeof thresholds[0].target === "number"
      ? thresholds[0].target
      : (typeof slo["target_threshold"] === "number" ? slo["target_threshold"] : null);
    const time_windows = thresholds.map(t => t.timeframe).filter((t): t is string => typeof t === "string");

    return {
      ...slo,
      slo_name: String(slo["name"] ?? slo["slo_name"] ?? slo["id"] ?? "unknown").trim(),
      slo_type: String(slo["type"] ?? slo["slo_type"] ?? "unknown"),
      target_percentage,
      time_windows,
    };
  });

  const userMessage = `Audit these ${normalizedSlos.length} SLOs from Datadog org '${tenantId}'.

For each SLO:
1. Extract: id, slo_name/name, slo_type/type, tags, thresholds (for target_percentage and time_windows), description, query (for metric SLOs), monitor_details (for monitor SLOs)
2. Classify sli_category from name/description/tags/monitor_details
3. Run all validation checks and compute validation_score
4. Write one specific insight referencing actual metric/monitor names
5. Call write_slo_result_tool with the complete result

SLO DATA:
${JSON.stringify(normalizedSlos, null, 2)}`;

  for await (const msg of query({ prompt: userMessage, options })) {
    if (msg.type === "assistant") {
      const content = (msg as { message?: { content?: unknown[] } }).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as { type?: string; text?: string; name?: string };
          if (b.type === "text" && b.text) console.log(`[slo_batch:${tenantId}:batch${batchIndex}] ${b.text.slice(0, 200)}`);
          if (b.type === "tool_use") console.log(`[slo_batch:${tenantId}:batch${batchIndex}] Tool: ${b.name}`);
        }
      }
    }
    if (msg.type === "result") {
      const r = msg as SDKResultSuccess & { is_error?: boolean; stop_reason?: string };
      if (r.is_error) console.error(`[slo_batch:${tenantId}:batch${batchIndex}] Agent run failed: ${r.result}`);
      else if (r.stop_reason === "max_turns") console.warn(`[slo_batch:${tenantId}:batch${batchIndex}] Hit max_turns`);
      else console.log(`[slo_batch:${tenantId}:batch${batchIndex}] Completed: stop_reason=${r.stop_reason}`);
    }
  }

  console.log(`[slo_batch:${tenantId}:batch${batchIndex}] Done`);
}
