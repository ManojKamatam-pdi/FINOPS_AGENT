"""
DynamoDB table setup — run once to create local tables.
Usage: python dynamodb.py
"""
import os
import boto3
from decimal import Decimal
from datetime import datetime, timezone
from dotenv import load_dotenv

load_dotenv(".env.local")

ENDPOINT = os.getenv("DYNAMODB_ENDPOINT")
REGION = os.getenv("AWS_REGION", "us-east-1")


def get_client():
    kwargs = {"region_name": REGION}
    if ENDPOINT:
        kwargs["endpoint_url"] = ENDPOINT
        kwargs["aws_access_key_id"] = "local"
        kwargs["aws_secret_access_key"] = "local"
    return boto3.client("dynamodb", **kwargs)


def create_tables():
    client = get_client()
    existing = client.list_tables()["TableNames"]

    tables = [
        {
            "TableName": "finops_runs",
            "KeySchema": [
                {"AttributeName": "run_id", "KeyType": "HASH"},
                {"AttributeName": "sk", "KeyType": "RANGE"},
            ],
            "AttributeDefinitions": [
                {"AttributeName": "run_id", "AttributeType": "S"},
                {"AttributeName": "sk", "AttributeType": "S"},
                {"AttributeName": "status", "AttributeType": "S"},
                {"AttributeName": "started_at", "AttributeType": "S"},
            ],
            "GlobalSecondaryIndexes": [
                {
                    "IndexName": "status-started_at-index",
                    "KeySchema": [
                        {"AttributeName": "status", "KeyType": "HASH"},
                        {"AttributeName": "started_at", "KeyType": "RANGE"},
                    ],
                    "Projection": {"ProjectionType": "ALL"},
                    "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
                }
            ],
            "BillingMode": "PAY_PER_REQUEST",
        },
        {
            "TableName": "finops_host_lists",
            "KeySchema": [
                {"AttributeName": "tenant_id", "KeyType": "HASH"},
                {"AttributeName": "run_id", "KeyType": "RANGE"},
            ],
            "AttributeDefinitions": [
                {"AttributeName": "tenant_id", "AttributeType": "S"},
                {"AttributeName": "run_id", "AttributeType": "S"},
            ],
            "BillingMode": "PAY_PER_REQUEST",
        },
        {
            "TableName": "finops_org_summary",
            "KeySchema": [
                {"AttributeName": "tenant_id", "KeyType": "HASH"},
                {"AttributeName": "run_id", "KeyType": "RANGE"},
            ],
            "AttributeDefinitions": [
                {"AttributeName": "tenant_id", "AttributeType": "S"},
                {"AttributeName": "run_id", "AttributeType": "S"},
            ],
            "GlobalSecondaryIndexes": [
                {
                    "IndexName": "run_id-index",
                    "KeySchema": [
                        {"AttributeName": "run_id", "KeyType": "HASH"},
                    ],
                    "Projection": {"ProjectionType": "ALL"},
                    "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
                }
            ],
            "BillingMode": "PAY_PER_REQUEST",
        },
        {
            "TableName": "finops_host_results",
            "KeySchema": [
                {"AttributeName": "tenant_id", "KeyType": "HASH"},
                {"AttributeName": "sk", "KeyType": "RANGE"},
            ],
            "AttributeDefinitions": [
                {"AttributeName": "tenant_id", "AttributeType": "S"},
                {"AttributeName": "sk", "AttributeType": "S"},
                {"AttributeName": "run_id", "AttributeType": "S"},
            ],
            "GlobalSecondaryIndexes": [
                {
                    "IndexName": "run_id-index",
                    "KeySchema": [
                        {"AttributeName": "run_id", "KeyType": "HASH"},
                    ],
                    "Projection": {"ProjectionType": "ALL"},
                    "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
                }
            ],
            "BillingMode": "PAY_PER_REQUEST",
        },
    ]

    for table_def in tables:
        name = table_def["TableName"]
        if name in existing:
            print(f"  [ok] {name} already exists")
            continue
        # Remove GSI ProvisionedThroughput for PAY_PER_REQUEST tables
        if table_def.get("BillingMode") == "PAY_PER_REQUEST":
            for gsi in table_def.get("GlobalSecondaryIndexes", []):
                gsi.pop("ProvisionedThroughput", None)
        client.create_table(**table_def)
        print(f"  [ok] Created {name}")

    print("All tables ready.")


# ---------------------------------------------------------------------------
# DynamoDB resource + helper utilities
# ---------------------------------------------------------------------------

def _serialize(obj):
    """Convert Python types to DynamoDB-safe types (float → Decimal)."""
    if isinstance(obj, float):
        return Decimal(str(obj))
    if isinstance(obj, dict):
        return {k: _serialize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_serialize(i) for i in obj]
    return obj


def _deserialize(obj):
    """Convert DynamoDB Decimal back to float."""
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, dict):
        return {k: _deserialize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_deserialize(i) for i in obj]
    return obj


def get_dynamodb_resource():
    """Return a boto3 DynamoDB resource, wired to local endpoint if set."""
    kwargs = {"region_name": REGION}
    if ENDPOINT:
        kwargs["endpoint_url"] = ENDPOINT
        kwargs["aws_access_key_id"] = "local"
        kwargs["aws_secret_access_key"] = "local"
    return boto3.resource("dynamodb", **kwargs)


def get_run(run_id: str) -> dict | None:
    """Fetch a single run record by run_id."""
    db = get_dynamodb_resource()
    table = db.Table("finops_runs")
    resp = table.get_item(Key={"run_id": run_id, "sk": "METADATA"})
    item = resp.get("Item")
    return _deserialize(item) if item else None


def get_latest_run() -> dict | None:
    """Return the most recently started run (any status) via full table scan."""
    from boto3.dynamodb.types import TypeDeserializer

    client = get_client()
    resp = client.scan(TableName="finops_runs")
    raw_items = resp.get("Items", [])
    if not raw_items:
        return None

    deserializer = TypeDeserializer()
    items = [
        _deserialize({k: deserializer.deserialize(v) for k, v in item.items()})
        for item in raw_items
    ]
    return max(items, key=lambda x: x.get("started_at", ""))


def get_latest_completed_run() -> dict | None:
    """Query status-started_at-index GSI for the most recent completed run."""
    from boto3.dynamodb.types import TypeDeserializer

    client = get_client()
    resp = client.query(
        TableName="finops_runs",
        IndexName="status-started_at-index",
        KeyConditionExpression="#s = :s",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": {"S": "completed"}},
        ScanIndexForward=False,
        Limit=1,
    )
    items = resp.get("Items", [])
    if not items:
        return None

    deserializer = TypeDeserializer()
    item = {k: deserializer.deserialize(v) for k, v in items[0].items()}
    return _deserialize(item)


def create_run(
    run_id: str,
    trigger_type: str,
    triggered_by: str,
    okta_token: str,
    tenants_total: int,
) -> None:
    """Insert a new run record with status='running'."""
    db = get_dynamodb_resource()
    table = db.Table("finops_runs")
    now = datetime.now(timezone.utc).isoformat()
    table.put_item(Item=_serialize({
        "run_id": run_id,
        "sk": "METADATA",
        "trigger_type": trigger_type,
        "triggered_by": triggered_by,
        "okta_token": okta_token,
        "status": "running",
        "started_at": now,
        "completed_at": None,
        "tenants_total": tenants_total,
        "tenants_done": 0,
        "hosts_total": 0,
        "hosts_done": 0,
        "log": [],
    }))


def update_run_status(run_id: str, status: str, completed_at: str | None = None) -> None:
    """Update status (and optionally completed_at) for an existing run."""
    db = get_dynamodb_resource()
    table = db.Table("finops_runs")
    expr = "SET #s = :s"
    names = {"#s": "status"}
    values = {":s": status}
    if completed_at:
        expr += ", completed_at = :ca"
        values[":ca"] = completed_at
    table.update_item(
        Key={"run_id": run_id, "sk": "METADATA"},
        UpdateExpression=expr,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def get_org_summaries_for_run(run_id: str) -> list[dict]:
    """Query finops_org_summary by run_id via run_id-index GSI."""
    from boto3.dynamodb.types import TypeDeserializer

    client = get_client()
    resp = client.query(
        TableName="finops_org_summary",
        IndexName="run_id-index",
        KeyConditionExpression="run_id = :r",
        ExpressionAttributeValues={":r": {"S": run_id}},
    )
    deserializer = TypeDeserializer()
    items = [
        _deserialize({k: deserializer.deserialize(v) for k, v in item.items()})
        for item in resp.get("Items", [])
    ]
    return items


def get_host_results_for_run(run_id: str) -> list[dict]:
    """Query finops_host_results by run_id via run_id-index GSI.

    The SK is a composite 'host_id#run_id' — split it so callers see just host_id.
    """
    from boto3.dynamodb.types import TypeDeserializer

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
    # Split composite SK host_id#run_id → host_id
    for r in results:
        sk = r.get("sk", "")
        if "#" in sk:
            r["host_id"] = sk.split("#")[0]
    return results


if __name__ == "__main__":
    create_tables()
