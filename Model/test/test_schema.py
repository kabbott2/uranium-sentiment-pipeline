from goldset.schema import validate_label

KEYS = {"SPUT", "CAMECO", "OFF_TOPIC"}


def valid_label() -> dict:
    return {
        "tags": ["SPUT"],
        "overall_sentiment": 2,
        "no_sentiment": False,
        "tag_sentiment": {"SPUT": 2},
        "confidence": "high",
        "rationale": "conviction buy language",
    }


def test_valid_label_passes():
    assert validate_label(valid_label(), KEYS) == []


def test_unknown_tag_and_missing_field_are_caught():
    assert validate_label({**valid_label(), "tags": ["SPUT", "TSLA"]}, KEYS)
    label = valid_label()
    del label["rationale"]
    assert validate_label(label, KEYS)


def test_tag_sentiment_keys_must_be_tagged():
    label = {**valid_label(), "tag_sentiment": {"CAMECO": 1}}
    assert any("not among tags" in e for e in validate_label(label, KEYS))


def test_no_sentiment_requires_neutral():
    label = {**valid_label(), "no_sentiment": True, "overall_sentiment": 1}
    assert any("requires overall_sentiment 0" in e for e in validate_label(label, KEYS))


def test_empty_tags_rejected():
    label = {**valid_label(), "tags": [], "tag_sentiment": {}}
    assert any("OFF_TOPIC" in e for e in validate_label(label, KEYS))


def test_out_of_range_sentiment_rejected():
    assert validate_label({**valid_label(), "overall_sentiment": 3}, KEYS)
    assert validate_label({**valid_label(), "tag_sentiment": {"SPUT": 5}}, KEYS)
