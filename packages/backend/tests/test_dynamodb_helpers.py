"""
Integration tests for DynamoDB helpers.
Requires: docker run -p 8000:8000 amazon/dynamodb-local
"""
import os
import pytest
from datetime import datetime, timezone

os.environ.setdefault("DYNAMODB_ENDPOINT", "http://localhost:8003")
os.environ.setdefault("AWS_REGION", "us-east-1")

from dynamodb import create_tables, create_run, get_run, update_run_status, get_latest_completed_run


@pytest.fixture(autouse=True)
def setup_tables():
    create_tables()


@pytest.mark.integration
def test_create_and_get_run():
    run_id = "run_test_001"
    create_run(run_id, "manual", "user@pdi.com", "tok123", 2)
    run = get_run(run_id)
    assert run is not None
    assert run["run_id"] == run_id
    assert run["status"] == "running"
    assert run["tenants_total"] == 2
    assert run["okta_token"] == "tok123"


@pytest.mark.integration
def test_update_run_status():
    run_id = "run_test_002"
    create_run(run_id, "scheduled", "scheduler", "tok456", 2)
    now = datetime.now(timezone.utc).isoformat()
    update_run_status(run_id, "completed", now)
    run = get_run(run_id)
    assert run["status"] == "completed"
    assert run["completed_at"] == now


@pytest.mark.integration
def test_get_latest_completed_run():
    run_id = "run_test_003"
    create_run(run_id, "manual", "user@pdi.com", "tok789", 2)
    now = datetime.now(timezone.utc).isoformat()
    update_run_status(run_id, "completed", now)
    result = get_latest_completed_run()
    assert result is not None
    assert result["status"] == "completed"
