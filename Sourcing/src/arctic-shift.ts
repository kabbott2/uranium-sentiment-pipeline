import type { Window } from './window';

export type Kind = 'posts' | 'comments';

/** Records are stored verbatim; only `created_utc` is read, to drive pagination. */
export interface Row {
  created_utc: number;
  [field: string]: unknown;
}

export interface Client {
  base: string;
  delayMs: number;
}

const USER_AGENT = 'uranium-sentiment-pipeline (Cloudflare Workflow collector)';
const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 60_000;

/**
 * Pages a search window oldest-first, yielding whole pages as they arrive so a
 * caller can persist each one instead of accumulating a month in memory.
 */
export async function* pages(
  client: Client,
  kind: Kind,
  subreddit: string,
  window: Window,
): AsyncGenerator<Row[]> {
  let cursor = window.after;
  let previousLast = -1;

  while (true) {
    const rows = await fetchPage(client, kind, subreddit, cursor, window.before);
    if (rows.length === 0) return;

    yield rows;

    const last = lastCreatedUtc(rows, kind, subreddit);
    // `after` is exclusive, so stepping one second back re-reads the boundary
    // second: a page that splits a same-second group cannot drop its tail.
    // The overlap costs duplicate rows, which Phase 2 dedups by id; a gap would
    // be permanent. When a page fails to advance the clock at all we are inside
    // one oversized second and must step past it to make progress.
    cursor = last === previousLast ? last : last - 1;
    previousLast = last;

    await sleep(client.delayMs);
  }
}

async function fetchPage(
  client: Client,
  kind: Kind,
  subreddit: string,
  after: number,
  before: number,
): Promise<Row[]> {
  const url = new URL(`${client.base}/${kind}/search`);
  url.searchParams.set('subreddit', subreddit);
  url.searchParams.set('after', String(after));
  url.searchParams.set('before', String(before));
  url.searchParams.set('sort', 'asc');
  // Numeric limits cap at 100; `auto` is the only way to get large pages.
  url.searchParams.set('limit', 'auto');

  let lastError = '';

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });

    if (response.ok) {
      const body = (await response.json()) as { data?: unknown };
      // An empty page is the pagination loop's only termination condition, so
      // a malformed 200 must throw rather than coerce to [] and end the window.
      if (!Array.isArray(body.data)) {
        throw new Error(
          `Arctic Shift ${kind} search returned no data array for r/${subreddit}`,
        );
      }
      return body.data as Row[];
    }

    if (response.status === 429) {
      lastError = 'rate limited';
      await sleep(rateLimitDelayMs(response, attempt));
      continue;
    }

    const body = (await response.json().catch(() => ({}))) as { error?: string };
    lastError = `${response.status} ${body.error ?? response.statusText}`;

    if (response.status >= 500 || isServerTimeout(response.status, body.error)) {
      await sleep(backoffMs(attempt));
      continue;
    }

    throw new Error(`Arctic Shift ${kind} search failed for r/${subreddit}: ${lastError}`);
  }

  throw new Error(
    `Arctic Shift ${kind} search gave up for r/${subreddit} after ${MAX_ATTEMPTS} attempts: ${lastError}`,
  );
}

/** A wide window can exceed the archive's own query timeout; it is retryable. */
function isServerTimeout(status: number, error: string | undefined): boolean {
  return status === 422 && (error ?? '').toLowerCase().includes('timeout');
}

function rateLimitDelayMs(response: Response, attempt: number): number {
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.min(reset * 1000, MAX_BACKOFF_MS);
  return backoffMs(attempt);
}

function backoffMs(attempt: number): number {
  return Math.min(2 ** attempt * 1000, MAX_BACKOFF_MS);
}

function lastCreatedUtc(rows: Row[], kind: Kind, subreddit: string): number {
  const last = rows[rows.length - 1]?.created_utc;
  if (!Number.isFinite(last)) {
    throw new Error(`Arctic Shift returned a ${kind} row without created_utc for r/${subreddit}`);
  }
  return last as number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
