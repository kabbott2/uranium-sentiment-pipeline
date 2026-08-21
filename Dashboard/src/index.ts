/**
 * The exuberance/despair dashboard Worker — see Dashboard/DASHBOARD.md.
 *
 * Serves one HTML page plus the JSON the page fetches: the series/tags
 * aggregates the Data container publishes to R2 hourly, and the EOD price
 * series this Worker's own daily cron pulls from Yahoo. The R2 bucket stays
 * private; the browser only ever talks to this origin.
 */
import { dashboardHTML } from './html.ts';
import { SYMBOLS, readPrices, refreshPrices } from './prices.ts';

export interface Env {
  DERIVED: R2Bucket;
  DASHBOARD_SUBREDDIT: string;
}

// Three missed hourly derive runs = the collector or converter died silently.
export const STALE_AFTER_SECONDS = 3 * 3600;

export function isStale(generatedAt: number | null, now: number): boolean {
  return generatedAt == null || now - generatedAt > STALE_AFTER_SECONDS;
}

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'max-age=60',
};

async function serveObject(bucket: R2Bucket, key: string): Promise<Response> {
  const object = await bucket.get(key);
  if (!object) {
    return new Response(JSON.stringify({ error: `${key} not published yet` }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(object.body, { headers: JSON_HEADERS });
}

async function servePrices(bucket: R2Bucket): Promise<Response> {
  const series = await Promise.all(SYMBOLS.map((s) => readPrices(bucket, s.key)));
  const payload = Object.fromEntries(SYMBOLS.map((s, i) => [s.key, series[i]]));
  return new Response(JSON.stringify(payload), { headers: JSON_HEADERS });
}

async function serveStatus(env: Env, now: number): Promise<Response> {
  const object = await env.DERIVED.get(`dashboard/${env.DASHBOARD_SUBREDDIT}/series.json`);
  const series = object ? ((await object.json()) as any) : null;
  const prices = await readPrices(env.DERIVED, SYMBOLS[0].key);
  const generatedAt = series?.generated_at ?? null;
  return new Response(
    JSON.stringify({
      generated_at: generatedAt,
      partial_after: series?.partial_after ?? null,
      prices_updated_at: prices?.updated_at ?? null,
      stale: isStale(generatedAt, now),
    }),
    { headers: JSON_HEADERS },
  );
}

export default {
  async fetch(request, env): Promise<Response> {
    const path = new URL(request.url).pathname;
    const sub = env.DASHBOARD_SUBREDDIT;
    switch (path) {
      case '/':
        return new Response(dashboardHTML(sub), {
          headers: { 'Content-Type': 'text/html;charset=utf-8' },
        });
      case '/api/series':
        return serveObject(env.DERIVED, `dashboard/${sub}/series.json`);
      case '/api/tags':
        return serveObject(env.DERIVED, `dashboard/${sub}/tags.json`);
      case '/api/prices':
        return servePrices(env.DERIVED);
      case '/api/status':
        return serveStatus(env, Math.floor(Date.now() / 1000));
      default:
        return new Response('not found', { status: 404 });
    }
  },

  async scheduled(_controller, env): Promise<void> {
    const report = await refreshPrices(env.DERIVED, Math.floor(Date.now() / 1000));
    console.log(`price refresh: ${report.join(' · ')}`);
  },
} satisfies ExportedHandler<Env>;
