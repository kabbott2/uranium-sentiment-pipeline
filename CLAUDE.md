# Uranium Sentiment Pipeline — Agent Instructions

Working repo for a Reddit sentiment index on uranium equities and spot price,
built for Curzon. This file governs how any coding agent works in this project.
Phase-specific specs live in the subfolders; read the relevant one before
writing code for that phase.

## Project structure

```
SentimentAnalysis/
├── CLAUDE.md            ← this file: standards, repo rules, project map
├── architecture_memo.md ← infrastructure decisions (hosting, storage, access)
├── subreddits_to_scan.md← the 21 target subreddits + exclusion list
├── Sources/             ← academic references (PDFs)
├── Sourcing/            ← Phase 1: collection from Arctic Shift → R2 (SOURCING.md)
├── Data/                ← Phase 2: raw → Parquet, side tables, DuckDB (DATA.md)
├── Model/               ← Phase 3: sentiment scoring + benchmark (MODEL.md)
└── Dashboard/           ← Phase 4: Pages + DuckDB-WASM front end (DASHBOARD.md)
```

Each phase folder holds its own spec (a working document, not final), its
scripts, and nothing belonging to another phase. If a piece of logic seems to
span two phases, it goes in the earlier one and exposes a clean output.

## Code standards

- Clean, built to last, understandable. Someone at Curzon who has never seen
  this repo inherits it after the internship ends. Write for that reader.
- No spaghetti: small functions with one job, explicit data flow, no clever
  indirection. If a function needs a comment to explain what it does, rename
  or split it instead.
- No superfluous commentary. Comments explain *why* only when the why is
  non-obvious (e.g. "Arctic Shift returns placeholder scores under ~36h").
  No banner comments, no commented-out code, no changelog headers.
- No dead code, no speculative abstractions, no options nobody asked for.
- Languages: **TypeScript** for anything running on Cloudflare Workers or
  Workflows (that runtime is JS-only). **Python** for container-side work
  (Parquet builds, scoring, DuckDB queries).
- Configuration comes from environment variables / wrangler bindings. Never
  hardcode credentials, account IDs, or bucket names. The handoff to Curzon
  must be a config change, not a code change.

## Repo rules

- All code is pushed to the public GitHub repo under Kai's account. Commit in
  coherent units with plain, descriptive messages. Push when a piece works,
  not at the end of a session.
- Never commit secrets, tokens, or `.env` files. Add them to `.gitignore`
  before the first commit.
- Cloudflare Workers Builds is connected to the repo: a push to main deploys.
  Treat main as deployable; do risky work on a branch.
- No GitHub Actions. All scheduled and durable compute runs on Cloudflare
  (Workflows, Cron Triggers, Containers). GitHub's only job is version control.

## Non-negotiable constraints (project-wide)

- Nothing is stored on the local machine. All data lives in Cloudflare R2;
  local disk holds code only.
- The raw layer in R2 is append-only and never edited. Every downstream
  artifact must be rebuildable from it.
- Posts/comments younger than ~36h carry placeholder engagement
  (`score=1, num_comments=0, upvote_ratio=1`). Any engagement-weighted
  series must exclude or lag this window.
- Arctic Shift is a single-maintainer third-party archive (Pushshift died in
  2023). Persist every pull immediately; assume the source can vanish.
