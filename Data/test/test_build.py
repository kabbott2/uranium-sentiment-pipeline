from derive.build import RAW_PART, Partition


def test_raw_key_pattern_matches_both_writers():
    # backfill/reconcile keys
    m = RAW_PART.match("raw/uraniumsqueeze/2021-09/comments-part-0306.jsonl.gz")
    assert m and m["sub"] == "uraniumsqueeze" and m["month"] == "2021-09" and m["kind"] == "comments"
    # hourly collector keys
    m = RAW_PART.match("raw/nuclear/2026-08/posts-recent-20260815T14-part-0000.jsonl.gz")
    assert m and m["kind"] == "posts" and m["month"] == "2026-08"


def test_raw_key_pattern_ignores_receipts_and_foreign_prefixes():
    assert not RAW_PART.match("receipts/uraniumsqueeze/2021-09-posts.json")
    assert not RAW_PART.match("raw/uraniumsqueeze/2021-09/posts-part-0000.jsonl")
    assert not RAW_PART.match("derived/posts/subreddit=x/month=2021-09/data.parquet")


def test_fingerprint_is_order_independent_and_content_sensitive():
    a = {"Key": "raw/x/2021-09/posts-part-0000.jsonl.gz", "ETag": '"e1"', "Size": 10}
    b = {"Key": "raw/x/2021-09/posts-part-0001.jsonl.gz", "ETag": '"e2"', "Size": 20}
    p1 = Partition("x", "2021-09", "posts", [a, b])
    p2 = Partition("x", "2021-09", "posts", [b, a])
    assert p1.fingerprint() == p2.fingerprint()
    changed = {**b, "ETag": '"e3"'}
    p3 = Partition("x", "2021-09", "posts", [a, changed])
    assert p3.fingerprint() != p1.fingerprint()
