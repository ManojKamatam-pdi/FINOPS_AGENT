"""
Org Analysis Flow — Python wrapper (not a single agent).
Orchestrates: List-Hosts Agent → batch fan-out → Summarize Agent.
"""
import asyncio
import logging
from agents.list_hosts_agent import run_list_hosts_agent
from agents.host_batch_agent import run_host_batch_agent
from agents.summarize_agent import run_summarize_agent
from agents.tools.dynamodb_tools import read_host_list

logger = logging.getLogger(__name__)

BATCH_SIZE = 10


async def run_org_analysis(tenant_id: str, okta_token: str, run_id: str) -> None:
    """
    Full org analysis flow for one tenant:
    1. List-Hosts Agent: discover hosts, write to DynamoDB
    2. Python: read host list, fan out batches
    3. Host Batch Sub-Agents: analyze hosts in parallel (asyncio.gather)
    4. Summarize Agent: compute org summary, write to DynamoDB
    """
    logger.info(f"[org_analysis:{tenant_id}] Starting host discovery")

    # Invocation 1: List-Hosts Agent
    await run_list_hosts_agent(tenant_id, okta_token, run_id)

    # Python step: read host list from DynamoDB
    hosts = read_host_list(tenant_id, run_id)
    if not hosts:
        logger.warning(f"[org_analysis:{tenant_id}] No hosts found — skipping batch analysis")
        # Still run summarize to write an empty summary
        await run_summarize_agent(tenant_id, okta_token, run_id)
        return

    logger.info(f"[org_analysis:{tenant_id}] Found {len(hosts)} hosts, fanning out batches")

    # Python step: fan out batches of BATCH_SIZE
    batches = [hosts[i:i + BATCH_SIZE] for i in range(0, len(hosts), BATCH_SIZE)]
    total_batches = len(batches)

    await asyncio.gather(*[
        run_host_batch_agent(
            tenant_id=tenant_id,
            hosts=batch,
            okta_token=okta_token,
            run_id=run_id,
            batch_index=i,
            total_batches=total_batches,
        )
        for i, batch in enumerate(batches)
    ])

    logger.info(f"[org_analysis:{tenant_id}] All batches complete, running summarize")

    # Invocation 2: Summarize Agent
    await run_summarize_agent(tenant_id, okta_token, run_id)

    logger.info(f"[org_analysis:{tenant_id}] Org analysis complete")
