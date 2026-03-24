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
        "Get CPU count (vcpu) and RAM GB for an EC2 instance type from the live AWS catalog. Returns { vcpu, ram_gb, instance_type }.",
        { instance_type: z.string(), region: z.string().default("us-east-1") },
        async ({ instance_type, region }) => {
          const specs = await getInstanceSpecs(instance_type, region);
          const text = specs
            ? JSON.stringify(specs)
            : JSON.stringify({ error: `Instance type ${instance_type} not found in AWS catalog for ${region}` });
          return { content: [{ type: "text" as const, text }] };
        }
      ),
      tool(
        "get_instance_on_demand_price_tool",
        "Get monthly on-demand price (USD) for a known instance type when NO cpu/ram metrics are available (PATH 3). Call this to populate current_monthly_cost when the host has an instance_type tag but no utilization data.",
        { instance_type: z.string(), region: z.string().default("us-east-1") },
        async ({ instance_type, region }) => {
          const price = await getInstanceOnDemandPrice(instance_type, region);
          const text = price !== null
            ? JSON.stringify({ monthly_usd: price })
            : JSON.stringify({ error: `Price unavailable for ${instance_type} in ${region}` });
          return { content: [{ type: "text" as const, text }] };
        }
      ),
      tool(
        "suggest_right_sized_instance_tool",
        "Use this tool when instance_type IS known AND it is an AWS EC2 type (e.g. t2.medium, m5a.large, c5.xlarge, r5.2xlarge). ALWAYS call this instead of suggest_universal_rightsizing_tool when you have an AWS instance_type. Returns the best-fit replacement instance with live pricing, monthly savings, and current cost. cpu_p95_pct: 95th percentile CPU % (0-100). ram_avg_pct: average RAM used as % of current instance total RAM (0-100). Pass null if RAM data is unavailable — the tool will return ram_unavailable=true signaling you to use PATH 2: call suggest_universal_rightsizing_tool with ram_avg_pct=null instead. NOTE: If the instance_type is Azure (e.g. Standard_D2s_v3) or GCP (e.g. n2-standard-4), this tool will return catalog_not_available=true — in that case use suggest_universal_rightsizing_tool instead.",
        {
          cpu_p95_pct: z.number(),
          ram_avg_pct: z.number().nullable(),
          current_instance: z.string(),
          region: z.string().default("us-east-1"),
        },
        async ({ cpu_p95_pct, ram_avg_pct, current_instance, region }) => {
          const catalogInstances = await getAllInstancesSortedByPrice(CANDIDATE_FAMILIES_V1, {}, region);
          const prices = await getPricesForInstances(catalogInstances, region);

          // If the current instance isn't in the AWS catalog, it's Azure/GCP — signal the agent
          const currentPrice = prices[current_instance] ?? null;
          if (currentPrice === null && !catalogInstances.includes(current_instance)) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  catalog_not_available: true,
                  reason: `${current_instance} is not an AWS EC2 instance type — no AWS catalog entry found. Use suggest_universal_rightsizing_tool for this host instead.`,
                }),
              }],
            };
          }

          // If RAM data is unavailable, signal the agent to use PATH 2 (universal rightsizing)
          if (ram_avg_pct === null) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  ram_unavailable: true,
                  message: "RAM data unavailable — use PATH 2: call suggest_universal_rightsizing_tool with ram_avg_pct=null",
                  current_monthly_usd: currentPrice,
                }),
              }],
            };
          }

          const result = await suggestRightSizedInstance(cpu_p95_pct, ram_avg_pct, current_instance, prices, region);
          const suggestedPrice = prices[result.suggested] ?? null;
          let monthlySavings = 0;
          let savingsPct = 0;
          if (currentPrice && suggestedPrice && !result.already_right_sized) {
            // Floor at 0 — never report negative savings (upgrade recommendations have 0 savings)
            monthlySavings = Math.max(0, Math.round((currentPrice - suggestedPrice) * 100) / 100);
            savingsPct = currentPrice > 0 ? Math.max(0, Math.round((monthlySavings / currentPrice) * 1000) / 10) : 0;
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
        async ({ current_instance, suggested_instance, region }) => {
          // Build a URL that pre-selects the suggested instance in the AWS calculator
          // The AWS calculator doesn't support deep-linking to specific comparisons via query params,
          // but we can build a useful search URL pointing to the EC2 pricing page for the region
          const regionSlug = region.toLowerCase().replace(/-/g, "-");
          const url = `https://aws.amazon.com/ec2/pricing/on-demand/?nc2=type_a#${regionSlug}`;
          const text = JSON.stringify({
            pricing_calc_url: url,
            note: `Compare ${current_instance} vs ${suggested_instance} in ${region} on the AWS EC2 On-Demand pricing page`,
          });
          return { content: [{ type: "text" as const, text }] };
        }
      ),
      tool(
        "suggest_universal_rightsizing_tool",
        "Use this tool for: (1) hosts where instance_type is NULL (on-prem, bare-metal, untagged), (2) Azure or GCP instances where suggest_right_sized_instance_tool returns catalog_not_available=true, (3) AWS hosts where RAM data is unavailable (PATH 2). Generates a utilization-based recommendation without requiring an AWS catalog entry.",
        {
          host_name: z.string(),
          cpu_avg_pct: z.number().nullable(),
          cpu_p95_pct: z.number().nullable(),
          ram_avg_pct: z.number().nullable(),
          disk_avg_pct: z.number().nullable(),
          network_in_bytes_day: z.number().nullable(),
          network_out_bytes_day: z.number().nullable(),
          instance_cpu_count: z.number().nullable(),
          instance_ram_gb: z.number().nullable(),
          cloud_provider: z.string().default("unknown"),
        },
        async ({ host_name, cpu_avg_pct, cpu_p95_pct, ram_avg_pct, disk_avg_pct,
                  network_in_bytes_day, network_out_bytes_day,
                  instance_cpu_count, instance_ram_gb, cloud_provider }) => {

          // p95 is primary for right-sizing labeling; avg is fallback
          const cpu = cpu_p95_pct ?? cpu_avg_pct;
          // avg is used for recommendation text reporting
          const cpu_display = cpu_avg_pct ?? cpu_p95_pct;
          const ram = ram_avg_pct;
          const disk = disk_avg_pct;

          // Determine efficiency label — CPU, RAM, and disk all factor in
          // Network throughput is informational only (high traffic ≠ under-provisioned)
          let label: string;
          if (cpu === null && ram === null && disk === null) {
            label = "unknown";
          } else if ((cpu ?? 0) > 80 || (ram ?? 0) > 85 || (disk ?? 0) > 85) {
            label = "under-provisioned";
          } else if ((cpu ?? 100) < 20 && (ram ?? 100) < 40) {
            label = "over-provisioned";
          } else {
            label = "right-sized";
          }

          // Build recommendation sentence — use avg for display (more intuitive), p95 drives the label
          const parts: string[] = [];

          if (cpu_display !== null) parts.push(`CPU averaged ${cpu_display.toFixed(1)}%`);
          if (cpu_p95_pct !== null) parts.push(`p95 ${cpu_p95_pct.toFixed(1)}%`);
          if (ram !== null) parts.push(`RAM averaged ${ram.toFixed(1)}%`);
          if (disk_avg_pct !== null) parts.push(`disk at ${disk_avg_pct.toFixed(1)}%`);

          let action = "";
          if (label === "over-provisioned") {
            const suggestions: string[] = [];
            // Use p95 for sizing math — don't size below peak
            const cpuForSizing = cpu_p95_pct ?? cpu_avg_pct;
            if (cpuForSizing !== null && cpuForSizing < 20 && instance_cpu_count && instance_cpu_count > 1) {
              const suggestedCpu = Math.max(2, Math.ceil(instance_cpu_count * (cpuForSizing / 100) * 2));
              suggestions.push(`reduce vCPUs from ${instance_cpu_count} to ~${suggestedCpu} (based on 30-day p95 with 2× headroom)`);
            }
            if (ram !== null && ram < 40 && instance_ram_gb && instance_ram_gb > 1) {
              const suggestedRam = Math.max(1, Math.ceil(instance_ram_gb * (ram / 100) * 2));
              suggestions.push(`reduce RAM from ${instance_ram_gb.toFixed(0)} GB to ~${suggestedRam} GB`);
            }
            if (suggestions.length > 0) {
              action = `over-provisioned; consider ${suggestions.join(" and ")} to match actual usage`;
            } else {
              action = `over-provisioned; consider downsizing to match actual usage`;
            }
          } else if (label === "under-provisioned") {
            const concerns: string[] = [];
            if (cpu !== null && cpu > 80) concerns.push(`CPU p95 at ${cpu.toFixed(1)}%`);
            if (ram !== null && ram > 85) concerns.push(`RAM at ${ram.toFixed(1)}%`);
            if (disk !== null && disk > 85) concerns.push(`disk at ${disk.toFixed(1)}%`);
            action = `under-provisioned; ${concerns.join(" and ")} — consider scaling up to avoid performance issues`;
          } else if (label === "right-sized") {
            action = `right-sized for current workload`;
          } else {
            action = `insufficient metric data to make a recommendation`;
          }

          const metricSummary = parts.length > 0 ? parts.join(", ") : "no utilization data available";
          const recommendation = `${metricSummary} over 30 days — ${action}.`;

          // Suggested resource targets — use p95 for sizing math
          const cpuForSizing = cpu_p95_pct ?? cpu_avg_pct;
          const suggestedCpuCount = (cpuForSizing !== null && instance_cpu_count && label === "over-provisioned")
            ? Math.max(2, Math.ceil(instance_cpu_count * (cpuForSizing / 100) * 2))
            : null;
          const suggestedRamGb = (ram !== null && instance_ram_gb && label === "over-provisioned")
            ? Math.max(1, Math.ceil(instance_ram_gb * (ram / 100) * 2))
            : null;

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                efficiency_label: label,
                recommendation,
                suggested_cpu_count: suggestedCpuCount,
                suggested_ram_gb: suggestedRamGb,
                cloud_provider,
              }),
            }],
          };
        }
      ),
      tool(
        "write_host_result_tool",
        "Write a per-host analysis result to DynamoDB. IMPORTANT: Pass dd_host_metadata as the raw JSON object returned by search_datadog_hosts for this host (the row with hostname, instance_type, cloud_provider, hostname_aliases, tags). The server extracts instance_type and cloud_provider directly from Datadog metadata — values in result_json for these fields are used only as fallback when dd_host_metadata is absent.",
        {
          host_id: z.string(),
          result_json: z.string(),
          dd_host_metadata: z.string().optional().describe("Raw JSON of the search_datadog_hosts row for this host: {hostname, instance_type, cloud_provider, hostname_aliases, tags, sources}. Pass this so the server can extract instance_type authoritatively from Datadog."),
        },
        async ({ host_id, result_json, dd_host_metadata }) => {
          const raw = JSON.parse(result_json) as Record<string, unknown>;

          // ── Parse Datadog metadata if provided — authoritative source for instance_type ──
          let ddMeta: Record<string, string> = {};
          if (dd_host_metadata) {
            try { ddMeta = JSON.parse(dd_host_metadata) as Record<string, string>; } catch { /* ignore */ }
          }

          // ── Normalize field names to canonical schema ──────────────────────
          // Agents frequently use variant names — map them all to the canonical keys.
          const n = (key: string, ...aliases: string[]): unknown => {
            if (raw[key] !== undefined) return raw[key];
            for (const a of aliases) if (raw[a] !== undefined) return raw[a];
            return null;
          };

          const cpu_avg   = n("cpu_avg_30d",  "cpu_avg_pct",  "cpu_avg")   as number | null;
          const cpu_p95   = n("cpu_p95_30d",  "cpu_p95_pct",  "cpu_p95")   as number | null;
          const ram_avg   = n("ram_avg_30d",  "ram_avg_pct",  "ram_avg")   as number | null;
          const net_in    = n("network_in_avg_30d",  "net_in_avg",  "network_in",  "network_in_bytes_day")  as number | null;
          const net_out   = n("network_out_avg_30d", "net_out_avg", "network_out", "network_out_bytes_day") as number | null;
          const disk_avg  = n("disk_avg_30d", "disk_avg_pct", "disk_avg")  as number | null;

          // ── Recover metrics from recommendation text when agent omitted them from JSON ──
          // Pattern: "CPU averaged X%" and "RAM averaged Y%" appear in the recommendation
          // but the agent passed null for cpu_avg_30d / ram_avg_30d in the result JSON.
          const rec_text = (n("recommendation") as string | null) ?? "";
          const recCpuMatch = rec_text.match(/CPU averaged ([\d.]+)%/i);
          const recRamMatch = rec_text.match(/RAM averaged ([\d.]+)%/i);
          const recCpuP95Match = rec_text.match(/p95[:\s]+([\d.]+)%/i) ?? rec_text.match(/\(p95[:\s]+([\d.]+)%\)/i);
          // Recover p95 from recommendation text: "CPU p95 at X%" pattern
          const recCpuP95AtMatch = rec_text.match(/CPU p95 at ([\d.]+)%/i);
          const cpu_avg_final   = cpu_avg   ?? (recCpuMatch   ? parseFloat(recCpuMatch[1])   : null);
          const cpu_p95_final   = cpu_p95   ?? (recCpuP95Match ? parseFloat(recCpuP95Match[1]) : null)
                                            ?? (recCpuP95AtMatch ? parseFloat(recCpuP95AtMatch[1]) : null);
          const ram_avg_final   = ram_avg   ?? (recRamMatch   ? parseFloat(recRamMatch[1])   : null);

          // p95 is primary for right-sizing labeling (captures peak load); avg is fallback
          const cpu_for_label = cpu_p95_final ?? cpu_avg_final;
          // avg is primary for efficiency score (reporting); p95 is fallback
          const cpu_for_score = cpu_avg_final ?? cpu_p95_final;

          // Efficiency label — ALWAYS recompute from actual metric data (never trust agent's value blindly)
          // Rules (applied in order):
          //   1. cpu_p95 > 80 OR ram > 85 OR disk > 85  → under-provisioned
          //   2. cpu_p95 < 20 AND ram < 40               → over-provisioned
          //   3. any metric data present                  → right-sized
          //   4. all null                                 → unknown
          let efficiency_label: string;
          if (cpu_for_label !== null || ram_avg_final !== null || disk_avg !== null) {
            if ((cpu_for_label ?? 0) > 80 || (ram_avg_final ?? 0) > 85 || (disk_avg ?? 0) > 85) {
              efficiency_label = "under-provisioned";
            } else if ((cpu_for_label ?? 100) < 20 && (ram_avg_final ?? 100) < 40) {
              efficiency_label = "over-provisioned";
            } else {
              efficiency_label = "right-sized";
            }
          } else {
            efficiency_label = "unknown";
          }

          // Efficiency score — use cpu_avg for reporting (avg reflects sustained load)
          let efficiency_score = n("efficiency_score") as number | null;
          if (efficiency_score === null && cpu_for_score !== null && ram_avg_final !== null) {
            efficiency_score = Math.min(100, Math.max(0, Math.round((cpu_for_score + ram_avg_final) / 2)));
          }

          // Instance type — authoritative source is Datadog metadata (dd_host_metadata).
          // ddMeta.instance_type is what Datadog's own catalog says — never hallucinated.
          // Fallback to result_json only when dd_host_metadata was not passed.
          // Also check tags for "instance-type:<value>" as a secondary Datadog source.
          let instance_type: string | null = null;
          if (ddMeta.instance_type && ddMeta.instance_type.trim()) {
            // Datadog metadata column — most authoritative
            instance_type = ddMeta.instance_type.trim();
          } else if (ddMeta.tags) {
            // Parse instance-type tag from Datadog tags object
            try {
              const tags = typeof ddMeta.tags === "string" ? JSON.parse(ddMeta.tags) : ddMeta.tags;
              const tagVal = (tags as Record<string, string>)["instance-type"];
              if (tagVal && tagVal.trim()) instance_type = tagVal.trim();
            } catch { /* ignore */ }
          }
          // Only fall back to agent-provided value when no Datadog metadata was passed at all
          if (instance_type === null && !dd_host_metadata) {
            instance_type = (n("instance_type", "current_instance") as string | null)?.trim() || null;
          }
          const has_instance_tag = instance_type !== null;

          // Cloud provider — prefer Datadog metadata, then result_json, then region inference
          const ddCloudProvider = ddMeta.cloud_provider?.trim() || null;
          const rawProvider = ddCloudProvider
            ?? (n("cloud_provider") as string | null)
            ?? (String(n("region","instance_region") ?? "").match(/^(us|eu|ap|sa|ca|me|af)-[a-z]+-\d+/) ? "aws" : null)
            ?? "unknown";

          const providerNormMap: Record<string, string> = {
            // Confirmed on-prem variants (positive vsphere/vmware evidence)
            "on-premise": "on-prem",
            "on-premises": "on-prem",
            "onprem": "on-prem",
            "on_prem": "on-prem",
            "bare-metal": "on-prem",
            "baremetal": "on-prem",
            "vmware": "on-prem",
            // Hybrid/ambiguous variants → "unknown" (agent couldn't confirm on-prem, no positive evidence)
            // "No cloud tags" does NOT mean on-prem — these must stay "unknown"
            "on-prem/unknown": "unknown",
            "unknown/on-prem": "unknown",
            "unknown (on-prem)": "unknown",
            "unknown (on-prem/untagged)": "unknown",
            "unknown (on-prem/bare-metal)": "unknown",
            "on-prem/untagged": "unknown",
            "untagged": "unknown",
          };
          let cloud_provider = providerNormMap[rawProvider.toLowerCase()] ?? rawProvider;
          // Final safety net: if still not canonical, force to "unknown"
          const canonicalProviders = new Set(["aws", "azure", "gcp", "on-prem", "unknown"]);
          if (!canonicalProviders.has(cloud_provider)) {
            cloud_provider = "unknown";
          }

          // Monetary fields — normalize variant names
          const current_monthly_cost   = n("current_monthly_cost",   "current_monthly_usd",   "current_cost")   as number | null;
          const suggested_monthly_cost = n("suggested_monthly_cost",  "suggested_monthly_usd", "suggested_cost") as number | null;
          const monthly_savings        = n("monthly_savings",         "monthly_savings_usd")                     as number | null;
          // Recover savings_percent from monthly_savings / current_monthly_cost when agent omitted it
          const raw_savings_percent    = n("savings_percent",         "savings_pct")                             as number | null;
          const savings_percent = raw_savings_percent !== null
            ? Math.max(0, raw_savings_percent)
            : (monthly_savings != null && current_monthly_cost != null && current_monthly_cost > 0)
              ? Math.max(0, Math.round((monthly_savings / current_monthly_cost) * 1000) / 10)
              : null;

          // Recommendation — reject single-word keywords, require a proper sentence
          let recommendation = n("recommendation") as string | null;
          if (recommendation && recommendation.trim().split(/\s+/).length < 5) {
            // Agent wrote a keyword like "DOWNSIZE" — discard it
            recommendation = null;
          }

          // Synthesize a fallback recommendation when agent left it blank but we have metric data
          if (!recommendation || recommendation.trim() === "") {
            const parts: string[] = [];
            if (cpu_avg_final !== null) parts.push(`CPU averaged ${cpu_avg_final.toFixed(1)}%`);
            if (cpu_p95_final !== null) parts.push(`p95 ${cpu_p95_final.toFixed(1)}%`);
            if (ram_avg_final !== null) parts.push(`RAM averaged ${ram_avg_final.toFixed(1)}%`);
            if (disk_avg !== null) parts.push(`disk at ${disk_avg.toFixed(1)}%`);

            if (parts.length > 0) {
              const metricSummary = parts.join(", ");
              const instanceNote = (n("instance_type","current_instance") as string | null)
                ? ` on ${n("instance_type","current_instance") as string}`
                : "";
              if (efficiency_label === "over-provisioned") {
                recommendation = `${metricSummary} over 30 days${instanceNote} — over-provisioned; consider downsizing to reduce costs.`;
              } else if (efficiency_label === "under-provisioned") {
                recommendation = `${metricSummary} over 30 days${instanceNote} — under-provisioned; consider scaling up to avoid performance issues.`;
              } else if (efficiency_label === "right-sized") {
                recommendation = `${metricSummary} over 30 days${instanceNote} — right-sized for current workload.`;
              } else {
                recommendation = `${metricSummary} over 30 days${instanceNote} — insufficient data for a definitive recommendation.`;
              }
            } else {
              recommendation = "No metric data available for this host over the 30-day window. Host may be stopped, terminated, or neither the Datadog agent nor a cloud integration is configured.";
            }
          }

          const canonical: Record<string, unknown> = {
            host_name:              n("host_name", "hostname") ?? host_id,
            cloud_provider,
            cpu_avg_30d:            cpu_avg_final,
            cpu_p95_30d:            cpu_p95_final,
            ram_avg_30d:            ram_avg_final,
            network_in_avg_30d:     net_in,
            network_out_avg_30d:    net_out,
            disk_avg_30d:           disk_avg,
            instance_type,
            instance_region:        n("instance_region", "region") ?? null,
            instance_cpu_count:     n("instance_cpu_count", "vcpu", "cpu_count") ?? null,
            instance_ram_gb:        n("instance_ram_gb", "ram_gb", "ram_total_gb", "mem_total_gb") ?? null,
            has_instance_tag,
            catalog_data_available: n("catalog_data_available") ?? (current_monthly_cost !== null ? true : false),
            current_monthly_cost,
            suggested_instance:     n("suggested_instance") ?? null,
            suggested_monthly_cost,
            monthly_savings,
            savings_percent,
            pricing_calc_url:       n("pricing_calc_url") ?? null,
            efficiency_score,
            efficiency_label,
            recommendation,
            analyzed_at:            new Date().toISOString(),
          };

          // PATH 3 enforcement: AWS host with instance_type but no metrics MUST have current_monthly_cost
          // The prompt says get_instance_on_demand_price_tool is MANDATORY in this case.
          // Reject the write and force the agent to call it first.
          const hasInstanceType = !!(n("instance_type","current_instance") as string | null);
          const hasNoMetrics = cpu_avg_final === null && ram_avg_final === null;
          if (cloud_provider === "aws" && hasInstanceType && hasNoMetrics && current_monthly_cost === null) {
            const instanceType = n("instance_type","current_instance") as string;
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  error: "PATH 3 VIOLATION: AWS host with instance_type but no metrics requires current_monthly_cost.",
                  action_required: `Call get_instance_on_demand_price_tool(instance_type="${instanceType}", region="us-east-1") first, then retry write_host_result_tool with current_monthly_cost populated.`,
                }),
              }],
            };
          }

          await writeHostResult(tenantId, runId, host_id, canonical);
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
