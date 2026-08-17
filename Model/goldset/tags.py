"""Parse Model/TAGS.md into the tag taxonomy.

TAGS.md is the canonical config (a tag change is an edit there, not here).
Each table row yields one tag. The "Search terms" column feeds the keyword
search; the "LLM-only cues" column is passed verbatim to the labeling prompt.
Terms marked ⚠ collide with ordinary language and are matched strictly:
cash-tag form ($EU) or the exact capitalization written in the doc.
"""

import re
from dataclasses import dataclass
from pathlib import Path

_TAG_KEY = re.compile(r"`([A-Z0-9_]+)`")


@dataclass(frozen=True)
class Tag:
    key: str
    entity: str
    search_terms: tuple[str, ...]
    strict_terms: tuple[str, ...]
    llm_cues: str


def load_taxonomy(path: Path) -> list[Tag]:
    tags = []
    for cells in _table_rows(path.read_text(encoding="utf-8")):
        key_match = _TAG_KEY.search(cells[0])
        if not key_match:
            continue
        search_cell = cells[2] if len(cells) > 2 else ""
        loose, strict = _parse_terms(search_cell)
        tags.append(
            Tag(
                key=key_match.group(1),
                entity=cells[1],
                search_terms=tuple(loose),
                strict_terms=tuple(strict),
                llm_cues=cells[3] if len(cells) > 3 else "",
            )
        )
    if not tags:
        raise SystemExit(f"no tags parsed from {path}")
    return tags


def _table_rows(text: str):
    """Data rows of every markdown table whose first header cell is 'Tag'."""
    in_tag_table = False
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("|"):
            in_tag_table = False
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if cells[0] == "Tag":
            in_tag_table = True
        elif in_tag_table and not set(cells[0]) <= set("-: "):
            yield cells


def _parse_terms(cell: str) -> tuple[list[str], list[str]]:
    loose, strict = [], []
    for item in _split_top_level(cell):
        is_strict = "⚠" in item
        term = re.sub(r"\([^)]*\)", "", item).replace("⚠", "").strip().strip('"').strip()
        if term:
            (strict if is_strict else loose).append(term)
    return loose, strict


def _split_top_level(cell: str) -> list[str]:
    """Split on commas, ignoring commas inside parentheses or quotes."""
    items, depth, quoted, current = [], 0, False, []
    for ch in cell:
        if ch == '"':
            quoted = not quoted
        elif ch == "(" and not quoted:
            depth += 1
        elif ch == ")" and not quoted:
            depth = max(0, depth - 1)
        elif ch == "," and depth == 0 and not quoted:
            items.append("".join(current))
            current = []
            continue
        current.append(ch)
    items.append("".join(current))
    return [i.strip() for i in items if i.strip()]


def loose_pattern(tag: Tag) -> str | None:
    """Case-insensitive word-boundary regex over the tag's search terms."""
    if not tag.search_terms:
        return None
    alts = "|".join(re.escape(t) for t in tag.search_terms)
    return rf"(?i)\b({alts})\b"


def strict_pattern(tag: Tag) -> str | None:
    """Case-sensitive as-written match, or cash-tag form in any case."""
    if not tag.strict_terms:
        return None
    alts = "|".join(re.escape(t) for t in tag.strict_terms)
    return rf"\b(?:{alts})\b|(?i:\$(?:{alts})\b)"
