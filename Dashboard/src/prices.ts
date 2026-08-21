/**
 * EOD price series from Yahoo Finance's chart API — the ONE place a licensed
 * feed swaps in. Yahoo is unofficial: it serves full daily history to a plain
 * fetch with a browser User-Agent, no key. Each refresh refetches the whole
 * history and overwrites, so the store is idempotent and a bad day self-heals
 * on the next cron. A response that shrinks the series or carries insane
 * prices is rejected and the previous object kept.
 */

export interface PriceSeries {
  symbol: string;
  currency: string;
  updated_at: number;
  rows: [string, number][]; // [YYYY-MM-DD, close]
}

export const SYMBOLS = [
  { yahoo: 'URNM', key: 'urnm', label: 'URNM' },
  { yahoo: 'U-U.TO', key: 'u-u-to', label: 'SPUT (U.U)' },
] as const;

const CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const USER_AGENT = 'Mozilla/5.0 (compatible; uranium-dashboard cron)';
// A close outside this band is a parse or feed error, not a price.
const MIN_PRICE = 0.01;
const MAX_PRICE = 10_000;

export function priceKey(key: string): string {
  return `dashboard/prices/${key}.json`;
}

export function parseChart(payload: unknown, symbol: string, now: number): PriceSeries {
  const result = (payload as any)?.chart?.result?.[0];
  const timestamps: unknown[] = result?.timestamp ?? [];
  const closes: unknown[] = result?.indicators?.quote?.[0]?.close ?? [];
  const currency: string = result?.meta?.currency ?? '';
  if (!timestamps.length || timestamps.length !== closes.length) {
    throw new Error(`${symbol}: malformed chart payload`);
  }
  const rows: [string, number][] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const close = closes[i];
    if (typeof ts !== 'number' || typeof close !== 'number') continue;
    // Daily bars are stamped at market open (14:30Z NYSE, 13:30Z TSX), so the
    // UTC date of the stamp is the trading date.
    rows.push([new Date(ts * 1000).toISOString().slice(0, 10), round2(close)]);
  }
  return { symbol, currency, updated_at: now, rows };
}

export function validateSeries(next: PriceSeries, previous: PriceSeries | null): string | null {
  if (next.rows.length === 0) return 'no rows';
  for (const [, close] of next.rows) {
    if (!(close >= MIN_PRICE && close <= MAX_PRICE)) return `insane close ${close}`;
  }
  if (previous && next.rows.length < previous.rows.length) {
    return `series shrank ${previous.rows.length} -> ${next.rows.length}`;
  }
  return null;
}

export async function refreshPrices(bucket: R2Bucket, now: number): Promise<string[]> {
  const report: string[] = [];
  for (const { yahoo, key } of SYMBOLS) {
    const url = `${CHART_URL}${encodeURIComponent(yahoo)}?range=max&interval=1d`;
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) {
      report.push(`${yahoo}: HTTP ${response.status}, kept previous`);
      continue;
    }
    const series = parseChart(await response.json(), yahoo, now);
    const previous = await readPrices(bucket, key);
    const problem = validateSeries(series, previous);
    if (problem) {
      report.push(`${yahoo}: rejected (${problem}), kept previous`);
      continue;
    }
    await bucket.put(priceKey(key), JSON.stringify(series), {
      httpMetadata: { contentType: 'application/json' },
    });
    report.push(`${yahoo}: ${series.rows.length} rows through ${series.rows.at(-1)?.[0]}`);
  }
  return report;
}

export async function readPrices(bucket: R2Bucket, key: string): Promise<PriceSeries | null> {
  const object = await bucket.get(priceKey(key));
  return object ? ((await object.json()) as PriceSeries) : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
