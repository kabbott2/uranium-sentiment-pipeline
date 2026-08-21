import re

import pyarrow as pa
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

from derive.enrich import DERIVED_PART, Enricher, enrich_rows


def make_enricher(thresholds=None):
    return Enricher(
        matchers=(
            ("SPUT", (re.compile(r"(?i)\b(SPUT|U\.UN)\b"),)),
            ("CAMECO", (re.compile(r"(?i)\b(Cameco|CCJ)\b"),)),
        ),
        analyzer=SentimentIntensityAnalyzer(),
        thresholds=thresholds or {"pos": 0.05, "neg": -0.05},
        version="vader-test+tags-test",
    )


def posts_table(rows):
    return pa.Table.from_pylist(rows, schema=pa.schema(
        [("id", pa.string()), ("title", pa.string()), ("selftext", pa.string())]
    ))


def test_derived_key_pattern_matches_partitions_only():
    m = DERIVED_PART.match("derived/posts/subreddit=uraniumsqueeze/month=2021-09/data.parquet")
    assert m and m["kind"] == "posts" and m["sub"] == "uraniumsqueeze" and m["month"] == "2021-09"
    assert not DERIVED_PART.match("enrich/posts/subreddit=x/month=2021-09/data.parquet")
    assert not DERIVED_PART.match("derived/posts/subreddit=x/month=2021-09/extra/data.parquet")


def test_post_text_is_title_plus_selftext_and_title_only_works():
    rows = enrich_rows(posts_table([
        {"id": "a", "title": "Cameco is amazing", "selftext": "great earnings"},
        {"id": "b", "title": "SPUT at a discount", "selftext": None},
    ]), "posts", make_enricher())
    assert rows[0]["tags"] == ["CAMECO"]
    assert rows[0]["vader_label"] == "pos"
    assert rows[1]["tags"] == ["SPUT"]
    assert all(r["enrich_version"] == "vader-test+tags-test" for r in rows)


def test_null_text_rows_keep_their_id_with_null_sentiment():
    rows = enrich_rows(posts_table(
        [{"id": "gone", "title": None, "selftext": None}]
    ), "posts", make_enricher())
    assert rows == [{
        "id": "gone", "tags": [], "vader_compound": None, "vader_label": None,
        "enrich_version": "vader-test+tags-test",
    }]


def test_comment_body_is_scored_and_tagged():
    table = pa.Table.from_pylist(
        [{"id": "c1", "body": "u.un is a terrible disaster"}],
        schema=pa.schema([("id", pa.string()), ("body", pa.string())]),
    )
    rows = enrich_rows(table, "comments", make_enricher())
    assert rows[0]["tags"] == ["SPUT"]
    assert rows[0]["vader_label"] == "neg"
    assert rows[0]["vader_compound"] < 0


def test_neu_min_threshold_reaches_the_label():
    enricher = make_enricher({"pos": 0.05, "neg": -0.05, "neu_min": 0.0})
    rows = enrich_rows(posts_table(
        [{"id": "a", "title": "great amazing wonderful", "selftext": None}]
    ), "posts", enricher)
    assert rows[0]["vader_label"] == "neu"
