# Uranium Sentiment Pipeline — Infrastructure & Hosting Architecture

**Author:** Kai Abbott · **Original:** Aug 9, 2026 · **Rev 2:** Aug 11, 2026 · **Scope:** storage, scheduling, deployment, and access control. Data collection methodology and model fine-tuning are covered separately (see `Sourcing/SOURCING.md`, `Model/MODEL.md`).

## Summary

Code lives on GitHub, everything runs on Cloudflare, data lives in Cloudflare R2, and nothing runs on or is stored on a local machine. There is no server to maintain, so the pipeline keeps running with all personal computers off and survives personnel changes. Total cost: **$5/month** (Workers Paid), plus at most ~$10–17/yr in optionals (see Costs).

## Components

| Component | Service | Job |
|---|---|---|
| Collector | Cloudflare Workflows (TypeScript) | Durable, step-based collection from Arctic Shift; failed steps retry and resume instead of restarting the run |
| Scheduler | Cloudflare Cron Trigger | Hourly, starts a small Workflow instance for the fresh tail (≥1h intervals get a 15-min CPU budget vs 30 s below that) |
| Python compute | Cloudflare Container | raw → Parquet builds, sentiment scoring, keyword sweeps of the Hugging Face mirror; Workers isolates (128 MB, JS-only) can't run this |
| Code | GitHub repo (public) | Version control only — no Actions, no CI |
| Deploys | Cloudflare Workers Builds | Connected to the repo; push to main → build and deploy |
| Data storage | Cloudflare R2 (private bucket) | All three data layers; S3-compatible; zero egress fees |
| Query engine | DuckDB | Reads Parquet in R2 in place over the S3 protocol; only requested columns transfer |
| Dashboard hosting | Cloudflare Pages | Static dashboard (HTML + DuckDB-WASM, no backend) |
| Access control | Cloudflare Access | Login wall: only approved emails can view the dashboard |

## Data layers (all in R2)

1. **Raw** — gzipped JSON lines exactly as returned by Arctic Shift, partitioned `subreddit/month`, one object per page batch. Append-only, never edited. This is the irreplaceable artifact.
2. **Derived** — clean Parquet, ~20 projected fields, rebuilt from raw whenever cleaning rules change.
3. **Side tables** — narrow `id → sentiment, model_version` and `id → score, fetched_at` tables, rewritten on rescore/refetch without touching the text corpus.

DuckDB joins these into the published sentiment index, the small Parquet the dashboard reads.

## Data flow

```
Arctic Shift API
      │  Cloudflare Workflow
      │  (hourly cron + on-demand backfill instances)
      ▼
R2: raw NDJSON ──► Container ──► R2: derived Parquet + side tables
                                        │
                                        ▼
                                 R2: index Parquet
                                        │  published into the Pages build
                                        ▼
                         Cloudflare Pages dashboard
                         (behind Cloudflare Access)
```

## Access model

- The R2 bucket is **private** and never faces a browser. Rev 1 claimed browser data requests pass through Access "for free" — that was wrong (private R2 behind Access needs a custom bucket domain plus CORS-with-credentials, and Access mishandles preflight OPTIONS). Instead, the small **index Parquet is published into the Pages site itself**: same origin, already behind Access, no CORS surface at all.
- Access authenticates by email (one-time code or Google login) against an allow-rule such as "ends in @curzon.com." No password database exists anywhere in the project.
- The dashboard shows a "last updated" staleness indicator — the failure mode to design against is silent collector death, not downtime.

## Ownership & handoff

- **Code:** public repo under Kai's personal GitHub. Curzon forks it once now; forks survive anything that happens to the original account.
- **Compute + data + subscriptions:** the Cloudflare account (Workers Paid, R2 bucket, Pages site, Access policy) is **Curzon-owned from day one**. With Actions gone, everything that *runs* is on Curzon's account — the handoff surface is smaller than in Rev 1.
- All credentials, bucket names, and endpoints come from config/environment variables — never hardcoded — so swapping accounts is a config change.
- Handoff includes a one-page RUNBOOK: check last-run status, rotate the R2 token, re-trigger a backfill.