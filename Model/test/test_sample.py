import random

from goldset.sample import (
    COMMENTS_TOTAL,
    ERAS,
    NO_HIT_QUOTA,
    POSTS_TOTAL,
    REMOVED_POST_MIN,
    _allocate,
    _length_bucket,
)


def synthetic_pool() -> list[dict]:
    """A corpus-shaped pool: comment-heavy, common tags common, one rare tag."""
    rng = random.Random(7)
    pool = []
    n = 0
    for era in ERAS:
        for kind, count in (("post", 120), ("comment", 600)):
            for _ in range(count):
                n += 1
                roll = rng.random()
                if roll < 0.10:
                    tags = []
                elif roll < 0.55:
                    tags = ["SPUT"]
                else:
                    tags = ["SPOT_PRICE", "CAMECO"]
                pool.append(
                    {
                        "id": f"{kind[0]}{n:06d}",
                        "kind": kind,
                        "created_utc": 0,
                        "era": era,
                        "length": rng.choice(["short", "medium", "long"]),
                        "words": 50,
                        "removed": kind == "post" and rng.random() < 0.1,
                        "tags_hit": tags,
                    }
                )
    # A rare tag with exactly 3 candidates, all in one era.
    for i in range(3):
        pool.append(
            {
                "id": f"rare{i}",
                "kind": "comment",
                "created_utc": 0,
                "era": "2024",
                "length": "short",
                "words": 5,
                "removed": False,
                "tags_hit": ["BANNERMAN"],
            }
        )
    return pool


def test_allocation_meets_every_quota():
    selected = _allocate(synthetic_pool(), random.Random(1))
    posts = [c for c in selected if c["kind"] == "post"]
    comments = [c for c in selected if c["kind"] == "comment"]
    assert len(selected) == POSTS_TOTAL + COMMENTS_TOTAL
    assert len(posts) == POSTS_TOTAL
    assert len(comments) == COMMENTS_TOTAL

    no_hit = [c for c in selected if not c["tags_hit"]]
    assert len(no_hit) >= sum(NO_HIT_QUOTA.values())
    assert sum(1 for c in selected if c["removed"]) >= REMOVED_POST_MIN

    # Every era is represented for both kinds.
    for era in ERAS:
        assert any(c["era"] == era for c in posts)
        assert any(c["era"] == era for c in comments)


def test_rare_tag_candidates_are_all_taken():
    selected = _allocate(synthetic_pool(), random.Random(1))
    assert sum(1 for c in selected if "BANNERMAN" in c["tags_hit"]) == 3


def test_allocation_is_deterministic():
    first = sorted(c["id"] for c in _allocate(synthetic_pool(), random.Random(1)))
    second = sorted(c["id"] for c in _allocate(synthetic_pool(), random.Random(1)))
    assert first == second


def test_length_buckets():
    assert _length_bucket(3) == "short"
    assert _length_bucket(25) == "medium"
    assert _length_bucket(150) == "medium"
    assert _length_bucket(151) == "long"
