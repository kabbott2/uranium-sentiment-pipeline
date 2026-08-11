# DATA — Phase 2: raw → Parquet, side tables, query layer

Working document, skeletal for now. Fleshed out when Phase 1 (Sourcing) has
landed its first archive.

## Job

Turn the append-only raw archive in R2 into the queryable tables everything
downstream reads. Runs in a Cloudflare Container (Python), not a Worker —
Parquet/DuckDB tooling needs a real runtime.

## Layers produced (all in R2)

1. **Derived Parquet** — ~20 projected fields from the 109/65 raw ones,
   partitioned `subreddit/month`, rebuilt from raw whenever cleaning rules
   change. Dedup by id (hourly collector overlaps on purpose).
2. **Side tables**, narrow, keyed on id:
   - `id → sentiment, model_version` (written by Phase 3)
   - `id → score, fetched_at` (from the post-embargo score refetch)
   Rewritten wholesale on rescore/refetch; the text corpus is never touched.
3. **Index Parquet** — the small joined table the dashboard reads.

## Query layer

DuckDB reads the Parquet in place over the S3 protocol (`INSTALL httpfs`,
R2 API token as secret). No database server exists. SQL surface needed:
SELECT / WHERE / GROUP BY / date_trunc / JOIN / window functions.

## Open items

- [ ] Field list for the derived projection (draft from the "useful" columns
      in the Arctic Shift reference).
- [ ] Cleaning rules (deleted authors, empty bodies, bot detection?).
- [ ] Hugging Face mirror keyword sweep for the big general subs lives here.
- [ ] First sanity chart: posts per month per subreddit (gap detection).
