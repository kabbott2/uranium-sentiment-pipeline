"""The dedup rule is a tiebreak between copies of an id, never a filter on ids."""

from derive.dedup import dedupe


def stamped(row_id, **fields):
    return {"id": row_id, "_meta": {"retrieved_2nd_on": 1783000000}, **fields}


def bare(row_id, **fields):
    return {"id": row_id, **fields}


def ids(rows):
    return sorted(r["id"] for r in rows)


def test_unstamped_bulk_imported_rows_survive():
    # The known failure mode: everything before the 2023-07 import boundary
    # carries no _meta and no stamped copy of it exists anywhere. Reading the
    # stamp preference as a filter silently drops all of it (594k of 801k rows).
    bulk = [bare(f"row{i}", created_utc=1630000000 + i, score=5) for i in range(50)]
    survivors = list(dedupe(bulk))
    assert ids(survivors) == ids(bulk)
    assert all("_meta" not in r for r in survivors)


def test_mixed_stamped_and_unstamped_ids_all_survive():
    rows = [bare("old1"), stamped("new1"), bare("old2"), stamped("new2")]
    assert ids(dedupe(rows)) == ["new1", "new2", "old1", "old2"]


def test_stamped_copy_wins_over_placeholder_copy():
    placeholder = bare("abc", score=1, num_comments=0)
    settled = stamped("abc", score=42, num_comments=7)
    for order in ([placeholder, settled], [settled, placeholder]):
        (winner,) = dedupe(order)
        assert winner["score"] == 42


def test_two_stamped_copies_either_wins():
    # Engagement does not drift once stamped, so any stamped copy is correct.
    first = stamped("abc", score=10)
    second = stamped("abc", score=10)
    (winner,) = dedupe([first, second])
    assert winner["score"] == 10


def test_two_unstamped_copies_collapse_to_one():
    (winner,) = dedupe([bare("abc", score=1), bare("abc", score=1)])
    assert winner["id"] == "abc"


def test_rows_without_id_are_dropped_not_fatal():
    assert ids(dedupe([{"score": 3}, bare("ok")])) == ["ok"]


def test_meta_without_stamp_is_not_stamped():
    unstamped_meta = {"id": "abc", "_meta": {"something_else": 1}, "score": 1}
    settled = stamped("abc", score=9)
    (winner,) = dedupe([unstamped_meta, settled])
    assert winner["score"] == 9
