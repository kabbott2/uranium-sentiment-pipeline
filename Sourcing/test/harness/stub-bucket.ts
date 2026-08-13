import type { Env } from '../../src/env.ts';
import { receiptKey } from '../../src/storage.ts';
import type { Kind } from '../../src/arctic-shift.ts';

export interface StubReceipt {
  collected_at?: string;
  rows_unsettled?: number;
}

/** Records every key read, so a test can assert a settled partition costs no
 *  reads at all rather than merely producing no work. */
export interface BucketCalls {
  gets: string[];
  lists: number;
}

/** Enough of R2 for partition selection: prefix listing with a cursor, and JSON
 *  reads. `pageSize` forces the truncation path the real listing loop handles. */
export function stubBucket(
  objects: Record<string, unknown>,
  calls: BucketCalls,
  pageSize = 1000,
): R2Bucket {
  return {
    async list(options?: { prefix?: string; cursor?: string }) {
      calls.lists++;
      const matching = Object.keys(objects)
        .filter((key) => key.startsWith(options?.prefix ?? ''))
        .sort();
      const start = Number(options?.cursor ?? 0);
      const page = matching.slice(start, start + pageSize);
      const next = start + page.length;

      return {
        objects: page.map((key) => ({ key })),
        truncated: next < matching.length,
        cursor: String(next),
      };
    },
    async get(key: string) {
      calls.gets.push(key);
      if (!(key in objects)) return null;
      return { json: async () => objects[key] };
    },
  } as unknown as R2Bucket;
}

export function stubEnv(bucket: R2Bucket, reconcileMonths = 2): Env {
  return { RAW: bucket, RECONCILE_MONTHS: reconcileMonths } as unknown as Env;
}

/** Both kinds of a month, since the collector always writes them in pairs. */
export function receipts(
  subreddit: string,
  month: string,
  receipt: StubReceipt,
): Record<string, StubReceipt> {
  const kinds: Kind[] = ['posts', 'comments'];
  return Object.fromEntries(
    kinds.map((kind) => [receiptKey(subreddit, month, kind), { month, kind, ...receipt }]),
  );
}

export function labelsOf(partitions: Array<{ label: string; kind: string }>): string[] {
  return [...new Set(partitions.map((partition) => partition.label))].sort();
}
