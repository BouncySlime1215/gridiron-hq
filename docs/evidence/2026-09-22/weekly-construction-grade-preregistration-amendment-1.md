# S-02 pre-registration, amendment 1 (after the audits, before any new number)

Written 2026-09-22 on tree `0f397736`, after the one 2025 look (20:45:17Z) and after three
independent audits of that result. The original pre-registration
(`weekly-construction-grade-preregistration.md`, commit `dd4d2055`) is unchanged, byte for byte;
this file adds to it. Every `file:line` is on `0f397736`.

## 1. Why this amendment exists

1. **The arms are not the number any page shows.** The Start/Sit number is
   `round2(B × thisGame.mult × active_probability × lift)`: trade-engine.js:346 (`active_probability`,
   0.92 when there is no availability row), :359 (`currentWeekPpg`, 0 on a bye), then
   lineup-brain.js:356-363 (`startSitWeekPoints`, lift keyed on the asset's `players.team_abbr`).
   The arms stop before `thisGame.mult × active_probability`. The original §4 said availability
   "multiplies every arm by the same active_probability", so it could be left out. That does not
   hold for an MAE ranking of arms that differ mainly by level: multiplying by p changes which
   level is closest to the truth. The run-time parity check (§10.3a) fed arm B into
   `startSitWeekPoints` as `current_week_ppg`, so it only confirmed the rounding of B × lift.
2. **The lineup-level figure in the result was not measured.** "A nine-starter lineup total
   would read about 3.7 to 5.5 points low" was nine times the population mean signed error, not a
   measurement on starters.
3. **Test holes.** `compareArms`, the runner's call into it, the arguments passed to the served
   `weeklyExpertValues` and `vegasLift`, and `m0For` / `armSummary` / `headroom` /
   `pairAccuracy` had no test that fails when they are broken.
4. **Two other recorded level baselines disagree with S-02's** (weekly-ensemble.js:85-88;
   R25-LEVEL-VS-INFORMATION-RESULTS.md:45-47) and S-02 did not reconcile them.

## 2. What changes

- The §7 decisions stand as computed, but they are relabelled: **a grade of the construction
  before availability and the game factor.** They are not a grade of the page number.
  **S-03 must not remove the lift, change the coordinator's base or change its level on these
  verdicts.** The decision grade for S-03 is §4 below.
- Arm D is renamed from "Start/Sit today" to "served construction before availability and the
  game factor (lift keyed on the engine's team)".
- No run in this pass opens a new 2025 grade. The one 2025 figure this pass adds (§3.2) is a
  descriptive table computed on rows the claims audit already produced when it reproduced the
  20:45 look. It carries no rule and no decision, and it is logged in Holdout looks.

## 3. Report-only diagnostics run in this pass (no rule, no decision)

### 3.1 Consumer decomposition, 2026 current week of the copy

Week = `tradeWeekContext()` on the copy (2026 W3 at writing: no actuals, so not a grade).
`assetUniverse` on a synthetic 12-team PPR league object (no `leagues` row is read, so no league
data and no cookie column is touched). For every QB/RB/WR/TE asset that has an engine projection
and a coordinator correction:

- (a) the served `fantasy_coordinator.corrected_ppg` equals the study's arm B from its own engine
  build with the served fit;
- (b) `current_week_ppg === +(B × matchup.mult × active_probability).toFixed(2)`, and 0 on a bye;
- (c) the page number is `startSitWeekPoints(asset).week_points`, reported against `round2(arm D)`.

Stops if (a) or (b) fails on any asset. Reports: counts; the page / arm D ratio; the
`active_probability` distribution, overall and for assets with no injury status, with the share
whose p equals the `weeklyAvailability` durability prior; the availability basis
(`availabilityBasis()`); assets whose `players.team_abbr` differs from the engine's team; and
the weekly starter proxy (top QB 12 / RB 30 / WR 36 / TE 12 by arm D): mean arm D, mean page
number, median p.

### 3.2 Level by projection band

Mean signed error (prediction − actual; negative = the number reads low) with a player-clustered
90% CI: `pairedBootstrapDiff(zeros, errors, { groups: player_id, iterations: 2000, seed: 1 })`,
whose `mean_diff` is the mean error. Arms A, B, C, D, S1, S2 (S3 equals A or C). Per window
(2-4, 5-17). Row sets:

- all played rows; played rows with A ≥ 10; played rows with A < 10;
- the weekly starter proxy: each week's top QB 12 / RB 30 / WR 36 / TE 12 by A among that week's
  graded rows, measured on its played rows (level given he plays) and on its decision rows
  (DNP = 0, the level a lineup total carries before availability).

Inputs: the runner's own row objects, as dumped by the claims audit's reproduction run (the
runner at `0f397736` plus three dump lines, 2026-09-22 20:58-21:04Z, a `.backup` of the same
copy). Seasons: 2024 (the fit split) and 2025 (held out). **Reproduction control, a stop
condition:** before any band is printed, the dumped rows must reproduce the committed output
file: for 2025, `n_played`, `n_decision`, `mae` and `signed_error` of every arm in both windows to
4 decimal places; for 2024, the λ = 0 grid MAE (A's MAE) and m0 of every arm in both windows.
If either check fails, nothing is reported.

Not measured by this table: the level of the page number, which carries `active_probability`
(§3.1 measures that factor, on a week without actuals).

## 4. The decision grade for S-03: the served chain, run jointly with S-04 and A-11

Not run in this pass. Proposed specification, to be ratified in a committed amendment 2 signed
off by S-02, S-04 and A-11 **before any number is run**:

- Arms: each arm × `thisGame.mult` × p, with p =
  `weeklyAvailability(season, week, { through: season − 1 }).get(id)?.active_probability ?? 0.92`
  (trade-engine.js:304, :346) and 0 on a bye (:359). Lift as served.
- p basis: whatever S-04 serves when the grade runs (`role` if S-04 has landed, `pooled`
  otherwise), recorded from `availabilityBasis()` in the output.
- Truth: the served number folds in the chance to play, so it is an expected value. The primary
  truth is the DNP-included actual (0 when he does not play). Played-row MAE is secondary.
- Level target: A-11 decides, on the post-availability number, whether served numbers aim at
  the median or the mean, before the run. MAE rewards the median.
- Decisions: pair accuracy and win rate against "start the highest A × p" on the same chain.
- One more look at 2025, logged in Holdout looks.

Why it is not run now: on this copy p runs the `pooled` path (`nfl_availability_role_rates`
missing), which prices a player with no injury report at his durability prior. The code's own
record says healthy starters (no report, starter tier, played last game) played 94.5% of the
time while that path said 0.708 (contingency.js:697-698). S-04 exists to replace that path. On
that p, a served-chain MAE verdict mostly measures which arm offsets p's low level: the wiring
audit found, on 2024 (the fit split), that the lift passes and the coordinator fails on the
p basis, the reverse of the pre-availability verdicts. A verdict that flips with p's level is
not a verdict on the construction.

## 5. What would make this amendment wrong

- If S-04 does not land before week 5, the served chain at week 5 carries the pooled p. The
  joint grade then has to run on the pooled basis and say so, rather than wait.
- If the dumped rows fail the reproduction control, the 2025 band table is not reported and the
  lineup-level question stays open.
