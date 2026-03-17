"""
Integration test — requires DynamoDB Local running on port 8000.
Run: docker run -p 8000:8000 amazon/dynamodb-local
Then: pytest tests/test_dynamodb_setup.py -v
"""
import os
import pytest
import boto3

os.environ.setdefault("DYNAMODB_ENDPOINT", "http://localhost:8000")
os.environ.setdefault("AWS_REGION", "us-east-1")

from dynamodb import create_tables, get_client


@pytest.mark.integration
def test_create_tables_idempotent():
    """Tables can be created twice without error."""
    create_tables()
    create_tables()  # second call should not raise


@pytest.mark.integration
def test_all_tables_exist():
    create_tables()
    client = get_client()
    tables = client.list_tables()["TableNames"]
    for expected in ["finops_runs", "finops_host_lists", "finops_org_summary", "finops_host_results"]:
        assert expected in tables, f"Table {expected} not found"


@pytest.mark.integration
def test_finops_runs_has_gsi():
    create_tables()
    client = get_client()
    desc = client.describe_table(TableName="finops_runs")
    gsi_names = [g["IndexName"] for g in desc["Table"].get("GlobalSecondaryIndexes", [])]
    assert "status-started_at-index" in gsi_names


@pytest.mark.integration
def test_finops_host_results_has_gsi():
    create_tables()
    client = get_client()
    desc = client.describe_table(TableName="finops_host_results")
    gsi_names = [g["IndexName"] for g in desc["Table"].get("GlobalSecondaryIndexes", [])]
    assert "run_id-index" in gsi_names
