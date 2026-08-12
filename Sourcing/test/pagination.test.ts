import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectWindow, rowsAt, secondsEach } from './harness/stub-archive.ts';

const WINDOW = { after: 999, before: 2000 };

/** Matches `MIN_AUTO_PAGE_ROWS`. A page cut here is indistinguishable from one
 *  that merely ran out of rows, which is the whole point of the floor. */
const FLOOR = 100;

test('the collector fetches without a receiver', async () => {
  // The stub rejects a method call because the runtime's native fetch answers
  // one with an `Illegal invocation` TypeError, which took the collector down
  // for two hourly firings on 2026-08-12.
  const result = await collectWindow({ rows: secondsEach(1000, 3), pageSize: FLOOR }, WINDOW);

  assert.equal(result.unique, 3);
});

test('a window of single-row seconds is read whole and flags nothing', async () => {
  const result = await collectWindow({ rows: rowsAt([[1000, 1], [1001, 1], [1002, 1]]), pageSize: FLOOR }, WINDOW);

  assert.equal(result.unique, 3);
  assert.deepEqual(result.stats.unprovenAt, []);
  assert.deepEqual(result.stats.floorViolationAt, []);
});

test('a single row terminates without flagging', async () => {
  const result = await collectWindow({ rows: rowsAt([[1000, 1]]), pageSize: FLOOR }, WINDOW);

  assert.equal(result.unique, 1);
  assert.deepEqual(result.stats.unprovenAt, []);
  assert.equal(result.requests, 2);
});

test('an empty window costs one request and flags nothing', async () => {
  const result = await collectWindow({ rows: [], pageSize: FLOOR }, WINDOW);

  assert.equal(result.unique, 0);
  assert.equal(result.yielded, 0);
  assert.equal(result.requests, 1);
  assert.deepEqual(result.stats.unprovenAt, []);
});

test('paging across many seconds keeps every row and duplicates only boundaries', async () => {
  const result = await collectWindow({ rows: secondsEach(1000, 250), pageSize: FLOOR }, WINDOW);

  assert.equal(result.unique, 250);
  assert.ok(result.yielded > result.unique, 'boundary re-reads must duplicate rows for Phase 2 to dedup');
  assert.deepEqual(result.stats.unprovenAt, []);
  assert.deepEqual(result.stats.floorViolationAt, []);
});

test('a boundary second split across pages but read whole stays clean', async () => {
  const result = await collectWindow(
    { rows: rowsAt([[1000, 5], [1001, FLOOR - 1]]), pageSize: FLOOR },
    WINDOW,
  );

  assert.equal(result.unique, 5 + FLOOR - 1, 'every row is captured');
  assert.deepEqual(result.stats.unprovenAt, [], 'a page under the floor proves the second whole');
});

test('a second exactly at the floor is flagged even though nothing was lost', async () => {
  const result = await collectWindow({ rows: rowsAt([[1000, 5], [1001, FLOOR]]), pageSize: FLOOR }, WINDOW);

  assert.equal(result.unique, 5 + FLOOR, 'the second was in fact read whole');
  assert.deepEqual(result.stats.unprovenAt, [1001], 'but a page at the floor cannot prove it');
});

test('an oversized second mid-window is flagged and loses its tail', async () => {
  const rows = rowsAt([[1000, 5], [1001, 350], [1002, 4]]);
  const result = await collectWindow({ rows, pageSize: FLOOR }, WINDOW);

  assert.deepEqual(result.stats.unprovenAt, [1001]);
  assert.equal(result.unique, 5 + FLOOR + 4);
  assert.equal(rows.length - result.unique, 250, 'the unread tail is real, and recorded rather than repaired');
});

test('an oversized second at the window start is flagged on the first page', async () => {
  const result = await collectWindow({ rows: rowsAt([[1000, 350], [1001, 5]]), pageSize: FLOOR }, WINDOW);

  assert.deepEqual(result.stats.unprovenAt, [1000]);
  assert.equal(result.unique, FLOOR + 5);
});

test('an oversized second at the window end is flagged', async () => {
  const result = await collectWindow({ rows: rowsAt([[1000, 5], [1001, 350]]), pageSize: FLOOR }, WINDOW);

  assert.deepEqual(result.stats.unprovenAt, [1001], 'the case the previous heuristic could not see');
  assert.equal(result.unique, 5 + FLOOR);
});

test('two oversized seconds are flagged separately', async () => {
  const result = await collectWindow(
    { rows: rowsAt([[1000, 350], [1001, 350], [1002, 4]]), pageSize: FLOOR },
    WINDOW,
  );

  assert.deepEqual(result.stats.unprovenAt, [1000, 1001]);
  assert.equal(result.unique, FLOOR + FLOOR + 4);
});

test('a short page followed by more data reports a floor violation', async () => {
  const result = await collectWindow({ rows: secondsEach(1000, 5), pageSize: 3 }, WINDOW);

  assert.deepEqual(
    result.stats.floorViolationAt,
    [1002],
    'a 3-row page that was truncated disproves the documented 100-row minimum',
  );
  assert.deepEqual(result.stats.unprovenAt, [], 'and the second itself still reads as clean, which is the danger');
});

test('a malformed 200 throws instead of ending the window', async () => {
  await assert.rejects(
    () =>
      collectWindow(
        { rows: rowsAt([[1000, 1]]), pageSize: FLOOR, scripted: [{ status: 200, body: { data: null } }] },
        WINDOW,
      ),
    /no data array/,
  );
});

test('a non-retryable status throws', async () => {
  await assert.rejects(
    () =>
      collectWindow(
        { rows: [], pageSize: FLOOR, scripted: [{ status: 404, body: { error: 'not found' } }] },
        WINDOW,
      ),
    /search failed/,
  );
});

test('a query timeout is retried rather than read as end-of-window', async () => {
  const result = await collectWindow(
    {
      rows: rowsAt([[1000, 1]]),
      pageSize: FLOOR,
      scripted: [{ status: 422, body: { error: 'Timeout. Maybe slow down a bit' } }],
    },
    WINDOW,
  );

  assert.equal(result.unique, 1);
});

test('a rate limit is retried', async () => {
  const result = await collectWindow(
    { rows: rowsAt([[1000, 1]]), pageSize: FLOOR, scripted: [{ status: 429, body: {} }] },
    WINDOW,
  );

  assert.equal(result.unique, 1);
});
