"""Domain-adapted VADER: stock vaderSentiment plus a checked-in overlay.

The overlay (vader_lexicon.json) adds uranium/WSB slang, removes stock
lexicon entries that collide with tickers or domain jargon, and carries the
two compound thresholds that map to the 3-class scale. Fitting only ever
looks at the 42 exemplar rows; the 408-row holdout is spent sparingly via
`vader score` + `bench --collapse3`, each attempt under a bumped version.
"""

import json
import math
import re
from pathlib import Path

from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

from . import r2
from .config import GOLD_PREFIX, Config

LEXICON_PATH = Path(__file__).resolve().parent / "vader_lexicon.json"
VADER_PREFIX = "model/vader"
STOCK_VERSION = "vader-v0-stock"
# VADER's canonical neutral band, used for the stock baseline.
STOCK_THRESHOLDS = {"pos": 0.05, "neg": -0.05}


def load_overlay(path: Path = LEXICON_PATH) -> dict:
    overlay = json.loads(path.read_text(encoding="utf-8"))
    missing = {"lexicon", "neutralize", "thresholds", "version"} - overlay.keys()
    if missing:
        raise SystemExit(f"{path.name} missing keys: {sorted(missing)}")
    if not overlay["thresholds"]["neg"] < 0 < overlay["thresholds"]["pos"]:
        raise SystemExit("thresholds must straddle zero")
    return overlay


def build_analyzer(overlay: dict | None) -> SentimentIntensityAnalyzer:
    analyzer = SentimentIntensityAnalyzer()
    if overlay:
        for term in overlay["neutralize"]:
            analyzer.lexicon.pop(term.lower(), None)
        for term, valence in overlay["lexicon"].items():
            analyzer.lexicon[term.lower()] = valence
    return analyzer


def classify(scores: dict, thresholds: dict) -> int:
    """Map a polarity_scores() dict to -1/0/1.

    Besides the compound band, an optional neu_min rule calls a text neutral
    when VADER itself saw almost only neutral tokens — the compound saturates
    on long factual texts, so the band alone cannot catch them.
    """
    if scores["neu"] >= thresholds.get("neu_min", 2.0):
        return 0
    if scores["compound"] >= thresholds["pos"]:
        return 1
    if scores["compound"] <= thresholds["neg"]:
        return -1
    return 0


def run_vader_score(cfg: Config, stock: bool = False) -> None:
    overlay = None if stock else load_overlay()
    version = STOCK_VERSION if stock else overlay["version"]
    thresholds = STOCK_THRESHOLDS if stock else overlay["thresholds"]
    analyzer = build_analyzer(overlay)

    s3 = r2.client(cfg)
    labels = r2.read_jsonl(s3, cfg.derived_bucket, f"{GOLD_PREFIX}/labels.jsonl")
    holdout = [l for l in labels if l["reviewed"] and l["split"] == "holdout"]

    rows = []
    for label in holdout:
        scores = analyzer.polarity_scores(label["text"])
        rows.append(
            {
                "doc_id": label["doc_id"],
                "overall_sentiment": classify(scores, thresholds),
                "compound": round(scores["compound"], 4),
                "model_version": version,
            }
        )
    out_key = f"{VADER_PREFIX}/{version}/holdout-scores.jsonl"
    r2.put_jsonl(s3, cfg.derived_bucket, out_key, rows)

    dist = {v: sum(r["overall_sentiment"] == v for r in rows) for v in (-1, 0, 1)}
    print(f"scored {len(rows)} holdout rows as {version} -> {out_key}")
    print(f"class distribution: neg {dist[-1]}  neu {dist[0]}  pos {dist[1]}")
    print(f"bench with: python -m goldset bench --scores {out_key} --collapse3")


def run_vader_fit(cfg: Config) -> None:
    """Exemplar-only diagnostics: threshold grid plus a miss table.

    Prints, never writes — the human moves thresholds/terms into
    vader_lexicon.json by hand so every change is reviewable in git.
    """
    overlay = load_overlay()
    analyzer = build_analyzer(overlay)
    s3 = r2.client(cfg)
    labels = r2.read_jsonl(s3, cfg.derived_bucket, f"{GOLD_PREFIX}/labels.jsonl")
    exemplars = [l for l in labels if l["reviewed"] and l["split"] == "exemplar"]
    if not exemplars:
        raise SystemExit("no reviewed exemplar rows found")

    scored = [(l, analyzer.polarity_scores(l["text"])) for l in exemplars]
    gold3 = {l["doc_id"]: _collapse(l["overall_sentiment"]) for l in exemplars}

    band = [round(x * 0.02, 2) for x in range(1, 21)]
    neu_grid = [2.0] + [round(0.80 + x * 0.02, 2) for x in range(11)]
    best = max(
        ((pos, -neg, neu_min,
          _accuracy(scored, gold3, {"pos": pos, "neg": -neg, "neu_min": neu_min}))
         for pos in band for neg in band for neu_min in neu_grid),
        key=lambda t: t[3],
    )
    current = _accuracy(scored, gold3, overlay["thresholds"])
    print(f"exemplars: {len(exemplars)}")
    print(f"current thresholds {overlay['thresholds']}: {current:.1%} exact (3-class)")
    print(f"best on grid: pos={best[0]} neg={best[1]} neu_min={best[2]}: {best[3]:.1%} exact")

    print("\nmisses (gold vs vader, compound, neu, text head):")
    for label, scores in sorted(scored, key=lambda t: t[1]["compound"]):
        got = classify(scores, overlay["thresholds"])
        want = gold3[label["doc_id"]]
        if got != want:
            head = " ".join(label["text"].split())[:80]
            print(f"  {label['doc_id']}  gold {want:+d}  vader {got:+d}  "
                  f"compound {scores['compound']:+.3f}  neu {scores['neu']:.2f}  {head}")


def run_vader_distill(cfg: Config) -> None:
    """Fit lexicon valences from the bulk teacher labels (distillation).

    Associations are learned on 80% of the teacher rows; the scale and
    thresholds are selected on the held-back 20%, so no hyperparameter ever
    sees its own fitting data. The gold holdout is untouched — spending it is
    a separate, deliberate `vader score` + `bench --collapse3` run. The
    result overwrites vader_lexicon.json (version vader-v2) so the learned
    lexicon is reviewable in git before anything is published.
    """
    import hashlib

    from .bulk import read_teacher_rows
    from .config import TAGS_PATH
    from .tags import load_taxonomy

    rows = read_teacher_rows(cfg)
    fit, select = [], []
    for row in rows:
        y = _collapse(row["overall_sentiment"])
        bucket = fit if int(hashlib.md5(row["doc_id"].encode()).hexdigest(), 16) % 5 else select
        bucket.append((row["text"], y))
    print(f"teacher rows: {len(rows)} (fit {len(fit)}, select {len(select)})")

    banned = _entity_tokens(load_taxonomy(TAGS_PATH)) | _vader_machinery_tokens()
    hand = load_overlay()
    associations = _token_associations(fit, banned)
    print(f"candidate tokens with enough support: {len(associations)}")

    best = None
    band = [round(x * 0.03, 2) for x in range(1, 11)]
    for scale in (3.0, 4.5, 6.0, 8.0):
        lexicon = _build_lexicon(associations, hand["lexicon"], scale)
        analyzer = build_analyzer({**hand, "lexicon": lexicon})
        scored = [(analyzer.polarity_scores(text), y) for text, y in select]
        for pos in band:
            for neg in band:
                thresholds = {"pos": pos, "neg": -neg}
                accuracy = sum(
                    classify(s, thresholds) == y for s, y in scored) / len(scored)
                if best is None or accuracy > best[0]:
                    best = (accuracy, scale, thresholds, lexicon)
    accuracy, scale, thresholds, lexicon = best

    baseline = build_analyzer(hand)
    base_scored = [(baseline.polarity_scores(text), y) for text, y in select]
    base_accuracy = sum(
        classify(s, hand["thresholds"]) == y for s, y in base_scored) / len(base_scored)
    print(f"select-set 3-class exact: v1d {base_accuracy:.1%} -> "
          f"distilled {accuracy:.1%} (scale {scale}, thresholds {thresholds})")

    overlay = {
        "version": "vader-v2",
        "thresholds": thresholds,
        "lexicon": dict(sorted(lexicon.items())),
        "neutralize": hand["neutralize"],
    }
    LEXICON_PATH.write_text(
        json.dumps(overlay, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {len(lexicon)} terms to {LEXICON_PATH.name} as vader-v2")
    print("next: pytest, then ONE holdout spend: vader score && bench --collapse3")


# Frequent-token association fitting: shrunken P(pos|token) − P(neg|token),
# centered on the corpus prior so regime-frequency alone earns no valence.
MIN_TOKEN_DOCS = 50
SHRINKAGE = 30
MIN_ABS_VALENCE = 0.4
MAX_LEARNED_TERMS = 400

_TOKEN = re.compile(r"[a-z][a-z'’\-]{1,24}")


def _token_associations(fit: list, banned: set[str]) -> dict[str, tuple[float, int]]:
    from collections import Counter

    doc_pos: Counter = Counter()
    doc_neg: Counter = Counter()
    doc_all: Counter = Counter()
    total = pos_total = neg_total = 0
    for text, y in fit:
        tokens = set(_TOKEN.findall(text.lower())) - banned
        total += 1
        pos_total += y > 0
        neg_total += y < 0
        for token in tokens:
            doc_all[token] += 1
            if y > 0:
                doc_pos[token] += 1
            elif y < 0:
                doc_neg[token] += 1

    p_pos, p_neg = pos_total / total, neg_total / total
    prior = p_pos - p_neg
    associations = {}
    for token, n in doc_all.items():
        if n < MIN_TOKEN_DOCS:
            continue
        pos_rate = (doc_pos[token] + SHRINKAGE * p_pos) / (n + SHRINKAGE)
        neg_rate = (doc_neg[token] + SHRINKAGE * p_neg) / (n + SHRINKAGE)
        associations[token] = ((pos_rate - neg_rate) - prior, n)
    return associations


def _build_lexicon(associations: dict, hand_lexicon: dict, scale: float) -> dict:
    learned = {}
    for token, (association, support) in associations.items():
        valence = max(-3.5, min(3.5, scale * association))
        if abs(valence) >= MIN_ABS_VALENCE:
            learned[token] = (round(valence, 2), abs(valence) * math.log(support))
    top = sorted(learned.items(), key=lambda kv: kv[1][1], reverse=True)[:MAX_LEARNED_TERMS]
    # Hand entries stay; a learned value wins where both exist (data over intuition).
    return {**hand_lexicon, **{token: valence for token, (valence, _) in top}}


def _entity_tokens(taxonomy) -> set[str]:
    """Tickers and company names are neutral entities — only opinion words may
    carry valence, else 'sput' absorbs whatever regime it was sampled from."""
    tokens = set()
    for tag in taxonomy:
        for term in tag.search_terms + tag.strict_terms:
            tokens.update(_TOKEN.findall(term.lower()))
    return tokens


def _vader_machinery_tokens() -> set[str]:
    from vaderSentiment.vaderSentiment import BOOSTER_DICT, NEGATE

    return {t for t in NEGATE} | {t for t in BOOSTER_DICT}


def _collapse(value: int) -> int:
    return (value > 0) - (value < 0)


def _accuracy(scored, gold3, thresholds) -> float:
    hits = sum(
        classify(scores, thresholds) == gold3[label["doc_id"]]
        for label, scores in scored
    )
    return hits / len(scored)
