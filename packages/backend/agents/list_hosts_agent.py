"""
List-Hosts Agent — discovers all hosts in a Datadog org and writes them to DynamoDB.

Uses the Datadog MCP Workflow Router (3 tools: query-datadog, check-status, list-tenants).
Pattern: query-datadog → get instanceId → poll check-status until completed → parse result.
"""
import json
import logging
from claude_agent_sdk import (
    ClaudeAgentOptions, query, tool, create_sdk_mcp_server,
    AssistantMessage, TextBlock, ResultMessage,
)
from agents.config.mcp_registry import get_mcp_servers
from agents.tools.dynamodb_tools import write_host_list, update_hosts_total

logger = logging.getLogger(__name__)


async def run_list_hosts_agent(tenant_id: str, okta_token: str, run_id: str) -> None:
    """
    Run the List-Hosts Agent for a single tenant.
    Calls the Datadog MCP to list all hosts, then writes them to DynamoDB.
    """

    @tool(
        "write_host_list_tool",
        "Write the discovered host list to DynamoDB. hosts_json: JSON array of {host_id, host_name} objects.",
        {"hosts_json": str},
    )
    async def write_host_list_tool(args: dict) -> dict:
        hosts = json.loads(args["hosts_json"])
        write_host_list(tenant_id, run_id, hosts)
        return {"content": [{"type": "text", "text": f"Wrote {len(hosts)} hosts to DynamoDB for {tenant_id}"}]}

    @tool(
        "update_hosts_total_tool",
        "Update the total host count on the run record. count: number of hosts discovered for this org.",
        {"count": int},
    )
    async def update_hosts_total_tool(args: dict) -> dict:
        update_hosts_total(run_id, args["count"])
        return {"content": [{"type": "text", "text": f"Updated hosts_total by {args['count']} for run {run_id}"}]}

    local_server = create_sdk_mcp_server(
        "list-hosts-tools",
        tools=[write_host_list_tool, update_hosts_total_tool],
    )

    system_prompt = f"""You are a host discovery agent for the Datadog org '{tenant_id}'.

The Datadog MCP exposes 3 tools:
- query-datadog(tenant_id, query): triggers a Datadog Workflow → AI Agent, returns {{instance_id, status: "running"}}
- check-status(tenant_id, instance_id): polls the workflow; returns status "running"|"completed"|"failed", and when completed returns the agent's answer
- list-tenants(): lists available orgs

Your task:
1. Call query-datadog with tenant_id="{tenant_id}" and query:
   "List ALL monitored hosts in this org. For each host return: host_id, host_name, and any tags including instance_type and region. Return as a JSON array."
2. You will receive an instance_id immediately. The workflow is now running.
3. Call check-status(tenant_id="{tenant_id}", instance_id=<the id you got>) repeatedly (every few seconds) until status is "completed" or "failed".
4. When completed, parse the agent's response to extract the host list as a JSON array of {{host_id, host_name}} objects.
5. Call write_host_list_tool with the JSON array.
6. Call update_hosts_total_tool with the total count.
7. Confirm completion.

Important:
- Keep polling check-status until you get a completed/failed status — do not stop after the first "running" response.
- If the response is a string (not JSON), extract host information from the text as best you can.
- If status is "failed", write an empty host list and log the failure."""

    options = ClaudeAgentOptions(
        system_prompt=system_prompt,
        mcp_servers={
            "list-hosts-tools": local_server,
            **get_mcp_servers(["datadog"], okta_token=okta_token),
        },
        max_turns=30,
        permission_mode="acceptEdits",
    )

    user_message = f"List all hosts in Datadog org '{tenant_id}' and write them to DynamoDB."

    try:
        async for event in query(prompt=user_message, options=options):
            if isinstance(event, AssistantMessage):
                for block in event.content:
                    if isinstance(block, TextBlock):
                        logger.info(f"[list_hosts:{tenant_id}] {block.text[:200]}")
            elif isinstance(event, ResultMessage):
                if event.is_error:
                    logger.error(f"[list_hosts:{tenant_id}] Agent run failed: {event.result}")
                elif event.stop_reason == "max_turns":
                    logger.warning(f"[list_hosts:{tenant_id}] Hit max_turns limit")
                else:
                    logger.info(f"[list_hosts:{tenant_id}] Completed: stop_reason={event.stop_reason}")
    except Exception as e:
        logger.error(f"[list_hosts:{tenant_id}] SDK error: {e}")
        raise

    logger.info(f"List-Hosts Agent completed for {tenant_id}")
