from goldset.score import _pick_exemplars, _slug, extract_json


def test_extract_json_handles_fences_and_prose():
    assert extract_json('{"a": 1}') == {"a": 1}
    assert extract_json('Here you go:\n```json\n{"a": 1}\n```') == {"a": 1}
    assert extract_json("no json here") is None


def test_slug_is_filesystem_safe():
    assert _slug("@cf/openai/gpt-oss-120b") == "cf-openai-gpt-oss-120b"


def test_exemplar_picks_span_levels_and_are_deterministic():
    exemplars = [
        {"doc_id": f"d{i}", "overall_sentiment": (i % 5) - 2} for i in range(30)
    ]
    picked = _pick_exemplars(exemplars)
    assert {e["overall_sentiment"] for e in picked} == {-2, -1, 0, 1, 2}
    assert picked == _pick_exemplars(list(reversed(exemplars)))
