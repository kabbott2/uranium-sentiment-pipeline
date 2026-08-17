"""Benchmark any scorer's output against the reviewed gold holdout.

Scores are a JSONL object in R2 with at least (doc_id, overall_sentiment),
optionally tags. Only reviewed holdout rows count — exemplar rows sit in the
bulk scorer's prompt and would flatter the numbers. `--self` benches the gold
labels against themselves: every metric must come out perfect, which is the
sanity check that the metric code works.
"""

from . import r2
from .config import GOLD_PREFIX, Config
from .schema import SENTIMENT_LEVELS

LEVELS = sorted(SENTIMENT_LEVELS)


def run_bench(cfg: Config, scores_key: str | None, self_check: bool) -> None:
    s3 = r2.client(cfg)
    gold = [
        row
        for row in r2.read_jsonl(s3, cfg.derived_bucket, f"{GOLD_PREFIX}/labels.jsonl")
        if row["reviewed"] and row["split"] == "holdout"
    ]
    if not gold:
        raise SystemExit("no reviewed holdout rows yet — run review merge first")
    if self_check:
        scores = {row["doc_id"]: row for row in gold}
    else:
        scores = {row["doc_id"]: row for row in r2.read_jsonl(s3, cfg.derived_bucket, scores_key)}

    paired = [(g, scores[g["doc_id"]]) for g in gold if g["doc_id"] in scores]
    print(f"holdout: {len(gold)} rows, scored: {len(paired)}")
    if not paired:
        raise SystemExit("no overlap between scores and holdout")

    _sentiment_report([g["overall_sentiment"] for g, _ in paired],
                      [s["overall_sentiment"] for _, s in paired])
    if all("tags" in s for _, s in paired):
        _tag_report(paired)


def _sentiment_report(gold: list[int], scored: list[int]) -> None:
    n = len(gold)
    exact = sum(g == s for g, s in zip(gold, scored)) / n
    off_by_one = sum(abs(g - s) <= 1 for g, s in zip(gold, scored)) / n
    print(f"\nsentiment  exact agreement: {exact:.1%}")
    print(f"sentiment  within one level: {off_by_one:.1%}")
    print(f"sentiment  weighted kappa:   {quadratic_weighted_kappa(gold, scored):.3f}")

    counts = {(g, s): 0 for g in LEVELS for s in LEVELS}
    for g, s in zip(gold, scored):
        counts[(g, s)] += 1
    print("\nconfusion (rows gold, cols scored):")
    print("      " + "".join(f"{s:>6}" for s in LEVELS))
    for g in LEVELS:
        print(f"{g:>6}" + "".join(f"{counts[(g, s)]:>6}" for s in LEVELS))


def quadratic_weighted_kappa(gold: list[int], scored: list[int]) -> float:
    n = len(gold)
    span = (LEVELS[-1] - LEVELS[0]) ** 2
    gold_totals = {v: gold.count(v) for v in LEVELS}
    scored_totals = {v: scored.count(v) for v in LEVELS}
    observed = sum((g - s) ** 2 / span for g, s in zip(gold, scored))
    expected = sum(
        gold_totals[g] * scored_totals[s] / n * (g - s) ** 2 / span
        for g in LEVELS
        for s in LEVELS
    )
    return 1.0 if expected == 0 else 1 - observed / expected


def _tag_report(paired: list[tuple[dict, dict]]) -> None:
    keys = sorted({t for g, _ in paired for t in g["tags"]})
    print("\ntag          precision  recall      f1   gold_n")
    for key in keys:
        tp = sum(key in g["tags"] and key in s["tags"] for g, s in paired)
        fp = sum(key not in g["tags"] and key in s["tags"] for g, s in paired)
        fn = sum(key in g["tags"] and key not in s["tags"] for g, s in paired)
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        print(f"{key:<14} {precision:>8.1%} {recall:>7.1%} {f1:>7.2f} {tp + fn:>8}")
