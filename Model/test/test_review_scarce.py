from goldset.review import _assign_splits


def test_scarce_class_is_not_swallowed_by_the_exemplar_set():
    # 6 strong-bearish rows against 444 others: the holdout must keep some.
    labels = []
    for i in range(450):
        labels.append(
            {
                "doc_id": f"d{i:04d}",
                "doc_type": "comment",
                "overall_sentiment": -2 if i < 6 else (i % 3),
                "confidence": "high",
                "reviewed": True,
                "split": None,
            }
        )
    _assign_splits(labels)
    scarce = [l for l in labels if l["overall_sentiment"] == -2]
    assert any(l["split"] == "holdout" for l in scarce)
    assert any(l["split"] == "exemplar" for l in scarce)
