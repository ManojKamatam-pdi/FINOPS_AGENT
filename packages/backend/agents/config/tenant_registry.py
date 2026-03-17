"""
Tenant registry — maps tenant_id to Datadog org config.
All tenants share the same DATADOG_MCP_URL.
The MCP routes to the correct org via tenant_id parameter.
"""
from typing import TypedDict


class TenantConfig(TypedDict):
    tenant_id: str       # passed to query-datadog MCP tool
    display_name: str    # human-readable label for UI
    default_region: str  # used for AWS Pricing API calls


TENANTS: list[TenantConfig] = [
    {
        "tenant_id": "PDI-Enterprise",
        "display_name": "PDI Enterprise",
        "default_region": "us-east-1",
    },
    {
        "tenant_id": "PDI-Orbis",
        "display_name": "PDI Orbis",
        "default_region": "us-east-1",
    },
]


def get_tenants() -> list[TenantConfig]:
    return TENANTS


def get_tenant(tenant_id: str) -> TenantConfig | None:
    return next((t for t in TENANTS if t["tenant_id"] == tenant_id), None)
