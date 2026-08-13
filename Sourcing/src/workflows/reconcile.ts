import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers';
import { collectMonth } from '../collect.ts';
import { targetSubreddits, type Env } from '../env.ts';
import { openPartitions, type Partition } from '../partitions.ts';
import { secondsNow, settledMonth } from '../window.ts';

const STEP: WorkflowStepConfig = {
  retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' },
  timeout: '1 hour',
};

/**
 * Keeps R2 in agreement with the archive. A gap and a placeholder score are the
 * same failure — R2 does not hold what Arctic Shift has — and one re-pagination
 * fixes both, so this owns the boundary the backfill's 48h cutoff leaves behind
 * and the settlement the hourly collector cannot wait around for.
 *
 * A partition is reopened until its receipt proves every row settled, which is
 * why nothing here reasons about elapsed time: the archive's re-scrape queue
 * backlogs unpredictably, so the schedule decides how fast R2 converges and
 * never whether it does.
 */
export class Reconcile extends WorkflowEntrypoint<Env, unknown> {
  async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const cutoff = secondsNow(event.timestamp) - this.env.BACKFILL_CUTOFF_HOURS * 3600;
    const collected: Array<Partition & { subreddit: string; rows_unsettled: number }> = [];

    for (const subreddit of targetSubreddits(this.env)) {
      const open = await step.do(`${subreddit} survey`, STEP, () =>
        openPartitions(this.env, subreddit, event.timestamp),
      );

      for (const { label, kind } of open) {
        const month = settledMonth(label, cutoff);
        if (!month) continue;

        const receipt = await step.do(`${subreddit} ${label} ${kind}`, STEP, () =>
          collectMonth(this.env, subreddit, month, kind),
        );
        collected.push({ subreddit, label, kind, rows_unsettled: receipt.rows_unsettled });
      }
    }

    return {
      partitions: collected.length,
      still_unsettled: collected.filter((entry) => entry.rows_unsettled > 0).length,
      collected,
    };
  }
}
