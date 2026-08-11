# DASHBOARD — Phase 4: publishing the index

Working document, skeletal for now. Last phase; nothing here blocks earlier
work.

## Job

A static site on Cloudflare Pages charting the sentiment index against
SPUT/spot. DuckDB-WASM in the browser queries the index Parquet directly —
no backend, no API server.

## Decisions so far

- Access control: Cloudflare Access in front of the Pages site, email
  allow-rule (e.g. @curzon domain). No password database anywhere.
- The browser must NOT query the private R2 bucket directly (Access + CORS
  on a bucket hostname is a known trap — preflight OPTIONS mishandling).
  Instead: publish the small index Parquet into the Pages site itself, same
  origin, already behind Access.
- Two series, never mixed: unweighted text sentiment at ~hourly freshness,
  engagement-weighted at t−48h (score embargo).
- Staleness indicator ("last updated") on the page — the failure mode to
  design against is silent collector death, not downtime.

## Open items

- [ ] Chart set (index vs SPUT premium/discount? per-subreddit breakdown?).
- [ ] How the index Parquet gets from R2 into the Pages deploy.
- [ ] Custom domain question (only matters if circulated beyond Curzon).
