# N15 — Route/route-tree and man-vs-zone proxies from public play-by-play & formation data

Researcher: N15-route-proxies-from-pbp | bucket: new | date: 2026-09-12

## Headline finding (changes the framing of the whole topic)

The topic asked for "proxies... without tracking data." For **2019–2025, Gridiron doesn't need a proxy — it needs to stop discarding a column it already downloads.**

`server/services/nfl-formations.js` (`ingestFormations`) fetches
`pbp_participation_<season>.csv` from nflverse every season and stores only 9 of its columns into
`nfl_play_formations` (`server/db/schema/nfl-a-to-m.js:468`). The file itself — verified by
downloading `pbp_participation_2022.csv`, `_2024.csv`, and `_2025.csv` directly from
`github.com/nflverse/nflverse-data/releases/download/pbp_participation/` — has 6 more columns
that are parsed and then thrown away:

```
route, defense_man_zone_type, defense_coverage_type, was_pressure, time_to_throw, ngs_air_yards
```

Confirmed by pulling and parsing all three files with `csv.DictReader` (not naive comma-split —
the personnel fields are quoted CSV with embedded commas, which is exactly why a byte-count of the
file is not enough to know what's in it):

- **2024** (45,919 rows): `defense_man_zone_type` populated on 22,408 dropback plays —
  `ZONE_COVERAGE` 11,369 / `MAN_COVERAGE` 11,039. `defense_coverage_type` gives the actual shell:
  `COVER_1` 8,322, `COVER_2` 4,527, `COVER_3` 3,870, `2_MAN` 1,701, `COVER_4` 1,384, `COVER_0`
  1,016, `COVER_6` 778, `COMBO` 436, `COVER_9` 336, `BLOWN` 38.
- **route** (19,110 non-blank rows in 2024) is the *primary/targeted receiver's* charted route on
  the play, one of 13 labels: `QUICK OUT`, `HITCH/CURL`, `SCREEN`, `IN/DIG`, `GO`, `DEEP OUT`,
  `SHALLOW CROSS/DRAG`, `SLANT`, `CORNER`, `SWING`, `POST`, `WHEEL`, `TEXAS/ANGLE`. This is a real,
  charted route-tree label — not a route-tree for every man on the field, but the actual route run
  by the guy who got the ball (or was intended to).
- **2025** file already has the full season through the Super Bowl (weeks 01–22, 45,185 rows) —
  fully backfillable now. **2026 (the current, live season) has no file yet** — 404 confirmed
  2026-09-12 — so this is a historical/backtest asset only until nflverse cuts a 2026 release, not
  something that helps this week's live games.
- **2022** already carries these same three columns (man/zone, coverage type, route), so this is
  not a brand-new 2023+ schema — Gridiron's ingestion code has been dropping it every season since
  whenever `ingestFormations` was written.
- The `nfl-formations.js` file header comment — *"participation ends after 2023... nflverse could
  not continue it"* — is stale. `nflreadr`'s data dictionary confirms `ngs_air_yards` (the old NGS
  chip-tracking air-yards number) is deprecated/NA from 2024 on, but the file itself continues,
  now sourced from FTN hand-charting rather than NGS tracking. **The route/man-zone/coverage-type
  columns are the FTN charting team's human film-grading, not tracking data** — this is exactly
  the "NGS-adjacent, non-tracking, public" signal the research prompt asked for, and it already
  exists in a feed Gridiron already fetches.

Source (read in full): nflreadr Participation Data Dictionary —
https://nflreadr.nflverse.com/articles/dictionary_participation.html — gives the authoritative
field definitions quoted above, including the "route" field's exact 13-value domain and the
explicit note that `ngs_air_yards` is a "legacy column... NA for 2024 on."

## Second finding: the FTN charting table Gridiron *does* use is also missing columns

`server/services/nfl-formations.js` `ingestCharting()` stores 12 columns from `ftn_charting_<season>.csv`
into `nfl_play_charting` (schema at `server/db/schema/nfl-a-to-m.js`, ~line 480). The full FTN
charting data dictionary (read in full: https://nflreadr.nflverse.com/articles/dictionary_ftn_charting.html)
lists 29 fields. Not ingested: `starting_hash` (ball placement L/M/R — a real pre-snap formation
variable that changes route stems), `read_thrown` (which progression read the QB was on — direct
route-within-play-design context), `is_interception_worthy`, `is_catchable_ball`,
`is_created_reception`, `is_drop`, `n_blitzers`, `n_pass_rushers` (charting's own copy, distinct
from participation's `number_of_pass_rushers`), `is_qb_fault_sack`, `is_qb_sneak`. None of these
require new data acquisition — they are columns in a CSV Gridiron already downloads and parses,
sitting one field-list edit away.

## What Gridiron's existing tables can and cannot support today (grepped, not assumed)

- `nfl_play_formations` (game_id, play_id, season, possession, offense_formation,
  offense_personnel, defense_personnel, defenders_in_box, pass_rushers) — down/distance/score are
  NOT in this table; they'd need a join to `nflverse pbp` on `(game_id, play_id)`, which the table's
  own key is designed for.
- `nfl_play_charting` (12 of 29 FTN fields, see above).
- `nfl_ngs` (season, week, player_id, kind, player_name, team, position, stats JSON) — receiving
  kind already carries `avg_cushion`, `avg_separation`, `avg_intended_air_yards`,
  `percent_share_of_intended_air_yards`, `catch_percentage`, `avg_yac`, `avg_expected_yac`,
  `avg_yac_above_expectation` (`server/services/nfl-advanced.js:87-95`, `NGS_FIELDS.receiving`).
  This is weekly-aggregated, tracking-derived-but-publicly-released data, already in the
  database — and today it is used exactly once, as a flat multi-week average folded into a hand-
  tuned modifier in `priorAdvancedPerformance()` (`server/services/nfl-player-value.js:137-163`):
  `modifier += clamp(((avg('avg_separation') ?? 2.9) - 2.9) * 0.05, -0.08, 0.12)`. It is never
  conditioned on the coming opponent's man/zone rate, never split by route type, and never
  compared against the player's *own* route mix. That is the gap this research fills: `nfl_ngs`
  gives a player's average openness; `nfl_play_formations` (once fixed) gives what defense he's
  about to face; nothing today multiplies the two.
- No table anywhere stores man/zone rate *by defense*, route-tree *by player*, or the joined
  player-route-x-coverage-outcome table a matchup model needs. That is new capability, full stop.

## Literature: what's published on man/zone and route inference without full tracking

1. **nflreadr Participation Data Dictionary** (nflverse, ongoing) — https://nflreadr.nflverse.com/articles/dictionary_participation.html
   Read in full. Primary technical source for the headline finding above: exact field
   definitions, domains, and the tracking→charting provenance switch at 2024.

2. **nflreadr FTN Charting Data Dictionary** — https://nflreadr.nflverse.com/articles/dictionary_ftn_charting.html
   Read in full. Full 29-field list for `ftn_charting`, used to identify the 8-column gap in
   `nfl_play_charting` above.

3. **JJ, "NFL Coverage Funnels & Positional Target Tendencies"** (Substack, 2026) —
   https://jsleeprstats.substack.com/p/nfl-coverage-funnels-and-positional
   Read in full. Uses charted coverage data (SumerSports, same charting lineage as FTN) across
   2022–2025 regular seasons to report target-rate-per-route-run splits by coverage: **RBs get
   12.74% TPRR vs. man but 19.90% vs. zone** (the single largest position/coverage split in the
   piece, stable 2022–2025); WRs earn a higher share of targets vs. man, TEs/RBs benefit from
   zone; slot receivers gain **+3.93 pp** target rate when the defense blitzes vs. **+2.94 pp**
   for outside receivers; RBs are the only group whose target rate *drops* on a blitz. Honest
   limitation stated in the piece itself: coverage *shell* (single-high vs. two-high) is a coarser
   signal than actual coverage *type* — two defenses both playing "single-high" can be running
   very different assignment schemes with different target distributions, so shell-level splits
   understate how much a good coverage-type model could separate. This is direct, out-of-sample-
   flavored (multi-season, stable-effect) evidence that a coverage-conditioned feature has real
   signal for exactly the props use case Gridiron has (RB/WR/TE target-rate projection).

4. **Chandra, et al., "Integrating Unsupervised and Supervised Learning for the Prediction of
   Defensive Schemes in American Football"** (arXiv 2602.10784, 2026) —
   https://arxiv.org/abs/2602.10784
   Read in full (HTML). Sample: **3,963 offensive plays, first 9 weeks of the 2024 season, NFL Big
   Data Bowl 2025 tracking release** (2,980 zone / 983 man — a 3:1 class imbalance worth noting for
   any classifier Gridiron trains on FTN's labels, which show a much closer ~1:1 split in the full
   participation data). Method: elastic-net logistic regression and gradient-boosted trees on
   **pre-motion contextual features** (quarter, down, yards-to-go, yardline, score, seconds
   remaining, plus tracking-derived convex-hull/standardized-position features at the snap), then
   augmented with post-snap trajectory features and an HMM-derived latent-assignment feature.
   Honest result: the paper reports the HMM-augmented model beats the pre-motion baseline on
   accuracy/AUC/logloss but gives the comparison only as boxplots over 50 cross-fitting runs, not
   a single reportable number — and explicitly flags the sample as "quite small, constraining both
   model complexity and generalizability." **Limitation for Gridiron's purposes: even the "pre-
   motion" baseline in this paper uses tracking-derived standardized player coordinates at the
   snap, not box-score formation counts** — so it is not itself a tracking-free method. What it
   establishes is the general finding this research leans on: situational/contextual pre-snap
   features (down, distance, score, quarter) carry real signal for coverage prediction even before
   any player-movement feature is added — which is exactly the class of feature
   (`nfl_play_formations.offense_formation/personnel/defenders_in_box` + PBP down/distance/score)
   Gridiron already has for every season back to 2019, once joined.

5. **Dutta, Yurko, Ventura, "Unsupervised methods for identifying pass coverage among defensive
   backs with NFL player tracking data"**, Journal of Quantitative Analysis in Sports 16(2),
   2020, pp. 143–161 — cited, not read in full (abstract-level only from search). Included as the
   *tracking-based ceiling*: this is the canonical academic reference for coverage identification
   from full player-tracking data (hierarchical clustering on defender trajectories), useful context
   for how much signal a real tracking-based method captures that a charted-label or formation-only
   proxy will not — e.g., mid-play coverage rotations and busted assignments that FTN's single
   play-level label can't represent.

## Honest synthesis

- For **2019–2025**, "proxy" is the wrong word — ground truth already exists in a file Gridiron
  already downloads. The engineering task is ingestion, not modeling.
- For the **live current season** (2026, and any week before nflverse cuts next season's
  participation release), no proxy in the literature reviewed here is tracking-free. Every
  method that predicts coverage from pre-snap information found in this search (arXiv
  2602.10784, and the Big Data Bowl coverage-classification lineage it cites) uses tracking-
  derived positions at the snap, not box-score formation/personnel counts. A formation-only
  classifier (offense_formation + personnel + defenders_in_box + down/distance/score, no tracking)
  is therefore a genuinely novel thing to build — it hasn't been validated in the literature
  surveyed here — but it *can* be trained and honestly graded against 7 seasons of real FTN labels
  Gridiron will have in-house once candidate 1 below ships, which is a rare case of "build it and
  you get your own held-out test set for free."
- `route` is one label per play (the primary/targeted receiver), not a route for every receiver.
  Do not oversell this as "route tree data" in the sense of five simultaneous routes charted —
  it is not that, and no free public feed provides that.
