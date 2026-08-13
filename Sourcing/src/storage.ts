import type { Kind, Row } from './arctic-shift.ts';
import { monthOf } from './window.ts';

export interface Receipt {
  keys_written: number;
  rows: number;
  last_created_utc: number;
  /** Seconds the collector could not prove it read whole, equal to
   *  `unproven_at.length`. Not measured loss — the archive exposes no reliable
   *  per-second count — so treat it as a pointer to the recovery runbook in
   *  SOURCING.md, with Phase 2's id-level dedup as the authority. */
  seconds_unproven: number;
  unproven_at: number[];
  /** Seconds disproving the page-size floor the proof rests on. Always empty;
   *  anything else invalidates every clean second in this partition. */
  floor_violation_at: number[];
  /** Rows still awaiting the archive's second retrieval and young enough to
   *  expect it. Non-zero means the partition is not final and the reconciler
   *  will come back to it. */
  rows_unsettled: number;
  /** Earliest unsettled row, so a stuck partition can be diagnosed against the
   *  archive's re-scrape backlog. Zero when nothing is unsettled. */
  oldest_unsettled_created_utc: number;
  /** Rows past the retry horizon that never received a second retrieval. Their
   *  engagement is permanently placeholder — exclude them from any
   *  engagement-weighted series rather than reading `score=1` as a score. */
  rows_abandoned: number;
}

/** A receipt as it comes back out of R2. Every field is optional because objects
 *  written by earlier versions of the collector predate them, and the reconciler
 *  has to decide what to do about exactly those. */
export type StoredReceipt = Partial<Receipt> & {
  subreddit?: string;
  month?: string;
  kind?: Kind;
  collected_at?: string;
};

export async function readReceipt(
  bucket: R2Bucket,
  subreddit: string,
  month: string,
  kind: Kind,
): Promise<StoredReceipt | null> {
  const object = await bucket.get(receiptKey(subreddit, month, kind));
  return object ? ((await object.json()) as StoredReceipt) : null;
}

/** Backfill owns `{kind}-part-NNNN`; a rerun of a month replaces exactly this set. */
export function backfillKey(subreddit: string, month: string, kind: Kind, part: number): string {
  return `${partitionPrefix(subreddit, month)}${kind}-part-${pad4(part)}.jsonl.gz`;
}

/** The hourly collector stamps its objects with the firing hour, so a retried
 *  firing overwrites its own output instead of appending a duplicate set. */
export function recentKey(
  subreddit: string,
  month: string,
  kind: Kind,
  stamp: string,
  part: number,
): string {
  return `${partitionPrefix(subreddit, month)}${kind}-recent-${stamp}-part-${pad4(part)}.jsonl.gz`;
}

export async function putRows(bucket: R2Bucket, key: string, rows: Row[]): Promise<void> {
  const ndjson = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  await bucket.put(key, await gzip(ndjson), {
    httpMetadata: { contentType: 'application/gzip' },
  });
}

/** Deletes backfill parts a shorter rerun did not overwrite (index >=
 *  partsWritten). Runs only after the rerun's parts and receipt are written:
 *  the raw layer is irreplaceable, so nothing is deleted before its
 *  replacement exists. Hourly `{kind}-recent-*` objects live under a
 *  different name and are deliberately untouched.
 *
 *  Only objects predating this run are eligible. A part index identifies a
 *  position, not the run that wrote it, so two passes over one partition —
 *  a manual rerun against the six-hourly sweep, or a firing that overran into
 *  the next — would otherwise let whichever finished first delete the parts the
 *  other had not reached yet, and `limit=auto` varies enough that they
 *  legitimately disagree on the count. */
export async function deleteStaleBackfillParts(
  bucket: R2Bucket,
  subreddit: string,
  month: string,
  kind: Kind,
  partsWritten: number,
  writtenBefore: Date,
): Promise<void> {
  const prefix = `${partitionPrefix(subreddit, month)}${kind}-part-`;
  let cursor: string | undefined;

  do {
    const listed = await bucket.list({ prefix, cursor });
    const stale = listed.objects
      .filter((object) => object.uploaded < writtenBefore)
      .map((object) => object.key)
      .filter((key) => Number.parseInt(key.slice(prefix.length), 10) >= partsWritten);
    if (stale.length > 0) {
      await bucket.delete(stale);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

export async function writeReceipt(
  bucket: R2Bucket,
  subreddit: string,
  month: string,
  kind: Kind,
  receipt: Receipt,
): Promise<void> {
  const body = JSON.stringify({
    subreddit: subreddit.toLowerCase(),
    month,
    kind,
    collected_at: new Date().toISOString(),
    ...receipt,
  });

  await bucket.put(receiptKey(subreddit, month, kind), body, {
    httpMetadata: { contentType: 'application/json' },
  });
}

export function receiptKey(subreddit: string, month: string, kind: Kind): string {
  return `receipts/${subreddit.toLowerCase()}/${month}-${kind}.json`;
}

export function receiptPrefix(subreddit: string): string {
  return `receipts/${subreddit.toLowerCase()}/`;
}

/** A trailing window can straddle a month boundary, so rows are filed by their
 *  own timestamp rather than by the window they were fetched in. */
export function groupByMonth(rows: Row[]): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();

  for (const row of rows) {
    const month = monthOf(row.created_utc);
    const group = groups.get(month);
    if (group) group.push(row);
    else groups.set(month, [row]);
  }

  return groups;
}

function partitionPrefix(subreddit: string, month: string): string {
  return `raw/${subreddit.toLowerCase()}/${month}/`;
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const compressed = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return await new Response(compressed).arrayBuffer();
}

function pad4(part: number): string {
  return String(part).padStart(4, '0');
}
