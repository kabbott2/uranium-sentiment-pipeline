# Tag Taxonomy — draft for review

The canonical tag list for the labeling and scoring passes. This document is the
human-readable source; at build time it is compiled into `Model/goldset/tags.json`,
which the sampler's keyword search and the LLM prompts both read. Adding or renaming
a tag is an edit here, not a code change.

Conventions:

- Items are **multi-label**: one comment can carry `SPUT` + `CAMECO` + `SPOT_PRICE`.
- Tag keys are stable snake-case identifiers; they end up in Parquet columns and
  dashboard filters, so they never change once data is scored against them.
- Every alias sits in one of two columns, and the compiler treats them differently:
  - **Search terms** go to the keyword search (the literal scan over the corpus that
    finds sample candidates). Matched case-insensitively on word boundaries.
    Company names, tickers, and project names belong here whenever the word is
    distinctive enough to search for.
  - **LLM-only cues** are context Claude uses when labeling ("the trust", "NAV
    discount talk"). They are NEVER given to the keyword search — either they
    aren't literal words, or they'd match thousands of unrelated comments.
- ⚠ marks a search term that collides with ordinary language or another entity.
  The keyword search only counts it in cash-tag (`$EU`) or exact all-caps/ticker
  form, and the LLM confirms from context before tagging.

## Holding vehicles

| Tag | Entity | Search terms | LLM-only cues |
|---|---|---|---|
| `SPUT` | Sprott Physical Uranium Trust | SPUT, U.UN, U.U, SRUUF, Sprott ⚠ (also the asset manager and the URNM/URNJ fund names — LLM confirms trust context), UPC ⚠, "Uranium Participation" | "the trust", NAV discount/premium talk |
| `YELLOW_CAKE` | Yellow Cake plc | YCA, YLLXF, "Yellow Cake" ⚠ (capitalized; lowercase "yellowcake" usually means the commodity U3O8 → `SPOT_PRICE`) | |

Note: SPUT launched July 2021 by converting Uranium Participation Corp. The corpus
starts 2021-02, so early mentions of **U.TO / UPC / Uranium Participation** exist and
alias to `SPUT`.

## Prices

| Tag | Covers | Search terms | LLM-only cues |
|---|---|---|---|
| `SPOT_PRICE` | Spot U3O8 price | "spot price", U3O8, yellowcake, Numerco, UxC, TradeTech | "spot" alone (matches "spot on", "sweet spot" — never searched bare), $/lb talk, Cameco daily price references |
| `TERM_PRICE` | Term price & contracting cycle | "term price", "long-term contracting", "contracting cycle", offtake | utility RFPs, contracting-cycle discourse without the literal phrases |

## ETFs — one tag per fund

| Tag | Entity | Search terms | LLM-only cues |
|---|---|---|---|
| `URA` | Global X Uranium ETF | URA | |
| `URNM` | Sprott Uranium Miners ETF | URNM | "Sprott miners fund" |
| `URNJ` | Sprott Junior Uranium Miners ETF | URNJ | "the juniors ETF" |
| `HURA` | Global X (ex-Horizons) Uranium Index ETF | HURA, HURA.TO | |
| `NLR` | VanEck Uranium and Nuclear ETF | NLR | |
| `NUKZ` | Range Nuclear Renaissance ETF | NUKZ | |
| `ETF_OTHER` | Any other uranium/nuclear fund | U3O8.TO, GCLN | regional listings |

`ETF_OTHER` plays the same role as `MINER_OTHER`: strays get counted, and any fund
that starts trending gets promoted to its own tag.

## Miners — one tag per company

| Tag | Company | Search terms | LLM-only cues |
|---|---|---|---|
| `CAMECO` | Cameco | Cameco, CCJ, CCO.TO | "the big Canadian one" |
| `KAZATOMPROM` | Kazatomprom | Kazatomprom, Kazatom, KAP, NATKY | "the Kazakhs" |
| `NEXGEN` | NexGen Energy | NexGen, NXE, "Rook I" | Arrow (deposit — common word, LLM resolves) |
| `DENISON` | Denison Mines | Denison, DNN, DML.TO, "Wheeler River", "Phoenix ISR" | Phoenix alone |
| `ENERGY_FUELS` | Energy Fuels | "Energy Fuels", UUUU, EFR.TO, "White Mesa" | |
| `UEC` | Uranium Energy Corp | UEC, "Uranium Energy Corp" | |
| `PALADIN` | Paladin Energy (incl. Fission Uranium, acquired Dec 2024) | Paladin, PDN, PDN.AX, PALAF, "Langer Heinrich", Fission ⚠ (capital-F/ticker context — lowercase "fission" is the physics), FCU, FCU.TO, "Triple R" | PLS (also caps-lock "please" — LLM resolves Patterson Lake South from context). Pre-merger FCU mentions refer to Fission standalone but count under this tag |
| `BOSS` | Boss Energy | "Boss Energy", BOE ⚠ (also Bank of England), BOE.AX, BQSSF | Boss alone, Honeymoon (project — common word) |
| `DEEP_YELLOW` | Deep Yellow | "Deep Yellow", DYL, DYL.AX, Tumas | |
| `BANNERMAN` | Bannerman Energy | Bannerman, BMN, BMN.AX, Etango | |
| `GLOBAL_ATOMIC` | Global Atomic | "Global Atomic", GLO ⚠, GLO.TO, GLATF, Dasa | |
| `ENCORE` | enCore Energy | "enCore Energy", EU ⚠ (also European Union — cash-tag/ticker context), EU.V | "encore" alone |
| `UR_ENERGY` | Ur-Energy | Ur-Energy, URG, URE.TO, "Lost Creek" | |
| `PENINSULA` | Peninsula Energy | "Peninsula Energy", PEN ⚠, PEN.AX | Peninsula alone, Lance (project — common name) |
| `LOTUS` | Lotus Resources | "Lotus Resources", LOT ⚠, LOT.AX, Kayelekera | Lotus alone |
| `ISOENERGY` | IsoEnergy | IsoEnergy, ISO ⚠, ISO.TO | Hurricane (deposit — common word) |
| `MINER_OTHER` | Any other uranium miner/developer | "Uranium Royalty", UROY, Forsys, Skyharbour, CanAlaska, "F3 Uranium", "92 Energy", Anfield, Laramide, "Toro Energy", "Aura Energy", "Berkeley Energia", GoviEx, "Mega Uranium" | any other small name the LLM recognizes as a uranium company |

`MINER_OTHER` keeps the taxonomy bounded: small names get counted without each one
becoming a column. Any name that starts trending gets promoted to its own tag (config
edit + rescore). Uranium Royalty (UROY) is a royalty company, not a miner; the rubric
notes it counts here anyway.

## Nuclear equities (non-fuel-cycle)

| Tag | Covers | Search terms | LLM-only cues |
|---|---|---|---|
| `NUCLEAR_TECH` | Reactor & SMR developers / nuclear tech stocks | Oklo, OKLO, NuScale, SMR ⚠ (cash-tag `$SMR` or with "NuScale" = the company; generic "SMRs" as technology → `NUCLEAR_MACRO`), BWXT, "BWX Technologies", "Nano Nuclear", NNE ⚠, Lightbridge, LTBR, TerraPower, X-energy, Kairos ⚠ | "Rolls-Royce SMR" program talk |
| `NUCLEAR_UTILITIES` | Nuclear-heavy power producers & utilities | Constellation ⚠, CEG, Vistra, VST, Talen, TLN, Exelon, EXC, Entergy, ETR ⚠, NextEra, NEE ⚠, PSEG, PEG ⚠, Duke ⚠ (also the university), DUK | Southern (SO) and Dominion (D) — tickers too ambiguous to search, cash-tag or LLM only |

One bucket each rather than per company: these are adjacent to the uranium thesis,
not its core, and per-name volume is low in this corpus. Promote a name to its own
tag if it starts trending (config edit + rescore).

## Fuel cycle

| Tag | Covers | Search terms | LLM-only cues |
|---|---|---|---|
| `ENRICHMENT` | Enrichment / conversion / fuel fabrication | Centrus, LEU ⚠, Urenco, Orano, Silex, SLX.AX, HALEU, SWU | "conversion" (common word — LLM resolves fuel-cycle context) |

## Macro & supply

| Tag | Covers | Search terms | LLM-only cues |
|---|---|---|---|
| `NUCLEAR_MACRO` | Demand- and supply-side nuclear news & policy | "reactor restart", SMRs, "datacenter", "new builds", "enriched uranium ban" | policy talk (Japan/Germany/France, COP pledges), Russian EUP ban, Kazakh transport routes, Niger coup, mine floods, production guidance cuts, tariffs — mostly context, not keywords |

One bucket by design. Note for the rubric: sentiment here is scored **relative to the
uranium thesis**, so supply disruption (a mine flood, an export ban) is typically
*bullish* even though the news itself is negative.

## Meta

| Tag | Covers |
|---|---|
| `OFF_TOPIC` | Memes with no directional content, glassware, moderation talk, anything non-uranium. Usually pairs with the `no_sentiment` flag. No search terms — reached only by the LLM (and the sampler's no-keyword-hit slice). |

## Resolved decisions (Kai, 2026-08-17)

- Miners list confirmed as-is; `MINER_OTHER` catches strays.
- ETFs split per fund (was one bucket).
- Supply/geopolitics merged into `NUCLEAR_MACRO`, with the thesis-relative
  sentiment note carried into the rubric.
- `FISSION` folded into `PALADIN` via aliases; no standalone Fission tag.
- Added `NUCLEAR_TECH` (SMR/reactor developers) and `NUCLEAR_UTILITIES` (nuclear
  power producers) as single buckets.
- Every alias split into search terms vs LLM-only cues; company names added as
  search terms alongside tickers (Kai). Bare "spot" and "the trust" moved to
  LLM-only. Ambiguous project names (Honeymoon, Arrow, Hurricane, Lance, Phoenix)
  are LLM-only; distinctive ones (Etango, Tumas, Kayelekera, Dasa) are searchable.
