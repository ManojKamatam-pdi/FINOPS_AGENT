import json
import os
import pytest


CATALOG_PATH = os.path.join(
    os.path.dirname(__file__), "..", "agents", "config", "ec2_instances.json"
)


@pytest.fixture
def catalog():
    with open(CATALOG_PATH) as f:
        return json.load(f)


def test_catalog_loads(catalog):
    assert len(catalog) > 0


def test_required_families_present(catalog):
    families = {v["family"] for v in catalog.values()}
    for required in ["t3", "m5", "c5", "r5"]:
        assert required in families, f"Family {required} missing from catalog"


def test_each_entry_has_vcpu_and_ram(catalog):
    for instance_type, specs in catalog.items():
        assert "vcpu" in specs, f"{instance_type} missing vcpu"
        assert "ram_gb" in specs, f"{instance_type} missing ram_gb"
        assert specs["vcpu"] > 0
        assert specs["ram_gb"] > 0


def test_t3_xlarge_specs(catalog):
    assert "t3.xlarge" in catalog
    assert catalog["t3.xlarge"]["vcpu"] == 4
    assert catalog["t3.xlarge"]["ram_gb"] == 16.0


def test_r5_xlarge_specs(catalog):
    assert "r5.xlarge" in catalog
    assert catalog["r5.xlarge"]["vcpu"] == 4
    assert catalog["r5.xlarge"]["ram_gb"] == 32.0
