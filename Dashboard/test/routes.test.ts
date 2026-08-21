import assert from 'node:assert/strict';
import { test } from 'node:test';

import worker, { STALE_AFTER_SECONDS, isStale, type Env } from '../src/index.ts';
import { stubBucket } from './stub-bucket.ts';

const NOW = 1_766_300_000;

function makeEnv(objects: Record<string, string>): Env {
  return { DERIVED: stubBucket(objects), DASHBOARD_SUBREDDIT: 'uraniumsqueeze' };
}

const get = (env: Env, path: string) =>
  worker.fetch!(new Request(`https://dash.example${path}`), env);

test('root serves the page with the subreddit baked in', async () => {
  const response = await get(makeEnv({}), '/');
  assert.equal(response.headers.get('Content-Type'), 'text/html;charset=utf-8');
  const html = await response.text();
  assert.match(html, /r\/Uraniumsqueeze/);
  assert.match(html, /\/api\/series/);
  assert.match(html, /data-theme/); // light/dark support baked in
});

test('api routes proxy the published JSON with a short cache', async () => {
  const env = makeEnv({
    'dashboard/uraniumsqueeze/series.json': JSON.stringify({ daily: [], generated_at: NOW }),
  });
  const response = await get(env, '/api/series');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'max-age=60');
  assert.equal(((await response.json()) as any).generated_at, NOW);
});

test('unpublished JSON is 503, unknown routes 404', async () => {
  assert.equal((await get(makeEnv({}), '/api/tags')).status, 503);
  assert.equal((await get(makeEnv({}), '/nope')).status, 404);
});

test('prices merge both symbols and tolerate missing ones', async () => {
  const env = makeEnv({
    'dashboard/prices/urnm.json': JSON.stringify({ symbol: 'URNM', rows: [] }),
  });
  const payload = (await (await get(env, '/api/prices')).json()) as any;
  assert.equal(payload.urnm.symbol, 'URNM');
  assert.equal(payload['u-u-to'], null);
});

test('status reports staleness from generated_at', async () => {
  const env = makeEnv({
    'dashboard/uraniumsqueeze/series.json': JSON.stringify({
      generated_at: NOW, partial_after: '2026-08-19',
    }),
    'dashboard/prices/urnm.json': JSON.stringify({ updated_at: NOW - 3600, rows: [] }),
  });
  const status = (await (await get(env, '/api/status')).json()) as any;
  assert.equal(status.stale, true); // Date.now() is far past NOW
  assert.equal(status.partial_after, '2026-08-19');
  assert.equal(status.prices_updated_at, NOW - 3600);
});

test('isStale is the three-missed-runs rule', () => {
  assert.equal(isStale(null, NOW), true);
  assert.equal(isStale(NOW - STALE_AFTER_SECONDS, NOW), false);
  assert.equal(isStale(NOW - STALE_AFTER_SECONDS - 1, NOW), true);
});
