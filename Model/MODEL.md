# MODEL — Phase 3: sentiment scoring and benchmark

Working document, skeletal for now. Blocked on Phase 2's derived Parquet.

## Job

Score every post/comment for sentiment, then prove (or disprove) that the
resulting index relates to SPUT/spot/equity moves. Runs in the Cloudflare
Container (Python).

## Plan of record

1. **Hand-label a holdout** of 300–500 comments from our own corpus first.
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
- [ ] Labeling rubric for the holdout set.
- [ ] Neutral-text handling (Liu 2024 notes in project memory).
