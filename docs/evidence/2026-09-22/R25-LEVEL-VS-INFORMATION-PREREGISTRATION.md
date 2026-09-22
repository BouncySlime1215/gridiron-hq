# Auditor §R25 pre-registration: level vs. information in shipped-vs-control

Locked before any measurement runs against real rig data, per the Auditor's
own binding condition ("the Auditor binds itself to the pre-registration").
No weight change ships from this unit — it is a gate/measurement unit only.

## 0. Amendments (Auditor R36, R37)

R36 acknowledged the original design (below, sections 1-4) with two
required changes, applied throughout this document and the implementation:

- **Change 1 — median, not mean.** Centring uses the MEDIAN of the bias
  split's residuals, not the mean: MAE's optimal centring statistic is the
  median, weekly scores are right-skewed, and the two arms' mean-median
  gaps differ enough that a mean-based centring does not cancel out of the
  delta between them. Also reports the multiplicative form from R7:
  `headroom(X) = MAE(X) − MAE(X × m0(X))`, `m0` = the prediction-weighted
  median of `actual/pred` on the bias split. See section 5.
- **Change 2 — add 2021 and 2022.** 2024 is inside control's own fit
  window (fit-1 was fit on pooled 2023-2025), so testing on 2024 is
  in-sample for control and asymmetrically favours it — the same applies
  to the production figure being decomposed. 2021 and 2022 are outside
  both arms' fitting data (shipped: "fit on 2023 only, architecture
  selected on 2024, evaluated once on 2025" per `weekly-ensemble.js:10-11`)
  and are the clean, out-of-sample comparison. 2024 stays as the figure
  being decomposed; if control's win does not reproduce on 2021/2022, the
  2024 decomposition explains an artefact, not a real advantage. See
  section 3.
- **Minor — citation tree.** Line numbers below are this branch's tree
  (`shrinkage-efficiency-weighting`), not `main`: the docs-correction
  commit that renumbered `weekly-ensemble.js` (18d6b52) is not on `main`.
  Verified directly: `main` `1a136145`'s `WEEKLY_ENSEMBLE_WEIGHTS` is at
  `:59-64` and `weeklyEnsembleWeightsFor` at `:156-161` (unchanged from
  `654ff93`, since this file's rewrite never merged). This branch's lines
  (`:75-80`, `:172-177`) are ~16 lines further down for the same code, from
  that same not-yet-merged rewrite.

**R37 rider**, carried on every result from this unit: *this grades the
replay predictor, whose equivalence to production's is unestablished.*
Explorer's trace found the live weekly engine reads 23 tables and the
replay 4 (`weekly-backtest.js`'s weekly path: `player_week_usage`,
`shrinkage_fits`, `nfl_player_week_features`, `players` — section 4); the
open question the Auditor has narrowed it to is whether the replay's
`structural` input is computed by production's own code or a
reimplementation. Applies identically to shipped and control, since both
run through the same replay.

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

- **Bias split: 2023 only** (R36 change 1 keeps this singular, not a
  rolling per-season split): used only to compute each arm's own MEDIAN
  residual and `m0` on player-weeks neither test season is graded on. This
  is a fixed correction, computed once, applied identically to every test
  season below.
- **Test seasons: 2024, 2021, 2022** (R36 change 2). 2024 is the figure
  being decomposed (the 0.0632/-0.4898/-0.5136 production numbers) but is
  in-sample for control's own fit; 2021 and 2022 are out-of-sample for
  both arms and are the clean comparison — verified on the rig
  independently of 2020 (see note below).
- **No 2025.** Not touched by this unit.
- **2020 note.** The Auditor's background cited "2020-2024 REG 29,428
  player-weeks" as already on the rig. Verified directly against this
  container: `player_week_usage` has 0 rows for `season = 2020`
  (`SELECT COUNT(*) FROM player_week_usage WHERE season = 2020` → 0; 2021
  has 7,659 rows, 2022 7,945, 2023 8,436, 2024 8,675). This may describe a
  different container or a broader scope than what this rig holds today.
  It does not block this unit: the design needs only 2023 (bias) and
  2021/2022/2024 (test), none of which requires 2020 data — `actuals()`
  (`backtest.js:26-28`) reads only the season being replayed, and
  `replaySeasonWeekly`'s in-season heads (season_to_date, last3, last1,
  median) come from weeks 1..W-1 of that same season, not a prior season's
  truth table. Sanity-checked: `buildProjections({ through: 2021,
  throughWeek: 4 })` returns 453 projected players; `throughWeek: 17`
  returns 631 — both non-empty, confirming 2021 is independently usable
  with no 2020 dependency.
- `replaySeasonWeekly(season, { predictionHead: controlFn, distributions:
  false })` for each of 2023, 2024, 2021, 2022 — default `startWeek: 5,
  endWeek: 18` (`weekly-backtest.js:95`, matching fit-1's own grading
  window). `distributions: false` skips the Monte Carlo sampler
  (`sampleWeeks`, PIT, CRPS) since this comparison needs only point
  predictions and errors — cheaper, and nothing this unit measures depends
  on the distributional path.
- **One run per season, not two per season.** `weekly-backtest.js:179`,
  `predictionRows.push({ ...context, prediction: modelPred, blend:
  blendPred, actual: act })` — `context` already carries
  `candidate_heads.active_champion` (shipped's prediction, set at line
  157) and `context.player_id`/`context.week`/`context.position`. So a
  single `replaySeasonWeekly(<season>, { predictionHead: controlFn,
  distributions: false })` call yields shipped's prediction, control's
  prediction, and the real outcome for every graded player-week, on
  identical players and the same fixed seed (`20260826`,
  `weekly-backtest.js:91`) — a fully paired comparison from one run per
  season, for all four seasons (2023 bias + three test seasons = 4 runs
  total, not 8). **No change to `weekly-backtest.js` or
  `weekly-ensemble.js` is needed for this measurement** — everything the
  decomposition needs is already returned in `_predictions`. If a change
  turns out to be needed once the script is written, it gets TDD like any
  other code change; none is anticipated.
- **Same n within each season, both arms.** Since shipped and control are
  read off the same `_predictions` rows for a given season (same
  `player_id`/`week` keys), n is identical by construction between the two
  arms — there is no separate "shipped's n" vs "control's n" to
  reconcile. n itself varies BETWEEN seasons (2021/2022/2024 each have
  their own player-week count) — that is expected and reported per season,
  not something to force equal.

## 4. Rig-scope caveats (Explorer's findings, stated verbatim per the
coordinator's 16:23:39Z follow-up — both apply to shipped and control
equally, since both read the same rig)

- `players.espn_id` is NULL for every row on the rig (1,140 players, 135
  QBs, 0 with an id), so the QBR nudge short-circuits at `nfl-qbr.js:129`
  (`if (espnId == null) return null;`) before any query ever runs.
  Condition B on the rig is five blindnesses, not four.
- `replaySeasonWeekly()`'s weekly path reads only `player_week_usage`,
  `shrinkage_fits`, `nfl_player_week_features`, and `players` — snaps,
  injuries, and depth-chart state cannot affect this comparison, on either
  side, in any of the four seasons run (2023 bias, 2024/2021/2022 test).

These are stated so a reader of the eventual result does not read the
shipped-vs-control gap as including any of that missing signal — it can't,
on this rig, for either side.

## 5. Decomposition method (amended per R36 change 1)

Reusing the `_centred` idiom already in this codebase
(`offseason-model.js:1624-1643`: "Comparing across the two measures the
centring, not the feature set" — compare centred-to-centred and
raw-to-raw separately to isolate how much of a gap is pure level/bias vs.
genuine predictive shape), with the centring statistic changed from mean
to median per R36, and the R7 multiplicative form added.

Implemented in `server/services/level-information-decomposition.js`
(`weightedQuantile`, `predictionWeightedMedianRatio`, `decomposeArm` — RED
tested in `test/level-information-decomposition.test.js`, 11 tests, before
the module existed; GREEN after; mutation-checked by hand-flipping the
median centring to a mean and confirming exactly one test catches it, per
`docs/tdd/level-information-decomposition.tdd.md`).

1. Run `replaySeasonWeekly(2023, { predictionHead: controlFn,
   distributions: false })` once (the bias split, shared by all three test
   seasons). From `_predictions`, for each arm compute:
   - `medianBias = median(actual - pred)` over all 2023 graded rows (was
     `mean` pre-R36 — the fix this unit's own tests pin).
   - `m0 = predictionWeightedMedianRatio(pred, actual)` — the
     prediction-weighted median of `actual/pred` over the same 2023 rows,
     dropping any row with a non-positive prediction.
2. For each test season in `[2024, 2021, 2022]`, run
   `replaySeasonWeekly(season, { predictionHead: controlFn, distributions:
   false })`. From that season's `_predictions`, for each arm:
   - **Raw**: `rawMae = mean(|actual - pred|)`. `raw_delta = rawMae_shipped
     - rawMae_control` (2024's raw_delta is the reported 0.0632).
   - **Additive de-biased**: `debiasedPred = pred + medianBias` (the
     arm's OWN 2023 medianBias, never a 2024/2021/2022-derived value) →
     `debiasedMae = mean(|actual - debiasedPred|)`.
     `debiased_delta = debiasedMae_shipped - debiasedMae_control`.
   - **Multiplicative headroom (R7)**: `scaledPred = pred * m0` (the arm's
     OWN 2023 m0) → `scaledMae = mean(|actual - scaledPred|)`.
     `headroom = rawMae - scaledMae`, reported per arm per season — how
     much of that arm's own raw MAE a single multiplicative rescale would
     close. This is diagnostic (per-arm), not part of `raw_delta`'s
     decomposition, which uses the additive form.
   - **level_share** = `raw_delta - debiased_delta` (how much of the raw
     gap closes once each side is centred by its own known 2023 bias —
     the part of control's win that is just "control's level was already
     closer to zero going in").
   - **information_share** = `debiased_delta` (the residual gap after both
     sides are put on equal footing for level — genuine predictive-shape
     advantage, if any, not just a better intercept).
   - Also report each side's raw mean signed error directly per season (on
     2024 this is checked against the production -0.4898 / -0.5136
     figures being decomposed).
   - The bias split (2023) is never used to compute the test season's own
     metrics beyond `medianBias`/`m0` — no row from a test season feeds
     back into computing its own correction.
3. **Significance**: player-clustered `pairedBootstrapDiff` (already used
   this way in `backtest-significance.js`) per test season, twice — once
   on the raw absolute-error arrays (`|actual - active_champion|` vs
   `|actual - prediction|`), once on the additive-de-biased absolute-error
   arrays — `groups: predictionRows.map(r => r.player_id)`, default
   `iterations: 2000`. Report `mean_diff`, `ci90`, `n` for each season,
   each of the two comparisons. A CI that excludes zero on 2024's raw
   comparison but includes zero on 2021/2022's would itself be the
   finding: the 2024 win doesn't reproduce out of sample. A CI that
   excludes zero on raw but includes zero on de-biased (any season) means
   that season's win is level, not information.

## 6. Reporting format (Auditor submission, once run)

- (a) One-sentence claim: what share of 2024's 0.0632 pooled MAE win is
  level vs. information, whether that win reproduces on 2021/2022, with
  point estimates and CIs for all three seasons. Carries the R37 rider
  verbatim: *this grades the replay predictor, whose equivalence to
  production's is unestablished.*
- (b) file:line, stating the tree: this branch's own citations above are
  `shrinkage-efficiency-weighting` (currently head `1a70355`), not `main`
  — `weekly-ensemble.js`'s docs-rewrite (18d6b52) that moved
  `WEEKLY_ENSEMBLE_WEIGHTS`/`weeklyEnsembleWeightsFor` is unmerged. On
  `main` `1a136145`: `WEEKLY_ENSEMBLE_WEIGHTS` is at `:59-64`,
  `weeklyEnsembleWeightsFor` at `:156-161` (both files/lines otherwise
  identical to what's cited here). Also cites
  `server/services/level-information-decomposition.js`,
  `scripts/r25-level-vs-information.mjs`, `nfl-qbr.js:129`,
  `offseason-model.js:1624-1643`, `backtest.js:26-28`.
- (c) Evidence: n per season (2024/2021/2022, each independently), the
  2023 bias-split medianBias and m0 per arm, both bootstrap CIs per
  season, the raw mean signed error per arm per season (2024's checked
  against -0.4898 / -0.5136), and per-arm headroom (the multiplicative
  form) per season.
- (d) Incumbent to beat: shipped (`WEEKLY_ENSEMBLE_WEIGHTS`, the live
  path) — this unit does not propose beating it; it explains what the
  0.0632 pooled figure is made of and whether it holds out of sample. No
  promotion, no weight change, no `saveWeeklyFit` call happens from this
  unit.

## 7. What this unit will NOT do

- Will not touch `weekly-weight-store.js`, `saveWeeklyFit`, or any
  promotion path.
- Will not run anything against 2025 or 2020 (2020 is unavailable on this
  rig regardless — section 3).
- Will not spend paid resources (`nothing paid`, per standing rule).
- Will not change `weekly-backtest.js` or `weekly-ensemble.js` unless the
  measurement script turns out to need something not already returned by
  `_predictions` — in which case that change gets its own RED/GREEN/
  evidence-file treatment before this unit's numbers are trusted.
- Will not drop the R37 rider from any reported result, until the
  replay-vs-production equivalence question is separately resolved.
