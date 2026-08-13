import type { Kind } from './arctic-shift.ts';
import type { Env } from './env.ts';
import { readReceipt, receiptPrefix, type StoredReceipt } from './storage.ts';
import { absoluteMonth, monthEnd, parseMonthLabel, recentMonthLabels } from './window.ts';

const KINDS: Kind[] = ['posts', 'comments'];

/**
 * Ceiling on how far back a gap in collection is filled forward, so a bucket
 * whose receipts are old cannot turn one firing into a full-history backfill.
 * Seeding history stays a deliberate `/backfill` call.
 */
const MAX_FILL_FORWARD_MONTHS = 24;

/**
 * Receipts written before settlement was tracked carry no `rows_unsettled`.
 * Re-reading the whole archive to establish one would cost a million rows, so a
 * legacy receipt counts as final when its month ended far enough before it was
 * collected that the archive's second retrieval cannot still have been pending.
 * The worst backlog measured is ten days; this margin is thirty.
 */
const LEGACY_SETTLED_MARGIN_SECONDS = 30 * 24 * 3600;

export interface Partition {
  label: string;
  kind: Kind;
}

/**
 * The partitions a reconcile firing must read: the moving tail, plus everything
 * already collected that cannot be shown final. A partition that is settled and
 * whose month has passed is absent, and stays absent — that is what stops the
 * sweep from re-reading the whole archive every six hours forever.
 */
export async function openPartitions(env: Env, subreddit: string, at: Date): Promise<Partition[]> {
  const known = await listCollectedPartitions(env.RAW, subreddit);
  const open: Partition[] = [];
  const queued = new Set<string>();

  // The tail is reconciled whether or not the subreddit has ever been
  // backfilled. The hourly collector starts writing the moment a target enters
  // the config and every row it writes carries placeholder engagement; since
  // receipts are the only index of what exists, gating this on them left an
  // unseeded target's rows settling nowhere while they accumulated hourly.
  // Seeding history is still a deliberate `/backfill` call — the tail reaches
  // two months back, not five years.

  for (const label of tailLabels(env, known, at)) {
    for (const kind of KINDS) {
      open.push({ label, kind });
      queued.add(`${label}-${kind}`);
    }
  }

  for (const partition of known) {
    if (queued.has(`${partition.label}-${partition.kind}`)) continue;

    const receipt = await readReceipt(env.RAW, subreddit, partition.label, partition.kind);
    if (receipt && isFinal(receipt, partition.label)) continue;

    open.push(partition);
  }

  return open;
}

/**
 * The months re-read unconditionally. Normally the current one and its
 * predecessor, but collection is filled forward from the newest receipt so an
 * outage spanning months does not leave a hole no receipt points at.
 */
function tailLabels(env: Env, known: Partition[], at: Date): string[] {
  const current = absoluteMonth(at.getUTCFullYear(), at.getUTCMonth());

  const newest = known.reduce((latest, partition) => {
    const parsed = parseMonthLabel(partition.label);
    return parsed ? Math.max(latest, absoluteMonth(parsed.year, parsed.index)) : latest;
  }, -Infinity);

  const sinceNewest = Number.isFinite(newest) ? current - newest + 1 : 0;

  return recentMonthLabels(at, Math.min(Math.max(env.RECONCILE_MONTHS, sinceNewest), MAX_FILL_FORWARD_MONTHS));
}

function isFinal(receipt: StoredReceipt, label: string): boolean {
  if (typeof receipt.rows_unsettled === 'number') return receipt.rows_unsettled === 0;

  const parsed = parseMonthLabel(label);
  const collectedAt = Date.parse(receipt.collected_at ?? '') / 1000;
  if (!parsed || !Number.isFinite(collectedAt)) return false;

  return collectedAt - monthEnd(parsed.year, parsed.index) > LEGACY_SETTLED_MARGIN_SECONDS;
}

/** Receipts are the record of what has ever been collected, so listing them
 *  enumerates the archive without reading the raw layer. */
async function listCollectedPartitions(bucket: R2Bucket, subreddit: string): Promise<Partition[]> {
  const prefix = receiptPrefix(subreddit);
  const partitions: Partition[] = [];
  let cursor: string | undefined;

  do {
    const listed = await bucket.list({ prefix, cursor });
    for (const object of listed.objects) {
      const parsed = parseReceiptName(object.key.slice(prefix.length));
      if (parsed) partitions.push(parsed);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return partitions;
}

function parseReceiptName(name: string): Partition | null {
  const match = /^(\d{4}-\d{2})-(posts|comments)\.json$/.exec(name);
  // The shape alone would admit a month 13, which then survives as a partition
  // no window can ever be built for.
  if (!match || !parseMonthLabel(match[1]!)) return null;

  return { label: match[1]!, kind: match[2] as Kind };
}
