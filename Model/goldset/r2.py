"""Thin R2 access over the S3 protocol. Nothing touches local disk."""

import json

import boto3
from botocore.config import Config as BotoConfig

from .config import Config


def client(cfg: Config):
    return boto3.client(
        "s3",
        endpoint_url=cfg.endpoint,
        aws_access_key_id=cfg.access_key_id,
        aws_secret_access_key=cfg.secret_access_key,
        region_name="auto",
        config=BotoConfig(retries={"max_attempts": 5, "mode": "adaptive"}),
    )


def exists(s3, bucket: str, key: str) -> bool:
    try:
        s3.head_object(Bucket=bucket, Key=key)
        return True
    except s3.exceptions.ClientError:
        return False


def read_jsonl(s3, bucket: str, key: str) -> list[dict]:
    body = s3.get_object(Bucket=bucket, Key=key)["Body"].read().decode("utf-8")
    return [json.loads(line) for line in body.splitlines() if line.strip()]


def put_jsonl(s3, bucket: str, key: str, rows: list[dict]) -> None:
    data = "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n"
    s3.put_object(Bucket=bucket, Key=key, Body=data.encode(), ContentType="application/x-ndjson")


def put_json(s3, bucket: str, key: str, value: dict) -> None:
    data = json.dumps(value, indent=1).encode()
    s3.put_object(Bucket=bucket, Key=key, Body=data, ContentType="application/json")


def put_bytes(s3, bucket: str, key: str, data: bytes, content_type: str) -> None:
    s3.put_object(Bucket=bucket, Key=key, Body=data, ContentType=content_type)
