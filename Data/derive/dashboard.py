"""Dashboard aggregates: daily sentiment series, per-tag series, and the
compact JSON the dashboard Worker serves.

DuckDB joins the derived and enrich layers in place over R2. The exuberance
gauge is computed here — and only here — so it is plain unit-testable Python;
its definition and rationale live in Dashboard/DASHBOARD.md. The trailing
PARTIAL_DAYS are still filling with hourly collector output, so the gauge
reads as of last_date − PARTIAL_DAYS and the JSON marks the boundary for the
chart to shade.
"""

import io
import json
import math
import time
from datetime import date, timedelta

import pyarrow.parquet as pq

from . import duck, r2
from .config import Config

PARTIAL_DAYS = 2
WINDOW_7D = 7
BASELINE_DAYS = 365
TAG_BASELINE_DAYS = 90
TAG_DAILY_TAIL_DAYS = 180
# A z-score against fewer baseline points than this is noise, not a reading.
MIN_BASELINE_POINTS = 60
CHANGE_PERIODS = {"1W": 7, "1M": 30, "3M": 91, "1Y": 365}
ANALOG_WINDOW = 30
# The analog match must end this long before asof so "most similar period"
# can never be the current period overlapping itself.
ANALOG_GAP = 60


def run_dashboard(cfg: Config, subreddit: str) -> None:
    sub = subreddit.lower()
    con = duck.connect(cfg)
    daily_table = _query(con, cfg, sub, _DAILY_SQL)
    daily = daily_table.to_pylist()
    if not daily:
        raise SystemExit(f"no enriched data found for subreddit {sub}")
    tags_table = _query(con, cfg, sub, _TAGS_SQL)
    tag_daily = tags_table.to_pylist()
    versions = _versions(con, cfg, sub)

    s3 = r2.client(cfg)
    _write_parquet(s3, cfg, sub, "daily-sentiment", daily_table, daily)
    _write_parquet(s3, cfg, sub, "daily-tags", tags_table, tag_daily)

    generated_at = int(time.time())
    series = _series_payload(sub, daily, versions, generated_at)
    tags = _tags_payload(sub, tag_daily, versions, generated_at)
    _put_compact_json(s3, cfg, f"dashboard/{sub}/series.json", series)
    _put_compact_json(s3, cfg, f"dashboard/{sub}/tags.json", tags)

    gauge = series["gauge"]
    print(f"{sub}: {len(daily)} days, {len(tags['tags'])} active tags")
    if gauge:
        print(f"gauge {gauge['value']:+.2f} ({gauge['band']}) as of {gauge['asof']} — "
              f"volume_z {gauge['volume_z']:+.2f}, sentiment_z {gauge['sentiment_z']:+.2f}")


def _globs(cfg: Config, layer: str, kind: str) -> str:
    return f"s3://{cfg.derived_bucket}/{layer}/{kind}/*/*/*.parquet"


def _joined_sql(cfg: Config) -> str:
    parts = []
    for kind in ("posts", "comments"):
        parts.append(f"""
            SELECT to_timestamp(d.created_utc)::DATE AS day, d.kind, d.author,
                   e.tags, e.vader_compound, e.vader_label
            FROM read_parquet('{_globs(cfg, "derived", kind)}', hive_partitioning=1) d
            JOIN read_parquet('{_globs(cfg, "enrich", kind)}', hive_partitioning=1) e
              USING (id)
            WHERE d.subreddit = ? AND e.subreddit = ?
        """)
    return " UNION ALL ".join(parts)


_DAILY_SQL = """
    WITH joined AS ({joined}),
    daily AS (
        SELECT day,
               count(*) FILTER (WHERE kind = 'post') AS num_posts,
               count(*) FILTER (WHERE kind = 'comment') AS num_comments,
               count(DISTINCT author) AS num_unique_authors,
               count(vader_compound) AS num_scored,
               round(avg(vader_compound), 4) AS mean_compound,
               round(median(vader_compound), 4) AS median_compound,
               round(count(*) FILTER (WHERE vader_label = 'pos')
                     / nullif(count(vader_compound), 0), 4) AS pct_pos,
               round(count(*) FILTER (WHERE vader_label = 'neg')
                     / nullif(count(vader_compound), 0), 4) AS pct_neg,
               round(count(*) FILTER (WHERE vader_label = 'neu')
                     / nullif(count(vader_compound), 0), 4) AS pct_neu
        FROM joined
        GROUP BY day
    ),
    spine AS (
        SELECT unnest(generate_series(min(day), max(day), INTERVAL 1 DAY))::DATE AS day
        FROM daily
    )
    SELECT spine.day AS date,
           coalesce(num_posts, 0) AS num_posts,
           coalesce(num_comments, 0) AS num_comments,
           coalesce(num_unique_authors, 0) AS num_unique_authors,
           coalesce(num_scored, 0) AS num_scored,
           mean_compound, median_compound, pct_pos, pct_neg, pct_neu
    FROM spine
    LEFT JOIN daily ON daily.day = spine.day
    ORDER BY date
"""

_TAGS_SQL = """
    WITH joined AS ({joined}),
    exploded AS (
        SELECT day, kind, unnest(tags) AS tag, vader_compound, vader_label
        FROM joined
    )
    SELECT day AS date, tag,
           count(*) AS num_items,
           count(*) FILTER (WHERE kind = 'post') AS num_posts,
           count(*) FILTER (WHERE kind = 'comment') AS num_comments,
           round(avg(vader_compound), 4) AS mean_compound,
           round(count(*) FILTER (WHERE vader_label = 'pos')
                 / nullif(count(vader_compound), 0), 4) AS pct_pos,
           round(count(*) FILTER (WHERE vader_label = 'neg')
                 / nullif(count(vader_compound), 0), 4) AS pct_neg
    FROM exploded
    GROUP BY day, tag
    ORDER BY date, tag
"""


def _query(con, cfg: Config, sub: str, sql_template: str):
    sql = sql_template.format(joined=_joined_sql(cfg))
    return con.execute(sql, [sub, sub, sub, sub]).fetch_arrow_table()


def _versions(con, cfg: Config, sub: str) -> dict:
    row = con.execute(
        f"""SELECT enrich_version FROM
            read_parquet('{_globs(cfg, "enrich", "comments")}', hive_partitioning=1)
            WHERE subreddit = ? LIMIT 1""",
        [sub],
    ).fetchone()
    if row is None:
        raise SystemExit(f"no enrich rows for {sub} — run enrich first")
    lexicon, tags = row[0].split("+")
    return {"lexicon": lexicon, "tags": tags}


def _write_parquet(s3, cfg: Config, sub: str, name: str, table,
                   rows: list[dict]) -> None:
    buffer = io.BytesIO()
    pq.write_table(table, buffer, compression="zstd")
    key = f"series/{sub}/{name}.parquet"
    r2.put_bytes(s3, cfg.derived_bucket, key, buffer.getvalue(),
                 "application/vnd.apache.parquet")
    r2.put_json(s3, cfg.derived_bucket, f"series/{sub}/{name}-receipt.json", {
        "subreddit": sub,
        "rows": len(rows),
        "first_date": str(rows[0]["date"]),
        "last_date": str(rows[-1]["date"]),
        "note": f"trailing ~{PARTIAL_DAYS} days are partial: "
                "the hourly collector is still filling them",
        "generated_at": int(time.time()),
    })


def _put_compact_json(s3, cfg: Config, key: str, value: dict) -> None:
    data = json.dumps(value, separators=(",", ":")).encode()
    r2.put_bytes(s3, cfg.derived_bucket, key, data, "application/json")


def _series_payload(sub: str, daily: list[dict], versions: dict,
                    generated_at: int) -> dict:
    partial_after = daily[-1]["date"] - timedelta(days=PARTIAL_DAYS)
    return {
        "subreddit": sub,
        "generated_at": generated_at,
        "versions": versions,
        "partial_after": str(partial_after),
        "daily": [
            {
                "d": str(row["date"]),
                "p": row["num_posts"],
                "c": row["num_comments"],
                "a": row["num_unique_authors"],
                "s": row["mean_compound"],
                "pos": row["pct_pos"],
                "neg": row["pct_neg"],
            }
            for row in daily
        ],
        "gauge": compute_gauge(daily),
        "volume_changes": compute_volume_changes(daily),
        "analog": compute_analog(daily),
    }


def compute_volume_changes(daily: list[dict]) -> dict:
    """Mean daily items over each period (ending asof) vs the period before."""
    asof_index = len(daily) - 1 - PARTIAL_DAYS
    totals = [row["num_posts"] + row["num_comments"] for row in daily[: asof_index + 1]]
    changes = {}
    for name, days in CHANGE_PERIODS.items():
        if len(totals) < 2 * days:
            changes[name] = None
            continue
        current = sum(totals[-days:]) / days
        previous = sum(totals[-2 * days: -days]) / days
        changes[name] = {
            "current": round(current, 1),
            "previous": round(previous, 1),
            "delta": round(current / previous - 1, 3) if previous else None,
        }
    return changes


def compute_analog(daily: list[dict]) -> dict | None:
    """The past ANALOG_WINDOW-day stretch most like the current one, compared
    on the same footing the gauge uses: rolling volume and sentiment z-scores."""
    asof_index = len(daily) - 1 - PARTIAL_DAYS
    volumes = [math.log1p(row["num_posts"] + row["num_comments"]) for row in daily]
    sentiments = [row["mean_compound"] for row in daily]
    z_volume = [_trailing_zscore(volumes, i) for i in range(asof_index + 1)]
    z_sentiment = [_trailing_zscore(sentiments, i) for i in range(asof_index + 1)]

    def window(zs, end):
        values = zs[end - ANALOG_WINDOW + 1: end + 1]
        return None if any(v is None for v in values) else values

    current_v = window(z_volume, asof_index)
    current_s = window(z_sentiment, asof_index)
    if current_v is None or current_s is None:
        return None

    best = None
    for end in range(ANALOG_WINDOW - 1, asof_index - ANALOG_GAP + 1):
        past_v, past_s = window(z_volume, end), window(z_sentiment, end)
        if past_v is None or past_s is None:
            continue
        distance = math.sqrt(
            sum((a - b) ** 2 for a, b in zip(current_v + current_s, past_v + past_s))
            / (2 * ANALOG_WINDOW)
        )
        if best is None or distance < best[0]:
            best = (distance, end)
    if best is None:
        return None

    distance, end = best
    value = max(-3.0, min(3.0, (z_volume[end] + z_sentiment[end]) / 2))
    return {
        "start": str(daily[end - ANALOG_WINDOW + 1]["date"]),
        "end": str(daily[end]["date"]),
        "band": band(value),
        "similarity": round(1 / (1 + distance), 3),
        "note": f"closest {ANALOG_WINDOW}d match in history",
    }


def compute_gauge(daily: list[dict]) -> dict | None:
    """The exuberance gauge — definition in Dashboard/DASHBOARD.md."""
    asof_index = len(daily) - 1 - PARTIAL_DAYS
    volumes = [math.log1p(row["num_posts"] + row["num_comments"]) for row in daily]
    sentiments = [row["mean_compound"] for row in daily]

    volume_z = _trailing_zscore(volumes, asof_index)
    sentiment_z = _trailing_zscore(sentiments, asof_index)
    if volume_z is None or sentiment_z is None:
        return None

    value = max(-3.0, min(3.0, (volume_z + sentiment_z) / 2))
    vol_window = [row["num_posts"] + row["num_comments"]
                  for row in daily[max(0, asof_index - WINDOW_7D + 1): asof_index + 1]]
    all_means = [m for m in (_window_mean(volumes, i) for i in range(asof_index + 1))
                 if m is not None]
    current = _window_mean(volumes, asof_index)
    return {
        "value": round(value, 2),
        "volume_z": round(volume_z, 2),
        "sentiment_z": round(sentiment_z, 2),
        "band": band(value),
        "vol_7d": round(sum(vol_window) / len(vol_window), 1),
        "vol_pctile_alltime": round(
            sum(m <= current for m in all_means) / len(all_means), 3),
        "sent_7d": _window_mean(sentiments, asof_index, digits=4),
        "asof": str(daily[asof_index]["date"]),
    }


def band(value: float) -> str:
    if value <= -1.5:
        return "peak despair"
    if value <= -0.5:
        return "despondent"
    if value < 0.5:
        return "neutral"
    if value < 1.5:
        return "excited"
    return "peak exuberance"


def _window_mean(values: list, i: int, window: int = WINDOW_7D,
                 digits: int | None = None) -> float | None:
    if i < window - 1:
        return None
    present = [v for v in values[i - window + 1: i + 1] if v is not None]
    if not present:
        return None
    mean = sum(present) / len(present)
    return round(mean, digits) if digits is not None else mean


def _trailing_zscore(values: list, asof_index: int) -> float | None:
    """z of the 7d mean at asof against the prior BASELINE_DAYS of 7d means."""
    if asof_index < 0:
        return None
    current = _window_mean(values, asof_index)
    if current is None:
        return None
    baseline = [
        m for m in (
            _window_mean(values, i)
            for i in range(max(0, asof_index - BASELINE_DAYS + 1), asof_index + 1)
        )
        if m is not None
    ]
    if len(baseline) < MIN_BASELINE_POINTS:
        return None
    mean = sum(baseline) / len(baseline)
    variance = sum((m - mean) ** 2 for m in baseline) / len(baseline)
    if variance == 0:
        return 0.0
    return (current - mean) / math.sqrt(variance)


def _tags_payload(sub: str, tag_daily: list[dict], versions: dict,
                  generated_at: int) -> dict:
    if not tag_daily:
        return {"subreddit": sub, "generated_at": generated_at,
                "versions": versions, "asof": None, "tags": []}
    by_tag: dict[str, list[dict]] = {}
    for row in tag_daily:
        by_tag.setdefault(row["tag"], []).append(row)
    last_date = max(row["date"] for row in tag_daily)
    asof = last_date - timedelta(days=PARTIAL_DAYS)

    tags = [_tag_summary(key, rows, asof) for key, rows in by_tag.items()]
    tags.sort(key=lambda t: t["items_7d"], reverse=True)
    return {
        "subreddit": sub,
        "generated_at": generated_at,
        "versions": versions,
        "asof": str(asof),
        "tags": tags,
    }


def _tag_summary(key: str, rows: list[dict], asof: date) -> dict:
    full = [r for r in rows if r["date"] <= asof]
    recent = [r for r in full if r["date"] > asof - timedelta(days=WINDOW_7D)]
    baseline = [r for r in full if r["date"] > asof - timedelta(days=TAG_BASELINE_DAYS)]

    items_7d = sum(r["num_items"] for r in recent)
    baseline_daily = sum(r["num_items"] for r in baseline) / TAG_BASELINE_DAYS
    delta = (items_7d / WINDOW_7D) / baseline_daily - 1 if baseline_daily else None

    # Sparse rows: absent days are zeros, so build the dense daily count series
    # for the z-score the same way the main gauge sees volume.
    counts_by_date = {r["date"]: r["num_items"] for r in full}
    if full:
        first = min(counts_by_date)
        days = (asof - first).days + 1
        dense = [math.log1p(counts_by_date.get(first + timedelta(days=i), 0))
                 for i in range(days)]
        volume_z = _trailing_zscore(dense, len(dense) - 1)
    else:
        volume_z = None

    weighted = [(r["mean_compound"], r["num_items"]) for r in recent
                if r["mean_compound"] is not None]
    total = sum(n for _, n in weighted)
    sent_7d = round(sum(s * n for s, n in weighted) / total, 4) if total else None

    return {
        "key": key,
        "items_7d": items_7d,
        "delta_vs_90d": round(delta, 3) if delta is not None else None,
        "sent_7d": sent_7d,
        "volume_z": round(volume_z, 2) if volume_z is not None else None,
        "weekly": _weekly(full),
        "daily": [
            [str(r["date"]), r["num_items"], r["mean_compound"]]
            for r in full if r["date"] > asof - timedelta(days=TAG_DAILY_TAIL_DAYS)
        ],
    }


def _weekly(rows: list[dict]) -> list[list]:
    weeks: dict[date, list] = {}
    for row in rows:
        start = row["date"] - timedelta(days=row["date"].weekday())
        bucket = weeks.setdefault(start, [0, 0.0, 0])
        bucket[0] += row["num_items"]
        if row["mean_compound"] is not None:
            bucket[1] += row["mean_compound"] * row["num_items"]
            bucket[2] += row["num_items"]
    return [
        [str(start), items, round(weighted / scored, 4) if scored else None]
        for start, (items, weighted, scored) in sorted(weeks.items())
    ]
