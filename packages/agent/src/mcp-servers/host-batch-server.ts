import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { writeHostResult, updateRunProgress } from "../tools/dynamodb.js";
import { getInstanceSpecs, suggestRightSizedInstance, getAllInstancesSortedByPrice, CANDIDATE_FAMILIES_V1 } from "../tools/aws-instances.js";
import { getPricesForInstances, getInstanceOnDemandPrice } from "../tools/aws-pricing.js";
import { getHostMetricsFromCache } from "../tools/metric-cache.js";
import { getHostMetadataFromCache } from "../tools/host-metadata-cache.js";
import { getTenants } from "../config/tenants.js";

const DD_MCP_BASE: Record<string, string> = {
  "datadoghq.com":     "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp",
  "datadoghq.eu":      "https://mcp.datadoghq.eu/api/unstable/mcp-server/mcp",
  "us3.datadoghq.com": "https://mcp.us3.datadoghq.com/api/unstable/mcp-server/mcp",
  "us5.datadoghq.com": "https://mcp.us5.datadoghq.com/api/unstable/mcp-server/mcp",
  "ap1.datadoghq.com": "https://mcp.ap1.datadoghq.com/api/unstable/mcp-server/mcp",
};

/** Parse the TSV_DATA block from a search_datadog_hosts MCP response. */
function parseTsvRow(text: string, hostname: string): Record<string, string> | null {
  const match = text.match(/<TSV_DATA>\n([\s\S]*?)\n<\/TSV_DATA>/);
  if (!match) return null;
  const lines = match[1].split("\n").filter(Boolean);
  if (lines.length < 2) return null;
  const headers = lines[0].split("\t");
  for (const line of lines.slice(1)) {
    const cols = line.split("\t");
    const row = Object.fromEntries(headers.map((h, i) => [h, cols[i] ?? ""]));
    if (row["hostname"] === hostname) return row;
  }
  return null;
}

// ─── Metrics shape returned by getHostMetricsFromCache ────────────────────────
interface HostMetrics {
  "system.cpu.idle"?: number | null;
  "system.cpu.idle.p95"?: number | null;
  "system.mem.pct_usable"?: number | null;
  "system.disk.in_use"?: number | null;
  "system.net.bytes_rcvd"?: number | null;
  "system.net.bytes_sent"?: number | null;
  "aws.ec2.cpuutilization"?: number | null;
  "aws.ec2.cpuutilization.p95"?: number | null;
  "aws.ec2.network_in"?: number | null;
  "aws.ec2.network_out"?: number | null;
  "azure.vm.percentage_cpu"?: number | null;
  "azure.vm.available_memory_bytes"?: number | null;
  "azure.vm.network_in_total"?: number | null;
  "azure.vm.network_out_total"?: number | null;
  "gcp.gce.instance.cpu.utilization"?: number | null;
  "gcp.gce.instance.memory.balloon.ram_used"?: number | null;
  "gcp.gce.instance.network.received_bytes_count"?: number | null;
  "gcp.gce.instance.network.sent_bytes_count"?: number | null;
  "vsphere.cpu.usage.avg"?: number | null;
  "vsphere.mem.usage.average"?: number | null;
  "vsphere.disk.usage.avg"?: number | null;
  "vsphere.net.received.avg"?: number | null;
  "vsphere.net.transmitted.avg"?: number | null;
}

// ─── Metadata shape returned by getHostMetadataFromCache ─────────────────────
interface CachedMeta {
  aliases: string[];
  tags: string[];
  apps: string[];
  instance_type: string | null;
  cloud_provider: string | null;
  /** Total RAM in MiB from DDSQL — used as fallback instance_ram_gb when pricing catalog has no entry. */
  memory_mib: number | null;
  /** Logical CPU count from DDSQL — used as fallback instance_cpu_count when pricing catalog has no entry. */
  cpu_logical_processors: number | null;
}

// ─── Canonical result shape written to DynamoDB ───────────────────────────────
interface HostResult {
  host_name: string;
  cloud_provider: string;
  host_subtype: string | null;
  cpu_avg_30d: number | null;
  cpu_p95_30d: number | null;
  ram_avg_30d: number | null;
  network_in_avg_30d: number | null;
  network_out_avg_30d: number | null;
  disk_avg_30d: number | null;
  instance_type: string | null;
  instance_region: string | null;
  instance_cpu_count: number | null;
  instance_ram_gb: number | null;
  has_instance_tag: boolean;
  catalog_data_available: boolean;
  current_monthly_cost: number | null;
  suggested_instance: string | null;
  suggested_monthly_cost: number | null;
  monthly_savings: number | null;
  savings_percent: number | null;
  pricing_calc_url: string | null;
  efficiency_score: number | null;
  efficiency_label: string;
  recommendation: string;
  analyzed_at: string;
}

// ─── Step A: Classify host from metadata ─────────────────────────────────────
// Implements the 14-rule classification decision tree from the system prompt.
// Returns { cloud_provider, host_subtype, instance_type, instance_region }.
function classifyHost(
  aliases: string[],
  tags: string[],
  apps: string[],
  metaInstanceType: string | null,
  metaCloudProvider: string | null,
  metrics: HostMetrics
): {
  cloud_provider: string;
  host_subtype: string | null;
  instance_type: string | null;
  instance_region: string | null;
} {
  let cloud_provider: string | null = null;
  let host_subtype: string | null = null;
  let instance_region: string | null = null;

  // Rule 1: EC2 instance ID alias
  for (const alias of aliases) {
    if (/^i-[0-9a-f]{8,17}$/i.test(alias.trim())) {
      cloud_provider = "aws";
      host_subtype = "ec2";
      break;
    }
  }

  // Rule 2: apps/sources
  if (!cloud_provider) {
    const appsLower = apps.map(a => a.toLowerCase());
    if (appsLower.includes("ecs")) { cloud_provider = "aws"; host_subtype = "ecs"; }
    else if (appsLower.includes("fargate")) { cloud_provider = "aws"; host_subtype = "fargate"; }
    else if (appsLower.some(a => a === "vsphere" || a === "vmware")) { cloud_provider = "on-prem"; host_subtype = "vmware"; }
    else if (appsLower.some(a => a === "kubernetes" || a === "k8s")) { host_subtype = "kubernetes_node"; }
  }

  // Rules 3–6: tags
  if (!cloud_provider) {
    for (const tag of tags) {
      const [k, ...vParts] = tag.split(":");
      const v = vParts.join(":").trim();
      const key = k.trim().toLowerCase();

      // Rule 3: instance-type tag
      if (key === "instance-type" && v) {
        if (/^(t[23456]|m[456789]|c[456789]|r[456789]|x[12]|z1d|a1|inf|trn|hpc|p[234]|g[34]|i[234]|d[23]|h1|f1)/i.test(v)) {
          cloud_provider = "aws"; break;
        }
        if (/^Standard_/i.test(v)) { cloud_provider = "azure"; break; }
        if (/^(n[12]d?|e2|c[2]d?|m[12]|a2|t2d)-/i.test(v)) { cloud_provider = "gcp"; break; }
      }

      // Rule 4: region / availability-zone tags
      if (key === "region" && v) {
        if (/^(us|eu|ap|sa|ca|me|af)-[a-z]+-\d+/.test(v)) { cloud_provider = "aws"; instance_region = v; break; }
        if (/^(eastus|westus|northeurope|westeurope|uksouth|ukwest|australiaeast|australiasoutheast|centralus|southcentralus|northcentralus|westcentralus|canadacentral|canadaeast|brazilsouth|japaneast|japanwest|koreacentral|koreasouth|southeastasia|eastasia|centralindia|southindia|westindia|francecentral|francesouth|germanywestcentral|norwayeast|switzerlandnorth|uaenorth|southafricanorth)/i.test(v)) {
          cloud_provider = "azure"; instance_region = v; break;
        }
        if (/^(us-central1|us-east1|us-east4|us-west1|us-west2|us-west3|us-west4|northamerica-northeast1|southamerica-east1|europe-west[1-9]|europe-north1|europe-central2|asia-east[12]|asia-northeast[123]|asia-south[12]|asia-southeast[12]|australia-southeast[12]|me-west1|africa-south1)/.test(v)) {
          cloud_provider = "gcp"; instance_region = v; break;
        }
      }
      if (key === "availability-zone" && v) {
        const azMatch = v.match(/^((us|eu|ap|sa|ca|me|af)-[a-z]+-\d+)[a-z]$/);
        if (azMatch) { cloud_provider = "aws"; instance_region = azMatch[1]; break; }
      }

      // Rule 5: explicit cloud tags
      if (key === "cloud_provider" && v) {
        const norm: Record<string, string> = { aws: "aws", azure: "azure", gcp: "gcp", "on-prem": "on-prem", "on-premise": "on-prem", "on-premises": "on-prem" };
        if (norm[v.toLowerCase()]) { cloud_provider = norm[v.toLowerCase()]; break; }
      }
      if (key === "subscriptionid") { cloud_provider = "azure"; break; }
      if (key === "project_id") { cloud_provider = "gcp"; break; }

      // Rule 6: aws_account tag
      if (key === "aws_account") { cloud_provider = "aws"; break; }
    }
  }

  // Rules 7–8: T2 metric probes (only if still unknown)
  if (!cloud_provider) {
    if ((metrics["aws.ec2.cpuutilization"] ?? null) !== null) {
      cloud_provider = "aws"; host_subtype = host_subtype ?? "ec2";
    } else if ((metrics["azure.vm.percentage_cpu"] ?? null) !== null) {
      cloud_provider = "azure";
    } else if ((metrics["gcp.gce.instance.cpu.utilization"] ?? null) !== null) {
      cloud_provider = "gcp";
    } else if ((metrics["vsphere.cpu.usage.avg"] ?? null) !== null) {
      cloud_provider = "on-prem"; host_subtype = "vmware";
    } else {
      cloud_provider = "unknown";
    }
  }

  // Normalize cloud_provider to canonical values
  const providerNormMap: Record<string, string> = {
    "on-premise": "on-prem", "on-premises": "on-prem", "onprem": "on-prem",
    "on_prem": "on-prem", "bare-metal": "on-prem", "baremetal": "on-prem", "vmware": "on-prem",
    "on-prem/unknown": "unknown", "unknown/on-prem": "unknown",
  };
  const canonical = new Set(["aws", "azure", "gcp", "on-prem", "unknown"]);
  cloud_provider = providerNormMap[cloud_provider.toLowerCase()] ?? cloud_provider;
  if (!canonical.has(cloud_provider)) cloud_provider = "unknown";

  // instance_type: prefer metadata field, then instance-type tag
  let instance_type = metaInstanceType ?? null;
  if (!instance_type) {
    for (const tag of tags) {
      if (tag.startsWith("instance-type:")) {
        const val = tag.split(":").slice(1).join(":").trim();
        if (val) { instance_type = val; break; }
      }
    }
  }

  // instance_region from tags (if not already set)
  if (!instance_region) {
    for (const tag of tags) {
      const [k, ...vParts] = tag.split(":");
      const v = vParts.join(":").trim();
      if (k.trim().toLowerCase() === "region" && v) { instance_region = v; break; }
      if (k.trim().toLowerCase() === "availability-zone" && v) {
        const m = v.match(/^((us|eu|ap|sa|ca|me|af)-[a-z]+-\d+)[a-z]$/);
        if (m) { instance_region = m[1]; break; }
      }
    }
  }

  return { cloud_provider, host_subtype, instance_type, instance_region };
}

// ─── Step B: Extract canonical metrics from the raw cache map ─────────────────
function extractMetrics(
  m: HostMetrics,
  instance_ram_gb: number | null
): {
  cpu_avg_30d: number | null;
  cpu_p95_30d: number | null;
  ram_avg_30d: number | null;
  disk_avg_30d: number | null;
  network_in_avg_30d: number | null;
  network_out_avg_30d: number | null;
} {
  // T1 preferred, T2 fallback
  const idle    = m["system.cpu.idle"]       ?? null;
  const idleP95 = m["system.cpu.idle.p95"]   ?? null;
  const memPct  = m["system.mem.pct_usable"] ?? null;
  const diskFrac = m["system.disk.in_use"]   ?? null;

  const cpu_avg_30d: number | null =
    idle !== null ? Math.min(100, Math.max(0, 100 - idle)) :
    (m["aws.ec2.cpuutilization"] ?? null) !== null ? m["aws.ec2.cpuutilization"]! :
    (m["azure.vm.percentage_cpu"] ?? null) !== null ? m["azure.vm.percentage_cpu"]! :
    (m["gcp.gce.instance.cpu.utilization"] ?? null) !== null
      ? Math.min(100, (m["gcp.gce.instance.cpu.utilization"]! > 1 ? m["gcp.gce.instance.cpu.utilization"]! : m["gcp.gce.instance.cpu.utilization"]! * 100))
    : (m["vsphere.cpu.usage.avg"] ?? null) !== null ? m["vsphere.cpu.usage.avg"]!
    : null;

  const cpu_p95_30d: number | null =
    idleP95 !== null ? Math.min(100, Math.max(0, 100 - idleP95)) :
    (m["aws.ec2.cpuutilization.p95"] ?? null) !== null ? m["aws.ec2.cpuutilization.p95"]!
    : null;

  // RAM: T1 preferred, then T2 (Azure/GCP need instance_ram_gb for conversion)
  let ram_avg_30d: number | null = null;
  if (memPct !== null) {
    // system.mem.pct_usable is a FRACTION (0–1): 0.2 = 20% free = 80% used.
    // Correct formula: (1 - fraction) * 100 = % used.
    ram_avg_30d = Math.min(100, Math.max(0, (1 - memPct) * 100));
  } else if ((m["vsphere.mem.usage.average"] ?? null) !== null) {
    ram_avg_30d = m["vsphere.mem.usage.average"]!;
  } else if ((m["azure.vm.available_memory_bytes"] ?? null) !== null && instance_ram_gb) {
    const totalBytes = instance_ram_gb * 1073741824;
    ram_avg_30d = Math.min(100, Math.max(0, 100 - (m["azure.vm.available_memory_bytes"]! / totalBytes) * 100));
  } else if ((m["gcp.gce.instance.memory.balloon.ram_used"] ?? null) !== null && instance_ram_gb) {
    const totalBytes = instance_ram_gb * 1073741824;
    ram_avg_30d = Math.min(100, Math.max(0, (m["gcp.gce.instance.memory.balloon.ram_used"]! / totalBytes) * 100));
  }

  const disk_avg_30d: number | null =
    diskFrac !== null ? Math.min(100, Math.max(0, diskFrac * 100)) : null;

  const network_in_avg_30d: number | null =
    (m["system.net.bytes_rcvd"] ?? null) !== null ? m["system.net.bytes_rcvd"]! :
    (m["aws.ec2.network_in"] ?? null) !== null ? m["aws.ec2.network_in"]! :
    (m["azure.vm.network_in_total"] ?? null) !== null ? m["azure.vm.network_in_total"]! :
    (m["gcp.gce.instance.network.received_bytes_count"] ?? null) !== null ? m["gcp.gce.instance.network.received_bytes_count"]! :
    (m["vsphere.net.received.avg"] ?? null) !== null ? m["vsphere.net.received.avg"]! * 1024
    : null;

  const network_out_avg_30d: number | null =
    (m["system.net.bytes_sent"] ?? null) !== null ? m["system.net.bytes_sent"]! :
    (m["aws.ec2.network_out"] ?? null) !== null ? m["aws.ec2.network_out"]! :
    (m["azure.vm.network_out_total"] ?? null) !== null ? m["azure.vm.network_out_total"]! :
    (m["gcp.gce.instance.network.sent_bytes_count"] ?? null) !== null ? m["gcp.gce.instance.network.sent_bytes_count"]! :
    (m["vsphere.net.transmitted.avg"] ?? null) !== null ? m["vsphere.net.transmitted.avg"]! * 1024
    : null;

  return { cpu_avg_30d, cpu_p95_30d, ram_avg_30d, disk_avg_30d, network_in_avg_30d, network_out_avg_30d };
}

// ─── Compute efficiency label from metrics ────────────────────────────────────
// Under-provisioned: ANY dimension is saturated.
// Over-provisioned: ALL available dimensions are low (need at least CPU or RAM).
// This prevents a RAM-bound host (high RAM, low CPU) from being called over-provisioned.
function computeEfficiencyLabel(
  cpu_p95: number | null,
  cpu_avg: number | null,
  ram_avg: number | null,
  disk_avg: number | null
): string {
  const cpu_for_label = cpu_p95 ?? cpu_avg;
  if (cpu_for_label === null && ram_avg === null && disk_avg === null) return "unknown";

  // Under-provisioned: any dimension is saturated
  if ((cpu_for_label ?? 0) > 80) return "under-provisioned";
  if ((ram_avg ?? 0) > 85) return "under-provisioned";
  if ((disk_avg ?? 0) > 85) return "under-provisioned";

  // Over-provisioned: all available dimensions are low.
  // Only include a dimension in the check if we actually have data for it.
  // Require at least CPU or RAM data before calling something over-provisioned.
  if (cpu_for_label === null && ram_avg === null) return "right-sized";
  const cpuLow  = cpu_for_label !== null ? cpu_for_label < 20 : true; // absent = not a constraint
  const ramLow  = ram_avg       !== null ? ram_avg       < 40 : true; // absent = not a constraint
  const diskLow = disk_avg      !== null ? disk_avg      < 40 : true; // absent = not a constraint
  if (cpuLow && ramLow && diskLow) return "over-provisioned";

  return "right-sized";
}

// ─── Build recommendation sentence ───────────────────────────────────────────
function buildRecommendation(
  efficiency_label: string,
  cpu_avg: number | null,
  cpu_p95: number | null,
  ram_avg: number | null,
  disk_avg: number | null,
  network_in: number | null,
  network_out: number | null,
  instance_type: string | null,
  host_subtype: string | null,
  current_monthly_cost: number | null,
  suggested_instance: string | null,
  suggested_monthly_cost: number | null,
  monthly_savings: number | null,
  ram_unavailable: boolean
): string {
  // ECS/Fargate: special case
  if (host_subtype === "ecs" || host_subtype === "fargate") {
    return "ECS/Fargate task — container-level metrics are not scoped to host in Datadog. Use AWS Container Insights or the Datadog container integration to analyze resource utilization at the task/container level.";
  }

  const parts: string[] = [];
  if (cpu_avg !== null) parts.push(`CPU avg ${cpu_avg.toFixed(1)}%`);
  if (cpu_p95 !== null) parts.push(`CPU p95 ${cpu_p95.toFixed(1)}%`);
  if (ram_avg !== null) parts.push(`RAM avg ${ram_avg.toFixed(1)}%`);
  if (disk_avg !== null) parts.push(`disk ${disk_avg.toFixed(1)}%`);
  if (network_in !== null) parts.push(`net-in ${(network_in / 1_000_000).toFixed(1)} MB/s`);
  if (network_out !== null) parts.push(`net-out ${(network_out / 1_000_000).toFixed(1)} MB/s`);

  if (parts.length === 0) {
    if (instance_type && current_monthly_cost) {
      return `No utilization metrics available for this ${instance_type} (~$${current_monthly_cost.toFixed(0)}/month) — install the Datadog agent or enable the cloud integration to enable right-sizing analysis.`;
    }
    return "No metric data available for this host over the 30-day window. Host may be stopped, terminated, or neither the Datadog agent nor a cloud integration is configured.";
  }

  const metricSummary = parts.join(", ");
  const instanceNote = instance_type ? ` on ${instance_type}` : "";

  if (ram_unavailable) {
    return `${metricSummary} over 30 days${instanceNote}; RAM utilization unavailable — likely ${efficiency_label} but verify RAM usage before acting on this recommendation.`;
  }

  if (efficiency_label === "over-provisioned") {
    if (suggested_instance && monthly_savings && monthly_savings > 0) {
      return `${metricSummary} over 30 days${instanceNote} — over-provisioned; downsize to ${suggested_instance} to save ~$${monthly_savings.toFixed(0)}/month.`;
    }
    return `${metricSummary} over 30 days${instanceNote} — over-provisioned; consider downsizing to reduce costs.`;
  }

  if (efficiency_label === "under-provisioned") {
    // Identify which dimensions are saturated
    const cpuBound  = (cpu_p95 !== null && cpu_p95 > 80) || (cpu_avg !== null && cpu_avg > 80);
    const ramBound  = ram_avg  !== null && ram_avg  > 85;
    const diskBound = disk_avg !== null && disk_avg > 85;

    const concerns: string[] = [];
    if (cpuBound)  concerns.push(`CPU p95 at ${(cpu_p95 ?? cpu_avg)!.toFixed(1)}%`);
    if (ramBound)  concerns.push(`RAM at ${ram_avg!.toFixed(1)}%`);
    if (diskBound) concerns.push(`disk at ${disk_avg!.toFixed(1)}%`);

    // Dimension-specific action advice
    const actions: string[] = [];

    if (ramBound && !cpuBound) {
      // RAM-bound only: suggest memory-optimized family, keep same CPU count
      const suggestNote = suggested_instance
        ? `upgrade to a memory-optimized instance (e.g. ${suggested_instance})`
        : "upgrade to a memory-optimized instance family (r5/r6i/r7i) to add RAM without increasing CPU count";
      actions.push(suggestNote);
    } else if (cpuBound && !ramBound) {
      // CPU-bound only: suggest compute-optimized
      const suggestNote = suggested_instance
        ? `upgrade to a compute-optimized instance (e.g. ${suggested_instance})`
        : "upgrade to a compute-optimized instance family (c5/c6i/c7i) or larger general-purpose (m6i/m7i)";
      actions.push(suggestNote);
    } else if (cpuBound && ramBound) {
      // Both saturated: general scale-up
      const suggestNote = suggested_instance
        ? `scale up to ${suggested_instance}`
        : "scale up to a larger general-purpose instance (m6i/m7i) or memory-optimized (r6i/r7i)";
      actions.push(suggestNote);
    }

    if (diskBound) {
      // Disk saturation is a storage problem, not an instance-size problem
      actions.push("expand EBS volume or clean up data (disk saturation is a storage issue, not instance size)");
    }

    const actionText = actions.length > 0
      ? actions.join("; ")
      : "consider scaling up to avoid performance issues";

    return `${metricSummary} over 30 days${instanceNote} — under-provisioned (${concerns.join(", ")}); ${actionText}.`;
  }

  if (efficiency_label === "right-sized") {
    return `${metricSummary} over 30 days${instanceNote} — right-sized for current workload.`;
  }

  return `${metricSummary} over 30 days${instanceNote} — insufficient metric data for a definitive recommendation.`;
}

// ─── Core per-host processing logic ──────────────────────────────────────────
// Called by process_batch_tool for each host in parallel.
async function processOneHost(
  host_name: string,
  rawMetrics: HostMetrics | null,
  meta: CachedMeta | null,
  _tenantId: string,
  _runId: string
): Promise<HostResult> {
  const metrics: HostMetrics = rawMetrics ?? {};
  const aliases = meta?.aliases ?? [];
  const tags    = meta?.tags    ?? [];
  const apps    = meta?.apps    ?? [];

  // ── Step A: Classify ──────────────────────────────────────────────────────
  const { cloud_provider, host_subtype, instance_type, instance_region } = classifyHost(
    aliases, tags, apps,
    meta?.instance_type ?? null,
    meta?.cloud_provider ?? null,
    metrics
  );

  // ── Step C: Instance specs (needed for Azure/GCP RAM conversion) ──────────
  let instance_cpu_count: number | null = null;
  let instance_ram_gb: number | null = null;
  let catalog_data_available = false;

  if (instance_type) {
    const isAzure = /^Standard_/i.test(instance_type);
    const isGcp   = /^(n[12]d?|e2|c[2]d?|m[12]|a2|t2d)-/i.test(instance_type);
    if (!isAzure && !isGcp) {
      // AWS instance — look up specs
      const region = instance_region ?? "us-east-1";
      const specs = await getInstanceSpecs(instance_type, region);
      if (specs) {
        instance_cpu_count = specs.vcpu;
        instance_ram_gb    = specs.ram_gb;
        catalog_data_available = true;
      }
    }
  }

  // ── DDSQL hardware fallback ────────────────────────────────────────────────
  // If the pricing catalog has no entry (Azure/GCP hosts, or AWS hosts with no
  // instance-type tag), use memory_mib and cpu_logical_processors from the DDSQL
  // SELECT query run at list-hosts time. This enables RAM % calculation for
  // azure.vm.available_memory_bytes and gcp.gce.instance.memory.balloon.ram_used
  // without any additional MCP calls.
  if (instance_ram_gb === null && meta?.memory_mib) {
    instance_ram_gb = meta.memory_mib / 1024; // MiB → GiB
  }
  if (instance_cpu_count === null && meta?.cpu_logical_processors) {
    instance_cpu_count = meta.cpu_logical_processors;
  }

  // ── Step B: Extract metrics (needs instance_ram_gb for Azure/GCP RAM) ─────
  const {
    cpu_avg_30d, cpu_p95_30d, ram_avg_30d, disk_avg_30d,
    network_in_avg_30d, network_out_avg_30d,
  } = extractMetrics(metrics, instance_ram_gb);

  // ── Step D: Right-sizing ──────────────────────────────────────────────────
  let current_monthly_cost:   number | null = null;
  let suggested_instance:     string | null = null;
  let suggested_monthly_cost: number | null = null;
  let monthly_savings:        number | null = null;
  let savings_percent:        number | null = null;
  let pricing_calc_url:       string | null = null;
  let ram_unavailable = false;

  const hasMetrics = cpu_avg_30d !== null || ram_avg_30d !== null;
  const hasCpu     = cpu_avg_30d !== null || cpu_p95_30d !== null;

  if (instance_type && catalog_data_available && hasCpu) {
    // AWS instance with CPU data — PATH 1 or PATH 2
    const region = instance_region ?? "us-east-1";
    const catalogInstances = await getAllInstancesSortedByPrice(CANDIDATE_FAMILIES_V1, {}, region);
    const prices = await getPricesForInstances(catalogInstances, region);
    current_monthly_cost = prices[instance_type] ?? null;

    if (ram_avg_30d !== null) {
      // PATH 1: full rightsizing
      const cpuP95 = cpu_p95_30d ?? cpu_avg_30d!;
      const result = await suggestRightSizedInstance(cpuP95, ram_avg_30d, instance_type, prices, region);
      suggested_instance     = result.suggested;
      suggested_monthly_cost = prices[result.suggested] ?? null;
      if (!result.already_right_sized && current_monthly_cost && suggested_monthly_cost) {
        monthly_savings = Math.max(0, Math.round((current_monthly_cost - suggested_monthly_cost) * 100) / 100);
        savings_percent = current_monthly_cost > 0
          ? Math.max(0, Math.round((monthly_savings / current_monthly_cost) * 1000) / 10)
          : null;
      }
      if (!result.already_right_sized) {
        const regionSlug = region.toLowerCase();
        pricing_calc_url = `https://aws.amazon.com/ec2/pricing/on-demand/?nc2=type_a#${regionSlug}`;
      }
    } else {
      // PATH 2: CPU only, no RAM
      ram_unavailable = true;
    }
  } else if (instance_type && catalog_data_available && !hasMetrics) {
    // PATH 3: instance known but no metrics — just get the price
    const region = instance_region ?? "us-east-1";
    current_monthly_cost = await getInstanceOnDemandPrice(instance_type, region);
  }
  // PATH 4 (no instance_type + metrics) and PATH 5 (no metrics) need no pricing calls

  // ── Efficiency label + score ──────────────────────────────────────────────
  const efficiency_label = computeEfficiencyLabel(cpu_p95_30d, cpu_avg_30d, ram_avg_30d, disk_avg_30d);

  const cpu_for_score = cpu_avg_30d ?? cpu_p95_30d;
  let efficiency_score: number | null = null;
  if (cpu_for_score !== null && ram_avg_30d !== null) {
    efficiency_score = Math.min(100, Math.max(0, Math.round((cpu_for_score + ram_avg_30d) / 2)));
  } else if (cpu_for_score !== null) {
    efficiency_score = Math.min(100, Math.max(0, Math.round(cpu_for_score)));
  }

  // ── Recommendation ────────────────────────────────────────────────────────
  const recommendation = buildRecommendation(
    efficiency_label, cpu_avg_30d, cpu_p95_30d, ram_avg_30d, disk_avg_30d,
    network_in_avg_30d, network_out_avg_30d,
    instance_type, host_subtype,
    current_monthly_cost, suggested_instance, suggested_monthly_cost, monthly_savings,
    ram_unavailable
  );

  return {
    host_name,
    cloud_provider,
    host_subtype,
    cpu_avg_30d,
    cpu_p95_30d,
    ram_avg_30d,
    network_in_avg_30d,
    network_out_avg_30d,
    disk_avg_30d,
    instance_type,
    instance_region,
    instance_cpu_count,
    instance_ram_gb,
    has_instance_tag: instance_type !== null,
    catalog_data_available,
    current_monthly_cost,
    suggested_instance,
    suggested_monthly_cost,
    monthly_savings,
    savings_percent,
    pricing_calc_url,
    efficiency_score,
    efficiency_label,
    recommendation,
    analyzed_at: new Date().toISOString(),
  };
}

export function createHostBatchServer(
  tenantId: string,
  runId: string,
  batchIndex: number,
  totalBatches: number,
  _batchSize: number
) {
  return createSdkMcpServer({
    name: "host-batch-tools",
    version: "1.0.0",
    tools: [
      // ── PRIMARY TOOL: process entire batch end-to-end ─────────────────────
      tool(
        "process_batch_tool",
        "Process ALL hosts in this batch end-to-end: fetch metrics+metadata from cache, classify each host, compute right-sizing, write all results to DynamoDB, update progress. Call this ONCE with the full host list. Returns a summary of what was written.",
        {
          host_names: z.array(z.string()).describe("All host names in this batch — pass the complete list"),
        },
        async ({ host_names }) => {
          const label = `batch ${batchIndex + 1}/${totalBatches}`;
          console.log(`[process_batch:${tenantId}:${label}] Processing ${host_names.length} hosts`);

          // Fetch all metrics + metadata in parallel
          const hostData = await Promise.all(host_names.map(async (host_name) => {
            const [metrics, meta] = await Promise.all([
              getHostMetricsFromCache(tenantId, runId, host_name),
              getHostMetadataFromCache(tenantId, runId, host_name),
            ]);
            return { host_name, metrics: metrics as HostMetrics | null, meta: meta as CachedMeta | null };
          }));

          // Process all hosts in parallel
          const results = await Promise.all(hostData.map(async ({ host_name, metrics, meta }) => {
            try {
              const result = await processOneHost(host_name, metrics, meta, tenantId, runId);
              await writeHostResult(tenantId, runId, host_name, result as unknown as Record<string, unknown>);
              return { host_name, ok: true, label: result.efficiency_label };
            } catch (err) {
              console.error(`[process_batch:${tenantId}:${label}] Failed ${host_name}:`, err);
              return { host_name, ok: false, label: "unknown" };
            }
          }));

          // Update progress
          const done = results.filter(r => r.ok).length;
          await updateRunProgress(runId, tenantId, done,
            `${label} complete (${done}/${host_names.length} hosts) for ${tenantId}`);

          const byLabel = results.reduce((acc, r) => {
            acc[r.label] = (acc[r.label] ?? 0) + 1;
            return acc;
          }, {} as Record<string, number>);

          const summary = { processed: host_names.length, written: done, failed: host_names.length - done, by_label: byLabel };
          console.log(`[process_batch:${tenantId}:${label}] Done:`, JSON.stringify(summary));
          return { content: [{ type: "text" as const, text: JSON.stringify(summary) }] };
        }
      ),

      // ── FALLBACK: search Datadog directly for a single host (rare cache miss) ──
      tool(
        "search_datadog_hosts_fallback_tool",
        "ONLY call this when the pre-fetched cache has no data for a host AND you need its metadata. Fetches classification metadata for a single host directly from Datadog.",
        { host_name: z.string() },
        async ({ host_name }) => {
          const tenants = getTenants();
          const tenant = tenants.find(t => t.tenant_id === tenantId);
          if (!tenant) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ found: false, host_name, error: "Tenant not found" }) }] };
          }
          const site = tenant.dd_site ?? "datadoghq.com";
          const mcpUrl = (DD_MCP_BASE[site] ?? DD_MCP_BASE["datadoghq.com"]) + "?toolsets=core";

          try {
            const initResp = await fetch(mcpUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "DD-API-KEY": tenant.dd_api_key,
                "DD-APPLICATION-KEY": tenant.dd_app_key,
              },
              body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize",
                params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "finops-agent", version: "1.0" } } }),
            });
            if (!initResp.ok) throw new Error(`MCP init failed: ${initResp.status}`);
            const sessionId = initResp.headers.get("mcp-session-id") ?? "";

            const callResp = await fetch(mcpUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "DD-API-KEY": tenant.dd_api_key,
                "DD-APPLICATION-KEY": tenant.dd_app_key,
                "mcp-session-id": sessionId,
              },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
                params: { name: "search_datadog_hosts",
                  arguments: { query: `filter:"host:${host_name}"`, start_at: 0, max_tokens: 10000 } } }),
            });
            if (!callResp.ok) throw new Error(`MCP call failed: ${callResp.status}`);
            const data = await callResp.json() as { result?: { content?: Array<{ text: string }> } };
            const text = data.result?.content?.[0]?.text ?? "";
            const row = parseTsvRow(text, host_name);
            if (!row) {
              return { content: [{ type: "text" as const, text: JSON.stringify({ found: false, host_name }) }] };
            }
            let tags: string[] = [];
            const rawTags = row["tags"] ?? "";
            if (rawTags.trim().startsWith("[")) {
              try { tags = JSON.parse(rawTags); } catch { tags = []; }
            } else if (rawTags.trim()) {
              tags = rawTags.split(/\s+/).map(s => s.trim()).filter(Boolean);
            }
            const sourcesRaw = row["sources"] ?? "";
            const apps = sourcesRaw ? sourcesRaw.split(",").map(s => s.trim()).filter(Boolean) : [];
            return { content: [{ type: "text" as const, text: JSON.stringify({
              found: true, host_name,
              hostname_aliases: row["hostname_aliases"] ? row["hostname_aliases"].split(",").map(s => s.trim()).filter(Boolean) : [],
              tags, apps,
              instance_type: row["instance_type"] || null,
              cloud_provider: row["cloud_provider"] || null,
            }) }] };
          } catch (err) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ found: false, host_name, error: String(err) }) }] };
          }
        }
      ),
    ],
  });
}
