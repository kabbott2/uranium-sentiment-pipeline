"""Draft gold labels with an LLM, one item per call.

The system prompt is RUBRIC.md plus the taxonomy from TAGS.md; output is
forced through a tool call so every label arrives as validatable JSON.
Labels are pushed to R2 every few items — a crashed run resumes by skipping
doc_ids already labeled.
"""

import hashlib
import json
import os
import time

import anthropic

from . import r2
from .config import GOLD_PREFIX, RUBRIC_PATH, TAGS_PATH, Config
from .schema import SENTIMENT_LEVELS, validate_label
from .tags import load_taxonomy

MAX_TEXT_CHARS = 8000
FLUSH_EVERY = 25

LABEL_TOOL = {
    "name": "record_label",
    "description": "Record the tags and sentiment for one item.",
    "input_schema": {
        "type": "object",
        "properties": {
            "tags": {"type": "array", "items": {"type": "string"}},
            "overall_sentiment": {"type": "integer", "enum": sorted(SENTIMENT_LEVELS)},
            "no_sentiment": {"type": "boolean"},
            "tag_sentiment": {
                "type": "object",
                "additionalProperties": {"type": "integer", "enum": sorted(SENTIMENT_LEVELS)},
            },
            "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
            "rationale": {"type": "string"},
        },
        "required": [
            "tags", "overall_sentiment", "no_sentiment",
            "tag_sentiment", "confidence", "rationale",
        ],
    },
}


def run_label(cfg: Config, limit: int | None = None) -> None:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("missing required environment variable ANTHROPIC_API_KEY")
    taxonomy = load_taxonomy(TAGS_PATH)
    taxonomy_keys = {t.key for t in taxonomy}
    system_prompt = _system_prompt(taxonomy)

    s3 = r2.client(cfg)
    labels_key = f"{GOLD_PREFIX}/labels.jsonl"
    sample = r2.read_jsonl(s3, cfg.derived_bucket, f"{GOLD_PREFIX}/sample.jsonl")
    labels = (
        r2.read_jsonl(s3, cfg.derived_bucket, labels_key)
        if r2.exists(s3, cfg.derived_bucket, labels_key)
        else []
    )
    done = {row["doc_id"] for row in labels}
    todo = [row for row in sample if row["doc_id"] not in done]
    if limit is not None:
        todo = todo[:limit]
    print(f"{len(sample)} sampled, {len(done)} already labeled, labeling {len(todo)}")

    client = anthropic.Anthropic()
    failures = []
    for i, item in enumerate(todo, 1):
        label = _label_one(client, cfg.label_model, system_prompt, item, taxonomy_keys)
        if label is None:
            failures.append(item["doc_id"])
        else:
            labels.append(
                {
                    **item,
                    **label,
                    "labeler": cfg.label_model,
                    "label_version": "gold-v1",
                    "reviewed": False,
                    "split": None,
                }
            )
        if i % FLUSH_EVERY == 0 or i == len(todo):
            r2.put_jsonl(s3, cfg.derived_bucket, labels_key, labels)
            print(f"{i}/{len(todo)} labeled ({len(failures)} failures)")

    r2.put_json(
        s3,
        cfg.derived_bucket,
        f"{GOLD_PREFIX}/label-receipt.json",
        {
            "model": cfg.label_model,
            "prompt_sha256": hashlib.sha256(system_prompt.encode()).hexdigest(),
            "labeled": len(labels),
            "failures": failures,
            "generated_at": int(time.time()),
        },
    )
    if failures:
        print(f"failed after retry: {failures}")


def _system_prompt(taxonomy) -> str:
    lines = [
        f"- `{t.key}` — {t.entity}" + (f". Cues: {t.llm_cues}" if t.llm_cues else "")
        for t in taxonomy
    ]
    return (
        RUBRIC_PATH.read_text(encoding="utf-8")
        + "\n\n## Tag taxonomy\n\n"
        + "\n".join(lines)
        + "\n\nLabel each item with the record_label tool. Use only these tag keys."
    )


def _item_prompt(item: dict) -> str:
    text = item["text"]
    if len(text) > MAX_TEXT_CHARS:
        text = text[:MAX_TEXT_CHARS] + "\n[truncated]"
    parts = [f"Label this r/UraniumSqueeze {item['doc_type']}."]
    if item.get("context_text"):
        parts.append(f"Thread context:\n{item['context_text']}")
    parts.append(f"Text:\n{text}")
    return "\n\n".join(parts)


def _label_one(client, model: str, system_prompt: str, item: dict, taxonomy_keys: set[str]):
    prompt = _item_prompt(item)
    for attempt in range(2):
        response = client.messages.create(
            model=model,
            max_tokens=1024,
            temperature=0,
            system=[{"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}}],
            tools=[LABEL_TOOL],
            tool_choice={"type": "tool", "name": "record_label"},
            messages=[{"role": "user", "content": prompt}],
        )
        label = next(
            (block.input for block in response.content if block.type == "tool_use"), None
        )
        errors = validate_label(label, taxonomy_keys) if label else ["no tool call in response"]
        if not errors:
            return label
        prompt = f"{_item_prompt(item)}\n\nYour previous label was invalid: {'; '.join(errors)}. Fix it."
    print(f"  {item['doc_id']}: {errors}")
    return None
