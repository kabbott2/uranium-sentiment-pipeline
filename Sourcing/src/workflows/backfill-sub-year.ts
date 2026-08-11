import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers';
import { pages, type Kind } from '../arctic-shift';
import type { BackfillParams, Env } from '../env';
import {
  backfillKey,
  clearBackfillParts,
  putRows,
  writeReceipt,
  type Receipt,
} from '../storage';
import { secondsNow, settledMonths, type Month } from '../window';

const KINDS: Kind[] = ['posts', 'comments'];

const STEP: WorkflowStepConfig = {
  retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' },
  timeout: '1 hour',
};

/**
 * One instance per (subreddit, year); one step per (month, kind). Steps return
 * receipts only — the rows themselves go straight to R2, because a step result
 * caps at 1 MiB and a busy month does not fit in a 128 MB isolate.
 */
export class BackfillSubYear extends WorkflowEntrypoint<Env, BackfillParams> {
  async run(event: WorkflowEvent<BackfillParams>, step: WorkflowStep) {
    const { subreddit, year } = event.payload;
    const cutoff = secondsNow(event.timestamp) - this.env.BACKFILL_CUTOFF_HOURS * 3600;
    const months = settledMonths(year, cutoff);

    const receipts: Array<Receipt & { month: string; kind: Kind }> = [];

    for (const month of months) {
      for (const kind of KINDS) {
        const receipt = await step.do(`${month.label} ${kind}`, STEP, () =>
          collectMonth(this.env, subreddit, month, kind),
        );
        receipts.push({ month: month.label, kind, ...receipt });
      }
    }

    return {
      subreddit,
      year,
      months_collected: months.length,
      rows: receipts.reduce((total, receipt) => total + receipt.rows, 0),
      receipts,
    };
  }
}

async function collectMonth(
  env: Env,
  subreddit: string,
  month: Month,
  kind: Kind,
): Promise<Receipt> {
  await clearBackfillParts(env.RAW, subreddit, month.label, kind);

  const client = { base: env.ARCTIC_SHIFT_BASE, delayMs: env.REQUEST_DELAY_MS };
  let part = 0;
  let rows = 0;
  let lastCreatedUtc = 0;

  for await (const page of pages(client, kind, subreddit, month)) {
    await putRows(env.RAW, backfillKey(subreddit, month.label, kind, part), page);
    part++;
    rows += page.length;
    lastCreatedUtc = Math.max(lastCreatedUtc, page[page.length - 1]!.created_utc);
  }

  const receipt: Receipt = { keys_written: part, rows, last_created_utc: lastCreatedUtc };
  await writeReceipt(env.RAW, subreddit, month.label, kind, receipt);

  return receipt;
}
