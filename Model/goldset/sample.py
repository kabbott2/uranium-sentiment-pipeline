"""Stratified sample of ~450 items for the gold label set.

DuckDB scans the derived Parquet in R2 (metadata + keyword hits only, never
pulling the full corpus text down); allocation then runs in plain Python with
a seeded RNG so the same seed always yields the same sample. Strata and the
reasoning behind them are documented in the sample receipt.
"""

import random
import time

import duckdb

from . import r2
from .config import GOLD_PREFIX, SAMPLE_SEED, TAGS_PATH, Config
from .tags import Tag, load_taxonomy, loose_pattern, strict_pattern

POSTS_TOTAL = 150
COMMENTS_TOTAL = 300
ERAS = ["2021", "2022", "2023", "2024", "2025", "2026"]
# Short sarcastic one-liners are the hard case; length gets its own axis.
SHORT_WORDS, LONG_WORDS = 25, 150
TAG_MIN = 5           # minimum selected items per tag with any candidates
NO_HIT_QUOTA = {"post": 10, "comment": 30}   # no-keyword-hit slice: tests
REMOVED_POST_MIN = 10                        # coreference and OFF_TOPIC


def run_sample(cfg: Config, force: bool = False) -> None:
    taxonomy = load_taxonomy(TAGS_PATH)
    s3 = r2.client(cfg)
    sample_key = f"{GOLD_PREFIX}/sample.jsonl"
    if not force and r2.exists(s3, cfg.derived_bucket, sample_key):
        raise SystemExit(f"{sample_key} already exists; pass --force to resample")

    con = _connect(cfg)
    candidates = _scan_candidates(con, cfg, taxonomy)
    print(f"candidates: {len(candidates)}")
    selected = _allocate(candidates, random.Random(SAMPLE_SEED))
    rows = _fetch_records(con, cfg, selected)

    r2.put_jsonl(s3, cfg.derived_bucket, sample_key, rows)
    r2.put_json(s3, cfg.derived_bucket, f"{GOLD_PREFIX}/sample-receipt.json", _receipt(rows))
    print(f"wrote {len(rows)} rows to {sample_key}")


def _connect(cfg: Config):
    host = cfg.endpoint.removeprefix("https://")
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute("SET TimeZone='UTC'")
    con.execute(
        f"""CREATE SECRET r2 (TYPE s3, KEY_ID '{cfg.access_key_id}',
            SECRET '{cfg.secret_access_key}', ENDPOINT '{host}', URL_STYLE 'path')"""
    )
    return con


def _parquet_glob(cfg: Config, kind: str) -> str:
    return f"s3://{cfg.derived_bucket}/derived/{kind}/*/*/*.parquet"


def _tag_hit_sql(taxonomy: list[Tag]) -> str:
    """One VARCHAR column of ';'-joined tag keys whose search terms hit."""
    cases = []
    for tag in taxonomy:
        patterns = [p for p in (loose_pattern(tag), strict_pattern(tag)) if p]
        if not patterns:
            continue
        cond = " OR ".join(
            f"regexp_matches(txt, '{p.replace(chr(39), chr(39) * 2)}')" for p in patterns
        )
        cases.append(f"CASE WHEN {cond} THEN '{tag.key}' END")
    return f"concat_ws(';', {', '.join(cases)})"


def _scan_candidates(con, cfg: Config, taxonomy: list[Tag]) -> list[dict]:
    candidates = []
    for kind, text_expr, removed_expr in (
        ("posts", "concat_ws(' ', title, selftext)", "removal_category IS NOT NULL"),
        ("comments", "body", "FALSE"),
    ):
        sql = f"""
            WITH src AS (
                SELECT id, created_utc, {text_expr} AS txt, {removed_expr} AS removed
                FROM read_parquet('{_parquet_glob(cfg, kind)}', hive_partitioning=1)
                WHERE subreddit = 'uraniumsqueeze'
            )
            SELECT id, created_utc,
                   strftime(to_timestamp(created_utc), '%Y') AS era,
                   len(string_split_regex(trim(txt), '\\s+')) AS words,
                   removed,
                   {_tag_hit_sql(taxonomy)} AS tags_hit
            FROM src
            WHERE txt IS NOT NULL AND trim(txt) != ''
        """
        for id_, created, era, words, removed, tags_hit in con.execute(sql).fetchall():
            candidates.append(
                {
                    "id": id_,
                    "kind": kind.rstrip("s"),
                    "created_utc": created,
                    "era": era,
                    "length": _length_bucket(words),
                    "words": words,
                    "removed": removed,
                    "tags_hit": tags_hit.split(";") if tags_hit else [],
                }
            )
    return candidates


def _length_bucket(words: int) -> str:
    if words < SHORT_WORDS:
        return "short"
    return "long" if words > LONG_WORDS else "medium"


def _allocate(candidates: list[dict], rng: random.Random) -> list[dict]:
    """Deterministic quota allocation. Order of passes:

    1. no-keyword-hit slice (coreference + off-topic test cases)
    2. removed title-only posts
    3. per-tag minimums, rarest tag first
    4. fill remaining (kind, era) quotas, balancing length buckets
    """
    # Sort before shuffling so the outcome depends only on the seed, not on
    # whatever row order the Parquet scan happened to return.
    candidates = sorted(candidates, key=lambda c: (c["kind"], c["id"]))
    rng.shuffle(candidates)
    totals = {"post": POSTS_TOTAL, "comment": COMMENTS_TOTAL}
    era_quota = {
        (kind, era): total // len(ERAS) for kind, total in totals.items() for era in ERAS
    }
    filled: dict[tuple[str, str], int] = {cell: 0 for cell in era_quota}
    chosen: dict[str, dict] = {}

    def take(cand: dict, reason: str) -> None:
        cand["pick_reason"] = reason
        chosen[cand["id"]] = cand
        filled[(cand["kind"], cand["era"])] += 1

    def cell_deficit(cand: dict) -> int:
        cell = (cand["kind"], cand["era"])
        return era_quota[cell] - filled[cell]

    for kind, quota in NO_HIT_QUOTA.items():
        pool = [c for c in candidates if c["kind"] == kind and not c["tags_hit"]]
        for cand in _spread(pool, quota, cell_deficit):
            take(cand, "no_hit")

    pool = [c for c in candidates if c["removed"] and c["id"] not in chosen]
    for cand in _spread(pool, REMOVED_POST_MIN, cell_deficit):
        take(cand, "removed")

    by_tag: dict[str, list[dict]] = {}
    for cand in candidates:
        for key in cand["tags_hit"]:
            by_tag.setdefault(key, []).append(cand)
    for key in sorted(by_tag, key=lambda k: len(by_tag[k])):
        already = sum(1 for c in chosen.values() if key in c["tags_hit"])
        pool = [c for c in by_tag[key] if c["id"] not in chosen]
        for cand in _spread(pool, TAG_MIN - already, cell_deficit):
            take(cand, f"tag:{key}")

    target = sum(totals.values())
    pools: dict[tuple[str, str, str], list[dict]] = {}
    for cand in candidates:
        if cand["id"] not in chosen:
            pools.setdefault((cand["kind"], cand["era"], cand["length"]), []).append(cand)
    while len(chosen) < target:
        open_cells = [
            cell for cell in era_quota
            if era_quota[cell] - filled[cell] > 0
            and any(pools.get((*cell, ln)) for ln in ("short", "medium", "long"))
        ]
        if not open_cells:
            break
        cell = max(open_cells, key=lambda c: era_quota[c] - filled[c])
        length = min(
            (ln for ln in ("short", "medium", "long") if pools.get((*cell, ln))),
            key=lambda ln: sum(1 for c in chosen.values()
                               if (c["kind"], c["era"], c["length"]) == (*cell, ln)),
        )
        take(pools[(*cell, length)].pop(), "fill")
    # Era quotas can run dry (e.g. sparse 2026); top up anywhere to hit the target.
    leftovers = [c for c in candidates if c["id"] not in chosen]
    for cand in leftovers[: target - len(chosen)]:
        take(cand, "topup")
    return list(chosen.values())


def _spread(pool: list[dict], want: int, cell_deficit) -> list[dict]:
    """Pick up to `want` items, preferring the least-filled (kind, era) cells."""
    picked = []
    remaining = list(pool)
    for _ in range(max(0, want)):
        if not remaining:
            break
        best = max(remaining, key=cell_deficit)
        remaining.remove(best)
        picked.append(best)
    return picked


def _fetch_records(con, cfg: Config, selected: list[dict]) -> list[dict]:
    by_kind = {"post": [], "comment": []}
    for cand in selected:
        by_kind[cand["kind"]].append(cand["id"])
    meta = {c["id"]: c for c in selected}
    rows = []

    if by_kind["post"]:
        sql = f"""
            SELECT id, title, selftext, removal_category
            FROM read_parquet('{_parquet_glob(cfg, "posts")}', hive_partitioning=1)
            WHERE subreddit = 'uraniumsqueeze' AND id IN ({_placeholders(by_kind["post"])})
        """
        for id_, title, selftext, removal in con.execute(sql, by_kind["post"]).fetchall():
            text = f"{title}\n\n{selftext}" if selftext else (title or "")
            rows.append(_row(meta[id_], text, None, removal))

    if by_kind["comment"]:
        ids = by_kind["comment"]
        sql = f"""
            WITH c AS (
                SELECT id, body, link_id, parent_id
                FROM read_parquet('{_parquet_glob(cfg, "comments")}', hive_partitioning=1)
                WHERE subreddit = 'uraniumsqueeze' AND id IN ({_placeholders(ids)})
            ),
            p AS (
                SELECT id, title
                FROM read_parquet('{_parquet_glob(cfg, "posts")}', hive_partitioning=1)
                WHERE subreddit = 'uraniumsqueeze'
            ),
            parents AS (
                SELECT id, body
                FROM read_parquet('{_parquet_glob(cfg, "comments")}', hive_partitioning=1)
                WHERE subreddit = 'uraniumsqueeze'
            )
            SELECT c.id, c.body, p.title, parents.body
            FROM c
            LEFT JOIN p ON p.id = replace(c.link_id, 't3_', '')
            LEFT JOIN parents ON c.parent_id LIKE 't1_%'
                             AND parents.id = replace(c.parent_id, 't1_', '')
        """
        for id_, body, post_title, parent_body in con.execute(sql, ids).fetchall():
            context = None
            if post_title:
                context = f"Post title: {post_title}"
                if parent_body:
                    context += f"\nParent comment: {parent_body}"
            rows.append(_row(meta[id_], body or "", context, None))

    rows.sort(key=lambda r: r["doc_id"])
    return rows


def _placeholders(ids: list[str]) -> str:
    return ", ".join("?" for _ in ids)


def _row(cand: dict, text: str, context: str | None, removal: str | None) -> dict:
    return {
        "source": "reddit",
        "doc_id": cand["id"],
        "doc_type": cand["kind"],
        "created_utc": cand["created_utc"],
        "era": cand["era"],
        "length": cand["length"],
        "removal_category": removal,
        "keyword_tags": sorted(cand["tags_hit"]),
        "pick_reason": cand["pick_reason"],
        "text": text,
        "context_text": context,
    }


def _receipt(rows: list[dict]) -> dict:
    def count_by(field):
        counts: dict[str, int] = {}
        for row in rows:
            counts[str(row[field])] = counts.get(str(row[field]), 0) + 1
        return dict(sorted(counts.items()))

    tag_counts: dict[str, int] = {}
    for row in rows:
        for key in row["keyword_tags"]:
            tag_counts[key] = tag_counts.get(key, 0) + 1
    return {
        "seed": SAMPLE_SEED,
        "total": len(rows),
        "by_kind": count_by("doc_type"),
        "by_era": count_by("era"),
        "by_length": count_by("length"),
        "by_reason": count_by("pick_reason"),
        "keyword_tag_counts": dict(sorted(tag_counts.items())),
        "generated_at": int(time.time()),
    }
