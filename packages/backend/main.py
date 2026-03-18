"""PDI FinOps Intelligence Agent — FastAPI Backend"""
import asyncio
import logging
import os
import httpx
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv(".env.local")

from auth import get_current_user, get_user_email
from dynamodb import (
    create_tables,
    create_run,
    get_run,
    get_latest_run,
    get_latest_completed_run,
    update_run_status,
    get_org_summaries_for_run,
    get_host_results_for_run,
)
from scheduler import start_scheduler, stop_scheduler

AGENT_SERVER_URL = os.getenv("AGENT_SERVER_URL", "http://127.0.0.1:8005")

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    create_tables()
    start_scheduler()
    yield
    # Shutdown
    stop_scheduler()


app = FastAPI(title="FinOps Agent API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "https://*.cloudfront.net",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/api/trigger", status_code=202)
async def trigger_run(user: dict = Depends(get_current_user)):
    """Kick off a new FinOps analysis run."""
    from agents.config.tenant_registry import get_tenants

    # Check for already-running run
    latest = get_latest_run()
    if latest and latest.get("status") == "running":
        raise HTTPException(
            status_code=409,
            detail={"error": "A run is already in progress", "run_id": latest["run_id"]},
        )

    # Create run record
    run_id = f"run_{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}"
    triggered_by = get_user_email(user)
    trigger_type = "scheduled" if triggered_by == "scheduler" else "manual"
    tenants = get_tenants()
    okta_token = user.get("_raw_token", "")

    create_run(
        run_id=run_id,
        trigger_type=trigger_type,
        triggered_by=triggered_by,
        okta_token=okta_token,
        tenants_total=len(tenants),
    )

    # Kick off orchestrator via Node agent server (fire-and-forget)
    asyncio.create_task(_run_orchestrator(run_id, okta_token))

    return {"run_id": run_id, "status": "running"}


async def _run_orchestrator(run_id: str, okta_token: str):
    """Delegate to the TypeScript agent server — no subprocess, no CLAUDECODE conflict."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                f"{AGENT_SERVER_URL}/run",
                json={"run_id": run_id, "okta_token": okta_token},
            )
    except Exception as e:
        logger.error(f"Failed to reach agent server for run {run_id}: {e}")
        update_run_status(run_id, "failed", datetime.now(timezone.utc).isoformat())


@app.get("/api/status")
async def get_status(
    run_id: str | None = Query(default=None),
    user: dict = Depends(get_current_user),
):
    """Get current run progress."""
    if run_id:
        run = get_run(run_id)
    else:
        run = get_latest_run()

    if not run:
        raise HTTPException(status_code=404, detail="No run found")

    hosts_total = run.get("hosts_total", 0) or 0
    hosts_done = run.get("hosts_done", 0) or 0
    progress_pct = int((hosts_done / hosts_total) * 100) if hosts_total > 0 else 0

    return {
        "run_id": run["run_id"],
        "status": run.get("status"),
        "trigger_type": run.get("trigger_type"),
        "triggered_by": run.get("triggered_by"),
        "started_at": run.get("started_at"),
        "completed_at": run.get("completed_at"),
        "tenants_total": run.get("tenants_total", 0),
        "tenants_done": run.get("tenants_done", 0),
        "hosts_total": hosts_total,
        "hosts_done": hosts_done,
        "progress_pct": progress_pct,
        "log": run.get("log", []),
    }


@app.get("/api/results")
async def get_results(
    run_id: str | None = Query(default=None),
    user: dict = Depends(get_current_user),
):
    """Get analysis results for a completed run."""
    if run_id:
        run = get_run(run_id)
        if not run:
            raise HTTPException(status_code=404, detail="Run not found")
    else:
        run = get_latest_completed_run()
        if not run:
            raise HTTPException(status_code=404, detail="No completed run found")

    run_id = run["run_id"]
    org_summaries = get_org_summaries_for_run(run_id)
    host_results = get_host_results_for_run(run_id)

    return {
        "run_id": run_id,
        "completed_at": run.get("completed_at"),
        "trigger_type": run.get("trigger_type"),
        "org_summaries": org_summaries,
        "host_results": host_results,
    }
