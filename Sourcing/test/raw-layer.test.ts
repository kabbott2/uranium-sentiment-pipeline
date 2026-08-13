import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteStaleBackfillParts } from '../src/storage.ts';

const SUB = 'uraniumsqueeze';
const MONTH = '2021-09';
const RUN_STARTED = new Date('2026-08-13T12:00:00Z');
const BEFORE = new Date('2026-08-13T11:00:00Z');
const DURING = new Date('2026-08-13T12:30:00Z');

interface StubObject {
  key: string;
  uploaded: Date;
}

function stubBucket(objects: StubObject[], deleted: string[]): R2Bucket {
  return {
    async list(options?: { prefix?: string }) {
      return {
        objects: objects.filter((object) => object.key.startsWith(options?.prefix ?? '')),
        truncated: false,
        cursor: '',
      };
    },
    async delete(keys: string[]) {
      deleted.push(...keys);
    },
  } as unknown as R2Bucket;
}

function partsAt(count: number, uploaded: Date, first = 0): StubObject[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `raw/${SUB}/${MONTH}/comments-part-${String(first + index).padStart(4, '0')}.jsonl.gz`,
    uploaded,
  }));
}

test('a shorter rerun deletes the parts it did not overwrite', async () => {
  const deleted: string[] = [];
  const bucket = stubBucket(partsAt(6, BEFORE), deleted);

  await deleteStaleBackfillParts(bucket, SUB, MONTH, 'comments', 3, RUN_STARTED);

  assert.deepEqual(deleted, [
    `raw/${SUB}/${MONTH}/comments-part-0003.jsonl.gz`,
    `raw/${SUB}/${MONTH}/comments-part-0004.jsonl.gz`,
    `raw/${SUB}/${MONTH}/comments-part-0005.jsonl.gz`,
  ]);
});

test('parts a concurrent run is still writing are never deleted', async () => {
  // A manual rerun against the six-hourly sweep. `limit=auto` varies, so the
  // two runs disagree on the count and the shorter one would otherwise delete
  // the tail the longer one has not finished writing.
  const deleted: string[] = [];
  const bucket = stubBucket(partsAt(6, DURING), deleted);

  await deleteStaleBackfillParts(bucket, SUB, MONTH, 'comments', 3, RUN_STARTED);

  assert.deepEqual(deleted, [], 'every object postdates this run');
});

test('only the parts predating the run are eligible', async () => {
  const deleted: string[] = [];
  const bucket = stubBucket([...partsAt(4, BEFORE), ...partsAt(2, DURING, 4)], deleted);

  await deleteStaleBackfillParts(bucket, SUB, MONTH, 'comments', 2, RUN_STARTED);

  assert.deepEqual(deleted, [
    `raw/${SUB}/${MONTH}/comments-part-0002.jsonl.gz`,
    `raw/${SUB}/${MONTH}/comments-part-0003.jsonl.gz`,
  ]);
});

test('the hourly collector output is left alone', async () => {
  const deleted: string[] = [];
  const bucket = stubBucket(
    [
      ...partsAt(2, BEFORE),
      {
        key: `raw/${SUB}/${MONTH}/comments-recent-20260813T11-part-0000.jsonl.gz`,
        uploaded: BEFORE,
      },
    ],
    deleted,
  );

  await deleteStaleBackfillParts(bucket, SUB, MONTH, 'comments', 0, RUN_STARTED);

  assert.ok(
    !deleted.some((key) => key.includes('-recent-')),
    'provisional objects are a different name and a different lifecycle',
  );
});
