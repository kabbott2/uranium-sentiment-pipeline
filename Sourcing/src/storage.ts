import type { Kind, Row } from './arctic-shift';
import { monthOf } from './window';

export interface Receipt {
  keys_written: number;
  rows: number;
  last_created_utc: number;
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
 *  different name and are deliberately untouched. */
export async function deleteStaleBackfillParts(
  bucket: R2Bucket,
  subreddit: string,
  month: string,
  kind: Kind,
  partsWritten: number,
): Promise<void> {
  const prefix = `${partitionPrefix(subreddit, month)}${kind}-part-`;
  let cursor: string | undefined;

  do {
    const listed = await bucket.list({ prefix, cursor });
    const stale = listed.objects
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

  await bucket.put(`receipts/${subreddit.toLowerCase()}/${month}-${kind}.json`, body, {
    httpMetadata: { contentType: 'application/json' },
  });
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
