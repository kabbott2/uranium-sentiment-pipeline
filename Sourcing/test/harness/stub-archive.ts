import { pages, type PageStats } from '../../src/arctic-shift.ts';

export interface StubRow {
  id: string;
  created_utc: number;
}

export interface ScriptedResponse {
  status: number;
  body: unknown;
}

export interface StubOptions {
  rows: StubRow[];
  /** Rows per page. Real `limit=auto` varies between calls, so the collector
   *  may never assume a fixed value; tests set it to pin one behaviour. */
  pageSize: number;
  /** Served ahead of any real page, to drive the retry and failure paths. */
  scripted?: ScriptedResponse[];
}

export interface Collected {
  /** Rows handed to the caller, boundary duplicates included. */
  yielded: number;
  unique: number;
  stats: PageStats;
  requests: number;
}

/**
 * Serves `/{kind}/search` from a fixed row set, matching the behaviour probed
 * against the live archive: exclusive bounds, ascending order, and a page cut
 * at a size the caller cannot see.
 */
function stubFetch(options: StubOptions, requests: URL[]): typeof fetch {
  const rows = [...options.rows].sort(
    (left, right) => left.created_utc - right.created_utc || left.id.localeCompare(right.id),
  );
  const scripted = [...(options.scripted ?? [])];

  return async function (this: unknown, input) {
    // Modules are strict, so a receiverless call leaves `this` undefined. Any
    // other receiver means the collector called fetch as a method, which the
    // runtime's native fetch rejects with an illegal-invocation TypeError.
    if (this !== undefined) throw new Error('fetch must be called without a receiver');

    const url = new URL(String(input));
    requests.push(url);

    // Neither is recoverable if the collector ever starts depending on it: a
    // numeric `limit` caps at 100, and `sort=desc` returns the same
    // head-of-second rows as `asc` rather than the reverse.
    if (url.searchParams.get('limit') !== 'auto') throw new Error('limit must be auto');
    if (url.searchParams.get('sort') !== 'asc') throw new Error('sort must be asc');

    const scriptedResponse = scripted.shift();
    if (scriptedResponse) {
      return Response.json(scriptedResponse.body, { status: scriptedResponse.status });
    }

    const after = Number(url.searchParams.get('after'));
    const before = Number(url.searchParams.get('before'));
    const page = rows
      .filter((row) => row.created_utc > after && row.created_utc < before)
      .slice(0, options.pageSize);

    return Response.json({ data: page });
  };
}

export async function collectWindow(
  options: StubOptions,
  window: { after: number; before: number },
): Promise<Collected> {
  const requests: URL[] = [];
  const client = {
    base: 'https://stub.invalid/api',
    delayMs: 0,
    fetch: stubFetch(options, requests),
  };
  const stats: PageStats = { unprovenAt: [], floorViolationAt: [] };
  const seen = new Set<string>();
  let yielded = 0;

  for await (const page of pages(client, 'comments', 'stub', window, stats)) {
    yielded += page.length;
    for (const row of page) seen.add(String(row.id));
  }

  return { yielded, unique: seen.size, stats, requests: requests.length };
}

/** `[second, count]` pairs expanded into rows whose ids sort in creation order. */
export function rowsAt(spec: Array<[second: number, count: number]>): StubRow[] {
  const rows: StubRow[] = [];

  for (const [second, count] of spec) {
    for (let index = 0; index < count; index++) {
      rows.push({ id: `c${String(rows.length).padStart(6, '0')}`, created_utc: second });
    }
  }

  return rows;
}

export function secondsEach(first: number, count: number): StubRow[] {
  return rowsAt(Array.from({ length: count }, (_, index): [number, number] => [first + index, 1]));
}
