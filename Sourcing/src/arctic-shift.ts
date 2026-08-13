import type { Window } from './window.ts';

export type Kind = 'posts' | 'comments';

/** Records are stored verbatim; only `created_utc` is read, to drive pagination. */
export interface Row {
  created_utc: number;
  [field: string]: unknown;
}

export interface Client {
  base: string;
  delayMs: number;
  /** Injected so the pagination tests can serve a stubbed archive. */
  fetch: typeof fetch;
}

/**
 * Engagement is final if and only if Arctic Shift's second retrieval has run.
 * The archive scrapes each record twice: once on ingest (~20s after creation,
 * carrying Reddit's `score=1` placeholder) and once at T+36h, which writes
 * `_meta.retrieved_2nd_on` and the settled values. There is no third pass, and
 * the values never change afterwards.
 *
 * The field is checked rather than the clock because the re-scrape queue
 * backlogs: 74% of 2026-07 content was re-read late, the worst by ten days, so
 * an age test would have written placeholders as final for most of that month.
 * `score === 1` is no substitute either — about half of settled rows legitimately
 * score 1 — and `retrieved_on` is ingest time that the re-scrape never updates.
 *
 * Records predating the Pushshift-era bulk import carry no `_meta` at all and
 * are as settled as they will ever be, hence the cutoff.
 */
export function hasSettledEngagement(row: Row, exemptBefore: number): boolean {
  if (row.created_utc < exemptBefore) return true;

  const meta = row._meta;
  return typeof meta === 'object' && meta !== null && 'retrieved_2nd_on' in meta;
}

/**
 * `pending` rows are worth re-reading; `abandoned` ones are not. A few records
 * never receive a second retrieval at all — measured at 9 of 6,105 rows over
 * r/UraniumSqueeze's 2026, still bare four months on, live and undeleted — so
 * without a horizon their partitions would reopen every firing forever and the
 * archive would never converge.
 *
 * The horizon bounds retrying only. Whether a row is settled is still decided
 * per row by the stamp and never by age, so abandoning one records that its
 * engagement is permanently Arctic Shift's placeholder rather than pretending
 * it is final.
 */
export type EngagementState = 'settled' | 'pending' | 'abandoned';

export function engagementState(
  row: Row,
  at: number,
  exemptBefore: number,
  giveUpSeconds: number,
): EngagementState {
  if (hasSettledEngagement(row, exemptBefore)) return 'settled';

  return at - row.created_utc > giveUpSeconds ? 'abandoned' : 'pending';
}

/** Filled in by `pages()` so callers can surface pagination doubt in receipts. */
export interface PageStats {
  /** Seconds whose stalled page reached the page-size floor, leaving the second
   *  unprovable either way. */
  unprovenAt: number[];
  /** Seconds that disprove `MIN_AUTO_PAGE_ROWS`. Always empty in practice. */
  floorViolationAt: number[];
}

const USER_AGENT = 'uranium-sentiment-pipeline (Cloudflare Workflow collector)';
const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 60_000;

/**
 * `limit=auto` is documented to return between 100 and 1000 rows, so a shorter
 * page cannot have been truncated and holds every row its query matched. That
 * lower bound is the only completeness proof this API offers: there is no
 * cursor, `sort=desc` returns the same head-of-second rows rather than the
 * reverse, and the aggregate endpoint is unreliable at second granularity.
 */
const MIN_AUTO_PAGE_ROWS = 100;

/**
 * Pages a search window oldest-first, yielding whole pages as they arrive so a
 * caller can persist each one instead of accumulating a month in memory.
 */
export async function* pages(
  client: Client,
  kind: Kind,
  subreddit: string,
  window: Window,
  stats: PageStats,
): AsyncGenerator<Row[]> {
  let cursor = window.after;
  let provenLast = -1;

  while (true) {
    const rows = await fetchPage(client, kind, subreddit, cursor, window.before);

    // A page under the floor holds everything its query matched, so nothing
    // above its final second can still be in the window. A later row appearing
    // anyway means `limit=auto` returned fewer than its documented minimum —
    // and every clean second below is then a truncated page misread as whole.
    if (provenLast >= 0 && rows.some((row) => row.created_utc > provenLast)) {
      stats.floorViolationAt.push(provenLast);
    }

    if (rows.length === 0) return;

    yield rows;

    const last = lastCreatedUtc(rows, kind, subreddit);
    // `after` is exclusive, so stepping one second back re-reads the boundary
    // second: a page that splits a same-second group cannot drop its tail.
    // The overlap costs duplicate rows, which Phase 2 dedups by id; a gap would
    // be permanent. Re-reading with this `after` would repeat the page verbatim
    // — ordering within a second is identical across identical requests — so
    // the page ends inside `last` and the cursor can only advance by stepping
    // over that second. Below the floor that is free: the page already holds
    // the whole second. At or above it, the second's tail may be unread and
    // there is no way to tell, so the second is recorded rather than repaired.
    if (last - 1 === cursor) {
      if (rows.length >= MIN_AUTO_PAGE_ROWS) stats.unprovenAt.push(last);
      cursor = last;
    } else {
      cursor = last - 1;
    }
    provenLast = rows.length < MIN_AUTO_PAGE_ROWS ? last : -1;

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

  // Called off the client it would receive `client` as its `this`, and the
  // runtime's native fetch rejects any receiver that is not the global scope.
  const { fetch: send } = client;
  let lastError = '';

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await send(url, { headers: { 'user-agent': USER_AGENT } });

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
