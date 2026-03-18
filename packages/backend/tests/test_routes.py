"""Unit tests for API routes — mock DynamoDB and auth."""
import pytest
from unittest.mock import patch, AsyncMock
from fastapi.testclient import TestClient

MOCK_USER = {"email": "test@pdi.com", "_raw_token": "tok"}
AUTH_HEADER = {"Authorization": "Bearer fake-token"}

# Patch low-level calls before importing app so startup hooks don't hit real infra
with patch("dynamodb.create_tables"), \
     patch("scheduler.start_scheduler"):
    from main import app
    from auth import get_current_user


def _override_auth():
    """FastAPI dependency override that returns MOCK_USER without token validation."""
    async def _dep():
        return MOCK_USER
    app.dependency_overrides[get_current_user] = _dep


def _clear_overrides():
    app.dependency_overrides.clear()


client = TestClient(app)


def test_health():
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


@patch("main.get_latest_run", return_value=None)
@patch("main.create_run")
@patch("main.asyncio.create_task")
def test_trigger_creates_run(mock_task, mock_create, mock_latest):
    _override_auth()
    try:
        resp = client.post("/api/trigger", headers=AUTH_HEADER)
        assert resp.status_code == 202
        data = resp.json()
        assert "run_id" in data
        assert data["status"] == "running"
        mock_create.assert_called_once()
    finally:
        _clear_overrides()


@patch("main.get_latest_run", return_value={"run_id": "run_001", "status": "running"})
def test_trigger_409_when_running(mock_latest):
    _override_auth()
    try:
        resp = client.post("/api/trigger", headers=AUTH_HEADER)
        assert resp.status_code == 409
    finally:
        _clear_overrides()


@patch("main.get_run", return_value=None)
@patch("main.get_latest_run", return_value=None)
def test_status_404_when_no_run(mock_latest, mock_run):
    _override_auth()
    try:
        resp = client.get("/api/status", headers=AUTH_HEADER)
        assert resp.status_code == 404
    finally:
        _clear_overrides()


@patch("main.get_latest_completed_run", return_value=None)
def test_results_404_when_no_completed_run(mock_completed):
    _override_auth()
    try:
        resp = client.get("/api/results", headers=AUTH_HEADER)
        assert resp.status_code == 404
    finally:
        _clear_overrides()


@patch("main.get_run", return_value={
    "run_id": "run_001", "status": "running",
    "hosts_total": 100, "hosts_done": 50,
    "tenants_total": 2, "tenants_done": 1,
    "log": ["batch 1 done"],
    "started_at": "2026-03-17T02:00:00Z", "completed_at": None,
    "trigger_type": "manual", "triggered_by": "user@pdi.com"
})
def test_status_returns_progress(mock_run):
    _override_auth()
    try:
        resp = client.get("/api/status?run_id=run_001", headers=AUTH_HEADER)
        assert resp.status_code == 200
        data = resp.json()
        assert data["progress_pct"] == 50
        assert data["hosts_done"] == 50
    finally:
        _clear_overrides()
