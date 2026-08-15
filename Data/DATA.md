# DATA — Phase 2: raw → Parquet, side tables, query layer

Working document, skeletal for now. Fleshed out when Phase 1 (Sourcing) has
landed its first archive.

## Job

Turn the append-only raw archive in R2 into the queryable tables everything
downstream reads. Runs in a Cloudflare Container (Python), not a Worker —
Parquet/DuckDB tooling needs a real runtime.

The derived Parquet is the single read surface for everything downstream:
DuckDB queries it in place, and the LLM passes (tagging, sentiment) read
their text from it. Nothing downstream ever reads raw — raw is 109/65-field
JSON with duplicate ids from the deliberate collector overlap, so any
consumer skipping this layer re-pays parsing and re-implements dedup.

## Layers produced (all in R2)

1. **Derived Parquet** — ~20 projected fields from the 109/65 raw ones,
   partitioned `subreddit/month`, rebuilt from raw whenever cleaning rules
   change. Dedup by id (hourly collector overlaps on purpose).
2. **Side tables**, narrow, keyed on id:
   - `id → sentiment, model_version` (written by Phase 3)
   - `id → score, fetched_at` (from the post-embargo score refetch)
   - `id → tags` (written by the LLM tagging pass, which reads the derived
     Parquet; spec still open, see below)
   Rewritten wholesale on rescore/refetch/retag; the text corpus is never
   touched.
3. **Index Parquet** — the small joined table the dashboard reads.

## Dedup: which copy of an id wins

The hourly collector and the reconciler both write the same id, so dedup is
required, not optional. SOURCING.md says prefer the copy carrying
`_meta.retrieved_2nd_on`. **Implemented literally that rule loses 2022.**

Bulk-imported rows carry no `_meta` at all and no stamped copy of them exists
anywhere, so "keep only stamped rows" silently drops every row below the
2023-07 import boundary — 594k of the 801k collected. The rule is a tiebreak
between copies of the same id, never a filter on ids:

1. Group by id.
2. If any copy carries `_meta.retrieved_2nd_on`, take it (any one — engagement
   does not drift once stamped).
3. Otherwise take any copy. It is bulk-imported or unsettled, and which of those
   is decided by the engagement itself, not by the presence of the stamp — see
   `hasSettledEngagement` in `Sourcing/src/arctic-shift.ts`.

Row counts in receipts are rows *written*, including the deliberate
page-boundary overlap, so they exceed unique ids by design. Dedup is the
authority; the receipt count is not a target to reconcile against.

## Query layer

DuckDB reads the Parquet in place over the S3 protocol (`INSTALL httpfs`,
R2 API token as secret). No database server exists. SQL surface needed:
SELECT / WHERE / GROUP BY / date_trunc / JOIN / window functions.

Verified working recipe (same env vars as the build):

```sql
INSTALL httpfs; LOAD httpfs;
CREATE SECRET r2 (TYPE s3, KEY_ID '<R2_ACCESS_KEY_ID>',
  SECRET '<R2_SECRET_ACCESS_KEY>',
  ENDPOINT '<account-id>.r2.cloudflarestorage.com', URL_STYLE 'path');

SELECT month, count(*)
FROM read_parquet('s3://<DERIVED_BUCKET>/derived/comments/*/*/*.parquet',
                  hive_partitioning=1)
WHERE subreddit = 'uraniumsqueeze' GROUP BY month ORDER BY month;
```

## Derived projection (settled 2026-08-15)

One schema shared by the posts and comments tables; fields belonging to the
other kind stay NULL. `subreddit` and `month` come from the partition path
(`derived/{posts|comments}/subreddit=X/month=YYYY-MM/data.parquet`), read via
`hive_partitioning=1`.

- Identity/thread: `id`, `kind`, `parent_id`, `link_id` (kept with their
  `t1_`/`t3_` prefixes as Reddit serves them — joining `link_id` to the posts
  table means stripping `t3_`).
- Core: `author`, `created_utc` (epoch int64), `score`, `upvote_ratio`
  (posts, NULL pre-drift), `num_comments` (posts), `title`, `selftext`, `body`.
- Context: `is_self`, `over_18`, `stickied`, `distinguished`, `edited`
  (epoch → bool), `author_flair_text`, `link_flair_text`, `removal_category`
  (posts' `removed_by_category` coalesced with comments' `removal_reason`).
- Settlement: `engagement_settled` (Python mirror of `hasSettledEngagement` in
  `Sourcing/src/arctic-shift.ts` — exempt before 2023-07-01, else stamp, else
  engagement differing from the placeholder) and `retrieved_2nd_on`.
  Engagement-weighted series filter on `engagement_settled` instead of
  re-implementing the rule; that is also what excludes the abandoned rows
  whose `score=1` is permanently placeholder.

Dropped: `permalink` (reconstructable from subreddit + id) and modern
comments' `num_comments` (thread metadata, not comment engagement).

## Cleaning rules (settled 2026-08-15)

1. No rows are dropped — removed/deleted content stays; removal rates are
   signal.
2. `author` `[deleted]`/`[removed]` → NULL.
3. Text fields: `[deleted]`, `[removed]`, `[deleted by user]`,
   empty/whitespace → NULL; surviving text kept verbatim, markdown included.
4. Missing or wrong-typed fields → NULL, never an error — the raw schema
   drifts across years (comments 50 → 80 fields, posts 98 → 116).

## Build

`derive/` implements this layer. Runs anywhere Python runs; config is env
vars only (`R2_ENDPOINT` or `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `RAW_BUCKET`, `DERIVED_BUCKET`,
`SETTLE_EXEMPT_BEFORE`).

```sh
python -m pytest test/        # offline, no credentials needed
python -m derive build        # incremental: only partitions whose raw changed
python -m derive build --full # full rebuild — run whenever cleaning rules change
python -m derive report       # posts/comments-per-month sanity table vs receipts
```

Incremental mode fingerprints each partition's raw objects (key, etag, size)
against `state/build-manifest.json` in the derived bucket, so a run where
nothing landed is a no-op. On Cloudflare the same image runs as a Container
(`Dockerfile`) started by the cron Worker in `src/index.ts` at :15 hourly —
15 minutes after the hourly collector — so new raw converts within the hour.

## Deployed state (as of 2026-08-15)

- Worker `uranium-data` is live with the `15 * * * *` cron and carries the
  three secrets `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
  (`wrangler secret put`, an R2 Account API token scoped Object Read & Write
  to both buckets). Rotating credentials means rotating that token and
  re-putting the secrets — no code change.
- The derived bucket is named **`uranium-derived-sentiment`** (word order
  differs from `uranium-sentiment-raw`; it is what the R2 token is scoped
  to). The name lives only in `wrangler.jsonc` vars and the `DERIVED_BUCKET`
  env var.
- The full historical build (`build --full`) was run 2026-08-15 from the
  spec-settling session; hourly incremental runs have kept the layer current
  since. A concurrent full build and cron firing cannot conflict — both
  write the same deterministic keys and reconverge via the manifest.
- Local `wrangler deploy` builds the container image and therefore needs
  Docker with the buildx plugin (`brew install docker-buildx`, then link it
  into `~/.docker/cli-plugins/`). Without buildx the image build fails with
  `unknown flag: --load`.
- Workers Builds: this project deploys from the repo with root directory
  `Data/` (Sourcing has its own build rooted at `Sourcing/`). Container
  images are built in the cloud on push, so CI needs no local Docker.

## Open items

- [ ] LLM tagging pass spec: taxonomy (SPUT, YCA, spot/term, per-company
      miners, ETFs), how thread context is given to the model, batch cost
      cap, and where the prompt/model version is recorded for reruns.
- [ ] Hugging Face mirror keyword sweep for the big general subs lives here.
- [ ] First sanity chart: posts per month per subreddit (gap detection).
