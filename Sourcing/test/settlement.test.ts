import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasSettledEngagement, type Row } from '../src/arctic-shift.ts';
import { openPartitions } from '../src/partitions.ts';
import { labelsOf, receipts, stubBucket, stubEnv, type BucketCalls } from './harness/stub-bucket.ts';

/** 2022-01-01T00:00:00Z, matching `SETTLE_EXEMPT_BEFORE` in wrangler.jsonc. */
const EXEMPT_BEFORE = 1640995200;

const RECENT = 1786000000;
const AT = new Date('2026-08-13T14:00:00Z');
const SUB = 'uraniumsqueeze';

function row(fields: Record<string, unknown>): Row {
  return { created_utc: RECENT, ...fields } as Row;
}

function calls(): BucketCalls {
  return { gets: [], lists: 0 };
}

/** A current-month receipt. Collection is contiguous in practice, and anchoring
 *  it here keeps fill-forward out of the tests that are about settlement. */
const CURRENT = receipts(SUB, '2026-08', { rows_unsettled: 0, collected_at: '2026-08-13T00:00:00Z' });

test('a second retrieval marks engagement settled', () => {
  assert.equal(hasSettledEngagement(row({ _meta: { retrieved_2nd_on: RECENT + 129600 } }), EXEMPT_BEFORE), true);
});

test('no _meta means the second retrieval has not run', () => {
  assert.equal(hasSettledEngagement(row({ score: 1 }), EXEMPT_BEFORE), false);
});

test('_meta without the retrieval stamp is not settled', () => {
  // The object exists on some records for other reasons; only the stamp counts.
  assert.equal(hasSettledEngagement(row({ _meta: { is_edited: false } }), EXEMPT_BEFORE), false);
});

test('a settled row scoring 1 is not mistaken for a placeholder', () => {
  // About half of genuinely settled rows score 1, which is why the score is
  // never consulted.
  const settled = row({ score: 1, num_comments: 0, upvote_ratio: 1, _meta: { retrieved_2nd_on: RECENT } });

  assert.equal(hasSettledEngagement(settled, EXEMPT_BEFORE), true);
});

test('retrieved_on does not stand in for the second retrieval', () => {
  // Ingest time, written ~20s after creation and never updated. It is the field
  // most likely to be mistaken for a freshness signal.
  assert.equal(hasSettledEngagement(row({ retrieved_on: RECENT + 20 }), EXEMPT_BEFORE), false);
});

test('bulk-imported records predate _meta and count as settled', () => {
  const old = { created_utc: EXEMPT_BEFORE - 1, score: 42 } as Row;

  assert.equal(hasSettledEngagement(old, EXEMPT_BEFORE), true);
});

test('a settled past month is not reopened', async () => {
  const seen = calls();
  const bucket = stubBucket(
    { ...CURRENT, ...receipts(SUB, '2026-03', { rows_unsettled: 0, collected_at: '2026-08-12T00:00:00Z' }) },
    seen,
  );

  const open = await openPartitions(stubEnv(bucket), SUB, AT);

  // Absence here is what keeps the sweep off Arctic Shift: only returned
  // partitions are re-paginated, so a closed month costs one receipt read per
  // kind and not one request to the archive.
  assert.deepEqual(labelsOf(open), ['2026-07', '2026-08'], 'only the tail');
  assert.equal(seen.gets.filter((key) => key.includes('2026-03')).length, 2);
});

test('an unsettled partition is reopened however old its month', async () => {
  const bucket = stubBucket(
    { ...CURRENT, ...receipts(SUB, '2026-03', { rows_unsettled: 4, collected_at: '2026-08-12T00:00:00Z' }) },
    calls(),
  );

  const open = await openPartitions(stubEnv(bucket), SUB, AT);

  assert.deepEqual(labelsOf(open), ['2026-03', '2026-07', '2026-08']);
});

test('the current and previous months are read even when their receipts are clean', async () => {
  const bucket = stubBucket(
    {
      ...receipts(SUB, '2026-07', { rows_unsettled: 0, collected_at: '2026-08-12T00:00:00Z' }),
      ...receipts(SUB, '2026-08', { rows_unsettled: 0, collected_at: '2026-08-12T00:00:00Z' }),
    },
    calls(),
  );

  const open = await openPartitions(stubEnv(bucket), SUB, AT);

  assert.deepEqual(labelsOf(open), ['2026-07', '2026-08'], 'the tail is never closed — new rows keep arriving');
  assert.equal(open.length, 4, 'both kinds of both months');
});

test('a legacy receipt collected long after its month counts as final', async () => {
  // No `rows_unsettled` field at all: written before settlement was tracked.
  const bucket = stubBucket(
    { ...CURRENT, ...receipts(SUB, '2026-01', { collected_at: '2026-08-11T18:27:00Z' }) },
    calls(),
  );

  const open = await openPartitions(stubEnv(bucket), SUB, AT);

  assert.deepEqual(labelsOf(open), ['2026-07', '2026-08'], 'six months of margin is past any observed backlog');
});

test('a legacy receipt collected close to its own month is reopened', async () => {
  // Collected eleven days after the month ended — inside the ten-day backlog
  // the archive was measured running, so it cannot be assumed settled.
  const bucket = stubBucket(
    { ...CURRENT, ...receipts(SUB, '2026-04', { collected_at: '2026-05-12T00:00:00Z' }) },
    calls(),
  );

  const open = await openPartitions(stubEnv(bucket), SUB, AT);

  assert.deepEqual(labelsOf(open), ['2026-04', '2026-07', '2026-08']);
});

test('a legacy receipt without a usable timestamp is reopened', async () => {
  const bucket = stubBucket({ ...receipts(SUB, '2026-02', {}) }, calls());

  const open = await openPartitions(stubEnv(bucket), SUB, AT);

  assert.ok(labelsOf(open).includes('2026-02'), 'unprovable is treated as unsettled, never the reverse');
});

test('a subreddit the archive has never held is left alone', async () => {
  const open = await openPartitions(stubEnv(stubBucket({}, calls())), 'nuclear', AT);

  assert.deepEqual(open, [], 'seeding a new target stays a deliberate backfill call');
});

test('a gap in collection is filled forward past the configured tail', async () => {
  // Collection stopped in March; the two-month tail alone would skip April
  // through June, and no receipt exists to point at them.
  const bucket = stubBucket(
    { ...receipts(SUB, '2026-03', { rows_unsettled: 0, collected_at: '2026-04-30T00:00:00Z' }) },
    calls(),
  );

  const open = await openPartitions(stubEnv(bucket), SUB, AT);

  assert.deepEqual(labelsOf(open), ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']);
});

test('filling forward is capped so an old bucket cannot trigger a full backfill', async () => {
  const bucket = stubBucket(
    { ...receipts(SUB, '2021-09', { rows_unsettled: 0, collected_at: '2026-08-12T00:00:00Z' }) },
    calls(),
  );

  const open = await openPartitions(stubEnv(bucket), SUB, AT);

  assert.equal(labelsOf(open).length, 24, 'two years, not the five since 2021');
  assert.ok(!labelsOf(open).includes('2021-09'), 'and the settled receipt itself stays closed');
});

test('partitions are found across a truncated listing', async () => {
  const seen = calls();
  const bucket = stubBucket(
    {
      ...receipts(SUB, '2026-05', { rows_unsettled: 1, collected_at: '2026-08-11T00:00:00Z' }),
      ...receipts(SUB, '2026-06', { rows_unsettled: 1, collected_at: '2026-08-11T00:00:00Z' }),
    },
    seen,
    2,
  );

  const open = await openPartitions(stubEnv(bucket), SUB, AT);

  assert.ok(seen.lists > 1, 'the listing really did paginate');
  assert.deepEqual(labelsOf(open), ['2026-05', '2026-06', '2026-07', '2026-08']);
});

test('objects that are not receipts are ignored', async () => {
  const bucket = stubBucket(
    {
      [`receipts/${SUB}/notes.txt`]: {},
      // Shaped like a receipt but naming a month that does not exist; without a
      // label check it survives as a partition no window can be built for.
      [`receipts/${SUB}/2026-13-posts.json`]: {},
      ...receipts(SUB, '2026-07', { rows_unsettled: 2, collected_at: '2026-08-12T00:00:00Z' }),
    },
    calls(),
  );

  const open = await openPartitions(stubEnv(bucket), SUB, AT);

  assert.deepEqual(labelsOf(open), ['2026-07', '2026-08']);
});
