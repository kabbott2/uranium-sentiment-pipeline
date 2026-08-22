# Phase 3 Findings — gold set, model bake-off, cost economics

Results and decisions from the gold-label build and scorer bake-off
(2026-08-17 → 2026-08-19). Numbers here are measured, not estimated;
sources are the gold holdout and Workers AI's per-call `usage.neurons`.

## What exists now

- **Gold label set v1**: 450 posts/comments from r/UraniumSqueeze, drafted by
  Claude Sonnet 5 against RUBRIC.md, human-reviewed in full by Kai. Split:
  42 exemplars (few-shot examples inside the scorer prompt) / 408 holdout
  (never shown to any scorer; the benchmark). In R2 (`uranium-derived-sentiment`)
  under `model/gold/gold-v1/` — `labels.jsonl`, `labels.parquet`, receipts.
- **Bake-off scores** for four models over the holdout, under `model/bakeoff/`.
- Tooling in `goldset/`: `sample`, `label`, `review export|merge`,
  `score --model <id> [--batch N]`, `bench --scores <key> | --self`.

## Bake-off scorecard (408-item human-reviewed holdout)

5-level scale (-2..+2), exact / within-one / quadratic-weighted kappa:

| Model (Workers AI) | Exact | ±1 level | κ | Hard failures |
|---|---|---|---|---|
| deepseek-v4-flash-0731 | **81.2%** | **99.7%** | **0.868** | 3.4% |
| glm-4.7-flash | 73.5% | 96.7% | 0.772 | 2.9%* |
| gpt-oss-120b | 69.2% | 96.8% | 0.716 | 0.5% |
| qwen3-30b-a3b-fp8 | 68.6% | 97.3% | 0.729 | 0.7% |

*GLM needs a ≥3,000-token output budget or its reasoning truncates before the
JSON and ~60% of calls fail validation. Batch-20 DeepSeek (see below) scores
78.7% / 99.0% / κ 0.827 — the batching discount costs ~2.5 points of exact.

**Off-the-shelf open classifiers are not viable on this corpus.** Same holdout,
collapsed to 3 classes for fairness (LLMs on the same collapsed scale for
comparison): DeepSeek 87.1% / κ 0.780, Qwen 76.8% / κ 0.622, then
VADER 52.5% / κ 0.194, Twitter-RoBERTa 46.1% / κ 0.161, FinBERT 39.7% / κ 0.069.
κ below 0.2 is barely better than guessing: they misread thesis-relative news
("Kazatomprom cut guidance — great for us"), NAV-discount talk, and sarcasm.

## Cost economics (Workers AI bills $0.011 per 1,000 neurons)

The prompt (rubric + taxonomy + exemplars ≈ 11.7k tokens) dominates cost, and
Workers AI has no prompt caching, so **batching items per call is the whole
ballgame** — `score --batch 20` amortizes the prompt 20 ways:

| Model | neurons/item single | neurons/item batch-20 | Full history (779,738 items), batch-20 |
|---|---|---|---|
| deepseek-v4-flash | 521 | 38.8 | ~$333 |
| gpt-oss-120b | 378 | 37.2 | ~$319 |
| glm-4.7-flash | 96 | 18.9† | ~$162† |
| qwen3-30b | 87 | 8.9 | ~$76 |

†GLM's batch measurement hit the output ceiling; real cost higher, reliability suspect.

Add 5–10% for retries. Ongoing scoring of new posts (a few thousand items/month
across the captured subs) fits inside the Workers plan's included 10k
neurons/day — effectively $0.

## Decision (Kai + supervisor, 2026-08-19): score the spikiest periods, not the full history

Full-history LLM scoring was judged not worth justifying to Curzon. Instead the
LLM (DeepSeek V4 Flash, batch-20) is pointed at the **highest-activity windows**
of r/UraniumSqueeze, where the sentiment signal actually lives. Spike windows
are found by pure SQL over the derived Parquet (volume vs trailing baseline) —
counting is free; only judging costs money. Reference point: the Jan 15–30 2024
spot-price spike window holds 9,663 scoreable items ≈ **$4.30** to score.
Quiet periods stay unscored in v1; the versioned side table means widening
coverage later is a rerun, not a redesign.

## VADER domain adaptation (2026-08-21): ceiling confirmed at κ≈0.19

For the exuberance dashboard's always-on sentiment series (DASHBOARD.md), a
domain-adapted VADER was fitted: a checked-in lexicon overlay
(`goldset/vader_lexicon.json` — uranium/WSB slang added, colliding stock
entries like "trust"/"energy"/"share"/"enrich" neutralized), thresholds and a
neutral-override rule tuned on the 42 exemplars only, then evaluated on the
holdout via `bench --collapse3`. Four holdout evaluations were spent:

| Version | Change | Exact | κ |
|---|---|---|---|
| vader-v0-stock | stock VADER (harness check) | 52.5% | 0.190 |
| vader-v1 | lexicon + wide pos band (0.18) | 50.0% | 0.200 |
| vader-v1b | + neutral override (neu ≥ 0.92) | 48.0% | 0.166 |
| vader-v1c | lexicon only, canonical bands | 50.7% | 0.179 |
| **vader-v1d** | domain slang + neutralizations only, no frequent ambiguous words | **51.7%** | **0.192** |

Every variant lands within noise of stock (±2.5pt at n=408): exemplar-set
gains (up to +12pt on the 42 rows) never transferred, and the bake-off's
verdict stands — VADER cannot exceed κ≈0.19 on this corpus regardless of
lexicon. **vader-v1d ships** (published to `model/config/vader-v1d/`): same
measured accuracy as stock, but it removes systematic domain bias that would
tilt the *aggregated* daily series (every "the trust" / "Boss Energy" /
"share" mention nudging compounds positive), and it scores explicit finance
slang correctly. The dashboard labels the series a directional tone gauge and
cites these numbers; per-item scores are not truth and are never shown.

## VADER distillation (2026-08-22): vader-v2 ships, ceiling still κ≈0.19

Per Kai's push for maximum VADER accuracy, ~9.6k items (the 2021-09 squeeze
window, the 2024-01 spike window, and a year-stratified random slice) were
pseudo-labeled with DeepSeek V4 Flash batch-20 (`model/bulk/*.jsonl`, ~$5,
inside the pre-approved teacher budget; these double as the Phase-3 LLM side
table for the spike windows). `goldset vader distill` fits token valences
from shrunken label associations — taxonomy entity terms and VADER's own
booster/negation machinery excluded, association-floor 0.2 so
stopword/length-bias artifacts ("but", "also") never enter — with scale and
thresholds selected on a held-back 20% of the teacher rows. One gold-holdout
spend evaluated the result:

| Config | Exact | ±1 | κ |
|---|---|---|---|
| stock | 52.5% | 86.3% | 0.190 |
| vader-v1d (hand) | 51.7% | 86.5% | 0.192 |
| **vader-v2 (distilled)** | **53.7%** | **89.7%** | **0.195** |

vader-v2 (49 hand + 21 learned terms, thresholds ±0.3) is the best measured
config on every metric and ships (`model/config/vader-v2/`,
`ENRICH_LEXICON=vader-v2`). Honest caveats: the gain over stock is within
sampling noise at n=408, the κ≈0.19 ceiling stands (now consistent across
five adapted evaluations — VADER's architecture, not the lexicon, is the
limit), and the wide neutral band trades weak-negative recall (8/52) for
much better neutral detection (57/151). Scoring ops note: concurrency 12
drowns long Workers AI runs in 429s; bulk scoring runs at 4.

## Operational notes

- Scoring runs from a laptop via Cloudflare's OpenAI-compatible endpoint
  (`/ai/v1/chat/completions`); resumable — progress flushes to R2 every 25 items.
- Concurrency 12 triggered 429s when combined with other traffic; back off or
  keep a single run active.
- The Python venv lives at `~/.venvs/uranium-model`, deliberately **outside**
  the repo: the repo sits on an iCloud-synced Desktop, and macOS storage
  optimization evicted venv/git files to zero-byte stubs mid-run when the disk
  filled (torch install). Keep multi-GB artifacts off synced paths; if git or
  Python misbehave with "empty file" symptoms, check iCloud eviction first.
- All credentials via environment (`Model/.env`, gitignored): R2 keys +
  `WORKERS_AI_TOKEN`. Labeling used Sonnet subagents (no Anthropic API key);
  scoring uses Workers AI only.
