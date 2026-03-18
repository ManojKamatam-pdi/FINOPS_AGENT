/**
 * EC2 instance catalog + right-sizing logic.
 * Reads from config/ec2_instances.json (bundled, no network call).
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const CANDIDATE_FAMILIES_V1 = ["t3", "t3a", "m5", "m5a", "c5", "r5"];

interface InstanceSpecs {
  vcpu: number;
  ram_gb: number;
  family: string;
}

let _catalog: Record<string, InstanceSpecs> | null = null;

function loadCatalog(): Record<string, InstanceSpecs> {
  if (_catalog) return _catalog;
  const catalogPath = path.join(__dirname, "../../config/ec2_instances.json");
  _catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8")) as Record<string, InstanceSpecs>;
  return _catalog;
}

export function getInstanceSpecs(instanceType: string): InstanceSpecs | null {
  return loadCatalog()[instanceType] ?? null;
}

export function getAllInstancesSortedByPrice(
  families: string[] | null,
  prices: Record<string, number>
): string[] {
  const catalog = loadCatalog();
  const candidates = Object.keys(catalog).filter(
    (itype) => families === null || families.includes(catalog[itype].family)
  );
  return candidates.sort((a, b) => {
    const pa = prices[a] ?? Infinity;
    const pb = prices[b] ?? Infinity;
    return pa - pb;
  });
}

export function suggestRightSizedInstance(
  cpuP95Pct: number,
  ramAvgPct: number,
  currentInstance: string,
  prices: Record<string, number>
): { suggested: string; already_right_sized: boolean } {
  const currentSpecs = getInstanceSpecs(currentInstance);
  if (!currentSpecs) return { suggested: currentInstance, already_right_sized: true };

  const requiredVcpu = (cpuP95Pct / 100) * currentSpecs.vcpu * 1.3;
  const requiredRamGb = (ramAvgPct / 100) * currentSpecs.ram_gb * 1.3;

  const candidates = getAllInstancesSortedByPrice(CANDIDATE_FAMILIES_V1, prices);

  for (const candidate of candidates) {
    const specs = getInstanceSpecs(candidate);
    if (!specs) continue;
    if (specs.vcpu >= requiredVcpu && specs.ram_gb >= requiredRamGb) {
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

export function efficiencyLabel(
  score: number,
  cpuAvg: number | null,
  ramAvg: number | null
): string {
  if (cpuAvg === null || ramAvg === null) return "unknown";
  if (score < 30) return "over-provisioned";
  if (score < 70) return "right-sized";
  return "under-provisioned";
}
