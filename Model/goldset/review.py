"""Human review round-trip for the gold labels.

`export` writes a CSV (lowest-confidence rows first) for editing in any
spreadsheet; `merge` reads the edited CSV back, records corrections, and —
once every label is reviewed — assigns the exemplar/holdout split. The CSV
is transient working material; the durable record lives only in R2.
"""

import csv
import io
import json
import random

from . import r2
from .config import GOLD_PREFIX, SAMPLE_SEED, TAGS_PATH, Config
from .schema import validate_label
from .tags import load_taxonomy

EXEMPLAR_TOTAL = 50
_CONF_ORDER = {"low": 0, "medium": 1, "high": 2}
_EDITABLE = ["tags", "overall_sentiment", "no_sentiment", "tag_sentiment", "confidence", "rationale"]
_COLUMNS = ["doc_id", "doc_type", "era"] + _EDITABLE + ["context_text", "text"]


def run_export(cfg: Config, out_path: str) -> None:
    s3 = r2.client(cfg)
    labels = r2.read_jsonl(s3, cfg.derived_bucket, f"{GOLD_PREFIX}/labels.jsonl")
    labels.sort(key=lambda l: (_CONF_ORDER[l["confidence"]], l["doc_id"]))
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=_COLUMNS, extrasaction="ignore")
        writer.writeheader()
        for label in labels:
            writer.writerow(
                {
                    **label,
                    "tags": ";".join(label["tags"]),
                    "tag_sentiment": json.dumps(label["tag_sentiment"]),
                }
            )
    print(f"wrote {len(labels)} rows to {out_path} (edit label columns, then review merge)")


def run_merge(cfg: Config, in_path: str) -> None:
    taxonomy_keys = {t.key for t in load_taxonomy(TAGS_PATH)}
    s3 = r2.client(cfg)
    labels_key = f"{GOLD_PREFIX}/labels.jsonl"
    labels = {l["doc_id"]: l for l in r2.read_jsonl(s3, cfg.derived_bucket, labels_key)}

    corrected = 0
    with open(in_path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            label = labels.get(row["doc_id"])
            if label is None:
                raise SystemExit(f"unknown doc_id in CSV: {row['doc_id']}")
            edited = _parse_edits(row)
            errors = validate_label({**label, **edited}, taxonomy_keys)
            if errors:
                raise SystemExit(f"{row['doc_id']}: {'; '.join(errors)}")
            if any(edited[f] != label[f] for f in _EDITABLE):
                label.update(edited)
                label["labeler"] = "human"
                corrected += 1
            label["reviewed"] = True

    rows = sorted(labels.values(), key=lambda l: l["doc_id"])
    if all(l["reviewed"] for l in rows):
        _assign_splits(rows)
        print("all rows reviewed — exemplar/holdout split assigned")
    r2.put_jsonl(s3, cfg.derived_bucket, labels_key, rows)
    _put_parquet(s3, cfg, rows)
    print(f"merged {len(rows)} rows, {corrected} corrected by review")


def _parse_edits(row: dict) -> dict:
    def parse_bool(value: str) -> bool:
        if value.strip().lower() in ("true", "false"):
            return value.strip().lower() == "true"
        raise SystemExit(f"{row['doc_id']}: no_sentiment must be true/false, got {value!r}")

    try:
        return {
            "tags": [t.strip() for t in row["tags"].split(";") if t.strip()],
            "overall_sentiment": int(row["overall_sentiment"]),
            "no_sentiment": parse_bool(row["no_sentiment"]),
            "tag_sentiment": {k: int(v) for k, v in json.loads(row["tag_sentiment"]).items()},
            "confidence": row["confidence"].strip().lower(),
            "rationale": row["rationale"].strip(),
        }
    except (ValueError, json.JSONDecodeError) as e:
        raise SystemExit(f"{row['doc_id']}: unparseable edit — {e}")


def _assign_splits(rows: list[dict]) -> None:
    """Exemplar picks are stratified over (kind, sentiment) so the few-shot
    set spans the whole scale; high-confidence rows preferred as exemplars."""
    rng = random.Random(SAMPLE_SEED + 1)
    groups: dict[tuple, list[dict]] = {}
    for row in rows:
        row["split"] = "holdout"
        groups.setdefault((row["doc_type"], row["overall_sentiment"]), []).append(row)
    for group in groups.values():
        group.sort(key=lambda l: l["doc_id"])
        rng.shuffle(group)
        group.sort(key=lambda l: _CONF_ORDER[l["confidence"]], reverse=True)
    quota, remainder = divmod(EXEMPLAR_TOTAL, len(groups))
    ordered = sorted(groups, key=lambda g: len(groups[g]), reverse=True)
    for i, key in enumerate(ordered):
        want = quota + (1 if i < remainder else 0)
        # A scarce class (e.g. six strong-bearish rows) must not be swallowed
        # whole by the exemplar set — the holdout needs some of it to measure.
        want = min(want, max(1, len(groups[key]) // 2))
        for row in groups[key][:want]:
            row["split"] = "exemplar"


def _put_parquet(s3, cfg: Config, rows: list[dict]) -> None:
    import pyarrow as pa
    import pyarrow.parquet as pq

    table = pa.Table.from_pylist(
        [{**r, "tag_sentiment": json.dumps(r["tag_sentiment"])} for r in rows]
    )
    buf = io.BytesIO()
    pq.write_table(table, buf, compression="zstd")
    r2.put_bytes(
        s3, cfg.derived_bucket, f"{GOLD_PREFIX}/labels.parquet",
        buf.getvalue(), "application/octet-stream",
    )
