"""Thin R2 access over the S3 protocol. Nothing touches local disk."""

import gzip
import io
import json
from typing import Iterator

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


def list_objects(s3, bucket: str, prefix: str) -> Iterator[dict]:
    """Yield {Key, ETag, Size} for every object under a prefix."""
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        yield from page.get("Contents", [])


def list_subdirs(s3, bucket: str, prefix: str) -> list[str]:
    """Immediate child 'directories' under a prefix, e.g. subreddits under raw/."""
    paginator = s3.get_paginator("list_objects_v2")
    names = []
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix, Delimiter="/"):
        for cp in page.get("CommonPrefixes", []):
            names.append(cp["Prefix"][len(prefix) :].rstrip("/"))
    return names


def read_jsonl_gz(s3, bucket: str, key: str) -> Iterator[dict]:
    """Stream-parse one gzipped NDJSON object without writing it to disk."""
    body = s3.get_object(Bucket=bucket, Key=key)["Body"]
    with gzip.open(body, mode="rt", encoding="utf-8") as lines:
        for line in lines:
            line = line.strip()
            if line:
                yield json.loads(line)


def read_json(s3, bucket: str, key: str) -> dict | None:
    try:
        return json.loads(s3.get_object(Bucket=bucket, Key=key)["Body"].read())
    except s3.exceptions.NoSuchKey:
        return None


def put_bytes(s3, bucket: str, key: str, data: bytes, content_type: str) -> None:
    s3.put_object(Bucket=bucket, Key=key, Body=data, ContentType=content_type)


def put_json(s3, bucket: str, key: str, value: dict) -> None:
    put_bytes(s3, bucket, key, json.dumps(value, indent=1).encode(), "application/json")


def get_parquet_num_rows(s3, bucket: str, key: str) -> int:
    """Row count from a Parquet footer; fetched whole (partitions are small)."""
    import pyarrow.parquet as pq

    data = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    return pq.ParquetFile(io.BytesIO(data)).metadata.num_rows
