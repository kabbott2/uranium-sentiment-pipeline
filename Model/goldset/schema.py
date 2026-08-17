"""The gold label schema and its validator.

One place defines what a valid label row is; the labeler, the review merge,
and the benchmark all validate through here so a malformed row can never
reach R2 from any path.
"""

SENTIMENT_LEVELS = {-2, -1, 0, 1, 2}
CONFIDENCE_LEVELS = {"high", "medium", "low"}

LABEL_FIELDS = {
    "tags",
    "overall_sentiment",
    "no_sentiment",
    "tag_sentiment",
    "confidence",
    "rationale",
}


def validate_label(label: dict, taxonomy_keys: set[str]) -> list[str]:
    """Return a list of problems; empty means valid."""
    errors = []
    missing = LABEL_FIELDS - label.keys()
    if missing:
        return [f"missing fields: {sorted(missing)}"]

    tags = label["tags"]
    if not isinstance(tags, list) or not all(isinstance(t, str) for t in tags):
        errors.append("tags must be a list of strings")
        tags = []
    unknown = set(tags) - taxonomy_keys
    if unknown:
        errors.append(f"unknown tags: {sorted(unknown)}")
    if not tags:
        errors.append("tags must not be empty (use OFF_TOPIC)")

    if label["overall_sentiment"] not in SENTIMENT_LEVELS:
        errors.append(f"overall_sentiment {label['overall_sentiment']!r} not in -2..2")
    if not isinstance(label["no_sentiment"], bool):
        errors.append("no_sentiment must be a boolean")
    if label["no_sentiment"] and label["overall_sentiment"] != 0:
        errors.append("no_sentiment requires overall_sentiment 0")

    tag_sentiment = label["tag_sentiment"]
    if not isinstance(tag_sentiment, dict):
        errors.append("tag_sentiment must be an object")
    else:
        for key, value in tag_sentiment.items():
            if key not in tags:
                errors.append(f"tag_sentiment key {key} not among tags")
            if value not in SENTIMENT_LEVELS:
                errors.append(f"tag_sentiment[{key}] {value!r} not in -2..2")

    if label["confidence"] not in CONFIDENCE_LEVELS:
        errors.append(f"confidence {label['confidence']!r} invalid")
    if not isinstance(label["rationale"], str) or not label["rationale"].strip():
        errors.append("rationale must be a non-empty string")
    return errors
