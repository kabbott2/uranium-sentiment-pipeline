export interface BackfillParams {
  subreddit: string;
  year: number;
}

export interface Env {
  RAW: R2Bucket;
  BACKFILL: Workflow<BackfillParams>;
  COLLECT_RECENT: Workflow;

  ARCTIC_SHIFT_BASE: string;
  WHOLE_SUB_SUBREDDITS: string;
  REQUEST_DELAY_MS: number;
  RECENT_WINDOW_HOURS: number;
  BACKFILL_CUTOFF_HOURS: number;
  BACKFILL_MIN_YEAR: number;

  TRIGGER_SECRET: string;
}

export function targetSubreddits(env: Env): string[] {
  return env.WHOLE_SUB_SUBREDDITS.split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}
