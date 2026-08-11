# SOURCING — Phase 1: Reddit collection, Arctic Shift → Cloudflare R2

Working document. Defines the data collection method and the pipeline from the
Arctic Shift API to storage on Cloudflare. The deliverable of this phase is a
complete, continuously updated raw archive in R2. No cleaning, scoring, or
analysis happens here — that starts in `../Data/`.

## Pipeline at a glance

```
Arctic Shift API ──► Cloudflare Workflow (TypeScript, durable steps)
                          │  gzipped NDJSON, one object per page batch
                          ▼
                     R2: raw/{subreddit}/{YYYY-MM}/part-NNNN.jsonl.gz
                          │  (Phase 2 builds derived Parquet from this)
                          ▼
                     queried in place later by DuckDB — R2 is object
                     storage, not a database server; DuckDB reads the
                     files over the S3 protocol without downloading them
```

Two collection modes, one codebase:

1. **Backfill** (historical, run once): one Workflow instance per
   (subreddit, year); each step covers one month.
2. **Ongoing** (hourly): a Cron Trigger Worker starts a small Workflow
   instance that collects the trailing window for all target subreddits.

## Source: Arctic Shift API

- Base: `https://arctic-shift.photon-reddit.com/api` — free, no auth.
- Coverage: Dec 2005 → current. No 1,000-item wall (this is why the official
  Reddit API is not the source: it cannot enumerate history).
- Workhorses: `/posts/search` and `/comments/search`. Use `limit=auto`, which
  returns a few hundred rows per call. A *numeric* `limit` is rejected above
  100 (`'limit' must be between 1 and 100`), so `auto` is the only way to get
  large pages.
- Query params: `subreddit`, `after`, `before` (epoch or ISO 8601),
  `sort=asc|desc`, `limit`, `fields=<csv>`.
  - Do NOT use `fields` projection in this phase: raw means the full record.
- **`after` and `before` are both exclusive** (verified against the live API).
  A month window is therefore `after = monthStart − 1`, `before = nextMonthStart`,
  which tiles the calendar without gaps or double-counting.
- Pagination (no cursor): request `sort=asc`, then advance `after` toward the
  last row's `created_utc` until a page comes back empty. Because `after` is
  exclusive, setting it to the last `created_utc` always terminates — but it
  silently drops any rows sharing that second when a page splits mid-second.
  The collector instead sets `after = last − 1`, re-reading the boundary second
  and accepting one duplicate row per page (Phase 2 dedups by id), with a guard
  that steps past a second too large to page out of.
- Rate limits: informal, ~couple requests/sec sustained is safe. Note there is
  **no `X-RateLimit-Remaining` header** — only `x-ratelimit-reset` and
  `x-ratelimit-reset-at` — so there is no budget to read ahead of time; pace
  requests and react to failures. Be a good citizen — this is a free
  single-maintainer service.
- A wide window can exceed the archive's own query timeout, returning
  **HTTP 422 `{"error":"Timeout. Maybe slow down a bit"}`**. This is transient
  and must be retried; treating it as an empty page would silently truncate a
  month.
- Aggregate endpoints (`/search/aggregate`) currently 422 under load. Do not
  depend on them.

### Data-quality facts the collector must respect

- **~36h engagement embargo**: rows younger than ~36h return
  `score=1, num_comments=0, upvote_ratio=1` (placeholders). Text is real and
  arrives at ~30 min latency; engagement settles later. Consequence: the
  hourly collector fetches text fast, and a second pass re-fetches IDs after
  ~48h to capture real scores (that refetch feeds Phase 2's score side table,
  via `/posts/ids` and `/comments/ids` — 500 IDs per call).
- Scores are single-snapshot, not a time series.
- Deleted/removed content is retained with `removed_by_category` /
  `removal_reason` populated — keep it; removal rates are themselves signal.
- Schema drifts across years (old rows lack `upvote_ratio`, award fields).
  Parsing must be lenient; store whatever comes back.

## Targets

The subreddit list lives in `../subreddits_to_scan.md`. Summary:

- **Whole-sub capture** (every post + comment, no filter): r/UraniumSqueeze,
  r/nuclear, r/NuclearPower, r/NuclearEnergy.
- **Keyword-scoped capture**: the 17 large general venues (r/wallstreetbets,
  r/stocks, …). Keyword list is OPEN — it will be derived empirically from
  term frequency in the uranium-sub corpus once whole-sub capture lands.
  Do not invent a keyword list; whole-sub capture is not blocked on it.
- Blacklist r/uraniumglass by name before any keyword rule runs.

Full-text search (`query`/`body` params) is one-subreddit-at-a-time and times
out on very active subs. For r/wallstreetbets-scale keyword sweeps, the path
is the Hugging Face Arctic Shift Parquet mirror queried from the Phase 2
container, with the recent tail (mirror lags by weeks) topped up via this API.

## Collector design (Cloudflare Workflows)

Why Workflows and not a plain cron or GitHub Actions: durable execution.
Each step's result is persisted; a failed step retries and the run resumes
where it stopped instead of restarting. Missed runs are recoverable anyway
(Arctic Shift is replayable), so the real enemy is silent failure, not
downtime.

Requirements:

- **Backfill Workflow** `backfill-sub-year`, params `{subreddit, year}`.
  One step per month. Each step paginates posts then comments for that
  month window and writes to R2 as it goes.
- **Steps return receipts, never data.** Step results cap at 1 MiB. A step
  returns `{keys_written, rows, last_created_utc}` only.
- **Stream, don't buffer.** Worker isolates have 128 MB memory; a busy month
  cannot be held whole. Write one gzipped NDJSON object per page batch:
  `raw/{subreddit}/{YYYY-MM}/part-NNNN.jsonl.gz` (posts and comments in
  separate objects: `posts-part-NNNN` / `comments-part-NNNN`).
- **R2 via native binding** (`env.RAW.put(...)`) — no S3 keys in code.
- **Hourly Workflow** `collect-recent`: for each whole-capture subreddit, pull
  the trailing ~2h window (overlap is fine, dedup happens in Phase 2 by id).
  Triggered by the workflow's own native cron schedule (`"schedules": ["0 * * * *"]`
  on the binding), not by a separate Cron Trigger Worker with a `scheduled()`
  handler — fewer moving parts, and on Workers Paid a scheduled instance may run
  up to an hour per firing without consuming a concurrency slot. Stay hourly.
- **Manual trigger**: an HTTP endpoint on the Worker, guarded by a shared
  secret, that spawns backfill instances for a given (subreddit, year).
- **Concurrency throttle**: run only a handful of backfill instances at once,
  out of respect for Arctic Shift's rate limits.
- **Backfill cutoff**: `before = start_of_backfill − 48h`, so every backfilled
  row has settled engagement. The hourly collector owns the fresh tail.
- **Idempotency**: re-running a (subreddit, month) must be safe. Part keys are
  deterministic (`{kind}-part-NNNN`), so a rerun overwrites in place; only after
  the month's parts and receipt are all written does it delete stale parts with
  index >= the number just written, so a shorter rerun cannot leave a stale tail
  behind. Nothing in the raw layer is deleted before its replacement exists. The
  rerun deliberately leaves the hourly collector's `{kind}-recent-*` objects
  alone: those cover the fresh tail and a backfill rerun of the current month
  must not delete them.

## Storage contract (what this phase writes)

- Bucket: private R2 on the Curzon Cloudflare account. Name/binding from
  wrangler config, never hardcoded.
- Layout: `raw/{subreddit}/{YYYY-MM}/{posts|comments}-part-NNNN.jsonl.gz` from
  the backfill, and `{posts|comments}-recent-{YYYYMMDDTHH}-part-NNNN.jsonl.gz`
  from the hourly collector. Subreddit is lowercased in the key so casing
  cannot split a partition. Receipts live outside the raw prefix, at
  `receipts/{subreddit}/{YYYY-MM}-{posts|comments}.json`.
- Content: full Arctic Shift records, one JSON object per line, exactly as
  returned. Append-only. Never edited, never projected, never "fixed".
- This layer is the irreplaceable artifact: if Arctic Shift disappears
  (Pushshift precedent, May 2023), this archive is the project.

## Verification (definition of done for a backfill run)

- Smoke test first: r/UraniumSqueeze, one recent year, one instance. Confirm
  objects land in R2, gunzip cleanly, and row counts look sane before fanning
  out to 21 subs × ~20 years.
- Per-month receipt rows (from step results) logged somewhere queryable, so
  gaps are visible. Each (month, kind) step writes its receipt to
  `receipts/{subreddit}/{YYYY-MM}-{kind}.json` as well as returning it, so gaps
  are visible from R2 alone once instance history ages out.
- Row counts carry a small deliberate overlap: pagination re-reads each page's
  final second, so expect one duplicate row per page boundary
  (`rows − unique_ids == parts − 1` per partition). Phase 2 dedups by id.
- Final check happens in Phase 2: posts-per-month by subreddit out of the
  derived Parquet — holes in that chart mean holes in the archive.

## Operating the collector

All commands run from `Sourcing/`. Config lives in `wrangler.jsonc`; the only
secret is `TRIGGER_SECRET`.

```sh
npm install
npx wrangler deploy                      # also registers the hourly schedule
npx wrangler secret put TRIGGER_SECRET    # rotate the trigger secret

# start a backfill (one instance per subreddit-year)
curl -X POST "$WORKER_URL/backfill" \
  -H "Authorization: Bearer $TRIGGER_SECRET" \
  -d '{"subreddit":"UraniumSqueeze","year":2026}'
# add "rerun": true to re-collect a year already run; without it a repeat POST
# returns 409 rather than starting a second instance

npx wrangler workflows instances describe backfill-sub-year <instance-id>
npx wrangler workflows instances list collect-recent
```

Reading objects back requires `--remote`; without it wrangler silently reads a
local simulated bucket and reports the key as missing:

```sh
npx wrangler r2 object get "$BUCKET/raw/uraniumsqueeze/2026-01/posts-part-0000.jsonl.gz" \
  --remote --file out.jsonl.gz
```

Note for Workers Builds: the wrangler project is in `Sourcing/`, not the repo
root, so the build must be configured with that as its root directory.

## Open items

- [ ] Keyword list for the 17 general subs (derive from uranium-sub corpus).
- [x] Where receipts/run-logs live — R2 objects under `receipts/`, written by
      the step that produced them. No extra infrastructure.
- [ ] Score-refetch cadence for the side table (proposal: refetch IDs at
      ~48h and ~7d, then freeze).
- [ ] Hugging Face mirror sweep spec (belongs partly to Phase 2's container).
- [ ] Cross-instance concurrency cap for the fan-out. Per-request pacing is in
      place inside each instance; capping how many instances run at once needs a
      shared counter (KV or a Durable Object) and only matters once the backfill
      fans out past a handful of subreddits.
