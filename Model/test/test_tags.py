import re

from goldset.config import TAGS_PATH
from goldset.tags import load_taxonomy, loose_pattern, strict_pattern

TAXONOMY = {t.key: t for t in load_taxonomy(TAGS_PATH)}


def test_real_taxonomy_parses_completely():
    # TAGS.md is config; this is the drift guard between doc and code.
    assert len(TAXONOMY) == 33
    for expected in ("SPUT", "CAMECO", "URA", "NUCLEAR_TECH", "NUCLEAR_UTILITIES",
                     "MINER_OTHER", "NUCLEAR_MACRO", "OFF_TOPIC"):
        assert expected in TAXONOMY


def test_ambiguous_terms_are_strict_and_quotes_are_stripped():
    paladin = TAXONOMY["PALADIN"]
    assert "Fission" in paladin.strict_terms
    assert "FCU" in paladin.search_terms
    assert "Triple R" in paladin.search_terms          # quoted phrase, quotes gone
    assert "Sprott" in TAXONOMY["SPUT"].strict_terms   # ⚠ in doc
    assert "Duke" in TAXONOMY["NUCLEAR_UTILITIES"].strict_terms
    assert "CEG" in TAXONOMY["NUCLEAR_UTILITIES"].search_terms


def test_parenthetical_notes_do_not_leak_into_terms():
    for tag in TAXONOMY.values():
        for term in tag.search_terms + tag.strict_terms:
            assert "(" not in term and "⚠" not in term and '"' not in term


def test_off_topic_has_no_search_terms():
    # OFF_TOPIC is reached only by the LLM and the no-keyword-hit slice.
    off_topic = TAXONOMY["OFF_TOPIC"]
    assert not off_topic.search_terms and not off_topic.strict_terms


def test_loose_pattern_matches_lowercase_tickers():
    pattern = loose_pattern(TAXONOMY["CAMECO"])
    assert re.search(pattern, "ccj is ripping today")
    assert re.search(pattern, "buying more Cameco")
    assert not re.search(pattern, "occjx")


def test_strict_pattern_requires_caps_or_cashtag():
    pattern = strict_pattern(TAXONOMY["ENCORE"])  # EU collides with European Union
    assert re.search(pattern, "loading up on $eu here")
    assert re.search(pattern, "EU printed today")
    assert not re.search(pattern, "the eu banned russian fuel")

    lotus = strict_pattern(TAXONOMY["LOTUS"])
    assert not re.search(lotus, "a lot of people think so")
    assert re.search(lotus, "LOT up 12%")
