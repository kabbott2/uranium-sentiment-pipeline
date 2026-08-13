export interface BackfillParams {
  subreddit: string;
  year: number;
}

export interface Env {
  RAW: R2Bucket;
  BACKFILL: Workflow<BackfillParams>;
  COLLECT_RECENT: Workflow;
  RECONCILE: Workflow;

  ARCTIC_SHIFT_BASE: string;
  WHOLE_SUB_SUBREDDITS: string;
  REQUEST_DELAY_MS: number;
  RECENT_WINDOW_HOURS: number;
  BACKFILL_CUTOFF_HOURS: number;
  BACKFILL_MIN_YEAR: number;
  /** Records created before this carry no `_meta` and cannot be proven settled
   *  by it; they came from the bulk import and are already final. */
  SETTLE_EXEMPT_BEFORE: number;
  /** How long a row lacking the second-retrieval stamp stays worth re-reading.
   *  Bounds retrying only; it never decides whether a row is settled. */
  SETTLE_GIVE_UP_HOURS: number;
  /** How many months back the reconciler re-reads unconditionally, to own the
   *  moving boundary the backfill's 48h cutoff leaves behind. */
  RECONCILE_MONTHS: number;

  TRIGGER_SECRET: string;
}

export function targetSubreddits(env: Env): string[] {
  return env.WHOLE_SUB_SUBREDDITS.split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}
