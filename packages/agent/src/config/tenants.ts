import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface TenantConfig {
  tenant_id: string;
  display_name: string;
  dd_api_key: string;
  dd_app_key: string;
  dd_site: string;
  default_region: string;
  enabled: boolean;
}

function loadRegistry(): TenantConfig[] {
  const registryPath = join(__dirname, "../../config/dd-org-registry.json");
  const raw = readFileSync(registryPath, "utf-8");
  const entries = JSON.parse(raw) as TenantConfig[];
  return entries.filter((e) => e.enabled);
}

let _tenants: TenantConfig[] | null = null;

export function getTenants(): TenantConfig[] {
  if (!_tenants) _tenants = loadRegistry();
  return _tenants;
}
