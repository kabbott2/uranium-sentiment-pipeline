"""Configuration from environment variables only — see CLAUDE.md.

The same variables work on a laptop and inside the Cloudflare Container, so
the Curzon handoff is a credential rotation, not a code change.
"""

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    endpoint: str
    access_key_id: str
    secret_access_key: str
    raw_bucket: str
    derived_bucket: str
    # Later of the two per-kind bulk-import boundaries (2023-07-01). Rows
    # created before it are settled without a stamp. Mirrors
    # SETTLE_EXEMPT_BEFORE in Sourcing/wrangler.jsonc.
    settle_exempt_before: int
    # Versions of the Model-phase config artifacts the enrich pass applies;
    # bumping either forces a full re-enrich via the manifest fingerprint.
    enrich_lexicon: str
    enrich_tags: str
    dashboard_subreddits: tuple[str, ...]


def _require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"missing required environment variable {name}")
    return value


def from_env() -> Config:
    account_id = os.environ.get("R2_ACCOUNT_ID")
    endpoint = os.environ.get("R2_ENDPOINT") or (
        f"https://{account_id}.r2.cloudflarestorage.com" if account_id else ""
    )
    if not endpoint:
        raise SystemExit("set R2_ENDPOINT or R2_ACCOUNT_ID")
    return Config(
        endpoint=endpoint,
        access_key_id=_require("R2_ACCESS_KEY_ID"),
        secret_access_key=_require("R2_SECRET_ACCESS_KEY"),
        raw_bucket=os.environ.get("RAW_BUCKET", "uranium-sentiment-raw"),
        derived_bucket=_require("DERIVED_BUCKET"),
        settle_exempt_before=int(os.environ.get("SETTLE_EXEMPT_BEFORE", "1688169600")),
        enrich_lexicon=os.environ.get("ENRICH_LEXICON", "vader-v1d"),
        enrich_tags=os.environ.get("ENRICH_TAGS", "tags-v1"),
        dashboard_subreddits=tuple(
            s.strip().lower()
            for s in os.environ.get("DASHBOARD_SUBREDDITS", "uraniumsqueeze").split(",")
            if s.strip()
        ),
    )
