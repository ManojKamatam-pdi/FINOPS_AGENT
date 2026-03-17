"""
DynamoDB table setup — run once to create local tables.
Usage: python dynamodb.py
"""
import os
import boto3
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
    existing = [t["TableName"] for t in client.list_tables()["TableNames"]]

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
            print(f"  ✓ {name} already exists")
            continue
        # Remove GSI ProvisionedThroughput for PAY_PER_REQUEST tables
        if table_def.get("BillingMode") == "PAY_PER_REQUEST":
            for gsi in table_def.get("GlobalSecondaryIndexes", []):
                gsi.pop("ProvisionedThroughput", None)
        client.create_table(**table_def)
        print(f"  ✓ Created {name}")

    print("All tables ready.")


if __name__ == "__main__":
    create_tables()
