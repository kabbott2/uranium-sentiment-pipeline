"""Publish Model-owned config artifacts to R2 for the Data phase to consume.

Data never imports Model code: it reads these JSON artifacts. A lexicon or
taxonomy change is re-publish here plus a re-score there, not a code change.
"""

import time

from . import r2
from .config import TAGS_PATH, Config
from .tags import load_taxonomy, loose_pattern, strict_pattern
from .vader import load_overlay

CONFIG_PREFIX = "model/config"
TAGS_VERSION = "tags-v1"


def run_publish_lexicon(cfg: Config) -> None:
    overlay = load_overlay()
    key = f"{CONFIG_PREFIX}/{overlay['version']}/lexicon.json"
    s3 = r2.client(cfg)
    r2.put_json(s3, cfg.derived_bucket, key, {**overlay, "published_at": int(time.time())})
    print(f"published {overlay['version']} lexicon "
          f"({len(overlay['lexicon'])} terms, {len(overlay['neutralize'])} neutralized) -> {key}")


def run_publish_tags(cfg: Config) -> None:
    taxonomy = load_taxonomy(TAGS_PATH)
    compiled = [
        {"key": tag.key, "loose": loose_pattern(tag), "strict": strict_pattern(tag)}
        for tag in taxonomy
    ]
    keyword_reachable = sum(1 for t in compiled if t["loose"] or t["strict"])
    key = f"{CONFIG_PREFIX}/{TAGS_VERSION}.json"
    s3 = r2.client(cfg)
    r2.put_json(
        s3, cfg.derived_bucket, key,
        {"version": TAGS_VERSION, "tags": compiled, "published_at": int(time.time())},
    )
    print(f"published {TAGS_VERSION}: {len(compiled)} tags "
          f"({keyword_reachable} keyword-reachable) -> {key}")
