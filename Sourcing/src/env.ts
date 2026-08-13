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
  /** 2023-07-01, the first month the archive's second retrieval covers both
   *  kinds. Everything below it came from the bulk import, carries no `_meta`,
   *  and is already final. Measured on r/UraniumSqueeze: posts are unstamped
   *  through 2023-06 and comments through 2023-03, so the later of the two
   *  bounds it. Bare rows above the cutoff are judged on their engagement
   *  instead — see `hasSettledEngagement`. */
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
