"""Build the derived Parquet layer from the raw archive.

One partition = (subreddit, month, kind). Each build of a partition reads
every raw object under it — the deterministic `-part-` files and the hourly
`-recent-` files together — dedups by id, projects, and overwrites a single
Parquet object in the derived bucket. Partitions are small (the archive's
peak month is 61k rows), so a partition is built in memory and never touches
local disk.

Incremental mode fingerprints each partition's raw objects (key, etag, size)
and rebuilds only partitions whose fingerprint changed since the manifest was
last written. That makes the hourly container run cheap: the collector's new
`-recent-` objects and the reconciler's rewrites both change the fingerprint,
anything untouched is skipped. `--full` ignores the manifest and rebuilds
everything, which is the path to take whenever cleaning rules change.
"""

import hashlib
import io
import re
from dataclasses import dataclass, field

import pyarrow as pa
import pyarrow.parquet as pq

from . import r2
from .config import Config
from .dedup import dedupe
from .records import project

RAW_PART = re.compile(
    r"^raw/(?P<sub>[^/]+)/(?P<month>\d{4}-\d{2})/(?P<kind>posts|comments)-(?:part|recent-\d{8}T\d{2}-part)-\d{4}\.jsonl\.gz$"
)

MANIFEST_KEY = "state/build-manifest.json"

SCHEMA = pa.schema(
    [
        ("id", pa.string()),
        ("kind", pa.string()),
        ("author", pa.string()),
        ("created_utc", pa.int64()),
        ("score", pa.int32()),
        ("upvote_ratio", pa.float64()),
        ("num_comments", pa.int32()),
        ("title", pa.string()),
        ("selftext", pa.string()),
        ("body", pa.string()),
        ("parent_id", pa.string()),
        ("link_id", pa.string()),
        ("is_self", pa.bool_()),
        ("over_18", pa.bool_()),
        ("stickied", pa.bool_()),
        ("distinguished", pa.string()),
        ("edited", pa.bool_()),
        ("author_flair_text", pa.string()),
        ("link_flair_text", pa.string()),
        ("removal_category", pa.string()),
        ("engagement_settled", pa.bool_()),
        ("retrieved_2nd_on", pa.int64()),
    ]
)


@dataclass
class Partition:
    subreddit: str
    month: str
    kind: str
    objects: list[dict] = field(default_factory=list)

    @property
    def label(self) -> str:
        return f"{self.subreddit}/{self.month}/{self.kind}"

    @property
    def derived_key(self) -> str:
        return (
            f"derived/{self.kind}/subreddit={self.subreddit}/"
            f"month={self.month}/data.parquet"
        )

    def fingerprint(self) -> str:
        lines = sorted(f"{o['Key']}:{o['ETag']}:{o['Size']}" for o in self.objects)
        return hashlib.sha256("\n".join(lines).encode()).hexdigest()


def discover_partitions(s3, cfg: Config, only_subreddit: str | None = None) -> list[Partition]:
    prefix = f"raw/{only_subreddit.lower()}/" if only_subreddit else "raw/"
    found: dict[str, Partition] = {}
    for obj in r2.list_objects(s3, cfg.raw_bucket, prefix):
        match = RAW_PART.match(obj["Key"])
        if not match:
            continue
        label = f"{match['sub']}/{match['month']}/{match['kind']}"
        partition = found.setdefault(
            label, Partition(match["sub"], match["month"], match["kind"])
        )
        partition.objects.append(obj)
    return sorted(found.values(), key=lambda p: p.label)


def build_partition(s3, cfg: Config, partition: Partition) -> int:
    """Read, dedup, project, write. Returns the unique-id row count."""
    def raw_rows():
        for obj in sorted(partition.objects, key=lambda o: o["Key"]):
            yield from r2.read_jsonl_gz(s3, cfg.raw_bucket, obj["Key"])

    rows = [
        project(row, partition.kind, cfg.settle_exempt_before)
        for row in dedupe(raw_rows())
    ]
    rows.sort(key=lambda r: (r["created_utc"] or 0, r["id"]))

    table = pa.Table.from_pylist(rows, schema=SCHEMA)
    buffer = io.BytesIO()
    pq.write_table(table, buffer, compression="zstd")
    r2.put_bytes(
        s3, cfg.derived_bucket, partition.derived_key, buffer.getvalue(),
        "application/vnd.apache.parquet",
    )
    return len(rows)


def run_build(cfg: Config, full: bool, only_subreddit: str | None = None) -> None:
    s3 = r2.client(cfg)
    partitions = discover_partitions(s3, cfg, only_subreddit)
    manifest = r2.read_json(s3, cfg.derived_bucket, MANIFEST_KEY) or {}

    stale = [
        p for p in partitions
        if full or manifest.get(p.label) != p.fingerprint()
    ]
    print(f"{len(partitions)} partitions in raw, {len(stale)} to build")

    for partition in stale:
        count = build_partition(s3, cfg, partition)
        manifest[partition.label] = partition.fingerprint()
        # Persist after every partition so an interrupted run resumes where it
        # stopped instead of rebuilding what already landed.
        r2.put_json(s3, cfg.derived_bucket, MANIFEST_KEY, manifest)
        print(f"  built {partition.label}: {count} unique ids")

    if not stale:
        print("derived layer already current")
