# GF07 — Entity-resolution code for team-codes.js / nfl-contract-key.js

Agent: GF07-entity-resolution-code (bucket: fix, phase: GitHubFix)

## What exists today in Gridiron (read-only verification)

`server/services/team-codes.js`:
- `TEAM_CODE_ALIASES` — flat alias→canonical dict (WSH→WAS, LA/STL→LAR, SD→LAC, OAK/LVR→LV, JAC→JAX, plus PFR-style 3-letter codes).
- `teamResolver()` — deterministic cascade: exact full-name match → canonical-abbr lookup (with "NY" deliberately ambiguous → null) → last-word nickname match → city-prefix match → leading-token abbr → unique substring containment. Returns `{abbr, name}` or `null`. **Binary**: no confidence, no partial credit, no fuzzy/edit-distance step at all.
- `espnTeamCode()` — one more alias hop (`WAS→WSH`) for ESPN-sourced rows.

`server/services/nfl-contract-key.js`:
- `easternGameDate()` — converts a kickoff instant to an Eastern-time calendar date string, specifically to dodge the "1:15am-UTC Monday-night" boundary problem (per its own docstring). This is a *tz-conversion* fix, not a *fuzzy-match* fix — if two feeds disagree on the instant by enough to cross midnight ET (e.g. a feed that never converts and reports UTC-as-if-ET), you get two different calendar dates and the module has no path to notice they're one day apart.
- `eventKey({homeTeam, awayTeam, commenceTime})` — calls `teamResolver()` on both sides; fails closed (`{ok:false, reason: 'unresolved_team'|'invalid_event_time'|'same_team_both_sides', ...}`) on any miss; on success returns `nfl|{ET-date}|{away}@{home}`. No confidence field exists on the success path either — it's `ok:true` or nothing.
- `contractKey()` builds on `eventKey()` and adds market/period/side/line into one exact-contract key, again fail-closed with typed reasons.

**A second, uncanonicalized game-key implementation exists**: `server/services/polymarket-lines.js:251-252` builds its own raw-string join key `` `${r.away_team}@${r.home_team}` `` straight from `espn_line_moves` rows to match against Polymarket-derived game titles — bypassing `eventKey()`/`teamResolver()` entirely. This is a second, unaudited ad-hoc identity-matching site, not just the one named in team-codes.js. (`book-feeds.js` re-exports the *same* `teamResolver` — that one is not duplicated — but this raw string key is.)

So the real gap is not "the alias dict is wrong" (it looks fine and well-commented); it's that **the whole match decision is binary/exact-only, and a second ad-hoc key exists for the exact case the finding calls out (Polymarket-to-ESPN matching).**

## Repos read

### 1. moj-analytical-services/splink
- License: MIT. Stars: 2,398. Last commit: 2026-09-10 (active — UK Ministry of Justice's actively maintained probabilistic linkage tool).
- What it actually does (verified by reading, not the README): implements Fellegi-Sunter (1969) probabilistic record linkage. `splink/internals/comparison_level_library.py` defines graded comparison levels per field — `ExactMatchLevel`, `LevenshteinLevel`, `JaroWinklerLevel`, `JaroLevel`, `JaccardLevel`, `AbsoluteTimeDifferenceLevel`, `DistanceInKMLevel` — each with its own m/u probability learned (or supplied) per level. `splink/internals/comparison_level.py:426-459` computes, per level, `match_weight = log2(m/u)`, converts to a Bayes factor, and the linker sums `log2_bayes_factor` across all fields to get one overall match weight → match probability per candidate pair (`splink/internals/expectation_maximisation.py` does EM to learn m/u when no labels exist; `splink/internals/accuracy.py` scores against labels when they do). `splink/internals/blocking.py` generates SQL blocking rules so you never do the full cross-join.
- Adopt: **borrow-idea**. The full framework (SQL backends, EM training, Spark/DuckDB linker) is real overkill for a closed 32-team dictionary and Gridiron has no labeled training pairs tonight. What's worth porting is the *scoring formula* — sum of per-field `log2(m/u)` Bayes factors → one probability — as a **hand-tuned, non-EM** confidence score layered onto the existing deterministic `eventKey()`/`contractKey()`.
- Gridiron attachment point: `server/services/nfl-contract-key.js` `eventKey()` — attach a `match_confidence` (0–1) and `match_basis` field computed from hand-set weights (team exact/fuzzy/miss, date exact/shifted/miss), without weakening the existing fail-closed contract.

### 2. dedupeio/dedupe
- License: MIT. Stars: 4,512. Last commit: 2025-07-28 (maintenance mode — last real commit over a year old, CI-only churn since; project has had periods of near-abandonment historically).
- What it actually does (verified by reading): active-learning deduplication. `dedupe/predicates.py` defines blocking predicates (`TfidfPredicate`, `LevenshteinPredicate`, canopy/search variants); `dedupe/training.py` + `dedupe/labeler.py` implement an active-learning loop where a human labels ambiguous pairs and a logistic-regression classifier (`dedupe/core.py`) is retrained; `dedupe/canonical.py` collapses a matched cluster of records into one canonical merged record (field-by-field "pick the best value across duplicates").
- Adopt: **reference-only** for the ML/active-learning core (needs labeled training data and a human-in-the-loop UI Gridiron doesn't have and doesn't need for 32 known teams); **borrow-idea** for `canonical.py`'s pattern — collapsing multiple per-source spellings of one entity into a single canonical crosswalk record, rather than a flat one-directional alias dict.
- Gridiron attachment point: replace `TEAM_CODE_ALIASES` (flat alias→code) with a small `TEAM_CROSSWALK` table (one row per franchise, one column per source: `espn`, `nflverse`, `polymarket_token`, `book_feed_spellings[]`) and route `polymarket-lines.js:251-252`'s ad-hoc string key through it instead of a second bespoke join.

### 3. J535D165/recordlinkage
- License: BSD-3-Clause. Stars: 1,062. Last commit: 2023-07-20 (**stale — no real commits in ~2 years**; treat as a reference implementation, not a live dependency).
- What it actually does (verified by reading): classic Fellegi-Sunter toolkit on pandas. `recordlinkage/index.py` — `Full`, `Block`, `SortedNeighbourhood`, `Random` indexers generate the *candidate-pair set* before any comparison runs (this is the blocking step splink also has, but simpler/more readable). `recordlinkage/compare.py` — `Exact`, `String` (Jaro-Winkler/Levenshtein/qgram via jellyfish), `Numeric`, `Geographic`, `Date` comparison classes each emit a similarity score in [0,1], not just true/false. The `Date` class (`compare.py:335-427`) is notable: it gives **partial credit** (default 0.5) for common date-entry errors — day/month swapped, or specific month-number confusions (e.g. 6↔7, 9↔10) — rather than binary equal/not-equal. `recordlinkage/classifiers.py` — `FellegiSunter` base class plus `NaiveBayesClassifier`/`ECMClassifier` (unsupervised EM) and `LogisticRegressionClassifier`/`SVMClassifier` (supervised) consume the similarity-vector table.
- Adopt: **borrow-idea** (stale repo, do not depend on the package directly — reimplement the two ideas that matter). (a) `SortedNeighbourhood`/`Block` indexing pattern for the Polymarket tape → games join (block by ET-date window, don't cross-join 12.4M rows against every game). (b) The `Date` class's graded-partial-credit pattern, adapted from "day/month swap" to "off-by-one-calendar-day from a UTC/ET boundary miss."
- Gridiron attachment point: a new blocking helper ahead of any Polymarket-tape-to-game join (e.g. in `polymarket-lines.js` or wherever `nfl-evidence-dataset.js` builds its quarantine report), and a graded date-comparison inside `eventKey()`.

## Confidence-score design for the canonical game key

Keep `eventKey()`'s existing deterministic key (`nfl|{date}|{away}@{home}`) as the join key — don't change its shape, callers depend on it. Add a *scored* layer on top, computed only when the exact path doesn't cleanly resolve, or always computed and logged for audit:

```
score = Σ log2(bayes_factor_i)   over fields i ∈ {home_team, away_team, date}

home_team: exact canonical-code/name match  → weight +8   (m≈0.98, u≈1/32 for exact)
           fuzzy match (Jaro-Winkler ≥ .92) → weight +3   (moderate confidence)
           no match                          → weight −12  (near-certain non-match)
away_team: same three levels, same weights
date:      exact ET-calendar-date match      → weight +6
           off-by-exactly-one-calendar-day   → weight +2   (UTC/ET boundary near-miss)
           further apart                     → weight −12

match_probability = 2^score / (1 + 2^score)
```
Thresholds (hand-set, not EM-trained — no labeled pairs exist tonight):
- `score ≥ +15` → treat as `ok:true` automatically (this covers the current exact path — it will always clear this bar).
- `0 ≤ score < +15` → surface as a **fuzzy match candidate** with `match_confidence` attached; log to a review table instead of silently joining or silently failing.
- `score < 0` → `ok:false` as today.

This does not replace `teamResolver()`'s discipline of returning `null` rather than guessing — it just gives the *contract-key* layer a way to say "this join is probably right but wasn't exact" instead of the current all-or-nothing.

## Candidates
See structured output. Five candidates: (1) Fellegi-Sunter-style confidence score on `eventKey()`/`contractKey()`; (2) sorted-neighborhood/date-window blocking for the Polymarket tape; (3) graded (partial-credit) date comparison for the ET boundary near-miss; (4) canonical multi-source team crosswalk replacing the flat alias dict, closing the `polymarket-lines.js:251-252` duplicate ad-hoc key; (5) a small labeled gold-set + accuracy harness (new capability) so any of the above can be regression-tested rather than spot-checked.

## Do not do
- Do not adopt `dedupe`'s active-learning/ML classifier loop wholesale — it needs labeled training pairs and a human-labeling UI Gridiron doesn't have, for a problem (32 known teams) that doesn't need ML.
- Do not depend on `recordlinkage` as a live pip package — it's been stale since mid-2023; port the two ideas (blocking, graded date comparison), don't `import recordlinkage`.
- Do not run `splink`'s EM training against Gridiron's team names — there's no ambiguity in a 32-team dictionary for EM to resolve; EM is the wrong tool for a closed, small, well-known entity set. Reserve any EM/Bayesian-training idea for the *game-key* fuzzy layer only, and even there, start hand-tuned.
- Do not touch `fantasy-football-dashboard` directly (read-only tonight); these are proposals for a future PR, not applied changes.
