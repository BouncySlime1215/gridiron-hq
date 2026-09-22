# Auditor §R25 pre-registration: level vs. information in shipped-vs-control

Locked before any measurement runs against real rig data, per the Auditor's
own binding condition ("the Auditor binds itself to the pre-registration").
No weight change ships from this unit — it is a gate/measurement unit only.

## 1. The production fact this unit exists to decompose

Control beats shipped by 0.0632 MAE pooled (CI excludes zero) **and** carries
a better level (mean signed error -0.4898 vs -0.5136, 0.0238 less negative).
The usual pattern in this repo is the opposite direction — an MAE win bought
by pushing the level low (see `weekly-ensemble.js:58-69`, the WHY CONVEX
section: an unconstrained LAD fit beats convex by 0.078 MAE but via a level
shift, intercept -0.83 to -0.97, bias -1.02 to -1.56 pts/player-week vs
convex's -0.16 to -0.62). A both-ways win is not that pattern, so it must be
decomposed before it is read as "control is simply better."

## 2. Exact definitions

- **shipped**: `WEEKLY_ENSEMBLE_WEIGHTS` (`weekly-ensemble.js:75-80`), the
  frozen per-position fallback — confirmed the live production path since
  `promoted_fits_in_epoch: 0` (see `weekly-ensemble.js:4-17`). Always
  available in a replay via `context.candidate_heads.active_champion`,
  which `weekly-backtest.js:157` computes unconditionally on every graded
  player-week regardless of what `predictionHead` is passed.
- **control**: fit-1's global vector `[0.20 structural, 0.40 season_to_date,
  0.15 last3, 0.05 last1, 0.20 median]`, fit on pooled 2023-2025 and never
  promoted to any epoch (`weekly-ensemble.js:12-17`, the WITHDRAWN block —
  the vector existed and was measured, but zero rows in the active epoch
  means it has never been live). Represented as one flat vector applied
  uniformly across positions:
  ```js
  const CONTROL_WEIGHTS = Object.freeze({
    QB: [0.20, 0.40, 0.15, 0.05, 0.20],
    RB: [0.20, 0.40, 0.15, 0.05, 0.20],
    WR: [0.20, 0.40, 0.15, 0.05, 0.20],
    TE: [0.20, 0.40, 0.15, 0.05, 0.20]
  });
  ```
  Required shape confirmed by reading `weeklyEnsembleWeightsFor`
  (`weekly-ensemble.js:172-177`): it does `weightSet[context.position]`, so
  any weightSet — flat or fitted — must be keyed per position; there is no
  other representation `weeklyEnsemblePrediction` accepts. No `early` block
  is set on control: fit-1 itself was only ever fit and graded on weeks
  5-18 (`weekly-ensemble.js:31-45`), matching this unit's own week window
  (below), so an early-week bucket would test something fit-1 was never fit
  for.
  `predictionHead` for control:
  `context => weeklyEnsemblePrediction(context, CONTROL_WEIGHTS)`, imported
  from `weekly-ensemble.js`.

## 3. Rig scope

- **2023 → 2024 rolling**: 2023 is the training split, used only to compute
  each side's own bias (mean signed error) on player-weeks it was not
  graded on for the headline number. 2024 is the test split — the number
  that answers "does control really beat shipped, and on what."
- **No 2025.** Not touched by this unit.
- `replaySeasonWeekly(season, { predictionHead: controlFn, distributions:
  false })` — default `startWeek: 5, endWeek: 18` (`weekly-backtest.js:95`,
  matching fit-1's own grading window). `distributions: false` skips the
  Monte Carlo sampler (`sampleWeeks`, PIT, CRPS) since this comparison
  needs only point predictions and errors — cheaper, and nothing this unit
  measures depends on the distributional path.
- **One run per season, not two.** `weekly-backtest.js:179`,
  `predictionRows.push({ ...context, prediction: modelPred, blend:
  blendPred, actual: act })` — `context` already carries
  `candidate_heads.active_champion` (shipped's prediction, set at line
  157) and `context.player_id`/`context.week`/`context.position`. So a
  single `replaySeasonWeekly(2024, { predictionHead: controlFn,
  distributions: false })` call yields shipped's prediction, control's
  prediction, and the real outcome for every graded player-week, on
  identical players and the same fixed seed (`20260826`,
  `weekly-backtest.js:91`) — a fully paired comparison from one run per
  season. Same for 2023 (train split). **No change to
  `weekly-backtest.js` or `weekly-ensemble.js` is needed for this
  measurement** — everything the decomposition needs is already returned
  in `_predictions`. If a change turns out to be needed once the script is
  written, it gets TDD like any other code change; none is anticipated.
- **Same n, both sides.** Since shipped and control are read off the same
  `_predictions` rows (same `player_id`/`week` keys, same season), n is
  identical by construction — there is no separate "shipped's n" vs
  "control's n" to reconcile.

## 4. Rig-scope caveats (Explorer's findings, stated verbatim per the
coordinator's 16:23:39Z follow-up — both apply to shipped and control
equally, since both read the same rig)

- `players.espn_id` is NULL for every row on the rig (1,140 players, 135
  QBs, 0 with an id), so the QBR nudge short-circuits at `nfl-qbr.js:129`
  (`if (espnId == null) return null;`) before any query ever runs.
  Condition B on the rig is five blindnesses, not four.
- `replaySeasonWeekly(2024)`'s weekly path reads only `player_week_usage`,
  `shrinkage_fits`, `nfl_player_week_features`, and `players` — snaps,
  injuries, and depth-chart state cannot affect this comparison, on either
  side.

These are stated so a reader of the eventual result does not read the
shipped-vs-control gap as including any of that missing signal — it can't,
on this rig, for either side.

## 5. Decomposition method

Reusing the `_centred` idiom already in this codebase
(`offseason-model.js:1624-1643`: "Comparing across the two measures the
centring, not the feature set" — compare centred-to-centred and
raw-to-raw separately to isolate how much of a gap is pure level/bias vs.
genuine predictive shape).

1. Run `replaySeasonWeekly(2023, { predictionHead: controlFn,
   distributions: false })`. From `_predictions`, compute each side's own
   **training-split mean signed error**: `bias_shipped_2023 = mean(actual -
   candidate_heads.active_champion)`, `bias_control_2023 = mean(actual -
   prediction)`.
2. Run `replaySeasonWeekly(2024, { predictionHead: controlFn,
   distributions: false })`. From `_predictions` (2024, the test split):
   - **Raw**: `mae_shipped = mean(|actual - active_champion|)`,
     `mae_control = mean(|actual - prediction|)`. `raw_delta = mae_shipped
     - mae_control` (this is the reported 0.0632).
   - **De-biased**: subtract each side's OWN 2023 training-split bias from
     its OWN 2024 predictions before taking absolute error —
     `debiased_shipped_pred = active_champion + bias_shipped_2023`,
     `debiased_control_pred = prediction + bias_control_2023` — then
     `mae_debiased_shipped = mean(|actual - debiased_shipped_pred|)`,
     `mae_debiased_control = mean(|actual - debiased_control_pred|)`,
     `debiased_delta = mae_debiased_shipped - mae_debiased_control`. The
     2024 test split is never used to compute a bias — only 2023, to avoid
     leakage.
   - **level_share** = `raw_delta - debiased_delta` (how much of the raw
     gap closes once each side is centred by its own known training bias —
     this is the part of control's win that is just "control's level was
     already closer to zero going in").
   - **information_share** = `debiased_delta` (the residual gap after both
     sides are put on equal footing for level — this is the part, if any,
     that is genuine predictive-shape advantage, not just a better
     intercept).
   - Also report each side's raw 2024 mean signed error directly (the
     -0.4898 / -0.5136 production figures being decomposed), so the
     centring step is checkable against the number that motivated the
     unit.
3. **Significance**: player-clustered `pairedBootstrapDiff` (already used
   this way in `backtest-significance.js`) on the 2024 test split, twice —
   once on the raw absolute-error arrays (`|actual - active_champion|` vs
   `|actual - prediction|`), once on the de-biased absolute-error arrays —
   `groups: predictionRows.map(r => r.player_id)`, default `iterations:
   2000`. Report `mean_diff`, `ci90`, `n` for both. A CI that excludes zero
   on the raw comparison but includes zero on the de-biased comparison
   would itself be the finding: the raw win is level, not information.

## 6. Reporting format (Auditor submission, once run)

- (a) One-sentence claim: what share of the 0.0632 pooled MAE win is level
  vs. information, with the point estimates and both CIs.
- (b) file:line on `main` `1a136145` for every function cited above
  (`weekly-ensemble.js`, `weekly-backtest.js`, `nfl-qbr.js`,
  `offseason-model.js`) plus the new measurement script's own path:line.
- (c) Evidence: n (2024 graded player-weeks, expected in the low
  thousands per the existing weeks-5-18 pattern), the 2023 train-split
  bias figures used for centring, both bootstrap CIs, and the raw 2024
  mean signed error for both sides (checked against -0.4898 / -0.5136).
- (d) Incumbent to beat: shipped (`WEEKLY_ENSEMBLE_WEIGHTS`, the live
  path) — this unit does not propose beating it; it explains what the
  0.0632 pooled figure is made of. No promotion, no weight change, no
  `saveWeeklyFit` call happens from this unit.

## 7. What this unit will NOT do

- Will not touch `weekly-weight-store.js`, `saveWeeklyFit`, or any
  promotion path.
- Will not run anything against 2025.
- Will not spend paid resources (`nothing paid`, per standing rule).
- Will not change `weekly-backtest.js` or `weekly-ensemble.js` unless the
  measurement script turns out to need something not already returned by
  `_predictions` — in which case that change gets its own RED/GREEN/
  evidence-file treatment before this unit's numbers are trusted.
