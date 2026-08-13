import { engagementState, pages, type Kind, type PageStats, type Row } from './arctic-shift.ts';
import type { Env } from './env.ts';
import {
  backfillKey,
  deleteStaleBackfillParts,
  putRows,
  writeReceipt,
  type Receipt,
} from './storage.ts';
import type { Month } from './window.ts';

export interface Settlement {
  pending: number;
  abandoned: number;
  oldestPending: number;
}

export function newSettlement(): Settlement {
  return { pending: 0, abandoned: 0, oldestPending: 0 };
}

/** Both collectors report settlement, so both count it the same way. */
export function tallySettlement(rows: Row[], into: Settlement, at: number, env: Env): void {
  for (const row of rows) {
    const state = engagementState(row, at, env.SETTLE_EXEMPT_BEFORE, env.SETTLE_GIVE_UP_HOURS * 3600);
    if (state === 'settled') continue;

    if (state === 'abandoned') {
      into.abandoned++;
      continue;
    }

    into.pending++;
    into.oldestPending =
      into.oldestPending === 0 ? row.created_utc : Math.min(into.oldestPending, row.created_utc);
  }
}

/**
 * Paginates one month of one kind into `{kind}-part-NNNN` objects and records
 * what it saw. Collecting a month for the first time and re-collecting it to
 * pick up settled engagement are the same operation — part keys are
 * deterministic, so a second pass overwrites in place — which is why the
 * backfill and the reconciler share this and not just a helper.
 */
export async function collectMonth(
  env: Env,
  subreddit: string,
  month: Month,
  kind: Kind,
  at: number,
): Promise<Receipt> {
  const client = { base: env.ARCTIC_SHIFT_BASE, delayMs: env.REQUEST_DELAY_MS, fetch };
  const stats: PageStats = { unprovenAt: [], floorViolationAt: [] };
  const settlement = newSettlement();
  let part = 0;
  let rows = 0;
  let lastCreatedUtc = 0;

  for await (const page of pages(client, kind, subreddit, month, stats)) {
    await putRows(env.RAW, backfillKey(subreddit, month.label, kind, part), page);
    part++;
    rows += page.length;
    lastCreatedUtc = Math.max(lastCreatedUtc, page[page.length - 1]!.created_utc);
    tallySettlement(page, settlement, at, env);
  }

  const receipt: Receipt = {
    keys_written: part,
    rows,
    last_created_utc: lastCreatedUtc,
    seconds_unproven: stats.unprovenAt.length,
    unproven_at: stats.unprovenAt,
    floor_violation_at: stats.floorViolationAt,
    rows_unsettled: settlement.pending,
    oldest_unsettled_created_utc: settlement.oldestPending,
    rows_abandoned: settlement.abandoned,
  };
  await writeReceipt(env.RAW, subreddit, month.label, kind, receipt);

  // Part keys are deterministic, so a rerun overwrites in place; only now that
  // the month's parts and receipt exist is a shorter rerun's tail deleted.
  await deleteStaleBackfillParts(env.RAW, subreddit, month.label, kind, part);

  return receipt;
}
