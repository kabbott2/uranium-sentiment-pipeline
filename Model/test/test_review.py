from goldset.review import EXEMPLAR_TOTAL, _assign_splits, _parse_edits


def test_parse_edits_round_trips_the_export_encoding():
    row = {
        "doc_id": "abc",
        "tags": "SPUT;CAMECO",
        "overall_sentiment": "-1",
        "no_sentiment": "false",
        "tag_sentiment": '{"SPUT": -1}',
        "confidence": "Medium",
        "rationale": " trimmed after review ",
    }
    edited = _parse_edits(row)
    assert edited["tags"] == ["SPUT", "CAMECO"]
    assert edited["overall_sentiment"] == -1
    assert edited["no_sentiment"] is False
    assert edited["tag_sentiment"] == {"SPUT": -1}
    assert edited["confidence"] == "medium"
    assert edited["rationale"] == "trimmed after review"


def make_labels() -> list[dict]:
    labels = []
    for i in range(450):
        labels.append(
            {
                "doc_id": f"d{i:04d}",
                "doc_type": "post" if i % 3 == 0 else "comment",
                "overall_sentiment": (i % 5) - 2,
                "confidence": ["high", "medium", "low"][i % 3],
                "reviewed": True,
                "split": None,
            }
        )
    return labels


def test_split_covers_the_scale_and_hits_the_exemplar_quota():
    labels = make_labels()
    _assign_splits(labels)
    exemplar = [l for l in labels if l["split"] == "exemplar"]
    holdout = [l for l in labels if l["split"] == "holdout"]
    assert len(exemplar) == EXEMPLAR_TOTAL
    assert len(exemplar) + len(holdout) == len(labels)
    # Few-shot examples must span every sentiment level and both kinds.
    assert {l["overall_sentiment"] for l in exemplar} == {-2, -1, 0, 1, 2}
    assert {l["doc_type"] for l in exemplar} == {"post", "comment"}


def test_split_assignment_is_deterministic():
    first, second = make_labels(), make_labels()
    _assign_splits(first)
    _assign_splits(second)
    assert [l["split"] for l in first] == [l["split"] for l in second]
