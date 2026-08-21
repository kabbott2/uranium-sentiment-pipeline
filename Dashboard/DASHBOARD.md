# DASHBOARD — Phase 4: the exuberance/despair nowcast

Working document. This is the spec the dashboard is built from; the code in
this folder follows it, not the other way around. **v2 (2026-08-21):** full
visual redesign to a card-based layout in the style of
yellowcakeanalytics.com, per-tag click-through charts, measurement
interactions, light/dark mode, and a distillation-fitted VADER.

## Job

A single Cloudflare Worker serving a dashboard that answers one question at a
glance: **is r/UraniumSqueeze at peak exuberance, peak despair, or somewhere
in between — right now?**

This is a *nowcast*, not a forecast. The lead-lag pre-test (2026-08-19,
`Model/FINDINGS.md`) showed the sentiment barometer **lags** price; nothing
here claims predictive power, and the page footer says so.

## Superseded decisions

- Pages + DuckDB-WASM (architecture memo Rev 2) → single Worker, per Kai
  2026-08-21. Two survivors: the private R2 bucket never faces a browser
  (Worker reads it server-side via a binding), and the staleness indicator
  is mandatory.
- v1's SPUT-dash terminal layout (dense monospace strips, two stacked
  chart panels) → v2's yellowcake-style card layout below, per Kai
  2026-08-21.

## Architecture (unchanged in v2)

```
Model/  owns the method:   fitted VADER lexicon + compiled tag regexes,
        published to R2 as versioned config artifacts (model/config/…)
Data/   owns the numbers:  hourly container cron consumes those configs →
        enrich side table → daily aggregates → dashboard JSON
Dashboard/ owns the glass: a Worker that reads the JSON via an R2 binding,
        fetches EOD prices daily, and renders one HTML page
```

v1 scope: r/UraniumSqueeze only (full history 2021-02 →). Pipeline stays
`--subreddit`-parametrized.

## Data sources

| Series | Source | Cadence |
|---|---|---|
| Reddit volume + sentiment + tags | R2 derived Parquet → enrich → `dashboard/{sub}/*.json` | hourly (`:15` derive cron) |
| SPUT price | Yahoo Finance chart API, `U-U.TO` (USD TSX listing) | daily, 22:30 UTC Mon–Fri |
| URNM price | Yahoo Finance chart API, `URNM` | daily, 22:30 UTC Mon–Fri |

Yahoo notes: Stooq (first choice) fronts its CSVs with a JS proof-of-work
wall — unusable from a Worker. Yahoo serves full history to a plain fetch
with a browser UA, no key, but `range=max` silently truncates daily bars to
~1y — the fetcher uses explicit `period1=0&period2=now`. Unofficial-API
risk is contained in `src/prices.ts` (plain `[date, close]` rows) so a
licensed feed swaps in behind the same shape. EOD rows finalize after the
16:00 ET closes; each fetch overwrites full history (idempotent,
self-healing).

## Sentiment: distillation-fitted VADER (v2)

Stock VADER: 52.5% / κ 0.190 (3-class, gold holdout). Hand-tuned lexicon +
thresholds fitted on the 42 exemplars did **not** generalize — four holdout
evals all landed κ 0.17–0.20 (`Model/FINDINGS.md`); the exemplar set is too
small to fit against.

v2 path — **distillation** (inside the pre-approved ~$15–30 teacher-label
budget): score the spikiest activity windows plus a stratified random slice
(~20k items) with DeepSeek V4 Flash batch-20 (the bake-off winner,
81.2%/κ 0.868), then fit the VADER lexicon against those pseudo-labels:

- Candidate tokens: frequent tokens in the teacher corpus, **excluding all
  taxonomy entity terms** (tickers/company names are neutral entities; only
  opinion vocabulary may carry valence — this stops "sput" from absorbing
  bull-market polarity).
- Valence per token from its shrunken association with teacher labels
  (P(pos|token) − P(neg|token), m-estimate shrinkage), scaled into VADER's
  −4..+4; merged over the hand overlay; thresholds gridded on the teacher
  set, never on the holdout.
- One (budgeted) holdout evaluation decides: ship as `vader-v2` if it beats
  `vader-v1d`, else keep v1d and record the negative result. Whatever ships,
  the UI labels the series a directional tone gauge with its measured
  numbers.

Side benefit: the teacher scores ARE the planned Phase-3 LLM side table for
the spike windows (`model/bulk/*.jsonl`).

## Artifacts (derived bucket)

Unchanged from v1: `enrich/…` side table, `series/{sub}/daily-sentiment.parquet`,
`series/{sub}/daily-tags.parquet` (schemas in `Data/DATA.md`).

`dashboard/{sub}/series.json` — v2 adds `volume_changes` and `analog`:

```json
{ "subreddit": "...", "generated_at": 0, "versions": {"lexicon": "...", "tags": "..."},
  "partial_after": "YYYY-MM-DD",
  "daily": [{"d","p","c","a","s","pos","neg"}],
  "gauge": {"value","volume_z","sentiment_z","band","vol_7d",
            "vol_pctile_alltime","sent_7d","asof"},
  "volume_changes": {"1W": {"current": 19.4, "previous": 12.1, "delta": 0.60},
                     "1M": {...}, "3M": {...}, "1Y": {...}},
  "analog": {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "band": "despondent",
             "similarity": 0.93, "note": "closest 30d match in history"} }
```

- `volume_changes[P]`: mean daily items over the last P (full days, ending
  asof) vs the P before it; `delta` = current/previous − 1.
- `analog`: the past 30-full-day window (ending ≥60d before asof, so it
  never matches itself) minimizing euclidean distance over the z-normalized
  pair series (log-volume 7d mean, sentiment 7d mean); `band` is the gauge
  band at that window's end; `similarity` = 1/(1+distance).

`dashboard/{sub}/tags.json` — unchanged: per tag summary (7d items, Δ vs
90d, 7d sent, volume z) + weekly full-history + daily trailing-180d series.
This is what the per-tag click-through charts render; no new artifact needed.

`dashboard/prices/{urnm|u-u-to}.json` — unchanged.

## The gauge (unchanged definition)

`volume_z` and `sentiment_z` are z-scores of the trailing-7d mean
(log-volume / mean compound) against the prior 365d of 7d means;
`gauge = clamp(mean, −3, +3)`; bands: ≤−1.5 peak despair · ≤−0.5 despondent
· <0.5 neutral · <1.5 excited · ≥1.5 peak exuberance. Computed only in
`Data/derive/dashboard.py`. `asof = last_date − 2` (partial collector tail).

## Page design (v2)

Style: yellowcakeanalytics.com-inspired. Rounded cards (~12px) with 1px
borders on a flat page background; sans-serif headings (system Inter-like
stack), monospace tabular numerals; gold accent; green/red delta badges;
timeframe pills. **Light and dark mode**: CSS custom properties, default
follows `prefers-color-scheme`, a toggle in the header persists to
localStorage. **No horizontal scrolling ever**: one centered column
(max-width ~1160px), `overflow-x:hidden` on body, all grids collapse on
narrow viewports (portrait-first — "a hamburger, not a hot dog").

Sections, top to bottom:

1. **Header bar** — title `r/UraniumSqueeze — Exuberance Monitor`, staleness
   dot + last-derive time, theme toggle.
2. **Ticker strip** — SPUT and URNM last close + daily change badge, U3O8
   proxy absent (no licensed feed), gauge value + band.
3. **"Today in r/UraniumSqueeze"** summary card — asof date, items yesterday,
   7d volume, 7d sentiment, current band.
4. **KPI card row** (the yellowcake boxes) — one card per period 1W / 1M /
   3M / 1Y: mean daily volume now, delta badge vs the prior period.
   **Clicking a card sets the main chart's timeframe.** Plus two more cards:
   the **historical analog** ("this period most resembles <dates> —
   <band>") which when clicked windows the main chart to that period, and
   the **gauge mini-card** (value + band).
5. **Gauge card** — the despair↔exuberance tape with needle, and a **guide
   row underneath**: each band's range and name with its color swatch, plus
   a one-line "how it's computed" note.
6. **Main chart card** — ONE overlay chart: daily posts+comments bars (left
   axis) + SPUT/URNM closes indexed to 100 at window start (right axis) +
   7d VADER line (hidden third axis, −1..1). Legend toggles each series.
   Timeframe pills 1M/3M/6M/1Y/ALL synced with the KPI cards. Partial tail
   shaded.
7. **Tag grid** — a card per tag (sorted by 7d items; zero-activity tags in
   a collapsed "quiet tags" tail): tag name, 7d items, Δ vs 90d badge, 7d
   sentiment. **Clicking a tag card opens the tag detail** (inline expanding
   panel): a chart of that tag's daily volume bars + sentiment line (180d)
   with a toggle to full-history weekly, plus its summary stats.
8. No footer. Per Kai (2026-08-21) the page carries no fine print and never
   uses the word "nowcast" — accuracy numbers, source notes, and the
   lag-vs-price finding live in this spec and `Model/FINDINGS.md` instead.

**Measurement interaction (all charts, incl. tag details): press-and-hold
drag** — hold and drag (either direction, mouse or touch) to pin a start
date and measure to the hover date: Δ days, Δ volume (mean daily then vs
now), Δ each visible price series (%), Δ sentiment. Box rendered on-canvas
(SPUT-dash `drawMeasure` pattern). Release clears on click elsewhere; Esc
clears. Crosshair stays linked across the main chart and any open tag
detail.

## Worker

Unchanged surface: `GET /` (page), `/api/series`, `/api/tags`,
`/api/prices`, `/api/status`; daily 22:30 UTC price cron; R2 binding
`DERIVED`; `stale = now − generated_at > 3h`. No new routes — the tag
click-throughs render from the already-served `tags.json`.

## Cron schedule

| Worker | Cron (UTC) | Work |
|---|---|---|
| uranium-sourcing | `0 * * * *` | Arctic Shift → raw |
| uranium-data | `15 * * * *` | build → enrich → dashboard JSON |
| uranium-dashboard | `30 22 * * 1-5` | Yahoo EOD → price JSONs |

## Deployed state

- Live at `https://uranium-dashboard.smithcloudflare.workers.dev`.
- 2026-08-21: enrich backfill (2,028 days, 31 keyword-active tags); prices
  seeded (URNM 1,687 rows, U-U.TO 1,274); v1 page live; v2 in progress.
- Workers Builds did **not** auto-deploy uranium-data on push (last build
  2026-08-15) — deployed via local `wrangler deploy` (needs Docker buildx).
  Check the build config: dashboard → Workers & Pages → uranium-data →
  Settings → Build (root `Data/`, watch paths). uranium-dashboard is not
  connected to Workers Builds yet (root `Dashboard/`).

## Caveats

- Trailing ~2 days partial (shaded; excluded from gauge/KPIs/analog).
- Nothing engagement-weighted in v1/v2; any future engagement-weighted stat
  must lag 48h.
- Access: ships open. Before the URL circulates beyond Curzon, add a Zero
  Trust Access app (email allow-rule) on the workers.dev hostname — config
  only.

## Open items

- [ ] Custom domain (only if circulated beyond Curzon).
- [ ] Second subreddit once r/nuclear has enough history.
- [ ] Licensed spot/term price feed slot (`src/prices.ts`).
