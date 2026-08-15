"""Projection and cleaning: full Arctic Shift record → derived row.

Parsing is lenient by requirement: the schema drifts across years (comments
grew 50 → 80 fields, posts 98 → 116), old rows lack `upvote_ratio` and award
fields, and pre-2022 rows use `retrieved_utc` where modern ones use
`retrieved_on`. Every read is a `.get`; absence becomes NULL, never an error.
"""

from typing import Optional

DELETED_TEXT = {"[deleted]", "[removed]", "[deleted by user]"}
DELETED_AUTHOR = {"[deleted]", "[removed]"}

PLACEHOLDER_SCORE = 1
PLACEHOLDER_NUM_COMMENTS = 0
PLACEHOLDER_UPVOTE_RATIO = 1


def _clean_text(value) -> Optional[str]:
    """Deletion placeholders and empty strings become NULL; real text is kept
    verbatim, markdown included."""
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    if not stripped or stripped in DELETED_TEXT:
        return None
    return value


def _clean_author(value) -> Optional[str]:
    if not isinstance(value, str) or not value or value in DELETED_AUTHOR:
        return None
    return value


def _as_int(value) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    return None


def _as_float(value) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _as_bool(value) -> Optional[bool]:
    if isinstance(value, bool):
        return value
    return None


def _was_edited(value) -> bool:
    # Reddit encodes `edited` as false or the edit's epoch timestamp.
    if isinstance(value, bool):
        return value
    return isinstance(value, (int, float)) and value > 0


def _retrieved_2nd_on(row: dict) -> Optional[int]:
    meta = row.get("_meta")
    if isinstance(meta, dict):
        return _as_int(meta.get("retrieved_2nd_on"))
    return None


def _is_number_other_than(value, placeholder: int) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value != placeholder


def has_settled_engagement(row: dict, exempt_before: int) -> bool:
    """Python mirror of `hasSettledEngagement` in Sourcing/src/arctic-shift.ts.

    Settled means: created before the bulk-import boundary, or stamped by the
    archive's second retrieval, or carrying engagement that cannot be the
    ingest placeholder (`score=1, num_comments=0, upvote_ratio=1`). Rows that
    fail all three still hold placeholder engagement, and any
    engagement-weighted series must exclude them rather than read score=1 as
    a score.
    """
    created = _as_int(row.get("created_utc"))
    if created is not None and created < exempt_before:
        return True
    if _retrieved_2nd_on(row) is not None:
        return True
    return (
        _is_number_other_than(row.get("score"), PLACEHOLDER_SCORE)
        or _is_number_other_than(row.get("num_comments"), PLACEHOLDER_NUM_COMMENTS)
        or _is_number_other_than(row.get("upvote_ratio"), PLACEHOLDER_UPVOTE_RATIO)
    )


def project(row: dict, kind: str, exempt_before: int) -> dict:
    """One derived row. `kind` is 'posts' or 'comments'; fields belonging to
    the other kind stay NULL so both tables share one schema."""
    is_post = kind == "posts"
    return {
        "id": row.get("id"),
        "kind": "post" if is_post else "comment",
        "author": _clean_author(row.get("author")),
        "created_utc": _as_int(row.get("created_utc")),
        "score": _as_int(row.get("score")),
        "upvote_ratio": _as_float(row.get("upvote_ratio")) if is_post else None,
        "num_comments": _as_int(row.get("num_comments")) if is_post else None,
        "title": _clean_text(row.get("title")) if is_post else None,
        "selftext": _clean_text(row.get("selftext")) if is_post else None,
        "body": None if is_post else _clean_text(row.get("body")),
        # Kept with their t1_/t3_ prefixes exactly as Reddit serves them;
        # joining link_id to the posts table means stripping "t3_".
        "parent_id": None if is_post else row.get("parent_id"),
        "link_id": None if is_post else row.get("link_id"),
        "is_self": _as_bool(row.get("is_self")) if is_post else None,
        "over_18": _as_bool(row.get("over_18")),
        "stickied": _as_bool(row.get("stickied")),
        "distinguished": row.get("distinguished"),
        "edited": _was_edited(row.get("edited")),
        "author_flair_text": _clean_text(row.get("author_flair_text")),
        "link_flair_text": _clean_text(row.get("link_flair_text")) if is_post else None,
        "removal_category": row.get("removed_by_category") or row.get("removal_reason"),
        "engagement_settled": has_settled_engagement(row, exempt_before),
        "retrieved_2nd_on": _retrieved_2nd_on(row),
    }
