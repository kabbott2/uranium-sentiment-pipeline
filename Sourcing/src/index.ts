import { targetSubreddits, type Env } from './env';

export { BackfillSubYear } from './workflows/backfill-sub-year';
export { CollectRecent } from './workflows/collect-recent';

/**
 * The only HTTP surface is the manual backfill trigger. The hourly collector
 * needs no endpoint — it is started by the workflow's own cron schedule.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname !== '/backfill') return json(404, { error: 'not found' });
    if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
    if (!authorized(request, env.TRIGGER_SECRET)) return json(401, { error: 'unauthorized' });

    const parsed = parseBackfillRequest(await request.json().catch(() => null), env);
    if ('error' in parsed) return json(400, { error: parsed.error });

    const { subreddit, year, rerun } = parsed;
    const baseId = `backfill-${subreddit.toLowerCase()}-${year}`;
    const id = rerun ? `${baseId}-${Math.floor(Date.now() / 1000)}` : baseId;

    if (!rerun && (await exists(env.BACKFILL, baseId))) {
      return json(409, {
        error: `instance ${baseId} already exists`,
        hint: 'send {"rerun": true} to start a fresh run over the same months',
      });
    }

    const instance = await env.BACKFILL.create({ id, params: { subreddit, year } });

    return json(202, { id: instance.id, subreddit, year });
  },
} satisfies ExportedHandler<Env>;

type BackfillRequest =
  | { subreddit: string; year: number; rerun: boolean }
  | { error: string };

function parseBackfillRequest(body: unknown, env: Env): BackfillRequest {
  if (typeof body !== 'object' || body === null) {
    return { error: 'body must be a JSON object' };
  }

  const { subreddit, year, rerun } = body as Record<string, unknown>;

  // Only configured targets are collectable, so widening the collector is a
  // config change rather than an open proxy onto the archive.
  const targets = targetSubreddits(env);
  const target = targets.find(
    (name) => typeof subreddit === 'string' && name.toLowerCase() === subreddit.toLowerCase(),
  );
  if (!target) {
    return { error: `subreddit must be one of: ${targets.join(', ')}` };
  }

  const maxYear = new Date().getUTCFullYear();
  if (typeof year !== 'number' || !Number.isInteger(year) || year < env.BACKFILL_MIN_YEAR || year > maxYear) {
    return { error: `year must be an integer between ${env.BACKFILL_MIN_YEAR} and ${maxYear}` };
  }

  return { subreddit: target, year, rerun: rerun === true };
}

function authorized(request: Request, secret: string): boolean {
  // Without this, a missing secret and a missing Bearer token both encode to
  // empty buffers and timingSafeEqual accepts every request.
  if (!secret) return false;

  const header = request.headers.get('authorization') ?? '';
  const presented = new TextEncoder().encode(
    header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '',
  );
  const expected = new TextEncoder().encode(secret);

  if (presented.byteLength !== expected.byteLength) return false;
  return crypto.subtle.timingSafeEqual(presented, expected);
}

async function exists(workflow: Workflow, id: string): Promise<boolean> {
  try {
    await workflow.get(id);
    return true;
  } catch {
    return false;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
