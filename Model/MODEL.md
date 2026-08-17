# MODEL — Phase 3: sentiment scoring and benchmark

Working document, skeletal for now. Blocked on Phase 2's derived Parquet.

## Job

Score every post/comment for sentiment, then prove (or disprove) that the
resulting index relates to SPUT/spot/equity moves. Runs in the Cloudflare
Container (Python).

## Plan of record

1. **Gold label set** (~450 posts+comments, in progress — `goldset/`):
   a stratified sample drafted by Claude Sonnet 5 against RUBRIC.md and the
   TAGS.md taxonomy, then human-reviewed in full. Two deliberate deviations
   from the original "hand-label 300–500 comments" wording: labels are
   LLM-drafted and human-corrected (reviewing ~450 is hours, writing them is
   days), and posts are included because title-only link posts are 39% of
   posts and the scorer must handle them. Splits: ~50 reviewed rows become
   few-shot exemplars for the bulk scorer's prompt; the other ~400 are the
   holdout no scorer ever sees, so agreement against it measures accuracy
   rather than self-consistency.

   Pipeline (runs from a real machine, R2-only storage, `Model/.venv`):
   `python -m goldset sample` → `label` (resumable, needs ANTHROPIC_API_KEY)
   → `review export` / spreadsheet pass / `review merge` → `bench --self`.
   Artifacts live in the derived bucket under `model/gold/gold-v1/`
   (`sample.jsonl`, `labels.jsonl`, `labels.parquet`, receipts). The gold
   files snapshot their text so the benchmark stays self-contained across
   derived-layer rebuilds. Sentiment scale: integers -2..+2 plus a
   `no_sentiment` flag; overall and sparse per-tag sentiment both recorded.

2. **Bake-off** on that holdout: VADER vs FinBERT vs a Reddit-tuned model.
   FinBERT is trained on news/analyst register — transfer to Reddit is an
   open question, not an assumption. Keep the winner; record
   `model_version` in the sentiment side table so rescoring is cheap.
3. **Measures** (three families):
   - Polarity: primary index ln((1+N_pos)/(1+N_neg)) per Liu (2024).
   - Volume/attention: counts normalized by `subreddit_subscribers`
     (snapshotted free on every post).
   - Dispersion/composition: score sd, first-time-poster share, removal rate.
4. **Benchmark** (after scores exist, never before): contemporaneous
   correlation vs lead-lag tests, split by regime; posts after market close
   attribute to the next trading day; naive comparators (lagged returns,
   volume-only) chosen before results are seen.
5. Engagement-weighted variants must exclude/lag the trailing 48h
   (score embargo).

## Corpus facts (measured on r/UraniumSqueeze, 2022–2024 sample)

Every field scoring needs is present on 100% of rows of its kind — `body`,
`link_id`, `parent_id` on comments; `title`, `selftext`, `removed_by_category`
on posts; `author`, `created_utc`, `score`, `id` on both. No drift in those
across eras. What is *not* uniform:

- **Title-only posts are the norm, not an edge case.** 39% of posts are link
  posts carrying no `selftext` at all. Scoring must treat title-only as a
  first-class input rather than a degenerate one.
- **Removed posts keep their title.** Where `selftext` is `[removed]`/`[deleted]`
  the title survives 100% of the time and the cause is known 95.3% of the time,
  so removals are recoverable as title-only text plus a flag — not dropped rows.
- **The removal rate drifts, and that is a trap for the benchmark.** Posts lose
  their body 21.9% of the time in 2022, 5.0% in 2023 H2, 10.8% in 2024. The
  2022 figure is an artefact of *when the archive read the row*, not of what
  r/UraniumSqueeze was doing: bulk-imported months were scraped long after
  removal, live-scraped months within ~20s of creation. A series computed over
  surviving text alone therefore carries a time-varying selection filter that
  looks like a trend. Removal rate is a legitimate measure (above); removal as a
  silent filter on the text corpus is not.
- Corpus-wide the loss is small — comments are 786,522 of 801,535 rows and lose
  text ~2% of the time — so this bites post-weighted measures, not comment ones.

## Open items

- [ ] Step 0 of the whole project — what is the index meant to explain?
      (Candidate: SPUT premium/discount to NAV primary, equity basket
      secondary.) Still undecided; decide before benchmarks are run.
- [x] Labeling rubric for the holdout set — RUBRIC.md (doubles as the
      labeler's system prompt).
- [x] Neutral-text handling — RUBRIC.md separates neutral opinion (0) from
      `no_sentiment` (no directional view at all), so the polarity index can
      exclude the latter.
