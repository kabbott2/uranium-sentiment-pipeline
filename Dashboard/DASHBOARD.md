# DASHBOARD — Phase 4: the exuberance/despair nowcast

Working document. This is the spec the dashboard is built from; the code in
this folder follows it, not the other way around.

## Job

A single Cloudflare Worker serving a dashboard that answers one question at a
glance: **is r/UraniumSqueeze at peak exuberance, peak despair, or somewhere
in between — right now?**

This is a *nowcast*, not a forecast. The lead-lag pre-test (2026-08-19,
`Model/FINDINGS.md`) showed the sentiment barometer **lags** price; nothing
here claims predictive power, and the page footer says so. The value is
monitoring: seeing the crowd's temperature next to the assets it obsesses
over.

What the page shows:

- An **exuberance gauge** — a despair↔exuberance meter with a named band and
  its two components (volume z-score, sentiment z-score) displayed alongside.
- **Volume over time** (posts + comments per day) as bars, with a 7-day
  smoothed VADER sentiment line on a second axis, over selectable timeframes
  (1M / 3M / 6M / 1Y / All).
- A **price panel** above it, sharing the x-axis and crosshair: SPUT (U.U,
  the USD TSX listing) and URNM daily closes, each toggleable, indexed to 100
  at the start of the selected window so the two are comparable.
- A **per-tag table**: for each tag in the `Model/TAGS.md` taxonomy, 7-day
  item count, change vs its 90-day baseline, 7-day mean sentiment, and a
  volume z-score.
- A **staleness indicator** — the failure mode to design against is silent
  collector death, not downtime.

## Superseded decision

An earlier revision of this file (and `architecture_memo.md` Rev 2) specified
Cloudflare Pages + DuckDB-WASM querying a Parquet published into the site.
**Superseded 2026-08-21 (Kai):** the dashboard is a single Worker in the
style of the SPUT premium dashboard (sibling repo `curzon-uranium-dashboard`)
— inline HTML template, Chart.js from CDN, `wrangler deploy`. Two decisions
from that revision survive unchanged:

- The private R2 bucket never faces a browser. The Worker reads it
  server-side through an R2 binding; the browser only ever talks to the
  Worker's own origin.
- The staleness indicator is mandatory.

## Architecture

```
Model/  owns the method:   fitted VADER lexicon + compiled tag regexes,
        published to R2 as versioned config artifacts (model/config/…)
Data/   owns the numbers:  the hourly container cron consumes those configs
        mechanically → enrich side table → daily aggregates → dashboard JSON
Dashboard/ owns the glass: a Worker that reads the JSON via an R2 binding,
        fetches EOD prices daily, and renders one HTML page
```

A lexicon or taxonomy change is a Model re-run plus a Data re-score — never a
code migration. The dashboard only ever reads compact JSON; no Parquet
parsing happens in the Worker.

v1 scope is r/UraniumSqueeze only: it has full history (2021-02 → present);
the other whole-sub captures have ~2-month tails, useless for baselines. The
pipeline stays `--subreddit`-parametrized so a second sub is a re-run, not a
rewrite.

## Data sources

| Series | Source | Cadence | Notes |
|---|---|---|---|
| Reddit volume + sentiment | R2 derived Parquet → enrich → `dashboard/{sub}/*.json` | hourly (`:15` derive cron) | trailing ~2 days partial |
| SPUT price | Yahoo Finance chart API, symbol `U-U.TO` (USD TSX listing, matches the SPUT dash's U.U) | daily, 22:30 UTC Mon–Fri | history from SPUT's 2021-07 inception |
| URNM price | Yahoo Finance chart API, symbol `URNM` | daily, 22:30 UTC Mon–Fri | full daily history from 2021-02 |

Why Yahoo: Stooq (first choice) now fronts its CSV endpoints with a
JavaScript proof-of-work challenge, so a plain Worker fetch cannot get the
data. Yahoo's `query1.finance.yahoo.com/v8/finance/chart/{symbol}` endpoint
serves full daily history to a plain fetch with a browser User-Agent, no key.
It is unofficial and could change; the fetcher lives in one module
(`src/prices.ts`) and stores plain `[date, close]` rows, so a licensed feed
swaps in behind the same shape — the same pattern the SPUT dash documents
for Numerco. EOD rows finalize once per trading day after the 16:00 ET
close; the 22:30 UTC cron runs after both NYSE Arca and TSX have closed.
Each fetch pulls *full* history and overwrites, so the store is idempotent
and self-heals after any missed cron.

## Artifacts (bucket: the derived bucket)

Written by `Data/derive` (see `Data/DATA.md` for the pipeline side):

- `enrich/{posts|comments}/subreddit={sub}/month={YYYY-MM}/data.parquet`
  — per-row side table: `id`, `tags` (list of taxonomy keys; empty = no
  keyword hit), `vader_compound` (double, NULL when no scoreable text),
  `vader_label` (`pos|neu|neg`), `enrich_version`.
- `series/{sub}/daily-sentiment.parquet` — zero-gap-filled daily:
  `date, num_posts, num_comments, num_unique_authors, num_scored,
  mean_compound, median_compound, pct_pos, pct_neg, pct_neu`.
- `series/{sub}/daily-tags.parquet` — long and sparse (only tag-days with
  activity): `date, tag, num_items, num_posts, num_comments, mean_compound,
  pct_pos, pct_neg`.
- `dashboard/{sub}/series.json` — what the Worker serves:

  ```json
  { "subreddit": "uraniumsqueeze", "generated_at": 1766300000,
    "versions": {"lexicon": "vader-v1", "tags": "tags-v1"},
    "partial_after": "2026-08-19",
    "daily": [{"d":"2021-02-01","p":5,"c":120,"a":37,"s":0.123,
               "pos":0.31,"neg":0.12}],
    "gauge": {"value":1.2,"volume_z":1.8,"sentiment_z":0.6,"band":"excited",
              "vol_7d":412.3,"vol_pctile_alltime":0.91,"sent_7d":0.14,
              "asof":"2026-08-19"} }
  ```

- `dashboard/{sub}/tags.json` — per tag: summary (7d items, Δ vs 90d
  baseline, 7d mean sentiment, volume z), weekly full-history series, and
  daily series for the trailing 180 days (bounds the payload; full daily ×
  33 tags × 5.5 years would be multi-MB).

Written by the dashboard Worker itself:

- `dashboard/prices/{urnm|u-u-to}.json` —
  `{"symbol":"URNM","currency":"USD","updated_at":…,
    "rows":[["2021-02-01",71.20], …]}` (date, close only).

## The gauge

Computed in Python (`Data/derive/dashboard.py`) so it exists in exactly one
place and is unit-testable. Full days only: `asof = last_date − 2`, excluding
the partial collector window.

- `volume_z` — z-score of the trailing-7d mean of `log(1 + posts+comments)`
  against the distribution of such 7d means over the prior 365 days.
- `sentiment_z` — same construction on the 7d mean of `mean_compound`.
- `gauge = clamp((volume_z + sentiment_z) / 2, −3, +3)`.
- Bands: ≤ −1.5 **peak despair** · (−1.5, −0.5] **despondent** ·
  (−0.5, 0.5) **neutral** · [0.5, 1.5) **excited** · ≥ 1.5 **peak
  exuberance**.

Rationale: exuberance is many people talking, bullishly (the 2021 squeeze,
the Jan-2024 spot spike); despair is silence plus negativity (the 2022–23
drawdown — the volume collapse was the louder signal, hence equal weight and
a log transform against the heavy tail). Both components and the all-time
volume percentile are displayed next to the composite, so the gauge is never
a black box.

## Sentiment: domain-adapted VADER

Stock VADER scored 52.5% exact / κ 0.194 (3-class) against the gold set —
not viable (`Model/FINDINGS.md`). The dashboard series uses a
domain-adapted VADER: a checked-in custom lexicon (uranium/WSB slang,
neutralized colliding tickers like "U"/"BOE"/"LOT"), thresholds fitted on the
42 exemplar rows only, evaluated on the 408-row holdout with the existing
bench harness at most five times, frozen as `vader-v1` and published to
`model/config/`. Target ≥60% exact / κ ≥0.35. Method and results live in
`Model/MODEL.md` / `Model/FINDINGS.md`.

Known ceiling, stated in the UI: VADER cannot read thesis-relative sentiment
("Kazatomprom cut guidance — great for us") or sarcasm. Per-item scores are
noisy; the dashboard only ever shows daily aggregates over hundreds of items,
where systematic per-item error mostly washes out of the *trend*. The series
is labeled a directional tone gauge, not per-item truth.

## Tags

The keyword tagger applies the compiled `Model/TAGS.md` regexes
(`model/config/tags-v1.json`) to every row. `OFF_TOPIC` is LLM-only cues and
unreachable by keyword — it is absent from the tag table and footnoted. If
the Model phase later runs its bulk LLM tagging pass, its output replaces the
keyword `tags` column under a bumped `enrich_version`; nothing downstream
changes shape.

## Worker

`wrangler.jsonc`: name `uranium-dashboard`, `main: src/index.ts`, R2 binding
`DERIVED` → the derived bucket (reads `dashboard/*`, writes only
`dashboard/prices/*`), cron `30 22 * * 1-5`, observability on. No KV, no
secrets.

Routes:

| Route | Returns |
|---|---|
| `GET /` | the dashboard HTML |
| `GET /api/series` | `dashboard/{sub}/series.json` |
| `GET /api/tags` | `dashboard/{sub}/tags.json` |
| `GET /api/prices` | both price JSONs merged |
| `GET /api/status` | `{generated_at, partial_after, prices_updated_at, stale}` |

`stale` is true when `now − generated_at > 3h` — three missed hourly derive
runs turns the header dot red. API responses carry `Cache-Control:
max-age=60`.

Page layout, top to bottom (Chart.js 4 + luxon adapter from CDN; Curzon
palette Navy `#253461`, Gold `#C6A02E`, accent `#037DB4`, green `#2E7D52`,
red `#B23A2E`; dense monospace layout in the style of the SPUT dash):

1. Header strip: title, last-updated + staleness dot, config versions.
2. Gauge bar: despair↔exuberance meter, band label, both z components.
3. Timeframe buttons: 1M / 3M / 6M / 1Y / All.
4. Panel 1: SPUT / URNM toggles, closes indexed to 100 at window start.
5. Panel 2: volume bars (left axis) + 7d sentiment line (right axis,
   −1..+1); linked crosshair with panel 1; trailing partial window shaded
   ("collector still filling").
6. Tag table: 32 keyword-reachable tags sorted by 7d items.
7. Footer: "nowcast, not a leading indicator" + the VADER ceiling note.

## Cron schedule (whole system, final state)

| Worker | Cron (UTC) | Work |
|---|---|---|
| uranium-sourcing | `0 * * * *` | Arctic Shift → raw R2 |
| uranium-data | `15 * * * *` | `derive cron`: build → enrich → dashboard JSON |
| uranium-dashboard | `30 22 * * 1-5` | Yahoo EOD fetch → price JSONs |

## Caveats

- The trailing ~2 days of Reddit data are partial while the hourly collector
  fills them: shaded on the chart, excluded from the gauge.
- Nothing in v1 is engagement-weighted, so the <36h placeholder-score window
  needs no special handling here. Any *future* engagement-weighted stat must
  lag 48h (project-wide rule).
- Access control: ships open like the SPUT dash. Before the URL circulates
  beyond Curzon, put a Cloudflare Zero Trust Access app (email allow-rule)
  in front of the `uranium-dashboard.*.workers.dev` hostname — a dashboard-
  config change only, no code.

## Deployed state (as of 2026-08-21)

- Live at `https://uranium-dashboard.smithcloudflare.workers.dev` — first
  deploy via `wrangler deploy`; full price history seeded the same day
  (URNM 1,687 rows from 2019-12, U-U.TO 1,274 rows from 2021-07).
- Yahoo note: `range=max` silently truncates daily bars to ~1y; the fetcher
  uses explicit `period1=0&period2=now`.
- Enrich backfill ran 2026-08-21 (2,028 days, 31 keyword-active tags);
  the hourly container cron now runs build → enrich → dashboard.
- Not yet done: connect Workers Builds for this worker (dashboard →
  Workers & Pages → uranium-dashboard → Settings → Build → connect repo,
  root directory `Dashboard/`), and the Access toggle below.

## Open items

- [ ] Custom domain (only matters if circulated beyond Curzon).
- [ ] Second subreddit once r/nuclear has enough history for baselines.
