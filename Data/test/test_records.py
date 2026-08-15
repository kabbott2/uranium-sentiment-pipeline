from derive.records import has_settled_engagement, project

EXEMPT_BEFORE = 1688169600  # 2023-07-01, mirrors SETTLE_EXEMPT_BEFORE
OLD = 1630000000  # 2021
NEW = 1780000000  # 2026


def test_old_post_without_modern_fields_projects_cleanly():
    # Pre-2022 rows lack _meta, use retrieved_utc, and can omit upvote_ratio.
    row = {
        "id": "abc",
        "author": "someone",
        "created_utc": OLD,
        "score": 22,
        "num_comments": 13,
        "title": "DNN to the moon",
        "selftext": "thesis...",
        "retrieved_utc": 1656165932,
    }
    out = project(row, "posts", EXEMPT_BEFORE)
    assert out["kind"] == "post"
    assert out["upvote_ratio"] is None
    assert out["retrieved_2nd_on"] is None
    assert out["title"] == "DNN to the moon"
    assert out["body"] is None


def test_comment_projects_thread_fields_and_nulls_post_fields():
    row = {
        "id": "c1",
        "author": "someone",
        "created_utc": NEW,
        "score": 6,
        "parent_id": "t1_c0",
        "link_id": "t3_p0",
        "body": "spot price take",
        # Modern Arctic Shift comments carry a num_comments; it is thread
        # metadata, not comment engagement, and must not survive projection.
        "num_comments": 13,
        "upvote_ratio": 1,
    }
    out = project(row, "comments", EXEMPT_BEFORE)
    assert out["kind"] == "comment"
    assert out["parent_id"] == "t1_c0"
    assert out["link_id"] == "t3_p0"
    assert out["num_comments"] is None
    assert out["upvote_ratio"] is None
    assert out["title"] is None


def test_deleted_author_and_removed_body_become_null_but_row_survives():
    row = {"id": "c1", "author": "[deleted]", "created_utc": OLD, "body": "[removed]"}
    out = project(row, "comments", EXEMPT_BEFORE)
    assert out["id"] == "c1"
    assert out["author"] is None
    assert out["body"] is None


def test_empty_and_whitespace_text_becomes_null():
    row = {"id": "p1", "created_utc": OLD, "title": "link post", "selftext": "  "}
    assert project(row, "posts", EXEMPT_BEFORE)["selftext"] is None


def test_edited_epoch_becomes_true():
    row = {"id": "p1", "created_utc": OLD, "edited": 1630000123.0}
    assert project(row, "posts", EXEMPT_BEFORE)["edited"] is True
    row["edited"] = False
    assert project(row, "posts", EXEMPT_BEFORE)["edited"] is False


def test_removal_category_coalesces_both_raw_spellings():
    posts = {"id": "p", "created_utc": NEW, "removed_by_category": "moderator"}
    comments = {"id": "c", "created_utc": NEW, "removal_reason": "legal"}
    assert project(posts, "posts", EXEMPT_BEFORE)["removal_category"] == "moderator"
    assert project(comments, "comments", EXEMPT_BEFORE)["removal_category"] == "legal"


# Settlement mirror of Sourcing/src/arctic-shift.ts

def test_pre_boundary_bare_row_is_settled():
    assert has_settled_engagement({"id": "x", "created_utc": OLD, "score": 1}, EXEMPT_BEFORE)


def test_stamped_row_is_settled():
    row = {"id": "x", "created_utc": NEW, "score": 1, "_meta": {"retrieved_2nd_on": NEW + 130000}}
    assert has_settled_engagement(row, EXEMPT_BEFORE)


def test_post_boundary_bare_placeholder_is_not_settled():
    row = {"id": "x", "created_utc": NEW, "score": 1, "num_comments": 0, "upvote_ratio": 1}
    assert not has_settled_engagement(row, EXEMPT_BEFORE)


def test_post_boundary_bare_row_with_real_engagement_is_settled():
    # 2024-03 posts are 99% unstamped yet carry real scores — bulk-imported
    # above the boundary. Engagement itself is the evidence.
    row = {"id": "x", "created_utc": NEW, "score": 69, "num_comments": 0}
    assert has_settled_engagement(row, EXEMPT_BEFORE)


def test_settlement_flag_lands_in_projection():
    placeholder = {"id": "x", "created_utc": NEW, "score": 1, "num_comments": 0, "upvote_ratio": 1}
    assert project(placeholder, "posts", EXEMPT_BEFORE)["engagement_settled"] is False
