"""Bulk teacher scoring: DeepSeek pseudo-labels over corpus slices.

Two jobs at once: the Phase-3 LLM side table for the spikiest windows
(the 2026-08-19 decision in FINDINGS.md), and the teacher set the v2 VADER
lexicon is fitted against (distillation, inside the pre-approved teacher
budget). Slices are sampled deterministically (md5-ordered within each
stratum) so a rerun scores the same items; output is resumable like the
bake-off scorer, flushing to R2 every few batches.
"""

from concurrent.futures import ThreadPoolExecutor

import duckdb

from . import r2
from .config import TAGS_PATH, Config
from .label import MAX_TEXT_CHARS
from .score import CONCURRENCY, FLUSH_EVERY, _Api, _score_chunk, _system_prompt
from .tags import load_taxonomy

BULK_PREFIX = "model/bulk"
TEACHER_MODEL = "@cf/deepseek-ai/deepseek-v4-flash-0731"
SUBREDDIT = "uraniumsqueeze"

# The two spikiest windows (14d volume vs history) plus a year-stratified
# random slice so the fit also sees quiet-period language.
SLICES = [
    {"name": "squeeze-2021-09", "start": "2021-09-13", "end": "2021-09-27", "n": 8000},
    {"name": "spike-2024-01", "start": "2024-01-15", "end": "2024-01-31", "n": 5000},
    {"name": "random-by-year", "per_year": 1000},
]


def run_bulk_score(cfg: Config, model: str = TEACHER_MODEL, batch: int = 20,
                   limit: int | None = None) -> None:
    import os
    token = os.environ.get("WORKERS_AI_TOKEN")
    account_id = os.environ.get("R2_ACCOUNT_ID")
    if not token or not account_id:
        raise SystemExit("set WORKERS_AI_TOKEN and R2_ACCOUNT_ID")

    taxonomy = load_taxonomy(TAGS_PATH)
    taxonomy_keys = {t.key for t in taxonomy}
    s3 = r2.client(cfg)
    gold = r2.read_jsonl(s3, cfg.derived_bucket, "model/gold/gold-v1/labels.jsonl")
    system_prompt = _system_prompt(taxonomy, [l for l in gold if l["split"] == "exemplar"])
    # Holdout rows must never leak into the teacher set — the one honest
    # yardstick stays untouched by the fit.
    holdout_ids = {l["doc_id"] for l in gold if l["split"] == "holdout"}

    con = _connect(cfg)
    api = _Api(account_id, token, model, batch)
    for spec in SLICES:
        out_key = f"{BULK_PREFIX}/{spec['name']}.jsonl"
        scores = (
            r2.read_jsonl(s3, cfg.derived_bucket, out_key)
            if r2.exists(s3, cfg.derived_bucket, out_key)
            else []
        )
        done = {row["doc_id"] for row in scores}
        items = [i for i in _slice_items(con, cfg, spec)
                 if i["doc_id"] not in done and i["doc_id"] not in holdout_ids]
        if limit is not None:
            items = items[:limit]
        print(f"{spec['name']}: scoring {len(items)} items ({len(done)} already done)")

        chunks = [items[i: i + batch] for i in range(0, len(items), batch)]
        failures = 0
        with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
            results = pool.map(
                lambda chunk: (chunk, _score_chunk(api, system_prompt, chunk, taxonomy_keys)),
                chunks,
            )
            done_count = 0
            for chunk, labels_by_id in results:
                for item in chunk:
                    label = labels_by_id.get(item["doc_id"])
                    if label is None:
                        failures += 1
                    else:
                        scores.append({
                            "doc_id": item["doc_id"],
                            "doc_type": item["doc_type"],
                            "created_utc": item["created_utc"],
                            **label,
                            "model_version": f"{model}-batch{batch}",
                        })
                done_count += len(chunk)
                if done_count % FLUSH_EVERY < batch or done_count == len(items):
                    r2.put_jsonl(s3, cfg.derived_bucket, out_key, scores)
                    print(f"  {done_count}/{len(items)} ({failures} failures)")
        print(f"{spec['name']}: {len(scores)} rows in {out_key}")


def read_teacher_rows(cfg: Config) -> list[dict]:
    """All bulk pseudo-labels joined with their source texts, for fitting."""
    s3 = r2.client(cfg)
    labels = []
    for spec in SLICES:
        key = f"{BULK_PREFIX}/{spec['name']}.jsonl"
        if r2.exists(s3, cfg.derived_bucket, key):
            labels.extend(r2.read_jsonl(s3, cfg.derived_bucket, key))
    if not labels:
        raise SystemExit("no bulk teacher scores in R2 — run `bulk score` first")

    con = _connect(cfg)
    texts = {}
    for spec in SLICES:
        for item in _slice_items(con, cfg, spec):
            texts[item["doc_id"]] = item["text"]
    return [
        {**label, "text": texts[label["doc_id"]]}
        for label in labels
        if label["doc_id"] in texts
    ]


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


def _glob(cfg: Config, kind: str) -> str:
    return f"s3://{cfg.derived_bucket}/derived/{kind}/*/*/*.parquet"


def _slice_items(con, cfg: Config, spec: dict) -> list[dict]:
    """Deterministic sample of scoreable items for one slice, with the same
    context the gold labeling saw (post title, parent comment)."""
    if "per_year" in spec:
        where = "TRUE"
        pick = f"""QUALIFY row_number() OVER (
            PARTITION BY strftime(to_timestamp(created_utc), '%Y')
            ORDER BY md5(id)) <= {int(spec['per_year'])}"""
    else:
        where = (f"to_timestamp(created_utc)::DATE >= DATE '{spec['start']}' "
                 f"AND to_timestamp(created_utc)::DATE < DATE '{spec['end']}'")
        pick = f"QUALIFY row_number() OVER (ORDER BY md5(id)) <= {int(spec['n'])}"

    sql = f"""
        WITH posts AS (
            SELECT id, title, selftext, created_utc
            FROM read_parquet('{_glob(cfg, "posts")}', hive_partitioning=1)
            WHERE subreddit = '{SUBREDDIT}'
        ),
        comments AS (
            SELECT id, body, link_id, parent_id, created_utc
            FROM read_parquet('{_glob(cfg, "comments")}', hive_partitioning=1)
            WHERE subreddit = '{SUBREDDIT}'
        ),
        pool AS (
            SELECT id, 'post' AS doc_type, created_utc,
                   CASE WHEN selftext IS NOT NULL THEN title || chr(10) || chr(10) || selftext
                        ELSE title END AS text,
                   NULL AS post_title, NULL AS parent_body
            FROM posts
            UNION ALL
            SELECT c.id, 'comment', c.created_utc, c.body,
                   p.title, parents.body
            FROM comments c
            LEFT JOIN posts p ON p.id = replace(c.link_id, 't3_', '')
            LEFT JOIN comments parents ON c.parent_id LIKE 't1_%'
                                      AND parents.id = replace(c.parent_id, 't1_', '')
        )
        SELECT id, doc_type, created_utc, text, post_title, parent_body
        FROM pool
        WHERE text IS NOT NULL AND trim(text) != '' AND {where}
        {pick}
    """
    items = []
    for id_, doc_type, created, text, post_title, parent_body in con.execute(sql).fetchall():
        context = None
        if post_title:
            context = f"Post title: {post_title}"
            if parent_body:
                context += f"\nParent comment: {parent_body[:MAX_TEXT_CHARS]}"
        items.append({
            "doc_id": id_, "doc_type": doc_type, "created_utc": created,
            "text": text, "context_text": context,
        })
    items.sort(key=lambda i: i["doc_id"])
    return items
