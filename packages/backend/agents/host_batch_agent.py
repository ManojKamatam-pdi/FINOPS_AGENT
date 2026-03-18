"""
Host Batch Sub-Agent — analyzes a batch of hosts for CPU/RAM/Network metrics
and writes per-host results to DynamoDB.

Uses the Datadog MCP Workflow Router (3 tools: query-datadog, check-status, list-tenants).
For each host: query-datadog → poll check-status → parse metrics → right-size → write result.
"""
import json
import logging
from datetime import datetime, timezone
from claude_agent_sdk import (
    ClaudeAgentOptions, query, tool, create_sdk_mcp_server,
    AssistantMessage, TextBlock, ResultMessage,
)
from agents.tools.aws_instances import (
    get_instance_specs,
    suggest_right_sized_instance,
    get_all_instances_sorted_by_price,
    CANDIDATE_FAMILIES_V1,
)
from agents.tools.aws_pricing import get_prices_for_instances, get_instance_on_demand_price
from agents.tools.pricing_url import build_pricing_calculator_url
from agents.tools.dynamodb_tools import write_host_result, update_run_progress
from agents.config.mcp_registry import get_mcp_servers

logger = logging.getLogger(__name__)


async def run_host_batch_agent(
    tenant_id: str,
    hosts: list[dict],
    okta_token: str,
    run_id: str,
    batch_index: int = 0,
    total_batches: int = 1,
) -> None:
    """
    Run the Host Batch Sub-Agent for a batch of hosts.
    hosts: list of {host_id, host_name}
    """

    @tool(
        "get_instance_specs_tool",
        "Get CPU count and RAM GB for an EC2 instance type from the local catalog. Returns JSON: {vcpu, ram_gb, family} or {\"error\": \"not in catalog\"}.",
        {"instance_type": str},
    )
    async def get_instance_specs_tool(args: dict) -> dict:
        specs = get_instance_specs(args["instance_type"])
        text = json.dumps(specs) if specs else json.dumps({"error": f"Instance type {args['instance_type']} not in catalog"})
        return {"content": [{"type": "text", "text": text}]}

    @tool(
        "get_instance_on_demand_price_tool",
        "Get monthly on-demand price (USD) for an EC2 instance type. Returns JSON: {\"monthly_usd\": 134.40} or {\"error\": \"price unavailable\"}.",
        {"instance_type": str, "region": str},
    )
    async def get_instance_on_demand_price_tool(args: dict) -> dict:
        price = get_instance_on_demand_price(args["instance_type"], args.get("region", "us-east-1"))
        text = json.dumps({"monthly_usd": price}) if price is not None else json.dumps({"error": f"Price unavailable for {args['instance_type']}"})
        return {"content": [{"type": "text", "text": text}]}

    @tool(
        "suggest_right_sized_instance_tool",
        "Suggest the best-fit right-sized EC2 instance. cpu_p95_pct: 95th percentile CPU % (0-100). ram_avg_pct: average RAM used as % of current instance total RAM. current_instance: e.g. 'r5.xlarge'. region: AWS region.",
        {"cpu_p95_pct": float, "ram_avg_pct": float, "current_instance": str, "region": str},
    )
    async def suggest_right_sized_instance_tool(args: dict) -> dict:
        region = args.get("region", "us-east-1")
        catalog_instances = get_all_instances_sorted_by_price(region=region, families=CANDIDATE_FAMILIES_V1)
        prices = get_prices_for_instances(catalog_instances, region)
        result = suggest_right_sized_instance(args["cpu_p95_pct"], args["ram_avg_pct"], args["current_instance"], prices)
        suggested = result["suggested"]
        already_right_sized = result["already_right_sized"]
        current_price = prices.get(args["current_instance"])
        suggested_price = prices.get(suggested)
        monthly_savings = 0.0
        savings_pct = 0.0
        if current_price and suggested_price and not already_right_sized:
            monthly_savings = round(current_price - suggested_price, 2)
            savings_pct = round((monthly_savings / current_price) * 100, 1) if current_price > 0 else 0.0
        text = json.dumps({
            "suggested": suggested,
            "already_right_sized": already_right_sized,
            "suggested_monthly_usd": suggested_price,
            "current_monthly_usd": current_price,
            "monthly_savings": monthly_savings,
            "savings_percent": savings_pct,
        })
        return {"content": [{"type": "text", "text": text}]}

    @tool(
        "build_pricing_calculator_url_tool",
        "Build an AWS Pricing Calculator URL for comparing current vs. suggested instance. Returns the URL string.",
        {"current_instance": str, "suggested_instance": str, "region": str},
    )
    async def build_pricing_calculator_url_tool(args: dict) -> dict:
        url = build_pricing_calculator_url(
            args["current_instance"],
            args["suggested_instance"],
            args.get("region", "us-east-1"),
        )
        return {"content": [{"type": "text", "text": url}]}

    @tool(
        "write_host_result_tool",
        "Write a per-host analysis result to DynamoDB. result_json: JSON object with all host analysis fields.",
        {"host_id": str, "result_json": str},
    )
    async def write_host_result_tool(args: dict) -> dict:
        result = json.loads(args["result_json"])
        result["analyzed_at"] = datetime.now(timezone.utc).isoformat()
        write_host_result(tenant_id, run_id, args["host_id"], result)
        return {"content": [{"type": "text", "text": f"Wrote result for host {args['host_id']}"}]}

    @tool(
        "update_run_progress_tool",
        "Update run progress after completing hosts in this batch. hosts_done: number of hosts just completed. log_message: progress message.",
        {"hosts_done": int, "log_message": str},
    )
    async def update_run_progress_tool(args: dict) -> dict:
        update_run_progress(run_id, tenant_id, args["hosts_done"], args["log_message"])
        return {"content": [{"type": "text", "text": f"Progress updated: {args['log_message']}"}]}

    local_server = create_sdk_mcp_server(
        "host-batch-tools",
        tools=[
            get_instance_specs_tool,
            get_instance_on_demand_price_tool,
            suggest_right_sized_instance_tool,
            build_pricing_calculator_url_tool,
            write_host_result_tool,
            update_run_progress_tool,
        ],
    )

    hosts_json = json.dumps(hosts)
    system_prompt = f"""You are a FinOps host analyzer for the Datadog org '{tenant_id}'.
You will analyze a batch of {len(hosts)} hosts for CPU, RAM, and Network utilization over 30 days.

The Datadog MCP exposes 3 tools:
- query-datadog(tenant_id, query): triggers a Datadog Workflow → AI Agent, returns {{instance_id, status: "running"}}
- check-status(tenant_id, instance_id): polls the workflow; when completed returns the agent's answer
- list-tenants(): lists available orgs

FOR EACH HOST, follow this process:

STEP 1 — Query Datadog for 30-day metrics:
  Call query-datadog with tenant_id="{tenant_id}" and a query like:
  "For host <host_name> (host_id: <host_id>), give me the 30-day averages for:
   - CPU utilization (avg and p95 as % of total vCPUs, 0-100)
   - RAM: system.mem.usable average in bytes
   - Network: system.net.bytes_rcvd and system.net.bytes_sent averages in bytes/sec
   Also return the instance_type tag and region tag if present."
  Then poll check-status until completed. Extract the metrics from the response.

STEP 2 — Compute right-sizing (if instance_type tag found):
  - Call get_instance_specs_tool(instance_type) to get vcpu and ram_gb
  - Convert RAM: ram_avg_pct = ((ram_gb - mem_usable_bytes/1e9) / ram_gb) * 100
  - Convert Network: gb_per_day = (bytes_per_sec * 86400) / 1e9 (informational only)
  - Call suggest_right_sized_instance_tool(cpu_p95_pct, ram_avg_pct, current_instance, region)
  - If not already_right_sized: call build_pricing_calculator_url_tool

STEP 3 — Write result:
  Call write_host_result_tool(host_id, result_json) with:
  {{
    "host_name": "...", "cloud_provider": "aws",
    "cpu_avg_30d": <float>, "cpu_p95_30d": <float>, "ram_avg_30d": <float>,
    "network_in_avg_30d": <float>, "network_out_avg_30d": <float>,
    "instance_type": "..." or null, "instance_region": "..." or null,
    "instance_cpu_count": <int> or null, "instance_ram_gb": <float> or null,
    "has_instance_tag": true/false, "catalog_data_available": true/false,
    "current_monthly_cost": <float> or null, "suggested_instance": "..." or null,
    "suggested_monthly_cost": <float> or null, "monthly_savings": <float> or null,
    "savings_percent": <float> or null,
    "pricing_calc_url": "<url>" or null,
    "efficiency_score": <int 0-100>, "efficiency_label": "over-provisioned"|"right-sized"|"under-provisioned"|"unknown",
    "recommendation": "<explanation of finding>"
  }}

  If Datadog returns no data: set efficiency_score=0, efficiency_label="unknown", write result anyway.

AFTER ALL HOSTS:
  Call update_run_progress_tool(hosts_done={len(hosts)}, log_message="batch {batch_index+1}/{total_batches} complete ({len(hosts)} hosts) for {tenant_id}")

Important:
- Always poll check-status until completed/failed before moving to the next step.
- Write each host result before moving to the next host.
- Never skip a host — always write a result row even if data is unavailable."""

    options = ClaudeAgentOptions(
        system_prompt=system_prompt,
        mcp_servers={
            "host-batch-tools": local_server,
            **get_mcp_servers(["datadog"], okta_token=okta_token),
        },
        max_turns=200,
        permission_mode="acceptEdits",
    )

    user_message = f"Analyze these {len(hosts)} hosts from Datadog org '{tenant_id}':\n{hosts_json}"

    try:
        async for event in query(prompt=user_message, options=options):
            if isinstance(event, AssistantMessage):
                for block in event.content:
                    if isinstance(block, TextBlock):
                        logger.info(f"[host_batch:{tenant_id}:batch{batch_index}] {block.text[:200]}")
            elif isinstance(event, ResultMessage):
                if event.is_error:
                    logger.error(f"[host_batch:{tenant_id}:batch{batch_index}] Agent run failed: {event.result}")
                elif event.stop_reason == "max_turns":
                    logger.warning(f"[host_batch:{tenant_id}:batch{batch_index}] Hit max_turns limit (200)")
                else:
                    logger.info(f"[host_batch:{tenant_id}:batch{batch_index}] Completed: stop_reason={event.stop_reason}")
    except Exception as e:
        logger.error(f"[host_batch:{tenant_id}:batch{batch_index}] SDK error: {e}")
        raise

    logger.info(f"Host Batch Agent completed for {tenant_id} batch {batch_index}")
