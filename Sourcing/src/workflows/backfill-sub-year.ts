import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers';
import type { Kind } from '../arctic-shift.ts';
import { collectMonth } from '../collect.ts';
import type { BackfillParams, Env } from '../env.ts';
import type { Receipt } from '../storage.ts';
import { secondsNow, settledMonths } from '../window.ts';

const KINDS: Kind[] = ['posts', 'comments'];

const STEP: WorkflowStepConfig = {
  retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' },
  timeout: '1 hour',
};

/**
 * One instance per (subreddit, year); one step per (month, kind). Steps return
 * receipts only — the rows themselves go straight to R2, because a step result
 * caps at 1 MiB and a busy month does not fit in a 128 MB isolate.
 *
 * This seeds a year the archive has never held. Keeping it current afterwards
 * is the reconciler's job.
 */
export class BackfillSubYear extends WorkflowEntrypoint<Env, BackfillParams> {
  async run(event: WorkflowEvent<BackfillParams>, step: WorkflowStep) {
    const { subreddit, year } = event.payload;
    const now = secondsNow(event.timestamp);
    const cutoff = now - this.env.BACKFILL_CUTOFF_HOURS * 3600;
    const months = settledMonths(year, cutoff);

    const receipts: Array<Receipt & { month: string; kind: Kind }> = [];

    for (const month of months) {
      for (const kind of KINDS) {
        const receipt = await step.do(`${month.label} ${kind}`, STEP, () =>
          collectMonth(this.env, subreddit, month, kind, now),
        );
        receipts.push({ month: month.label, kind, ...receipt });
      }
    }

    return {
      subreddit,
      year,
      months_collected: months.length,
      rows: receipts.reduce((total, receipt) => total + receipt.rows, 0),
      rows_unsettled: receipts.reduce((total, receipt) => total + receipt.rows_unsettled, 0),
      rows_abandoned: receipts.reduce((total, receipt) => total + receipt.rows_abandoned, 0),
      receipts,
    };
  }
}
