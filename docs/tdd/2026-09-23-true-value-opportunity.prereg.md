# Pre-registration: AI-01 true value on the opportunity model

Unit AI-01 (plan item A2, Trade Machine). Written 2026-09-23 on `origin/main`
`131a7ba0`, **before any number from this test was computed**. This commit must be
an ancestor of the commit that contains results (`docs/evidence/STATS-METHOD.md`
rule 1). Nothing below moves after the run; a change is a new committed file that
says so.

## Audit: extend or build

| surface | producer on `131a7ba0` | what it is |
|---|---|---|
| rest-of-season rate served on the trade card | `ros_ppg`, `server/services/trade-engine.js:389-391,481`, from `buildRosProjections` (`server/services/ros-projection.js:364`) | 0.5 x structural head + 0.5 x [n/(n+4) x season-to-date PPG + 4/(n+4) x market prior]; per game played; no availability term (`ROS_PARAMS`, `ros-projection.js:71`) |
| expected fantasy points per player-week | table `nfl_ffopportunity_weekly`, writer `syncFfOpportunity` (`server/services/ffopportunity.js:45`, upsert at `:47`) | ffverse/ffopportunity xFP, CC BY-SA 4.0 (`ffopportunity.js:9-26`) |
| strictly-prior xFP summary | `priorFfOpportunity` (`ffopportunity.js:100`), read by `server/services/player-week-engine.js:359`; `xfp_ewma` feature (`server/services/opportunity-model.js:40,214`) | weekly-engine inputs, not a ROS value |
| touchdown luck | `server/services/td-regression.js` (`regressionCandidates`, `:259`) | expected TDs from opportunity classes; a second "luck" concept to reconcile if this ships |
| prior measurement | `docs/TARGET-SPEC.md:110-114` | as a WEEKLY head xFP was the best single head (MAE 4.821 vs season-to-date 4.854) but 0.95-correlated with season-to-date and added nothing to the ensemble |
| true value / `true-value.js` | none: `git grep -n -i "true.value\|trueValue\|true_value" -- server client/src` returns nothing on `131a7ba0` (control: the same grep for `ros_ppg` returns trade-engine.js hits) | - |

**Decision: build `server/services/true-value.js` only if the study passes; it would
extend, not replace, `ros_ppg`.** One-number rule: a second rest-of-season rate on the
trade card that disagrees with `ros_ppg` is a hole unless it is better than `ros_ppg`
too. So the ship rule below has a primary gate (the unit's own rule: beat
points-based ROS) and a one-producer gate (not worse than the served `ros_ppg`).

## Hypothesis (one sentence)

A player's season-to-date expected fantasy points per game (opportunity-based ROS)
predicts his next five weeks' points per game better than his season-to-date actual
points per game (points-based ROS).

## Literature (2-3 sentences)

Early-season rates are noisy measurements of a stable underlying ability, so a
noisier observed rate predicts later performance worse than a less noisy one or a
shrunk one (Efron & Morris 1975, *JASA* 70:311-319; Brown 2008, *Annals of Applied
Statistics* 2:113-152, in-season batting averages). Fantasy points are volume times
efficiency, and efficiency (yards per touch, touchdown rate) is the far less stable
half; ffopportunity (Ho & Sydlowski, ffverse, 2021) prices each play's opportunity
from nflfastR play-by-play so xFP strips most of the efficiency noise. The house
weekly result (`docs/TARGET-SPEC.md:110`) says the gain may be small because the two
series are 0.95-correlated.

## Data and split

- Source for both arms and the target: table `nfl_ffopportunity_weekly` (writer
  above). `expected_fantasy_points` = xFP; `actual_fantasy_points` = ffopportunity's
  actual points (its own PPR scoring). Same scoring for both arms and the target.
  Regular season only (week <= 18). A "game played" = a row for that player-week.
- Local copy of the app database (not production), `.local-db/data.sqlite` made
  with `sqlite3 ... ".backup"` on 2026-09-23.
- Seasons: **2021-2024 gated, walk-forward.** Neither primary arm has a fitted
  parameter; every input is weeks 1..t of the same season, strictly before the
  target window. **2025: reported once, not gated, logged in
  `docs/evidence/HOLDOUT-LEDGER.md`** (it is partly spent). 2026: forward check
  (below).
- Cutoffs: t = 3..13 (window t+1..t+5 stays inside week 18).
- Population at (season, t): QB/RB/WR/TE with >= 3 games in weeks 1..t and >= 1
  game in weeks t+1..t+5, and in the position top-N (QB 24, RB 48, WR 60, TE 24) by
  **either** arm (union, so the filter favours neither arm).
- Clusters: player (`player_gsis_id`) across all seasons and cutoffs.

## Arms and target

- Candidate `xfp_ppg` = mean xFP over games played in weeks 1..t.
- Incumbent-as-asked (dumb baseline) `std_ppg` = mean actual points over the same games.
- Primary target: mean actual points per game played in weeks t+1..t+5.
- Secondary target (reported): total actual points in weeks t+1..t+5, missed game = 0.
- Luck (reported, descriptive): `std_ppg - xfp_ppg`.

## Metrics and sign convention

Sign: **candidate minus incumbent.** MAE: negative favours the candidate. Pair
accuracy: positive favours the candidate.

1. MAE diff, `pairedBootstrapDiff(err_std, err_xfp, {seed: 20260923, iterations:
   2000, groups: player})` (`server/services/backtest-significance.js:57`); 90% CI.
2. Same-position pair accuracy: all same-position pairs within (season, t), pairs
   with equal target dropped, a tie in the prediction scores 0.5. Diff 90% CI from a
   player-cluster bootstrap (1,000 draws, seed 20260923), each pair weighted by the
   product of its two players' draw multiplicities (the R&D method in
   `rnd/loop/scripts/r3x_fc_wayback_eval.py`).
3. Reported: all-pairs (cross-position) accuracy, per-season and per-cutoff tables.
4. **Decision grade (rule 6):** the trade decision is "which of two players scores
   more". On same-position pairs where `xfp_ppg` and `std_ppg` order the two players
   differently, the share `xfp_ppg` gets right (0.5 = no better than the dumb
   baseline, which here is "offer fair value by season-to-date PPG").

## Ship rule

- **S1 (primary, the unit's rule)**, pooled 2021-2024: MAE diff 90% CI upper < 0
  **and** same-position pair-accuracy diff 90% CI lower > 0 **and** the MAE point
  estimate favours `xfp_ppg` in >= 3 of 4 seasons.
- **S2 (one producer)**, 2023-2024, t in {4, 6, 8, 10}, rows present in both
  populations: `xfp_ppg` against a walk-forward replay of the served `ros_ppg`
  formula (2023 fitted on 2022, 2024 on 2023, the exact `selectRosStructure`
  procedure of `scripts/fit-ros-projection.mjs`), same next-5 target on the app's PPR
  actuals (`backtest.js#actuals`). Pass iff NOT (MAE diff > 0 with CI excluding 0) and
  NOT (pair-accuracy diff < 0 with CI excluding 0). Reported, not gated: the served
  formula with `xfp_ppg` substituted for season-to-date PPG, same fitted params.
- **Outcomes.** S1 fails: decline, nothing served, decline recorded with MDE. S1
  passes and S2 fails: decline serving a second number; follow-up named (feed xFP into
  `ros-projection.js`). Both pass: build the module and expose it on the trade card
  subject to the forward rule.
- **Forward (rule 5).** 2026 weeks played in `player_week_usage` (writer
  `syncWeeklyUsage`, `server/services/nflverse.js:245`) and in
  `nfl_ffopportunity_weekly`: the test needs t >= 3 and five later weeks. If no such
  2026 cutoff exists, nothing can be confirmed forward, and a pass ships
  **default-off, "unconfirmed forward"**.
- **FantasyCalc (reported, not gated; n = 6 cutoffs).** On the six Wayback snapshots
  used by R&D (2023 W4/W5/W6/W9/W12 superflex, 2024 W2 1QB; RB/WR/TE; files stay local
  in `~/gridiron-local/rnd/loop/data/r3x_fc_wayback/`, only aggregates committed,
  FantasyCalc terms as read by R&D), same-position pair accuracy on rest-of-season
  total PPR (missed game = 0), `xfp_ppg` vs FantasyCalc value vs `std_ppg`.

## Power (rule 4), declared before the run

MDE80 = 1.512 x the 90% CI half-width. Expected half-widths are **guesses**: MAE
diff about 0.10 PPG (from the CI widths in `ros-projection.js:52-58` on similar rows),
so MDE80 about 0.15 PPG; same-position pair accuracy about 0.006 (R&D's half-width
was 0.017 on 29k pairs; this design has several times more pairs), so MDE80 about
0.009. Both are restated from the realised intervals.

## Replay configuration (rule 7)

S1 uses no projection engine (both arms are raw season-to-date means): not
applicable. S2 calls `buildProjections({through, throughWeek, roleRecency:
WEEKLY_ROLE_RECENCY})`, no `kOverride`, and stops if `activeKVectorFor` returns null or
a share k equal to the hardcoded 6 for the predicting season.
