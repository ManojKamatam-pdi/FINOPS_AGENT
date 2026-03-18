"""
Summarize Agent — reads all host results for an org and writes the org summary.
Does not call Datadog MCP — works entirely from DynamoDB data written by host_batch_agent.
"""
import json
import logging
from claude_agent_sdk import (
    ClaudeAgentOptions, query, tool, create_sdk_mcp_server,
    AssistantMessage, TextBlock, ResultMessage,
)
from agents.tools.dynamodb_tools import (
    read_org_host_results,
    write_org_summary,
    update_tenants_done,
)

logger = logging.getLogger(__name__)


async def run_summarize_agent(tenant_id: str, okta_token: str, run_id: str) -> None:
    """
    Run the Summarize Agent for a single tenant.
    Reads all host results from DynamoDB, computes org summary, writes it back.
    """

    @tool(
        "read_org_host_results_tool",
        "Read all host analysis results for this org from DynamoDB. Returns JSON array of host result objects.",
        {},
    )
    async def read_org_host_results_tool(args: dict) -> dict:
        results = read_org_host_results(tenant_id, run_id)
        return {"content": [{"type": "text", "text": json.dumps(results)}]}

    @tool(
        "write_org_summary_tool",
        "Write the org summary to DynamoDB. summary_json: JSON object with all org summary fields.",
        {"summary_json": str},
    )
    async def write_org_summary_tool(args: dict) -> dict:
        summary = json.loads(args["summary_json"])
        write_org_summary(tenant_id, run_id, summary)
        return {"content": [{"type": "text", "text": f"Wrote org summary for {tenant_id}"}]}

    @tool(
        "update_tenants_done_tool",
        "Increment tenants_done on the run record after this org completes.",
        {},
    )
    async def update_tenants_done_tool(args: dict) -> dict:
        update_tenants_done(run_id)
        return {"content": [{"type": "text", "text": f"Incremented tenants_done for run {run_id}"}]}

    local_server = create_sdk_mcp_server(
        "summarize-tools",
        tools=[read_org_host_results_tool, write_org_summary_tool, update_tenants_done_tool],
    )

    system_prompt = f"""You are a FinOps org summarizer for the Datadog org '{tenant_id}'.

Your task:
1. Call read_org_host_results_tool to get all host analysis results for this org.
2. Compute the org summary:
   - total_hosts: total number of host results
   - hosts_analyzed: hosts with metric data (efficiency_label != "unknown")
   - hosts_over_provisioned: count where efficiency_label == "over-provisioned"
   - hosts_right_sized: count where efficiency_label == "right-sized"
   - hosts_under_provisioned: count where efficiency_label == "under-provisioned"
   - hosts_no_tag: count where has_instance_tag == false
   - total_monthly_spend: sum of current_monthly_cost (skip nulls)
   - potential_savings: sum of monthly_savings (skip nulls)
   - savings_percent: (potential_savings / total_monthly_spend * 100) if total_monthly_spend > 0 else 0
   - avg_cpu_utilization: mean of cpu_avg_30d (skip nulls)
   - avg_ram_utilization: mean of ram_avg_30d (skip nulls)
   - top_offenders: list of top 5 host_id values sorted by monthly_savings descending (skip nulls)
   - completed_at: current UTC timestamp in ISO format
3. Call write_org_summary_tool with the computed summary as JSON.
4. Call update_tenants_done_tool to mark this org as complete.
5. Confirm completion.

Be precise with the arithmetic. Round monetary values to 2 decimal places, percentages to 1 decimal place."""

    options = ClaudeAgentOptions(
        system_prompt=system_prompt,
        mcp_servers={"summarize-tools": local_server},
        max_turns=15,
        permission_mode="acceptEdits",
    )

    user_message = f"Summarize all host analysis results for Datadog org '{tenant_id}' and write the org summary."

    try:
        async for event in query(prompt=user_message, options=options):
            if isinstance(event, AssistantMessage):
                for block in event.content:
                    if isinstance(block, TextBlock):
                        logger.info(f"[summarize:{tenant_id}] {block.text[:200]}")
            elif isinstance(event, ResultMessage):
                if event.is_error:
                    logger.error(f"[summarize:{tenant_id}] Agent run failed: {event.result}")
                elif event.stop_reason == "max_turns":
                    logger.warning(f"[summarize:{tenant_id}] Hit max_turns limit (15)")
                else:
                    logger.info(f"[summarize:{tenant_id}] Completed: stop_reason={event.stop_reason}")
    except Exception as e:
        logger.error(f"[summarize:{tenant_id}] SDK error: {e}")
        raise

    logger.info(f"Summarize Agent completed for {tenant_id}")
