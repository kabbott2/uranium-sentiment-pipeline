import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseChart, priceKey, refreshPrices, validateSeries } from '../src/prices.ts';
import { stubBucket } from './stub-bucket.ts';

// 2021-02-01 and 2021-02-02 at 14:30 UTC (NYSE open stamps).
const chartPayload = (closes: (number | null)[] = [71.2, 72.05]) => ({
  chart: {
    result: [
      {
        meta: { currency: 'USD' },
        timestamp: [1612189800, 1612276200],
        indicators: { quote: [{ close: closes }] },
      },
    ],
  },
});

test('parseChart maps stamps to trading dates and rounds closes', () => {
  const series = parseChart(chartPayload([71.204, 72.049]), 'URNM', 1000);
  assert.equal(series.symbol, 'URNM');
  assert.equal(series.currency, 'USD');
  assert.deepEqual(series.rows, [
    ['2021-02-01', 71.2],
    ['2021-02-02', 72.05],
  ]);
});

test('parseChart drops null closes and rejects malformed payloads', () => {
  assert.equal(parseChart(chartPayload([71.2, null]), 'URNM', 0).rows.length, 1);
  assert.throws(() => parseChart({}, 'URNM', 0), /malformed/);
});

test('validateSeries rejects shrinkage and insane prices', () => {
  const prev = parseChart(chartPayload(), 'URNM', 0);
  const one = parseChart(chartPayload([71.2, null]), 'URNM', 1);
  assert.match(validateSeries(one, prev) ?? '', /shrank/);
  const insane = parseChart(chartPayload([71.2, -3]), 'URNM', 1);
  assert.match(validateSeries(insane, null) ?? '', /insane/);
  assert.equal(validateSeries(prev, prev), null);
});

test('refreshPrices writes both symbols and keeps previous on a bad feed', async () => {
  const objects: Record<string, string> = {};
  const bucket = stubBucket(objects);
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(chartPayload()), { status: 200 })) as typeof fetch;
  try {
    let report = await refreshPrices(bucket, 500);
    assert.equal(report.length, 2);
    assert.ok(objects[priceKey('urnm')]);
    assert.ok(objects[priceKey('u-u-to')]);
    const stored = JSON.parse(objects[priceKey('urnm')]!);
    assert.equal(stored.updated_at, 500);

    globalThis.fetch = (async () =>
      new Response('down', { status: 503 })) as typeof fetch;
    report = await refreshPrices(bucket, 900);
    assert.match(report[0]!, /kept previous/);
    assert.equal(JSON.parse(objects[priceKey('urnm')]!).updated_at, 500);
  } finally {
    globalThis.fetch = original;
  }
});
