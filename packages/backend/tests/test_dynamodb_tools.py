"""
Integration tests for dynamodb_tools module.
Requires DynamoDB Local running on port 8003.
"""
import os
import pytest
import time

os.environ.setdefault("DYNAMODB_ENDPOINT", "http://localhost:8003")
os.environ.setdefault("AWS_REGION", "us-east-1")

from dynamodb import create_tables, create_run
from agents.tools.dynamodb_tools import (
    write_host_list,
    read_host_list,
    update_hosts_total,
    write_host_result,
    read_org_host_results,
    write_org_summary,
    update_tenants_done,
)


@pytest.fixture(autouse=True)
def setup_tables():
    create_tables()


@pytest.mark.integration
def test_write_and_read_host_list():
    tenant_id = "PDI-Enterprise"
    run_id = "run_test_hosts_001"
    hosts = [{"host_id": "i-001", "host_name": "web-01"}, {"host_id": "i-002", "host_name": "db-01"}]
    write_host_list(tenant_id, run_id, hosts)
    result = read_host_list(tenant_id, run_id)
    assert len(result) == 2
    assert result[0]["host_id"] == "i-001"


@pytest.mark.integration
def test_write_host_result_and_read():
    tenant_id = "PDI-Enterprise"
    run_id = "run_test_hosts_002"
    create_run(run_id, "manual", "user@pdi.com", "tok", 2)
    result = {
        "host_name": "web-01",
        "cloud_provider": "aws",
        "cpu_avg_30d": 18.2,
        "cpu_p95_30d": 31.4,
        "ram_avg_30d": 22.1,
        "network_in_avg_30d": 1.2,
        "network_out_avg_30d": 0.8,
        "instance_type": "t3.xlarge",
        "instance_region": "us-east-1",
        "instance_cpu_count": 4,
        "instance_ram_gb": 16.0,
        "has_instance_tag": True,
        "catalog_data_available": True,
        "current_monthly_cost": 134.40,
        "suggested_instance": "t3.small",
        "suggested_monthly_cost": 16.80,
        "monthly_savings": 117.60,
        "savings_percent": 87.5,
        "pricing_calc_url": "https://calculator.aws/...",
        "efficiency_score": 20,
        "efficiency_label": "over-provisioned",
        "recommendation": "This host is over-provisioned.",
    }
    write_host_result(tenant_id, run_id, "i-001", result)
    results = read_org_host_results(tenant_id, run_id)
    assert len(results) == 1
    assert results[0]["host_id"] == "i-001"
    assert results[0]["monthly_savings"] == 117.60


@pytest.mark.integration
def test_write_org_summary():
    tenant_id = "PDI-Enterprise"
    run_id = "run_test_summary_001"
    summary = {
        "total_hosts": 10,
        "hosts_analyzed": 9,
        "hosts_over_provisioned": 6,
        "hosts_right_sized": 3,
        "hosts_under_provisioned": 0,
        "hosts_no_tag": 1,
        "total_monthly_spend": 1200.0,
        "potential_savings": 400.0,
        "savings_percent": 33.3,
        "avg_cpu_utilization": 21.4,
        "avg_ram_utilization": 34.2,
        "top_offenders": ["i-001", "i-002"],
        "completed_at": "2026-03-17T02:44:00Z",
    }
    write_org_summary(tenant_id, run_id, summary)
    # Verify via DynamoDB resource
    from dynamodb import get_dynamodb_resource, _deserialize
    db = get_dynamodb_resource()
    table = db.Table("finops_org_summary")
    resp = table.get_item(Key={"tenant_id": tenant_id, "run_id": run_id})
    item = _deserialize(resp.get("Item", {}))
    assert item["total_hosts"] == 10
    assert item["potential_savings"] == 400.0
