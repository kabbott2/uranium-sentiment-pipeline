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

## Open items

- [ ] Step 0 of the whole project — what is the index meant to explain?
      (Candidate: SPUT premium/discount to NAV primary, equity basket
      secondary.) Still undecided; decide before benchmarks are run.
- [ ] Labeling rubric for the holdout set.
- [ ] Neutral-text handling (Liu 2024 notes in project memory).
