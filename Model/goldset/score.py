"""Score items with a Workers AI model, for the bake-off and later the bulk run.

The prompt is RUBRIC.md + the taxonomy + few-shot exemplars drawn from the
reviewed gold exemplar split. Output is requested as raw JSON and validated
through the same schema as the gold labels; a row that fails twice is skipped
and reported. Scores land in R2 under model/bakeoff/<model-slug>.jsonl,
pushed every few items so an interrupted run resumes.
"""

import json
import os
import re
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from . import r2
from .config import GOLD_PREFIX, RUBRIC_PATH, TAGS_PATH, Config
from .label import MAX_TEXT_CHARS
from .schema import validate_label
from .tags import load_taxonomy

BAKEOFF_PREFIX = "model/bakeoff"
EXEMPLARS_PER_LEVEL = 4
MAX_OUTPUT_TOKENS = 1400
CONCURRENCY = 6
FLUSH_EVERY = 25


def run_score(cfg: Config, model: str, limit: int | None = None) -> None:
    token = os.environ.get("WORKERS_AI_TOKEN")
    account_id = os.environ.get("R2_ACCOUNT_ID")
    if not token or not account_id:
        raise SystemExit("set WORKERS_AI_TOKEN and R2_ACCOUNT_ID")

    taxonomy = load_taxonomy(TAGS_PATH)
    taxonomy_keys = {t.key for t in taxonomy}
    s3 = r2.client(cfg)
    labels = r2.read_jsonl(s3, cfg.derived_bucket, f"{GOLD_PREFIX}/labels.jsonl")
    system_prompt = _system_prompt(taxonomy, [l for l in labels if l["split"] == "exemplar"])

    out_key = f"{BAKEOFF_PREFIX}/{_slug(model)}.jsonl"
    scores = (
        r2.read_jsonl(s3, cfg.derived_bucket, out_key)
        if r2.exists(s3, cfg.derived_bucket, out_key)
        else []
    )
    done = {row["doc_id"] for row in scores}
    todo = [l for l in labels if l["split"] == "holdout" and l["doc_id"] not in done]
    if limit is not None:
        todo = todo[:limit]
    print(f"{model}: scoring {len(todo)} holdout items ({len(done)} already done)")

    api = _Api(account_id, token, model)
    failures = []
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        results = pool.map(
            lambda item: (item, _score_one(api, system_prompt, item, taxonomy_keys)), todo
        )
        for i, (item, label) in enumerate(results, 1):
            if label is None:
                failures.append(item["doc_id"])
            else:
                scores.append({"doc_id": item["doc_id"], **label, "model_version": model})
            if i % FLUSH_EVERY == 0 or i == len(todo):
                r2.put_jsonl(s3, cfg.derived_bucket, out_key, scores)
                print(f"  {i}/{len(todo)} ({len(failures)} failures)")
    if failures:
        print(f"{model} failed items: {failures}")
    print(f"wrote {len(scores)} scores to {out_key}")


class _Api:
    def __init__(self, account_id: str, token: str, model: str):
        self.url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions"
        self.token = token
        self.model = model

    def chat(self, system: str, user: str) -> str:
        body = json.dumps(
            {
                "model": self.model,
                "max_tokens": MAX_OUTPUT_TOKENS,
                "temperature": 0,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            }
        ).encode()
        request = urllib.request.Request(
            self.url,
            data=body,
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
        )
        for attempt in range(4):
            try:
                response = json.load(urllib.request.urlopen(request, timeout=180))
                return response["choices"][0]["message"].get("content") or ""
            except urllib.error.HTTPError as e:
                if e.code in (429, 500, 502, 503) and attempt < 3:
                    time.sleep(2**attempt)
                    continue
                raise
            except TimeoutError:
                if attempt < 3:
                    continue
                raise
        return ""


def _slug(model: str) -> str:
    return re.sub(r"[^a-z0-9.-]+", "-", model.lower()).strip("-")


def _system_prompt(taxonomy, exemplars: list[dict]) -> str:
    tag_lines = [
        f"- `{t.key}` — {t.entity}" + (f". Cues: {t.llm_cues}" if t.llm_cues else "")
        for t in taxonomy
    ]
    shots = []
    for label in _pick_exemplars(exemplars):
        shots.append(
            "Item: " + json.dumps(_item_view(label), ensure_ascii=False)
            + "\nLabel: " + json.dumps(
                {f: label[f] for f in ("tags", "overall_sentiment", "no_sentiment",
                                       "tag_sentiment", "confidence", "rationale")},
                ensure_ascii=False,
            )
        )
    return (
        RUBRIC_PATH.read_text(encoding="utf-8")
        + "\n\n## Tag taxonomy\n\n" + "\n".join(tag_lines)
        + "\n\n## Reviewed examples\n\n" + "\n\n".join(shots)
        + "\n\n## Output format\n\nReply with ONLY a JSON object (no prose, no code fences): "
        + '{"tags": [...], "overall_sentiment": -2..2, "no_sentiment": bool, '
        + '"tag_sentiment": {tag: -2..2}, "confidence": "high"|"medium"|"low", '
        + '"rationale": "one sentence"}. Use only taxonomy tag keys.'
    )


def _pick_exemplars(exemplars: list[dict]) -> list[dict]:
    by_level: dict[int, list[dict]] = {}
    for label in sorted(exemplars, key=lambda l: l["doc_id"]):
        by_level.setdefault(label["overall_sentiment"], []).append(label)
    picked = []
    for level in sorted(by_level):
        picked.extend(by_level[level][:EXEMPLARS_PER_LEVEL])
    return picked


def _item_view(row: dict) -> dict:
    text = row["text"]
    if len(text) > MAX_TEXT_CHARS:
        text = text[:MAX_TEXT_CHARS] + "\n[truncated]"
    return {"doc_type": row["doc_type"], "context": row.get("context_text"), "text": text}


def extract_json(content: str) -> dict | None:
    """The models sometimes wrap JSON in fences or prose; find the object."""
    match = re.search(r"\{.*\}", content, re.DOTALL)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None


def _score_one(api: _Api, system_prompt: str, item: dict, taxonomy_keys: set[str]):
    prompt = "Label this item.\nItem: " + json.dumps(_item_view(item), ensure_ascii=False)
    for attempt in range(2):
        try:
            content = api.chat(system_prompt, prompt)
        except Exception as e:
            print(f"  {item['doc_id']}: request failed — {str(e)[:80]}")
            return None
        label = extract_json(content)
        if label is not None:
            label = {k: label.get(k) for k in ("tags", "overall_sentiment", "no_sentiment",
                                               "tag_sentiment", "confidence", "rationale")}
            if label["tag_sentiment"] is None:
                label["tag_sentiment"] = {}
            if not validate_label(label, taxonomy_keys):
                return label
        prompt += "\n\nYour previous reply was not a valid label JSON. Reply with only the JSON object."
    return None
