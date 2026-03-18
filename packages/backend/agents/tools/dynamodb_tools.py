"""
DynamoDB tool functions called by agents via @tool decorator wrappers.
These are plain Python functions — the @tool wrappers live in the agent files.
"""
import os
from datetime import datetime, timezone
from dynamodb import (
    get_dynamodb_resource,
    get_client,
    _serialize,
    _deserialize,
    REGION,
    ENDPOINT,
)
from boto3.dynamodb.types import TypeDeserializer


def write_host_list(tenant_id: str, run_id: str, hosts: list[dict]) -> None:
    """
    Write the discovered host list to finops_host_lists.
    hosts: list of {host_id, host_name}
    TTL: 7 days from now.
    """
    import time
    db = get_dynamodb_resource()
    table = db.Table("finops_host_lists")
    ttl = int(time.time()) + 7 * 86400
    table.put_item(Item=_serialize({
        "tenant_id": tenant_id,
        "run_id": run_id,
        "hosts": hosts,
        "ttl": ttl,
    }))


def read_host_list(tenant_id: str, run_id: str) -> list[dict]:
    """Read the host list written by the List-Hosts Agent."""
    db = get_dynamodb_resource()
    table = db.Table("finops_host_lists")
    resp = table.get_item(Key={"tenant_id": tenant_id, "run_id": run_id})
    item = resp.get("Item")
    if not item:
        return []
    return _deserialize(item).get("hosts", [])


def update_hosts_total(run_id: str, hosts_total: int) -> None:
    """Update hosts_total on finops_runs after host discovery."""
    db = get_dynamodb_resource()
    table = db.Table("finops_runs")
    table.update_item(
        Key={"run_id": run_id, "sk": "METADATA"},
        UpdateExpression="SET hosts_total = hosts_total + :n",
        ExpressionAttributeValues={":n": hosts_total},
    )


def update_run_progress(
    run_id: str,
    tenant_id: str,
    hosts_done_increment: int,
    log_message: str,
) -> None:
    """
    Increment hosts_done and append a log message (capped at last 20 entries).
    Called by Host Batch Sub-Agent after each host is processed.
    """
    db = get_dynamodb_resource()
    table = db.Table("finops_runs")
    # Append log message and trim to last 20
    table.update_item(
        Key={"run_id": run_id, "sk": "METADATA"},
        UpdateExpression=(
            "SET hosts_done = hosts_done + :inc, "
            "#log = list_append(if_not_exists(#log, :empty), :msg)"
        ),
        ExpressionAttributeNames={"#log": "log"},
        ExpressionAttributeValues={
            ":inc": hosts_done_increment,
            ":msg": [log_message],
            ":empty": [],
        },
    )
    # Trim log to last 20 — read current log length and slice if needed
    resp = table.get_item(
        Key={"run_id": run_id, "sk": "METADATA"},
        ProjectionExpression="#log",
        ExpressionAttributeNames={"#log": "log"},
    )
    log = resp.get("Item", {}).get("log", [])
    if len(log) > 20:
        table.update_item(
            Key={"run_id": run_id, "sk": "METADATA"},
            UpdateExpression="SET #log = :trimmed",
            ExpressionAttributeNames={"#log": "log"},
            ExpressionAttributeValues={":trimmed": _serialize(log[-20:])},
        )


def write_host_result(
    tenant_id: str,
    run_id: str,
    host_id: str,
    result: dict,
) -> None:
    """
    Write a per-host analysis result to finops_host_results.
    SK is composite: host_id#run_id
    TTL: 90 days from now.
    """
    import time
    db = get_dynamodb_resource()
    table = db.Table("finops_host_results")
    ttl = int(time.time()) + 90 * 86400
    item = {
        "tenant_id": tenant_id,
        "sk": f"{host_id}#{run_id}",
        "run_id": run_id,
        "host_id": host_id,
        "ttl": ttl,
        **result,
    }
    table.put_item(Item=_serialize(item))


def read_org_host_results(tenant_id: str, run_id: str) -> list[dict]:
    """
    Read all host results for a given org+run from finops_host_results.
    Used by the Summarize Agent.
    """
    client = get_client()
    resp = client.query(
        TableName="finops_host_results",
        IndexName="run_id-index",
        KeyConditionExpression="run_id = :r",
        ExpressionAttributeValues={":r": {"S": run_id}},
    )
    deserializer = TypeDeserializer()
    results = [
        _deserialize({k: deserializer.deserialize(v) for k, v in item.items()})
        for item in resp.get("Items", [])
    ]
    # Filter to this tenant only
    return [r for r in results if r.get("tenant_id") == tenant_id]


def write_org_summary(tenant_id: str, run_id: str, summary: dict) -> None:
    """
    Write org summary to finops_org_summary.
    TTL: 90 days from now.
    """
    import time
    db = get_dynamodb_resource()
    table = db.Table("finops_org_summary")
    ttl = int(time.time()) + 90 * 86400
    item = {
        "tenant_id": tenant_id,
        "run_id": run_id,
        "ttl": ttl,
        **summary,
    }
    table.put_item(Item=_serialize(item))


def update_tenants_done(run_id: str) -> None:
    """Increment tenants_done on finops_runs after an org completes."""
    db = get_dynamodb_resource()
    table = db.Table("finops_runs")
    table.update_item(
        Key={"run_id": run_id, "sk": "METADATA"},
        UpdateExpression="SET tenants_done = tenants_done + :one",
        ExpressionAttributeValues={":one": 1},
    )
