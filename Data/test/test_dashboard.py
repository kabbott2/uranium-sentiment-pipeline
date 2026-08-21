import math
import random
from datetime import date, timedelta

from derive.dashboard import (
    ANALOG_GAP,
    PARTIAL_DAYS,
    band,
    compute_analog,
    compute_gauge,
    compute_volume_changes,
    _tags_payload,
    _trailing_zscore,
    _window_mean,
)


def make_daily(volumes, sentiments=None, start=date(2024, 1, 1)):
    sentiments = sentiments or [0.1] * len(volumes)
    return [
        {
            "date": start + timedelta(days=i),
            "num_posts": 0,
            "num_comments": v,
            "num_unique_authors": 1,
            "num_scored": v,
            "mean_compound": s,
        }
        for i, (v, s) in enumerate(zip(volumes, sentiments))
    ]


def test_band_boundaries_match_the_spec():
    assert band(-3.0) == "peak despair"
    assert band(-1.5) == "peak despair"
    assert band(-1.49) == "despondent"
    assert band(-0.5) == "despondent"
    assert band(-0.49) == "neutral"
    assert band(0.49) == "neutral"
    assert band(0.5) == "excited"
    assert band(1.49) == "excited"
    assert band(1.5) == "peak exuberance"


def test_window_mean_skips_nulls_and_needs_a_full_window():
    values = [1.0, None, 3.0, None, None, None, 5.0]
    assert _window_mean(values, 5) is None            # index < window - 1
    assert _window_mean(values, 6) == 3.0             # mean of 3 and 5... and 1
    assert _window_mean([None] * 7, 6) is None


def test_trailing_zscore_needs_baseline_history():
    flat = [math.log1p(100)] * 40
    assert _trailing_zscore(flat, len(flat) - 1) is None  # < MIN_BASELINE_POINTS


def test_trailing_zscore_flags_a_volume_spike():
    rng = random.Random(1)
    quiet = [math.log1p(100 + rng.randint(0, 20)) for _ in range(400)]
    spike = quiet[:-7] + [math.log1p(1000)] * 7
    z_quiet = _trailing_zscore(quiet, len(quiet) - 1)
    z_spike = _trailing_zscore(spike, len(spike) - 1)
    assert abs(z_quiet) < 2
    assert z_spike > 3


def test_gauge_excludes_the_partial_tail():
    volumes = [100] * 400 + [5] * PARTIAL_DAYS  # collapsed tail = still filling
    jittered = [v + (i % 7) for i, v in enumerate(volumes)]
    gauge = compute_gauge(make_daily(jittered))
    assert gauge is not None
    assert gauge["asof"] == str(date(2024, 1, 1) + timedelta(days=399))
    assert abs(gauge["volume_z"]) < 2  # the tail never reached the reading


def test_gauge_is_null_on_short_history():
    assert compute_gauge(make_daily([10] * 30)) is None


def test_gauge_spike_reads_exuberant_when_sentiment_rises_too():
    volumes = [100 + (i % 7) for i in range(400)]
    volumes[-10:] = [800] * 10
    sentiments = [0.05 + 0.01 * (i % 3) for i in range(400)]
    sentiments[-10:] = [0.35] * 10
    gauge = compute_gauge(make_daily(volumes, sentiments))
    assert gauge["value"] >= 1.5
    assert gauge["band"] == "peak exuberance"


def test_tags_payload_summarizes_and_bounds_the_daily_tail():
    start = date(2024, 1, 1)
    rows = [
        {"date": start + timedelta(days=i), "tag": "SPUT", "num_items": 10,
         "num_posts": 1, "num_comments": 9, "mean_compound": 0.2,
         "pct_pos": 0.5, "pct_neg": 0.1}
        for i in range(400)
    ]
    payload = _tags_payload("uraniumsqueeze", rows, {"lexicon": "x", "tags": "y"}, 123)
    assert payload["asof"] == str(start + timedelta(days=399 - PARTIAL_DAYS))
    tag = payload["tags"][0]
    assert tag["key"] == "SPUT"
    assert tag["items_7d"] == 70
    assert tag["sent_7d"] == 0.2
    assert len(tag["daily"]) == 180
    assert len(tag["weekly"]) >= 56


def test_volume_changes_compare_adjacent_periods():
    volumes = [100] * 396 + [200] * 7 + [0] * PARTIAL_DAYS  # last full week doubled
    changes = compute_volume_changes(make_daily(volumes))
    assert changes["1W"] == {"current": 200.0, "previous": 100.0, "delta": 1.0}
    assert changes["1M"]["delta"] > 0
    assert changes["1Y"] is None  # needs 2 full years


def test_analog_finds_the_matching_regime_and_respects_the_gap():
    rng = random.Random(7)
    volumes = [100 + rng.randint(0, 10) for _ in range(900)]
    # One historical spike, then a current spike of the same shape.
    for i in range(500, 530):
        volumes[i] = 900 + rng.randint(0, 10)
    for i in range(870, 900):
        volumes[i] = 900 + rng.randint(0, 10)
    daily = make_daily(volumes + [0] * PARTIAL_DAYS)
    analog = compute_analog(daily)
    assert analog is not None
    start = date(2024, 1, 1)
    matched_end = date.fromisoformat(analog["end"])
    assert (matched_end - start).days <= 897 - ANALOG_GAP  # never the current window
    assert 495 <= (date.fromisoformat(analog["start"]) - start).days <= 520
    assert 0 < analog["similarity"] <= 1


def test_analog_is_null_on_short_history():
    assert compute_analog(make_daily([10] * 100)) is None


def test_tags_payload_handles_no_tags():
    payload = _tags_payload("x", [], {"lexicon": "a", "tags": "b"}, 1)
    assert payload["tags"] == []
