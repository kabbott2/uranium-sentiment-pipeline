"""Daily activity series: posts, comments, and unique authors per day.

DuckDB aggregates the derived Parquet straight from R2 and the result lands
back in R2 under series/ — nothing touches local disk. Unique authors are
counted across posts and comments together (a per-day distinct over the
union, not the sum of two per-table distincts); deleted/removed accounts
carry a NULL author and are excluded by count(DISTINCT ...). Days with no
activity appear as explicit zero rows so the series has no gaps. The
trailing day or two only holds what the hourly collector has fetched so
far, so those counts are still rising.
"""

import io
import time

import pyarrow.parquet as pq

from . import duck, r2
from .config import Config


def run_series(cfg: Config, subreddit: str) -> None:
    sub = subreddit.lower()
    table = _daily_volume(cfg, sub)
    if table.num_rows == 0:
        raise SystemExit(f"no derived data found for subreddit {sub}")

    buffer = io.BytesIO()
    pq.write_table(table, buffer, compression="zstd")
    s3 = r2.client(cfg)
    parquet_key = f"series/{sub}/daily-volume.parquet"
    r2.put_bytes(
        s3, cfg.derived_bucket, parquet_key, buffer.getvalue(),
        "application/vnd.apache.parquet",
    )
    receipt = _receipt(sub, table)
    r2.put_json(s3, cfg.derived_bucket, f"series/{sub}/daily-volume-receipt.json", receipt)

    print(f"wrote {table.num_rows} days to {parquet_key}")
    print(f"range: {receipt['first_date']} .. {receipt['last_date']}")
    print(f"totals: {receipt['total_posts']} posts, {receipt['total_comments']} comments")
    _print_tail(table)


def _daily_volume(cfg: Config, sub: str):
    globs = ", ".join(
        f"'s3://{cfg.derived_bucket}/derived/{kind}/*/*/*.parquet'"
        for kind in ("posts", "comments")
    )
    sql = f"""
        WITH activity AS (
            SELECT to_timestamp(created_utc)::DATE AS day, kind, author
            FROM read_parquet([{globs}], hive_partitioning=1)
            WHERE subreddit = ?
        ),
        daily AS (
            SELECT day,
                   count(*) FILTER (WHERE kind = 'post') AS num_posts,
                   count(*) FILTER (WHERE kind = 'comment') AS num_comments,
                   count(DISTINCT author) AS num_unique_authors
            FROM activity
            GROUP BY day
        ),
        spine AS (
            SELECT unnest(generate_series(min(day), max(day), INTERVAL 1 DAY))::DATE AS day
            FROM daily
        )
        SELECT spine.day AS date,
               coalesce(num_posts, 0) AS num_posts,
               coalesce(num_comments, 0) AS num_comments,
               coalesce(num_unique_authors, 0) AS num_unique_authors
        FROM spine
        LEFT JOIN daily ON daily.day = spine.day
        ORDER BY date
    """
    return duck.connect(cfg).execute(sql, [sub]).fetch_arrow_table()


def _receipt(sub: str, table) -> dict:
    dates = table.column("date").to_pylist()
    return {
        "subreddit": sub,
        "days": table.num_rows,
        "first_date": str(dates[0]),
        "last_date": str(dates[-1]),
        "total_posts": _column_sum(table, "num_posts"),
        "total_comments": _column_sum(table, "num_comments"),
        "note": "trailing ~2 days are partial: the hourly collector is still filling them",
        "generated_at": int(time.time()),
    }


def _column_sum(table, name: str) -> int:
    return sum(table.column(name).to_pylist())


def _print_tail(table, n: int = 3) -> None:
    print(f"{'date':<11} {'posts':>6} {'comments':>9} {'authors':>8}")
    for row in table.slice(table.num_rows - n).to_pylist():
        print(
            f"{row['date']!s:<11} {row['num_posts']:>6} "
            f"{row['num_comments']:>9} {row['num_unique_authors']:>8}"
        )
