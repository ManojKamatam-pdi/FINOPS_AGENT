/**
 * EC2 instance specs + right-sizing logic.
 * Specs (vCPU, RAM) are derived from the same public AWS Bulk Pricing JSON
 * that aws-pricing.ts uses — no static catalog file, no AWS credentials needed.
 */
import axios from "axios";

export const CANDIDATE_FAMILIES_V1 = [
  "t3", "t3a", "t4g",
  "m5", "m5a", "m6i", "m6a", "m7i", "m7a",
  "c5", "c5a", "c6i", "c6a", "c7i",
  "r5", "r5a", "r6i", "r6a",
];

interface InstanceSpecs {
  vcpu: number;
  ram_gb: number;
  family: string;
}

const PRICING_BASE = "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current";

// Cache: region -> { instanceType -> InstanceSpecs }
const specsCache = new Map<string, Record<string, InstanceSpecs>>();

// In-flight deduplication: region -> Promise<specs>
// Prevents 30 concurrent batch agents from all downloading the same 350MB JSON simultaneously.
const inFlight = new Map<string, Promise<Record<string, InstanceSpecs>>>();

async function fetchRegionSpecs(region: string): Promise<Record<string, InstanceSpecs>> {
  const url = `${PRICING_BASE}/${region}/index.json`;

  const resp = await axios.get<{
    products: Record<string, {
      attributes: Record<string, string>;
    }>;
  }>(url, { timeout: 300000 }); // 5 min — AWS pricing JSON is 300-400MB

  const specs: Record<string, InstanceSpecs> = {};
  for (const product of Object.values(resp.data.products)) {
    const attrs = product.attributes;
    if (
      attrs.operatingSystem === "Linux" &&
      attrs.tenancy === "Shared" &&
      attrs.capacitystatus === "Used" &&
      attrs.preInstalledSw === "NA" &&
      attrs.instanceType &&
      attrs.vcpu &&
      attrs.memory
    ) {
      const itype = attrs.instanceType;
      if (itype in specs) continue; // already recorded
      const vcpu = parseInt(attrs.vcpu, 10);
      // memory is like "8 GiB"
      const ramMatch = attrs.memory.match(/([\d.]+)\s*GiB/i);
      const ram_gb = ramMatch ? parseFloat(ramMatch[1]) : 0;
      if (!vcpu || !ram_gb) continue;
      const family = itype.split(".")[0];
      specs[itype] = { vcpu, ram_gb, family };
    }
  }
  return specs;
}

async function getRegionSpecs(region: string): Promise<Record<string, InstanceSpecs>> {
  // Return cached result immediately
  if (specsCache.has(region)) return specsCache.get(region)!;

  // If a fetch is already in-flight for this region, wait for it instead of
  // launching a second concurrent 350MB download (which causes stream aborts).
  if (inFlight.has(region)) return inFlight.get(region)!;

  const promise = fetchRegionSpecs(region)
    .then(specs => {
      specsCache.set(region, specs);
      inFlight.delete(region);
      return specs;
    })
    .catch(e => {
      console.error(`[aws-instances] Failed to fetch specs for ${region}:`, e);
      specsCache.set(region, {});
      inFlight.delete(region);
      return {} as Record<string, InstanceSpecs>;
    });

  inFlight.set(region, promise);
  return promise;
}

export async function getInstanceSpecs(
  instanceType: string,
  region = "us-east-1"
): Promise<InstanceSpecs | null> {
  const specs = await getRegionSpecs(region);
  return specs[instanceType] ?? null;
}

export async function getAllInstancesSortedByPrice(
  families: string[] | null,
  prices: Record<string, number>,
  region = "us-east-1"
): Promise<string[]> {
  const specs = await getRegionSpecs(region);
  const candidates = Object.keys(specs).filter(
    (itype) => families === null || families.includes(specs[itype].family)
  );
  return candidates.sort((a, b) => {
    const pa = prices[a] ?? Infinity;
    const pb = prices[b] ?? Infinity;
    return pa - pb;
  });
}

export async function suggestRightSizedInstance(
  cpuP95Pct: number,
  ramAvgPct: number,
  currentInstance: string,
  prices: Record<string, number>,
  region = "us-east-1"
): Promise<{ suggested: string; already_right_sized: boolean }> {
  const specs = await getRegionSpecs(region);
  const currentSpecs = specs[currentInstance];
  if (!currentSpecs) return { suggested: currentInstance, already_right_sized: true };

  const requiredVcpu = (cpuP95Pct / 100) * currentSpecs.vcpu * 1.3;
  const requiredRamGb = (ramAvgPct / 100) * currentSpecs.ram_gb * 1.3;

  const candidates = await getAllInstancesSortedByPrice(CANDIDATE_FAMILIES_V1, prices, region);

  for (const candidate of candidates) {
    const s = specs[candidate];
    if (!s) continue;
    if (s.vcpu >= requiredVcpu && s.ram_gb >= requiredRamGb) {
      if (candidate === currentInstance) return { suggested: currentInstance, already_right_sized: true };
      return { suggested: candidate, already_right_sized: false };
    }
  }
  return { suggested: currentInstance, already_right_sized: true };
}

export function computeEfficiencyScore(cpuAvg: number | null, ramAvg: number | null): number {
  if (cpuAvg === null || ramAvg === null) return 0;
  return Math.min(100, Math.max(0, Math.round(cpuAvg * 0.5 + ramAvg * 0.5)));
}
