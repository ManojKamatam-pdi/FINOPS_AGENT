import pytest
from agents.config.tenant_registry import get_tenants, get_tenant, TENANTS


def test_tenants_not_empty():
    assert len(get_tenants()) >= 2


def test_pdi_enterprise_exists():
    t = get_tenant("PDI-Enterprise")
    assert t is not None
    assert t["tenant_id"] == "PDI-Enterprise"
    assert t["default_region"] == "us-east-1"


def test_pdi_orbis_exists():
    t = get_tenant("PDI-Orbis")
    assert t is not None


def test_unknown_tenant_returns_none():
    assert get_tenant("nonexistent") is None


def test_all_tenants_have_required_fields():
    for t in get_tenants():
        assert "tenant_id" in t
        assert "display_name" in t
        assert "default_region" in t
