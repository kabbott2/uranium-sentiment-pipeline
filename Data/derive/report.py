"""Sanity chart: posts and comments per month, derived vs receipts.

DATA.md's first check — holes in this table mean holes in the archive. The
receipt column counts rows *written* including the deliberate page-boundary
overlap, so it exceeds the unique-id count by design; the derived column is
the authority. A receipt showing "-" means no backfill/reconcile receipt
exists yet (a month only the hourly collector has touched).
"""

import re
from collections import defaultdict

from . import r2
from .config import Config

DERIVED_KEY = re.compile(
    r"^derived/(?P<kind>posts|comments)/subreddit=(?P<sub>[^/]+)/month=(?P<month>\d{4}-\d{2})/data\.parquet$"
)


def run_report(cfg: Config, only_subreddit: str | None = None) -> None:
    s3 = r2.client(cfg)
    months: dict[str, dict[str, dict[str, int]]] = defaultdict(dict)

    for obj in r2.list_objects(s3, cfg.derived_bucket, "derived/"):
        match = DERIVED_KEY.match(obj["Key"])
        if not match:
            continue
        if only_subreddit and match["sub"] != only_subreddit.lower():
            continue
        unique = r2.get_parquet_num_rows(s3, cfg.derived_bucket, obj["Key"])
        months[match["sub"]].setdefault(match["month"], {})[match["kind"]] = unique

    for subreddit in sorted(months):
        print(f"\nr/{subreddit}")
        print(f"{'month':<9} {'posts':>7} {'receipt':>8} {'comments':>9} {'receipt':>8}")
        totals = {"posts": 0, "comments": 0}
        for month in sorted(months[subreddit]):
            cells = [f"{month:<9}"]
            for kind in ("posts", "comments"):
                unique = months[subreddit][month].get(kind, 0)
                totals[kind] += unique
                receipt = r2.read_json(
                    s3, cfg.raw_bucket, f"receipts/{subreddit}/{month}-{kind}.json"
                )
                written = str(receipt["rows"]) if receipt else "-"
                cells.append(f"{unique:>7} {written:>8}" if kind == "posts" else f"{unique:>9} {written:>8}")
            print(" ".join(cells))
        print(f"{'total':<9} {totals['posts']:>7} {'':>8} {totals['comments']:>9}")
