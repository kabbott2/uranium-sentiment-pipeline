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
  `sort=asc|desc`, `limit`, `fields=<csv>`. Comments also take `link_id` and
  `parent_id`; posts take `title`, `selftext`, `query`, `over_18` and friends.
  There is **no cursor and no `after_id`** — `after`/`before` plus `sort` is the
  only pagination primitive the API has.
  - The collector never sends `fields`: raw means the full record. The manual
    recovery runbook below does use it, but only to *enumerate* ids, which are
    then hydrated back to full records via `/{kind}/ids` before anything is
    stored.
- **`after` and `before` are both exclusive** (verified against the live API).
  A month window is therefore `after = monthStart − 1`, `before = nextMonthStart`,
  which tiles the calendar without gaps or double-counting.
- **`limit=auto` is not a constant.** Measured 345–635 rows across calls;
  documented as "between 100 and 1000 depending on the capacity of the server".
  A numeric `limit` is rejected above 100. So page size can never be hardcoded,
  and the only sound inference is the documented floor: **a page under 100 rows
  was not truncated** and holds every row its query matched.
- **`sort=desc` does not reverse within a second.** It orders *seconds*
  newest-first, but rows sharing a `created_utc` come back in the same order as
  `sort=asc`. Probed on a truncated 218-row second: the asc and desc reads were
  byte-identical, union 100 not 200. Reading a second from both ends is not a
  way to recover it — do not re-attempt this.
- Pagination (no cursor): request `sort=asc`, then advance `after` toward the
  last row's `created_utc` until a page comes back empty. Because `after` is
  exclusive, setting it to the last `created_utc` always terminates — but it
  silently drops any rows sharing that second when a page splits mid-second.
  The collector instead sets `after = last − 1`, re-reading the boundary second
  and accepting duplicate rows (Phase 2 dedups by id); a gap would be permanent.
- **The stall.** When `last − 1` equals the `after` just used, the next request
  would repeat the page verbatim — within-second ordering is identical across
  identical requests — so the page lies entirely inside one second and the
  cursor can only advance by stepping over it. Every window ends this way, on a
  short final page. The collector decides what that means with the page-size
  floor alone: **under 100 rows the second is provably whole and the step is
  free; at or above it the second's tail may be unread and no available
  primitive can tell**, so the second is recorded in the receipt as unproven
  rather than repaired. See the recovery runbook below.
- Rate limits: informal, ~couple requests/sec sustained is safe. Note there is
  **no `X-RateLimit-Remaining` header** — only `x-ratelimit-reset` and
  `x-ratelimit-reset-at` — so there is no budget to read ahead of time; pace
  requests and react to failures. Be a good citizen — this is a free
  single-maintainer service.
- A wide window can exceed the archive's own query timeout, returning
  **HTTP 422 `{"error":"Timeout. Maybe slow down a bit"}`**. This is transient
  and must be retried; treating it as an empty page would silently truncate a
  month.
- Aggregate endpoints (`/search/aggregate`) are **not trustworthy** and nothing
  in this pipeline may depend on them. Re-probed 2026-08-12, with plain
  `/search` returning 200 throughout:
  - `frequency=second` returned `422 {"error":"Timeout. Maybe slow down a bit"}`
    on every attempt, subreddit-scoped and reddit-wide, across seven tries with
    backoff. This is the one granularity an exact per-second count would need.
  - `frequency=hour|minute` over a one-second window returned `200` with
    `count: "0"` for a second where `/search` returns a row. Wrong, not slow.
  - `frequency=day` over a month works, but disagreed with `/search` by one row
    on a 94-row day, and its buckets are labelled at 23:00Z — they are not UTC
    days.

  It was tempting to use this endpoint as ground truth for "how many rows are
  really in this second". It cannot be. Completeness is decided by the page-size
  floor instead, and Phase 2's id-level dedup remains the authority.
- `/{kind}/ids` takes a comma-separated `ids` list, **500 per call**. `t1_`/`t3_`
  prefixes are accepted, unknown ids are silently omitted, and a **malformed id
  fails the whole call with 400** — sanitise before batching. Results are not
  documented as order-preserving; key by `id`.

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
  returns `{keys_written, rows, last_created_utc, seconds_unproven,
  unproven_at, floor_violation_at}` only.
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
  final second, so the duplicates at a boundary equal the row count of that
  boundary second — at least one, often more. A step past an unproven second
  produces zero duplicates at its boundary, so `rows − unique_ids >= parts − 1`
  per partition is a sanity check, not an identity. The authoritative check is
  Phase 2's id-level dedup.
- `seconds_unproven` counts **seconds the collector could not prove it read
  whole** — a stalled page that reached the 100-row floor. It is defined by what
  it measures, not by the mechanism: it is *not* a count of forced cursor
  advances, and it is *not* confirmed row loss. A flagged second may well have
  been complete; the archive simply offers no way to tell. Zero means every
  second in the partition is provably whole, which is the expected reading for
  all four whole-capture subreddits. Non-zero is a pointer to the runbook below.
  `seconds_unproven == unproven_at.length`, and `unproven_at` carries the epoch
  seconds so a flagged second can be worked on directly.
- `floor_violation_at` must always be `[]`. The whole scheme rests on one
  documented promise — that `limit=auto` never returns fewer than 100 rows — and
  this field monitors it instead of trusting it: a page under the floor followed
  by rows past its final second proves that page was truncated after all. A
  non-empty value invalidates every clean second in that partition and means the
  gate must be re-derived before the archive can be trusted.
- Final check happens in Phase 2: posts-per-month by subreddit out of the
  derived Parquet — holes in that chart mean holes in the archive.

## Recovering an unproven second (manual runbook)

Not implemented in the collector, deliberately. A stall needs one subreddit to
produce 100+ rows inside a single second, and no partition has yet managed it:
the 2021–2026 backfill of r/UraniumSqueeze reports `seconds_unproven: 0`
throughout. Size that risk against the archive's peak rather than the sub's
current activity, because the two are two orders of magnitude apart — a busy
month runs tens of thousands of comment rows (September 2021: 61,486 rows over
307 parts) while 2026 runs a few hundred. The 17 general venues are collected
from the Hugging Face mirror rather than this loop. Building recovery into the
pagination path would be speculative machinery on the hot path for a case the
targets have not reached. The flag exists so that if it ever fires, it fires
loudly and against a real case — and that is when this gets written as code.

Run this when a receipt shows `seconds_unproven > 0`. For each second `t` in
`unproven_at`, with window `after = t − 1`, `before = t + 1`:

1. **Enumerate.** Re-read the second with an id-only projection
   (`fields=id,created_utc` for posts, plus `link_id` for comments). Measured
   ~1.5× the rows of a full-record page (419 → 620), so it alone may close a
   second that only just overflowed.
2. **Hydrate.** Fetch the ids the collector does not already hold via
   `/{kind}/ids`, 500 per call, and append them to the partition as ordinary
   `{kind}-part-NNNN` objects. Storage stays full raw records — the projection
   is only ever an index.
3. **Fan out (comments only).** For each distinct `link_id` seen in that second,
   query the second again scoped to that thread. A single thread's slice of one
   second is small, so each of those reads lands under the 100-row floor and is
   therefore provably complete. Posts have no equivalent partition key, so a
   posts-second beyond one projected page is recoverable no further.
4. **Stop condition.** There isn't a clean one, and this is the caveat that
   keeps the ladder out of the collector: **thread discovery cannot be shown
   exhaustive.** Threads whose rows all sit past the projection's cut are never
   discovered, and no query enumerates "comments in second `t` *not* in the
   threads I already know". Step 3 recovers what it can and proves nothing about
   what it missed. Treat the result as best-effort, and record what was done.

Do not reach for `/search/aggregate` to size the gap — see the Source section
for why its counts cannot be trusted. Do not reach for `sort=desc` either.

## Operating the collector

All commands run from `Sourcing/`. Config lives in `wrangler.jsonc`; the only
secret is `TRIGGER_SECRET`.

```sh
npm install
npm test                                 # pagination suite, no network, no deps
npm run typecheck
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
- [x] Oversized-second loss is no longer silent. The page-size floor decides
      each stall, and a second that cannot be proven whole is recorded in
      `unproven_at` with its timestamp. Residual: a flagged second is not
      *repaired* — see the recovery runbook, which stays manual until a flag
      actually fires.
- [x] Watch `floor_violation_at` on the first fan-out. Held: the 2021–2025
      backfill of r/UraniumSqueeze ran 120 steps over 4,123 pages and 795,432
      rows with `floor_violation_at: []` and `seconds_unproven: 0` throughout.
      Keep reading it on every new subreddit — the floor is a documented
      promise, not a proven one.
- [ ] Score-refetch cadence for the side table (proposal: refetch IDs at
      ~48h and ~7d, then freeze).
- [ ] Hugging Face mirror sweep spec (belongs partly to Phase 2's container).
- [ ] Cross-instance concurrency cap for the fan-out. Per-request pacing is in
      place inside each instance; capping how many instances run at once needs a
      shared counter (KV or a Durable Object) and only matters once the backfill
      fans out past a handful of subreddits.
