"""
Orchestrator Agent — coordinates parallel org analysis across all tenants.
Uses claude_agent_sdk for the orchestration loop; actual org work is done
by run_org_analysis (Python wrapper, not inside the agent loop).
"""
import asyncio
import logging
from datetime import datetime, timezone
from claude_agent_sdk import ClaudeAgentOptions, query
from agents.config.tenant_registry import get_tenants
from agents.org_agent import run_org_analysis
from dynamodb import get_run, update_run_status

logger = logging.getLogger(__name__)


async def run_orchestrator(run_id: str) -> None:
    """
    Main entry point called by FastAPI background task.
    Reads the run record to get the okta_token, then runs all org analyses in parallel.
    """
    run = get_run(run_id)
    if not run:
        logger.error(f"Orchestrator: run {run_id} not found in DynamoDB")
        return

    okta_token = run.get("okta_token", "")
    tenants = get_tenants()

    logger.info(f"Orchestrator starting run {run_id} for {len(tenants)} tenants")

    try:
        # Run all org analyses in parallel
        await asyncio.gather(*[
            run_org_analysis(
                tenant_id=tenant["tenant_id"],
                okta_token=okta_token,
                run_id=run_id,
            )
            for tenant in tenants
        ])

        # Mark run as completed
        update_run_status(
            run_id,
            "completed",
            datetime.now(timezone.utc).isoformat(),
        )
        logger.info(f"Orchestrator: run {run_id} completed successfully")

    except Exception as e:
        logger.error(f"Orchestrator: run {run_id} failed: {e}")
        update_run_status(
            run_id,
            "failed",
            datetime.now(timezone.utc).isoformat(),
        )
        raise
