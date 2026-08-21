import json

import pytest

from goldset.vader import (
    LEXICON_PATH,
    STOCK_THRESHOLDS,
    build_analyzer,
    classify,
    load_overlay,
)

OVERLAY = load_overlay()


def test_checked_in_overlay_is_valid():
    assert OVERLAY["version"].startswith("vader-v")
    assert OVERLAY["thresholds"]["neg"] < 0 < OVERLAY["thresholds"]["pos"]
    for term, valence in OVERLAY["lexicon"].items():
        assert term == term.lower(), f"{term} must be lowercase"
        assert -4 <= valence <= 4, f"{term} valence {valence} outside VADER's -4..4"


def test_overlay_terms_reach_the_analyzer():
    analyzer = build_analyzer(OVERLAY)
    assert analyzer.lexicon["bagholder"] == OVERLAY["lexicon"]["bagholder"]
    assert analyzer.polarity_scores("total bagholder capitulation")["compound"] < 0
    assert analyzer.polarity_scores("mooning to a new ath")["compound"] > 0


def test_neutralized_terms_are_gone():
    stock = build_analyzer(None)
    adapted = build_analyzer(OVERLAY)
    for term in OVERLAY["neutralize"]:
        assert term.lower() not in adapted.lexicon
    # At least one neutralized term must exist in stock VADER, otherwise the
    # list is dead weight.
    assert any(t.lower() in stock.lexicon for t in OVERLAY["neutralize"])


def test_classify_maps_the_neutral_band():
    thresholds = {"pos": 0.1, "neg": -0.2}

    def scores(compound, neu=0.5):
        return {"compound": compound, "neu": neu}

    assert classify(scores(0.5), thresholds) == 1
    assert classify(scores(0.1), thresholds) == 1
    assert classify(scores(0.0), thresholds) == 0
    assert classify(scores(-0.19), thresholds) == 0
    assert classify(scores(-0.2), thresholds) == -1


def test_neu_min_rule_overrides_a_saturated_compound():
    thresholds = {"pos": 0.1, "neg": -0.1, "neu_min": 0.9}
    assert classify({"compound": 0.95, "neu": 0.93}, thresholds) == 0
    assert classify({"compound": 0.95, "neu": 0.6}, thresholds) == 1
    # Without neu_min in the thresholds the rule is off.
    assert classify({"compound": 0.95, "neu": 0.99}, {"pos": 0.1, "neg": -0.1}) == 1


def test_stock_thresholds_are_vaders_canonical_band():
    assert STOCK_THRESHOLDS == {"pos": 0.05, "neg": -0.05}


def test_load_overlay_rejects_missing_keys(tmp_path):
    bad = tmp_path / "lex.json"
    bad.write_text(json.dumps({"lexicon": {}}))
    with pytest.raises(SystemExit):
        load_overlay(bad)


def test_lexicon_file_is_the_one_the_package_ships():
    assert LEXICON_PATH.name == "vader_lexicon.json"
    assert LEXICON_PATH.exists()
