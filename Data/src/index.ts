/**
 * Cron shim for the Phase 2 pipeline. The Worker owns the schedule; the
 * actual work is `python -m derive cron` inside the container — incremental
 * build, then enrich (tags + VADER), then the dashboard aggregates/JSON.
 */
import { Container } from '@cloudflare/containers';

interface Env {
  DERIVE: DurableObjectNamespace<DeriveContainer>;
  RAW_BUCKET: string;
  DERIVED_BUCKET: string;
  ENRICH_LEXICON: string;
  ENRICH_TAGS: string;
  DASHBOARD_SUBREDDITS: string;
  R2_ENDPOINT: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
}

export class DeriveContainer extends Container<Env> {
  manualStart = true;
  sleepAfter = '15m';

  constructor(ctx: Container<Env>['ctx'], env: Env) {
    super(ctx, env);
    this.envVars = {
      RAW_BUCKET: env.RAW_BUCKET,
      DERIVED_BUCKET: env.DERIVED_BUCKET,
      ENRICH_LEXICON: env.ENRICH_LEXICON,
      ENRICH_TAGS: env.ENRICH_TAGS,
      DASHBOARD_SUBREDDITS: env.DASHBOARD_SUBREDDITS,
      R2_ENDPOINT: env.R2_ENDPOINT,
      R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
    };
  }

  async runBuild(): Promise<void> {
    // start() boots the image; its CMD runs the build and exits. The manifest
    // in the derived bucket makes overlapping or repeated runs idempotent.
    await this.start();
  }
}

export default {
  async scheduled(_controller, env) {
    const container = env.DERIVE.get(env.DERIVE.idFromName('derive-build'));
    await container.runBuild();
  },
} satisfies ExportedHandler<Env>;
