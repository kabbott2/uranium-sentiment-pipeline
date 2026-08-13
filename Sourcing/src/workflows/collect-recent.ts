import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers';
import { hasSettledEngagement, pages, type Kind, type PageStats } from '../arctic-shift.ts';
import { targetSubreddits, type Env } from '../env.ts';
import { groupByMonth, putRows, recentKey, type Receipt } from '../storage.ts';
import { hourStamp, trailingWindow, type Window } from '../window.ts';

const KINDS: Kind[] = ['posts', 'comments'];

const STEP: WorkflowStepConfig = {
  retries: { limit: 3, delay: '1 minute', backoff: 'exponential' },
  timeout: '15 minutes',
};

/**
 * Started hourly by the workflow's own cron schedule. It pulls a window wider
 * than the interval on purpose: overlapping the previous firing is cheap and
 * Phase 2 dedups by id, whereas a missed minute is a hole in the archive.
 *
 * This window is younger than Arctic Shift's second retrieval, so effectively
 * everything it writes carries placeholder engagement and its `-recent-` objects
 * are provisional: real text at ~30 min latency, engagement that is not yet
 * true. The reconciler re-reads the same months once the archive settles them
 * and writes the authoritative `-part-` objects.
 */
export class CollectRecent extends WorkflowEntrypoint<Env, unknown> {
  async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const window = trailingWindow(event.timestamp, this.env.RECENT_WINDOW_HOURS);
    const stamp = hourStamp(event.timestamp);
    const subreddits = targetSubreddits(this.env);

    const receipts: Array<Receipt & { subreddit: string; kind: Kind }> = [];

    for (const subreddit of subreddits) {
      for (const kind of KINDS) {
        const receipt = await step.do(`${subreddit} ${kind}`, STEP, () =>
          collectTail(this.env, subreddit, kind, window, stamp),
        );
        receipts.push({ subreddit, kind, ...receipt });
      }
    }

    return {
      stamp,
      rows: receipts.reduce((total, receipt) => total + receipt.rows, 0),
      receipts,
    };
  }
}

async function collectTail(
  env: Env,
  subreddit: string,
  kind: Kind,
  window: Window,
  stamp: string,
): Promise<Receipt> {
  const client = { base: env.ARCTIC_SHIFT_BASE, delayMs: env.REQUEST_DELAY_MS, fetch };
  const stats: PageStats = { unprovenAt: [], floorViolationAt: [] };
  const parts = new Map<string, number>();
  let rows = 0;
  let lastCreatedUtc = 0;
  let rowsUnsettled = 0;
  let oldestUnsettled = 0;

  for await (const page of pages(client, kind, subreddit, window, stats)) {
    for (const [month, monthRows] of groupByMonth(page)) {
      const part = parts.get(month) ?? 0;
      parts.set(month, part + 1);
      await putRows(env.RAW, recentKey(subreddit, month, kind, stamp, part), monthRows);
    }

    rows += page.length;
    lastCreatedUtc = Math.max(lastCreatedUtc, page[page.length - 1]!.created_utc);

    for (const row of page) {
      if (hasSettledEngagement(row, env.SETTLE_EXEMPT_BEFORE)) continue;
      rowsUnsettled++;
      oldestUnsettled = oldestUnsettled === 0 ? row.created_utc : Math.min(oldestUnsettled, row.created_utc);
    }
  }

  const keysWritten = [...parts.values()].reduce((total, count) => total + count, 0);

  return {
    keys_written: keysWritten,
    rows,
    last_created_utc: lastCreatedUtc,
    seconds_unproven: stats.unprovenAt.length,
    unproven_at: stats.unprovenAt,
    floor_violation_at: stats.floorViolationAt,
    rows_unsettled: rowsUnsettled,
    oldest_unsettled_created_utc: oldestUnsettled,
  };
}
