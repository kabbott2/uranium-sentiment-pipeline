"""Dedup: which copy of an id wins. Implements DATA.md's rule exactly.

The rule is a tiebreak between copies of the same id, never a filter on ids:

1. Group by id.
2. If any copy carries `_meta.retrieved_2nd_on`, take it — any one, because
   engagement does not drift once stamped.
3. Otherwise take any copy.

Bulk-imported rows (everything before the 2023-07 boundary) carry no `_meta`
at all and no stamped copy of them exists anywhere. Filtering on the stamp
would silently drop them — 594k of the 801k rows collected — so the absence
of a stamp must never remove an id from the corpus.
"""

from typing import Iterable, Iterator


def is_stamped(row: dict) -> bool:
    meta = row.get("_meta")
    return isinstance(meta, dict) and "retrieved_2nd_on" in meta


def dedupe(rows: Iterable[dict]) -> Iterator[dict]:
    """One row per id. A stamped copy beats an unstamped one; otherwise the
    first copy seen stands, which keeps the pass deterministic and single-pass."""
    best: dict[str, dict] = {}
    for row in rows:
        row_id = row.get("id")
        if not row_id:
            continue
        held = best.get(row_id)
        if held is None or (is_stamped(row) and not is_stamped(held)):
            best[row_id] = row
    return iter(best.values())
