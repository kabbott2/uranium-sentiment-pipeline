"""Configuration from environment variables only — see CLAUDE.md."""

import os
from dataclasses import dataclass
from pathlib import Path

TAGS_PATH = Path(__file__).resolve().parent.parent / "TAGS.md"
RUBRIC_PATH = Path(__file__).resolve().parent.parent / "RUBRIC.md"

SAMPLE_SEED = 20260817
GOLD_PREFIX = "model/gold/gold-v1"


@dataclass(frozen=True)
class Config:
    endpoint: str
    access_key_id: str
    secret_access_key: str
    derived_bucket: str
    label_model: str


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
        derived_bucket=_require("DERIVED_BUCKET"),
        label_model=os.environ.get("GOLDSET_LABEL_MODEL", "claude-sonnet-5"),
    )
