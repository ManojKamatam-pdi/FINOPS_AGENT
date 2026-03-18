export interface TenantConfig {
  tenant_id: string;
  display_name: string;
  default_region: string;
}

export const TENANTS: TenantConfig[] = [
  { tenant_id: "PDI-Enterprise", display_name: "PDI Enterprise", default_region: "us-east-1" },
  { tenant_id: "PDI-Orbis",      display_name: "PDI Orbis",      default_region: "us-east-1" },
];

export function getTenants(): TenantConfig[] {
  return TENANTS;
}
