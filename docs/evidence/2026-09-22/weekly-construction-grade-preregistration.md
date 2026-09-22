# S-02 pre-registration: grade the served weekly construction (4 arms + 3 S-03 candidates)

Locked before any number is run. Written on tree `d6d7bd5a` (origin/main, 2026-09-22).
Every `file:line` below is on that tree. This unit measures only. It changes no served
code. S-03 applies the result before week 5 (2026-10-08).

## 1. The question

The number Start/Sit shows for a player this week is built in three steps:

1. `weeklyPpg` = the weekly ensemble, `buildPlayerWeekEngine(...).ppg` (trade-engine.js:347).
2. `+ coordinator`: `coordinateFantasy(fit, weeklyExpertValues(...), weeklyPpg).corrected_ppg`
   (trade-engine.js:353-355). The fit's target is `actual − structural_ppg`
   (fantasy-coordinator.js:324), but it is added to the ensemble, not the structural head
   (STRUCTURE-MAP M1).
3. `× vegasLift`: the betting-line game-script multiplier, clamped [0.75, 1.3], RB split
   0.65 rush / 0.35 pass set by hand (lineup-brain.js:356-363, waiver-brain.js:162-185, :174).
   The coordinator already has game script as an expert (`game_script_delta`), so the lift
   may count it twice (M1). The lift has never been graded as a fantasy multiplier (M2).

Question: does each addition make the weekly number more accurate, and more useful for
start/sit, than the ensemble alone? An addition stays ON only if it earns it.

## 2. Literature grounding

A second-stage correction is only valid on the base it was trained to correct: stacked
generalization fits the level-1 learner on the level-0 model's own out-of-sample output
(Wolpert 1992, *Neural Networks* 5:241-259). Applying a correction trained on one base to
another is an ungraded model. Equal predictive accuracy is tested on the paired loss
differential (Diebold & Mariano 1995, *JBES* 13:253-263). Player-weeks from one player are
not independent, so the interval is a cluster bootstrap over players (Cameron, Gelbach &
Miller 2008, *REStat* 90:414-427), the same `pairedBootstrapDiff` the repo already uses.

## 3. Arms

`proj` = `playerWeekProjection(buildPlayerWeekEngine({ season, week, scoring: PPR }), id)`,
the served engine for that week (player-week-engine.js:256). `lift(x)` =
`x × vegasLift({ team_abbr: proj.team, position: proj.position }, season, week).multiplier`
when `applied`, else `x`. `experts` = `weeklyExpertValues(proj, season, week, PPR)`
(fantasy-coordinator.js:407). `coord(fit, base)` = `coordinateFantasy(fit, experts, base)`
(fantasy-coordinator.js:457): `corrected_ppg` when `ready`, else `base`, as trade-engine.js:355.

Primary (the unit's four):

| Arm | Construction | Served where |
|---|---|---|
| **A** (m0, ensemble) | `proj.ppg` | trade-engine.js:347 |
| **B** (+coordinator, served form) | `coord(fitS, proj.ppg)` | trade-engine.js:354-355 |
| **C** (+vegasLift) | `lift(proj.ppg)` | lineup-brain.js:356-363 applied to an uncoordinated base |
| **D** (+both, as served) | `lift(coord(fitS, proj.ppg))` | Start/Sit `week_points` today |

Secondary (S-03 candidates, graded under the same rule):

| Arm | Construction | Why |
|---|---|---|
| **S1** | `coord(fitS, proj.structural_ppg)` | the construction the coordinator was fit and gated on; PR #57's proposed fix |
| **S2** | `coord(fitE, proj.ppg)`, `fitE` = the same fitter on `target − ensemble_shift` | S-03 option "refit on the ensemble residual" |
| **S3** | `proj.ppg × multiplier^λ` when applied; λ chosen on 2024 from {0, 0.25, 0.5, 0.75, 1} per window, lowest 2024 MAE | S-03 option "lift shrunk" |

Fits:

- `fitS` = `fitFantasyCoordinator(await buildFantasyCoordinatorExamples({ fromSeason: 2022, throughSeason: 2024 }))`,
  the served refit (fantasy-coordinator.js:391, `fromSeason = 2022`) with the harness cutoff.
- `fitE` = `fitFantasyCoordinator` on the same examples with `target − experts.ensemble_shift`
  (rows with a non-finite shift dropped and counted).
- For the 2024 fit-split rows (m0, λ): the same two fits on the 2022-2023 subset of those examples,
  so 2024 is out of sample for them.
- For the 2026 forward rows: B, D and S1 use the SERVED fit, `activeFantasyCoordinatorFit()`
  (fantasy-coordinator.js:378, latest row); S2 uses `fitE` refit on 2022-2025 by the same function;
  S3 uses the λ chosen on 2024.

## 4. Configuration (rule 3)

- Engine: `buildPlayerWeekEngine`, the live path, not `replaySeasonWeekly` (which reads 4 tables
  to the engine's 23). `roleRecency: WEEKLY_ROLE_RECENCY` is hardcoded there (player-week-engine.js:273);
  `kOverride` is omitted, so `activeKVectorFor` supplies the fitted volume k, re-fit on seasons
  before the predicted one (shrinkage-fit.js:535-576).
- k control: before grading, `activeKVectorFor(WEEKLY_ROLE_RECENCY, { predictingSeason })` for
  2024, 2025 and 2026 must be non-null with `target_share.ALL !== 6`. Otherwise stop.
- Ensemble weights: whatever `activeWeeklyWeightSet({ season, week })` gives the engine at that
  week (player-week-engine.js:266). On the local copy both stored fits are through 2025-W18, so
  every 2022-2025 week gets the frozen per-position vectors (weekly-ensemble.js, fit on 2023,
  selected on 2024), and 2026 weeks get fit-2 (weeks 2-4: structural head for 1-3 prior games).
- Scoring: PPR for every arm and the truth (`actuals(season, PPR)`, backtest.js:26). Served numbers
  use each league's scoring.
- No availability term, no bye term, `thisGame.mult` = 1. Availability multiplies every arm by the
  same `active_probability` and is graded by S-04. The DNP-included metric carries the cost of
  not playing.
- Truth and population: `weekly-backtest.js` rules. A player is graded in week w if he has a
  projection, a QB/RB/WR/TE position and at least one played week in weeks 1..w-1 of that season.
  *Played rows* (he has a usage row in week w) grade MAE and Spearman. *Decision rows* (he played
  week w-1) grade DNP-included MAE, with actual 0 when he did not play week w.
- Data: a fresh `sqlite3 .backup` of `~/gridiron-local/data.sqlite`. Every result is labelled
  "local copy, not production".

## 5. Splits

- Fit: 2022-2024 (coordinator), 2024 (λ, m0). No 2025 row enters any fit used to grade 2025.
- Held out: **2025, weeks 2-4 and weeks 5-17, graded once, reported apart.** Pooled 2-17 is
  report-only.
- Forward: **every 2026 week already played on the copy with at least one prior 2026 week**
  (week 2 at time of writing). S-03 re-runs `--forward-only` after week 4 without reopening 2025.
- 2025 has been the test season for many earlier units (STRUCTURE-MAP M13). This is one more
  look, logged in the evidence file's "Holdout looks" section (no HOLDOUT-LEDGER.md on origin/main).

## 6. Metrics and sign conventions

- Signed error = prediction − actual (negative = under-projection).
- ΔMAE(X, R) = MAE(X) − MAE(R) on the played rows. **Negative = X better.** 90% CI from
  `pairedBootstrapDiff(|e_R|, |e_X|, { groups: player_id, iterations: 2000, seed: 1 })`
  (backtest-significance.js:57).
- ΔSpearman = ρ(X) − ρ(R), `spearman` (backtest.js:48). Positive = X better.
- ΔDNP-MAE = DNP-included MAE(X) − (R) on the decision rows, with the same bootstrap. Negative = X better.
- Start/sit pair accuracy: `startSitPairAccuracy` (scripts/promote-early-week-weights.mjs:153) on
  the decision rows, one common pair set (same week and position, every arm ≥ 4), ties 0.5.
- Decision win rate vs "start the highest m0 projection": on the same pair set, the pairs where X
  and A order the two players differently. Score 1 if X's pick scored more, 0 if less, 0.5 on a
  tie. Rate − 0.5 with a 90% CI by `pairedBootstrapDiff` clustered on week|position. Positive = X's
  calls beat m0's.
- MDE at 80% power for every non-pass: `2.487 × SE`, `SE = (ci90_hi − ci90_lo) / 3.29`
  (one-sided α = 0.05 matches a 90% two-sided CI; 1.645 + 0.842 = 2.487). Stated in points and as
  % of A's MAE.

## 7. Ship rule and decisions

**Rule** (matchups.js:33-35), arm X against reference R, 2025, one window:
(1) ΔMAE 90% CI entirely below 0; (2) ΔSpearman ≥ −0.002; (3) ΔDNP-MAE ≤ 0 (point estimate).

**Per window** (weeks 2-4, weeks 5-17):

1. Each of B, C, D, S1, S2, S3 is graded against A.
2. Marginal checks, report-only: D vs B (the lift given the coordinator), D vs C (the coordinator
   given the lift).
3. Pass set P = arms that pass against A. If P is empty the window's winner is **A: coordinator
   off, lift off**. Otherwise the winner is the arm in P with the lowest 2025 MAE; exact ties go to
   the arm with fewer components. That choice among passing arms uses 2025, so its margin over the
   other passing arms is optimistic.
4. A combination of a passing secondary coordinator arm (S1 or S2) with a passing lift arm (C or
   S3) is NOT graded here. S-03 either grades it or serves the better single arm.
5. Forward (Nick's rule b): a winner other than A ships ON only if, on the 2026 forward rows, its
   ΔMAE vs A ≤ 0 and its ΔDNP-MAE vs A ≤ 0 (point estimates). Otherwise it ships default-off,
   labelled "unconfirmed forward". Weeks 5-17 have no 2026 rows before week 5 is played, so their
   forward check uses the 2026 weeks 2-4 rows as a proxy, and says so.
6. Multiplicity: 6 arms × 2 windows = 12 tests at one-sided 5%. Under a true null for all of
   them, about 0.6 false passes are expected. Stated beside the result, not corrected for.

## 8. m0, defined jointly with WQ A-11

A-11 is the level correction on the incumbent weekly ensemble. This unit fixes the definition so
both units use one number:

`m0(arm, window) = predictionWeightedMedianRatio(pred, actual)` (level-information-decomposition.js:41)
over the arm's **2024 played rows in that window** (the fit split; engine replay as above; PPR).

Reported per arm and window, with the 2025 multiplicative headroom
`MAE(X) − MAE(X × m0)`. Diagnostic only: not part of the ship rule. m0(A) is the value A-11
starts from. A-11 may widen the split to 2021-2024 only by its own amendment.

## 9. Sensitivity (report-only)

The same arms with the base pinned to the copy's served 2026 weight set,
`weeklyWeightSetById(2, { week })` applied to the engine's own heads through
`weeklyEnsemblePrediction` (weekly-ensemble.js). Weeks 2-4: structural head for 1-3 prior games,
which is what the copy serves in 2026. Weeks 5-17: fit-2's vector, which was fit on 2021-2025,
so this row is in-sample for 2025 and says so.

## 10. Stop conditions (checked before any 2025 metric is computed)

1. The k control fails.
2. Any coordinator fit used for grading has `ready !== true`, or its examples include a season
   later than its cutoff.
3. Parity with the served functions fails on any graded row:
   (a) `round2(D) === startSitWeekPoints({ team_abbr, position, current_week_ppg: B }, season, week).week_points`
       (lineup-brain.js:356);
   (b) on the 2026 forward rows, `B === weeklyProjectionFor(id, { season, week }).corrected_ppg`
       (fantasy-coordinator.js:565, the served fit).
4. A window has zero graded rows (known-nonzero control: 2024 week 6 in the smoke run).

Counts are reported for the examples per season and week, because
`buildFantasyCoordinatorExamples` skips a week whose engine throws (fantasy-coordinator.js:305).

## 11. What would make this wrong

- The local copy differs from production. Production may serve the frozen weights in weeks 2-4
  (the weekly-ensemble.js comment records a live read with 0 promoted fits). Section 9 covers that
  axis for weeks 2-4 only.
- The lift uses `proj.team` (the engine's team at the cutoff). The served asset uses `players.team_id`,
  today's team. They differ for a player traded after the cutoff.
- PPR, not each league's scoring.
- The early-week rule in section 9 was chosen on 2024-2025.
- The 2026 forward sample is one week. It can veto a pass but it cannot confirm much.
