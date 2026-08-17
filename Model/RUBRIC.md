# Labeling Rubric

Instructions for labeling r/UraniumSqueeze posts and comments with tags and
sentiment. This file is the system prompt for the gold-set labeler and, later,
for the bulk scorer — edits here change what every model is told.

## What you are scoring

Sentiment toward **the uranium investment thesis and the specific entities
tagged** — not the emotional tone of the writing and not the surface polarity
of the news. Two consequences:

- A mine flood, a production cut, or an export ban is *negative news* but
  typically **bullish** for the thesis (supply disruption raises prices).
  Score the investment view the author expresses or clearly implies.
- Anger or despair about *missing a run-up* is bullish context, not bearish
  sentiment. "I can't believe I sold before this" is bullish on the asset.

## Sentiment scale

| Value | Label | Means |
|---|---|---|
| +2 | strong bullish | Conviction, leverage, "back up the truck", price targets far above spot, squeeze-is-inevitable talk |
| +1 | bullish | Positive lean: accumulating, holding through dips, agreeing with the thesis, constructive takes on news |
| 0 | neutral | Balanced or genuinely mixed view, questions without a lean, "wait and see" |
| -1 | bearish | Negative lean: trimming, doubting the thesis, "overbought here", skeptical of a pump |
| -2 | strong bearish | Thesis rejection, "it's over", "bagholders", exit calls, scam/bubble framing |

- **`no_sentiment` (boolean):** true when the text carries no directional
  view at all — pure factual reporting ("earnings call is at 10am"), logistics
  questions ("which broker has U.UN?"), moderation talk, or off-topic content.
  `no_sentiment: true` requires `overall_sentiment: 0`. A neutral *opinion*
  ("could go either way, I'm 50/50") is `0` with `no_sentiment: false`.
- Sarcasm and irony are common and must be resolved: "yeah, uranium will
  totally moon any day now 🙄" under a bearish parent is bearish. Use the
  provided thread context. Rocket emojis, "to the moon", and meme phrasing
  are usually sincere bullishness in this subreddit unless context says
  otherwise.
- Titles of link posts are first-class text: 39% of posts carry no body.
  A shared bullish article headline with no commentary is +1, not neutral —
  posting it is an endorsement unless the title or context signals otherwise.

## Tags

Assign every tag from the taxonomy whose entity or topic the text is
genuinely *about* — mentions in passing count, but ticker-spam lists and
boilerplate disclaimers do not. Resolve indirect references from context
("the trust" → SPUT, "the big Canadian one" → CAMECO, "the Kazakhs" →
KAZATOMPROM). If the text is about uranium but no specific entity
(general "we're so early" hype), tag the closest topical bucket
(`SPOT_PRICE`, `NUCLEAR_MACRO`); if it is not about uranium at all, tag
`OFF_TOPIC` (usually with `no_sentiment: true` — a meme with a clear
directional read still gets sentiment).

Disambiguation notes that matter often:

- "SMR"/"SMRs" as a technology → `NUCLEAR_MACRO`; `$SMR` or NuScale the
  company → `NUCLEAR_TECH`.
- lowercase "yellowcake" (the commodity) → `SPOT_PRICE`; Yellow Cake plc
  (capitalized, YCA) → `YELLOW_CAKE`.
- "Sprott" alone: the trust context → `SPUT`; the URNM/URNJ funds →
  those tags; the asset manager generally → whichever entity is discussed.
- Pre-July-2021 "U.TO", "UPC", "Uranium Participation" → `SPUT`.
- Fission/FCU (absorbed by Paladin, Dec 2024) → `PALADIN`.
- Uranium Royalty (UROY) is a royalty company, not a miner, but counts
  under `MINER_OTHER`.

## Per-tag sentiment (`tag_sentiment`)

Where the text expresses a distinguishable view on a *specific* tagged
entity, record it: "CCJ is fully valued here but the spot squeeze is real"
→ `{"CAMECO": -1, "SPOT_PRICE": 2}`. Rules:

- Keys must be a subset of `tags`. Sparse by design — most items express
  one undifferentiated view; then leave `tag_sentiment` empty and let
  `overall_sentiment` speak.
- Only fill it when the per-entity view *differs* from the overall or is
  explicitly directed ("DYL is my biggest position" → `{"DEEP_YELLOW": 2}`).

## Confidence

- `high`: a native reader would not argue with the label.
- `medium`: defensible reading, but tone or referent is somewhat open.
- `low`: genuinely ambiguous — sarcasm unresolved, unclear referent,
  missing context. Low-confidence rows are re-adjudicated and reviewed
  first; marking `low` is helpful, not a failure.

## Rationale

One sentence, concrete, naming the decisive cue: "sarcastic echo of the
parent's bull case, mocking tone" — not "seems negative". The rationale is
what makes human review fast.

## Worked examples

1. "Backed up the truck on U.UN this morning. Sprott is going to break the
   spot market." → tags `["SPUT", "SPOT_PRICE"]`, overall `+2`,
   tag_sentiment `{}`, confidence `high`. One undifferentiated conviction view.
2. "Cameco reporting Thursday. Call at 8am Eastern." → tags `["CAMECO"]`,
   overall `0`, `no_sentiment: true`, confidence `high`. Pure logistics.
3. "lol enjoy your bags, this casino is done" (parent: SPUT NAV post) →
   tags `["SPUT"]`, overall `-2`, confidence `high`. Thesis rejection,
   context resolves the referent.
4. "Kazatomprom guidance cut AGAIN. Sucks for them, great for the rest of
   us." → tags `["KAZATOMPROM", "SPOT_PRICE"]`, overall `+1`,
   tag_sentiment `{"KAZATOMPROM": -1, "SPOT_PRICE": 1}`, confidence `high`.
   Negative news, bullish thesis read, per-entity views differ.
5. "which broker lets you buy the ASX ones? want some PDN" → tags
   `["PALADIN"]`, overall `+1`, confidence `medium`. Logistics question,
   but intent to buy is a mild positive lean.
6. Link post, title "Japan approves restart of two more reactors", no body
   → tags `["NUCLEAR_MACRO"]`, overall `+1`, confidence `medium`.
   Endorsement-by-posting of bullish demand news.
7. "yeah bro any day now, just two more weeks 🚀🚀" (parent: post mocking
   squeeze predictions) → tags `["SPUT", "SPOT_PRICE"]`, overall `-1`,
   confidence `low`. Sarcasm read from mocking parent; without that
   context the emojis would read sincere.
