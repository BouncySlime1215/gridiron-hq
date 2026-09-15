# GN07 — Live in-game NFL win-probability: real code, MVP for Gridiron

Agent: GN07-live-win-probability-code | bucket: new | phase: GitHubNew | date: 2026-09-12

## Task
Clone/read the actual nflfastR win-probability model code (not the README's claims) and other
real in-game live-WP implementations, then specify a concrete MVP that plugs into Gridiron's
*existing* `nfl_play_by_play` table (server/db/schema/nfl-a-to-m.js:306-333, 251,591 rows per
tonight's audit) and `game_lines` table (spread).

## Repos read (all via `gh api` file fetch or `git clone --depth 1 --filter=blob:none`)

### 1. nflverse/nflfastR — the reference implementation
- License: **NOASSERTION** (no LICENSE file — GitHub default "all rights reserved" for the repo
  contents beyond what fair use/facts allow). Stars 541. Last push 2026-08-13 (actively maintained).
- Fetched and read in full (not the README — the actual model files):
  `R/ep_wp_calculators.R`, `R/helper_add_ep_wp.R` (2036 lines), `data-raw/MODELS.R` (the literal
  xgboost training script), `data-raw/_tune_spread_wp.R`.
- **What the code actually does** (verified by reading `data-raw/MODELS.R:172-278` and
  `R/ep_wp_calculators.R:117-215`):
  - Two separate binary-logistic **xgboost gbtree** models, not one: `wp_model` (no market info,
    65 trees, eta=0.2) and `wp_model_spread` (534 trees, eta=0.05, includes the closing spread).
  - `wp_model_spread` feature list (`MODELS.R:191-205`, exact column order enforced again at
    predict time in `wp_spread_model_select`, `helper_add_ep_wp.R:200-218`):
    `receive_2h_ko, spread_time, home, half_seconds_remaining, game_seconds_remaining,
    Diff_Time_Ratio, score_differential, down, ydstogo, yardline_100,
    posteam_timeouts_remaining, defteam_timeouts_remaining`. `wp_model` drops `spread_time` only.
  - `spread_time = posteam_spread * exp(-4 * elapsed_share)` and
    `Diff_Time_Ratio = score_differential / exp(-4 * elapsed_share)` — the spread and the score
    differential are both *decayed* toward irrelevance as the game empties out, rather than fed
    in raw. This is the single most important modeling trick in the whole codebase: it's why the
    model doesn't need a hand-written "garbage time" special case the way Gridiron's drive
    simulator apparently needs manual halftime/OT special-casing (and per tonight's audit,
    doesn't have it for the season-remainder path).
  - `params$monotone_constraints = "(0, 0, 0, 0, 0, 1, 1, -1, -1, -1, 1, -1)"`
    (`MODELS.R:220`) — xgboost is told at training time that WP must be non-decreasing in
    `score_differential` and `spread_time`, non-increasing in `down`, `ydstogo`,
    `yardline_100`, and `defteam_timeouts_remaining`, non-decreasing in
    `posteam_timeouts_remaining`. This is a **structural guarantee against the exact class of
    bug** tonight's audit found in `nfl-drive-sim.js` (inverted kneel rule, timeouts that never
    decrement, away-team WP using the home spread) — those are all "WP moved the wrong direction
    given the state" bugs, and a monotone-constrained model makes that category of bug
    impossible by construction, not just less likely.
  - `calculate_win_probability()` (`ep_wp_calculators.R:174-208`) is the runtime entry point:
    it derives `home`, `posteam_spread`, `elapsed_share`, `spread_time`, `Diff_Time_Ratio` from
    raw pbp columns, then calls `get_preds_wp` / `get_preds_wp_spread`, which just do
    `stats::predict(load_model(...), as.matrix(pbp |> wp_model_select()))` — i.e. the entire
    runtime cost is one matrix-vector pass through a pre-trained tree ensemble. No live
    simulation of remaining plays, no Monte Carlo of drives — this is the crucial architectural
    difference from Gridiron's `nfl-drive-sim.js`, which the audit found simulates the rest of
    the game play-by-play (and has 6 physics bugs in that simulation). nflfastR-style live WP
    is a **direct regression on game state**, not a simulator, so it can't inherit clock/kneel/
    timeout logic bugs from a simulator at all.
  - Training labels come from `guga31bb/metrics` `wp_tuning/cal_data.rds` (`MODELS.R:176-178`),
    filtered to `qtr <= 4` (no OT rows in training — OT is handled by falling back to the
    year's non-spread model per nflfastR docs, a real limitation worth inheriting knowingly).
  - EP model (`ep_wp_calculators.R:58-114`) is a separate 7-class `multi:softprob` xgboost
    (era/down/timeouts/dome dummies), used only to build `ep`, not `wp` directly — Gridiron
    doesn't need to replicate this to get live WP; the WP model is self-contained.
- **Adopt: borrow-idea** for the code itself (license risk — NOASSERTION means no explicit
  permission to redistribute/derive from the R source), **reference-only→reimplement** the
  feature engineering formulas and monotone-constraint list, which are facts/methodology, not
  copyrightable expression, and are simple enough (11 columns, 2 derived-feature formulas, one
  constraint vector) to reproduce independently in JS trained on Gridiron's own data.

### 2. AndrewRook/NFLWin — MIT-licensed, portable end to end
- License: **MIT**. Stars 24. Last push 2023-07-06 (dormant but complete, small, readable).
  Cloned: `github/AndrewRook__NFLWin` (540KB).
- Read in full: `nflwin/model.py` (520 lines), skimmed `preprocessing.py`.
- **What it actually does**: a scikit-learn `Pipeline` — `ComputeIfOffenseIsHome` →
  `CreateScoreDifferential` → `MapToInt(down)` → `ComputeElapsedTime` →
  `OneHotEncoderFromDataFrame(down)` → `CalibratedClassifierCV(LogisticRegression(), cv=2,
  method="isotonic")` (`model.py:397-469`). Far simpler feature set than nflfastR (no timeouts,
  no spread, no receive_2h_ko) — logistic regression, not gradient boosting.
- **The genuinely reusable piece is not the model, it's the validator**
  (`model.py:176-299,369-396`): `validate_model()` builds a Gaussian-kernel KDE
  (`bandwidth=0.01`) over predicted probabilities separately for "offense won" and "all plays",
  divides them to get the empirical win-rate at each 1%-99% predicted-probability bin, then
  reports `max_deviation` (worst calibration gap anywhere on the curve) and `residual_area`
  (integrated |predicted − actual| via Simpson's rule). This is a working, from-scratch
  **reliability-diagram / calibration-audit method with zero external service dependency** —
  directly relevant to tonight's finding that "no conformal or otherwise honestly-calibrated
  uncertainty interval exists anywhere in the pipeline."
- **Adopt: port** (MIT license, small, no xgboost/native-binary dependency — pure
  scikit-learn/numpy, and the calibration-KDE method is ~30 lines that ports cleanly to JS
  without needing scikit-learn at all, since a Gaussian KDE is just a weighted sum of
  exponentials).

### 3. topfunky/r-nfl-win-probability — smallest possible working example
- License: **none declared** (public repo, no LICENSE file — treat as reference-only, do not
  copy the R verbatim; the *approach* is a fact, not an expression, and is trivial enough to
  reimplement from scratch). Stars 5. Last push 2021-01-18 (a finished one-off "experiment," not
  maintained). Cloned: `github/topfunky__r-nfl-win-probability` (984KB, single file).
- Read in full: `win-probability.R` (381 lines).
- **What it actually does**: trains a single plain `glm(poswins ~ qtr + down + ydstogo +
  game_seconds_remaining + yardline_100 + score_differential + defteam_timeouts_remaining +
  posteam_timeouts_remaining + is_home_team, family="binomial")` (`win-probability.R:146-160`)
  on nflfastR's own historical pbp files, then plots the resulting curve against nflfastR's
  official `wp` column for named games, plus a **calibration plot**
  (`win-probability.R:286-338`): round predicted WP to nearest 5%, group by quarter, plot
  `bin_actual_prob` vs `bin_pred_prob` against the y=x diagonal — the same reliability-diagram
  idea as NFLWin's, done in three lines of dplyr instead of a KDE.
- Proves the ceiling/floor of the MVP: **a single plain logistic regression on features Gridiron
  already has 90% of** gets you visually close to nflfastR's own curve on real games. This is
  the fastest possible path to a first live-WP number, before ever touching gradient boosting.
- **Adopt: reference-only** (methodology confirmation / fallback design if the xgboost path is
  too slow to stand up this week).

### 4. greerreNFL/nfelo — checked, not applicable to *live* WP
- License: none declared. Stars 56. Last push 2026-09-11 (very actively maintained — Nick
  already has this in his research radar per nfeloqb/nfelo mentions in tonight's brief on the
  betting model).
- Inspected directory structure only (`nfelo/{Data,Development,Formatting,Model,Optimizer,
  Performance,Utilities}`) via `gh api contents` — no clone needed to answer the question asked:
  this is a **pregame** Elo-style power-rating system (extends 538's Elo with QB adjustments,
  rest, weather) that updates *between* games, not *within* a live game. There is no play-level
  win-probability surface anywhere in it.
- **Adopt: avoid** for this specific live-in-game-WP task (it solves a different, already
  partially-covered problem — see tonight's separate finding that nfelo-vs-Pinnacle-opener
  favorites is Gridiron's one working +CLV signal). Not cloned (directory listing was sufficient
  to confirm scope).

### 5. nflverse/nflverse-pbp (published as "nflfastR-data" historically) — the training/benchmark data, not code
- License: **CC-BY-4.0** (permissive, attribution required). Stars 346. Last push
  2026-09-11 (built fresh every week during season).
- Not cloned (it's a data-build repo, not something to run) — but its published output
  (`play_by_play_<year>.rds`/csv/parquet files, referenced directly in both `MODELS.R:176` and
  `topfunky/win-probability.R:32-33`) already contains, per play, nflfastR's own computed `wp`,
  `vegas_wp`, `spread_line`, and every raw column needed to retrain: `score_differential`,
  `game_seconds_remaining`, `posteam_timeouts_remaining`, `defteam_timeouts_remaining`, etc.,
  back to 1999.
- **Adopt: call** — download specific season files (no auth, no paid API, static URLs) as (a)
  extra training rows beyond Gridiron's own 251,591, and (b) a ground-truth benchmark to sanity
  check Gridiron's own `nfl_play_by_play` ingestion (do down/distance/score/yardline agree with
  the same real plays recorded independently by nflverse?).

## The concrete Gridiron gap this surfaces

`server/db/schema/nfl-a-to-m.js:306-333` — `nfl_play_by_play` has `down, distance,
yards_to_endzone, home_score, away_score, period, clock_seconds, offense, defense` — i.e. 8 of
the 11 nflfastR wp_model features already exist under different names. **It has no
`posteam_timeouts_remaining` / `defteam_timeouts_remaining` columns at all**, and no
`receive_2h_ko` equivalent. Both are monotone-constrained features in the reference model (timeouts
in particular is one of only two features nflfastR forces to move WP monotonically in the
*teams-own-favor* direction). Tonight's audit separately found the drive simulator's timeout
counter "never decrements" — so timeouts tracking is broken in the one place it currently exists
in Gridiron at all. Standing up any real live-WP model means fixing this data gap first, which is
its own useful side effect regardless of which model architecture gets picked.

## MVP recommendation (staged, cheapest-first)

1. **Days 0-1**: add `posteam_timeouts_remaining`/`defteam_timeouts_remaining` (and
   `receive_2h_ko`) to `nfl_play_by_play` ingestion, derived from existing play text/sequence
   (timeout events are already presumably present in the raw feed text field per the schema's
   `text TEXT` column, or need a new small event-listener) — see candidate GN07-c4.
2. **Days 1-3**: ship the topfunky-style plain logistic regression first (features Gridiron
   already has, minus timeouts) as `nfl-live-wp.js`, trained offline on Gridiron's own 251,591
   rows once labeled with game outcome, evaluated in pure JS (`sigmoid(dot(coefs, features))` —
   no runtime ML dependency at all) — see candidate GN07-c1.
3. **Days 3-5** (once timeouts land): upgrade to the full 11-feature, monotone-constrained
   xgboost architecture, trained offline in Python/R, exported via `dump_model` to JSON, walked
   at runtime with a ~40-line JS tree evaluator (no native xgboost binary needed in Node) —
   fold into GN07-c1 as v2.
4. In parallel: port NFLWin's KDE reliability-diagram calibration check (GN07-c2) and pull a
   season or two of nflverse-pbp as an external benchmark (GN07-c3) — both are needed to know
   whether steps 2-3 actually worked, and both generalize beyond WP to the "no honest
   calibration anywhere" gap tonight's audit flagged for CLV and props too.
5. Cheap, visible payoff once (2) exists: a live-WP line chart on Gridiron's own dashboard,
   modeled on topfunky's plot idea (quarter gridlines, scoring-event rug marks) — GN07-c5.

## Do not do
- Do not literally copy nflfastR's R source into Gridiron (NOASSERTION license — no explicit
  permission to redistribute/derive). Reimplement the formulas from the public methodology.
- Do not try to run xgboost's native binary inside Node in production — export trained trees to
  JSON and walk them in JS, or use a pure-JS logistic model; no npm xgboost binding was found in
  the repo search that looked maintained/trustworthy enough to add as a new runtime dependency.
- Do not point this at OT plays without a fallback — nflfastR's own spread model drops OT rows
  from training (`qtr <= 4` filter); either train a separate OT-only model later or explicitly
  degrade to a simpler no-spread estimate in OT rather than silently extrapolating.
