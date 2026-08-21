"""Per-row enrichment side table: keyword tags + adapted-VADER sentiment.

Consumes the Model phase's published config artifacts (model/config/…) and
walks the derived partitions incrementally: a partition is re-enriched when
its derived Parquet changed or when either config version was bumped, so a
lexicon or taxonomy change is a re-publish plus this pass, never a code
change here. Output rows stay 1:1 with derived rows; text that cannot be
scored ([deleted]/[removed] became NULL upstream) carries NULL sentiment.
"""

import hashlib
import io
import re
from dataclasses import dataclass

import pyarrow as pa
import pyarrow.parquet as pq
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

from . import r2
from .config import Config

MANIFEST_KEY = "state/enrich-manifest.json"

DERIVED_PART = re.compile(
    r"^derived/(?P<kind>posts|comments)/subreddit=(?P<sub>[^/]+)/month=(?P<month>\d{4}-\d{2})/data\.parquet$"
)

SCHEMA = pa.schema(
    [
        ("id", pa.string()),
        ("tags", pa.list_(pa.string())),
        ("vader_compound", pa.float64()),
        ("vader_label", pa.string()),
        ("enrich_version", pa.string()),
    ]
)


@dataclass(frozen=True)
class Enricher:
    """The published configs, compiled and ready to apply."""

    matchers: tuple[tuple[str, tuple[re.Pattern, ...]], ...]
    analyzer: SentimentIntensityAnalyzer
    thresholds: dict
    version: str

    def tags_for(self, text: str) -> list[str]:
        return [key for key, patterns in self.matchers
                if any(p.search(text) for p in patterns)]

    def sentiment_for(self, text: str) -> tuple[float, str]:
        scores = self.analyzer.polarity_scores(text)
        return scores["compound"], self._label(scores)

    def _label(self, scores: dict) -> str:
        if scores["neu"] >= self.thresholds.get("neu_min", 2.0):
            return "neu"
        if scores["compound"] >= self.thresholds["pos"]:
            return "pos"
        if scores["compound"] <= self.thresholds["neg"]:
            return "neg"
        return "neu"


def load_enricher(s3, cfg: Config) -> Enricher:
    tags_doc = r2.read_json(s3, cfg.derived_bucket, f"model/config/{cfg.enrich_tags}.json")
    lexicon_doc = r2.read_json(
        s3, cfg.derived_bucket, f"model/config/{cfg.enrich_lexicon}/lexicon.json"
    )
    if tags_doc is None or lexicon_doc is None:
        raise SystemExit(
            "model configs missing in R2 — run `python -m goldset tags publish` "
            "and `python -m goldset vader publish` (Model phase) first"
        )

    matchers = tuple(
        (tag["key"], tuple(re.compile(p) for p in (tag["loose"], tag["strict"]) if p))
        for tag in tags_doc["tags"]
        if tag["loose"] or tag["strict"]
    )
    analyzer = SentimentIntensityAnalyzer()
    for term in lexicon_doc["neutralize"]:
        analyzer.lexicon.pop(term.lower(), None)
    for term, valence in lexicon_doc["lexicon"].items():
        analyzer.lexicon[term.lower()] = valence
    return Enricher(
        matchers=matchers,
        analyzer=analyzer,
        thresholds=lexicon_doc["thresholds"],
        version=f"{lexicon_doc['version']}+{tags_doc['version']}",
    )


def enrich_rows(table: pa.Table, kind: str, enricher: Enricher) -> list[dict]:
    if kind == "posts":
        texts = [
            "\n\n".join(part for part in (title, selftext) if part)
            for title, selftext in zip(
                table.column("title").to_pylist(), table.column("selftext").to_pylist()
            )
        ]
    else:
        texts = [body or "" for body in table.column("body").to_pylist()]

    rows = []
    for id_, text in zip(table.column("id").to_pylist(), texts):
        if text.strip():
            compound, label = enricher.sentiment_for(text)
            row = {
                "id": id_,
                "tags": enricher.tags_for(text),
                "vader_compound": round(compound, 4),
                "vader_label": label,
            }
        else:
            row = {"id": id_, "tags": [], "vader_compound": None, "vader_label": None}
        rows.append({**row, "enrich_version": enricher.version})
    return rows


def run_enrich(cfg: Config, full: bool = False, only_subreddit: str | None = None) -> None:
    s3 = r2.client(cfg)
    enricher = load_enricher(s3, cfg)
    manifest = r2.read_json(s3, cfg.derived_bucket, MANIFEST_KEY) or {}

    partitions = []
    for obj in r2.list_objects(s3, cfg.derived_bucket, "derived/"):
        match = DERIVED_PART.match(obj["Key"])
        if not match:
            continue
        if only_subreddit and match["sub"] != only_subreddit.lower():
            continue
        label = f"{match['sub']}/{match['month']}/{match['kind']}"
        fingerprint = hashlib.sha256(
            f"{obj['ETag']}:{enricher.version}".encode()
        ).hexdigest()
        partitions.append((label, obj["Key"], match["kind"], fingerprint))
    partitions.sort()

    stale = [p for p in partitions if full or manifest.get(p[0]) != p[3]]
    print(f"{len(partitions)} derived partitions, {len(stale)} to enrich "
          f"(configs: {enricher.version})")

    columns = {"posts": ["id", "title", "selftext"], "comments": ["id", "body"]}
    for label, key, kind, fingerprint in stale:
        data = s3.get_object(Bucket=cfg.derived_bucket, Key=key)["Body"].read()
        table = pq.read_table(io.BytesIO(data), columns=columns[kind])
        rows = enrich_rows(table, kind, enricher)

        buffer = io.BytesIO()
        pq.write_table(pa.Table.from_pylist(rows, schema=SCHEMA), buffer, compression="zstd")
        out_key = f"enrich/{key.removeprefix('derived/')}"
        r2.put_bytes(s3, cfg.derived_bucket, out_key, buffer.getvalue(),
                     "application/vnd.apache.parquet")
        manifest[label] = fingerprint
        # Persist after every partition so an interrupted run resumes where it
        # stopped instead of re-enriching what already landed.
        r2.put_json(s3, cfg.derived_bucket, MANIFEST_KEY, manifest)
        print(f"  enriched {label}: {len(rows)} rows")

    if not stale:
        print("enrich layer already current")
