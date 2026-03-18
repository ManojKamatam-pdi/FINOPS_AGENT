"""
EC2 instance catalog + right-sizing logic.
Reads from agents/config/ec2_instances.json (bundled, no network call).
"""
import json
import os
from pathlib import Path

_CATALOG_PATH = Path(__file__).parent.parent / "config" / "ec2_instances.json"
_catalog: dict | None = None

CANDIDATE_FAMILIES_V1 = ["t3", "t3a", "m5", "m5a", "c5", "r5"]


def _load_catalog() -> dict:
    global _catalog
    if _catalog is None:
        with open(_CATALOG_PATH) as f:
            _catalog = json.load(f)
    return _catalog


def get_instance_specs(instance_type: str) -> dict | None:
    """Return {vcpu, ram_gb, family} for an instance type, or None if not in catalog."""
    catalog = _load_catalog()
    return catalog.get(instance_type)


def get_all_instances_sorted_by_price(
    region: str,
    families: list[str] | None = None,
    prices: dict[str, float] | None = None,
) -> list[str]:
    """
    Return instance type names sorted by on-demand price ascending.
    `prices` is a dict of {instance_type: monthly_price} pre-fetched by the caller.
    If prices is None or an instance has no price, it is sorted to the end.
    Optionally filter by families list.
    """
    catalog = _load_catalog()
    candidates = [
        itype for itype, specs in catalog.items()
        if families is None or specs.get("family") in families
    ]
    def sort_key(itype):
        if prices and itype in prices:
            return prices[itype]
        return float("inf")
    return sorted(candidates, key=sort_key)


def suggest_right_sized_instance(
    cpu_p95_pct: float,
    ram_avg_pct: float,
    current_instance: str,
    prices: dict[str, float],
) -> dict:
    """
    Cross-family right-sizing across CANDIDATE_FAMILIES_V1.
    cpu_p95_pct: Datadog system-wide CPU % (0-100, no normalization needed)
    ram_avg_pct: avg RAM used as % of current instance's RAM GB
    current_instance: e.g. "r5.xlarge"
    prices: {instance_type: monthly_usd} for all candidates

    Returns:
      {"suggested": str, "already_right_sized": bool}
    """
    current_specs = get_instance_specs(current_instance)
    if not current_specs:
        return {"suggested": current_instance, "already_right_sized": True}

    required_vcpu = (cpu_p95_pct / 100) * current_specs["vcpu"] * 1.3
    required_ram_gb = (ram_avg_pct / 100) * current_specs["ram_gb"] * 1.3

    candidates = get_all_instances_sorted_by_price(
        region="us-east-1",
        families=CANDIDATE_FAMILIES_V1,
        prices=prices,
    )

    for candidate in candidates:
        specs = get_instance_specs(candidate)
        if not specs:
            continue
        if specs["vcpu"] >= required_vcpu and specs["ram_gb"] >= required_ram_gb:
            if candidate == current_instance:
                return {"suggested": current_instance, "already_right_sized": True}
            return {"suggested": candidate, "already_right_sized": False}

    # Fallback: no smaller candidate fits — already right-sized
    return {"suggested": current_instance, "already_right_sized": True}


def compute_efficiency_score(cpu_avg: float | None, ram_avg: float | None) -> int:
    """Weighted average utilization score 0-100. Returns 0 if either metric is None."""
    if cpu_avg is None or ram_avg is None:
        return 0
    raw = (cpu_avg * 0.5) + (ram_avg * 0.5)
    return int(min(100, max(0, raw)))


def efficiency_label(score: int, cpu_avg: float | None, ram_avg: float | None) -> str:
    if cpu_avg is None or ram_avg is None:
        return "unknown"
    if score < 30:
        return "over-provisioned"
    if score < 70:
        return "right-sized"
    return "under-provisioned"
