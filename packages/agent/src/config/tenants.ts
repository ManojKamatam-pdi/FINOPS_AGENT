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

/** Converts a tenant_id like "PDI-Enterprise" → "PDI_ENTERPRISE" for env var lookup */
function toEnvKey(tenantId: string): string {
  return tenantId.toUpperCase().replace(/-/g, "_");
}

function resolveSecrets(entry: TenantConfig): TenantConfig {
  const key = toEnvKey(entry.tenant_id);
  const dd_api_key = process.env[`DD_API_KEY_${key}`];
  const dd_app_key = process.env[`DD_APP_KEY_${key}`];

  if (!dd_api_key) throw new Error(`Missing env var: DD_API_KEY_${key} (tenant: ${entry.tenant_id})`);
  if (!dd_app_key) throw new Error(`Missing env var: DD_APP_KEY_${key} (tenant: ${entry.tenant_id})`);

  return { ...entry, dd_api_key, dd_app_key };
}

function loadRegistry(): TenantConfig[] {
  const registryPath = join(__dirname, "../../config/dd-org-registry.json");
  const raw = readFileSync(registryPath, "utf-8");
  const entries = JSON.parse(raw) as TenantConfig[];
  return entries
    .filter((e) => e.enabled)
    .map(resolveSecrets);
}

let _tenants: TenantConfig[] | null = null;

export function getTenants(): TenantConfig[] {
  if (!_tenants) _tenants = loadRegistry();
  return _tenants;
}
