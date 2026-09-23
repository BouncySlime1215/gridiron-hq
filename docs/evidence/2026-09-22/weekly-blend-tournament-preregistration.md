# BLEND-01 pre-registration: blending ESPN's weekly projection into the served weekly number

Unit BLEND-01 (WORK-QUEUE §15; plan item C12 / Structure). Written and committed **before any
number from this test exists**. The runner (`scripts/weekly-blend-tournament.mjs --grade`)
refuses to grade unless this file is committed and unchanged. Evidence file:
`docs/tdd/2026-09-22-weekly-blend-tournament.tdd.md`. Tree: branch
`claude/local-blend-01-weekly-blend-tournament` from `origin/main` `a3e2bf35`.

Rows were assembled (`--assemble`) while this file was written. That mode prints row counts
only and computes no metric; nothing below was chosen after seeing a result.

## 1. Hypothesis

A combination of our served weekly number and ESPN's weekly projection orders same-position
start/sit pairs better than our number alone on 2023-2024, graded walk-forward, and the
direction holds on 2026 week 2. The evidence also says, in one sentence, whether the winner
beats ESPN's projection alone.

## 2. The two inputs

**Ours (`o`).** The number at the one call site, `trade-engine.js:384` `currentWeekPpg` on
`a3e2bf35`, as it will be once S-03 is in (this unit is stacked on S-03, which promotes a
coordinator fit and switches the betting-line lift off):

`o = base x thisGame.mult (1) x active_probability (?? 0.92, trade-engine.js:371)`, and 0 on a bye,

where `base` is S-03's served construction (`fantasy-coordinator.js` `servedWeekConstruction`
on S-03's branch): the structural head plus the coordinator's correction when the promoted fit is
on and the player has coordinator inputs, otherwise the ensemble. History uses walk-forward
coordinator fits (the fit that prices season S has seen seasons ≤ S-1 only, S-02's
`assertFitCutoff`); 2026 uses the fit S-03 promotes (`fantasy_coordinator_fits` id 7, through
2025). Our number for the sensitivity row without the coordinator is the ensemble, `A x p`.

**ESPN (`e`).**
- *Served:* `league_roster_snapshots.projected_points` (writer `scripts/collect-roster-snapshots.mjs:109`
  `writePeriod`, value built at `:92`), for this league and any league with identical scoring,
  the current period's `on_roster = 1` rows. Leagues that disagree by more than 0.01 give no
  value (C-01's rule). No value: ours, labelled `no_espn_value`. No migration.
- *History:* ESPN's own archived weekly projection (public `leaguedefaults/3` view, pulled by the
  R&D loop into `~/gridiron-local/rnd/loop/data/espn_proj_hist/`, never committed). It is the
  same number the app stores: 161/161, 166/166 and 166/166 skill rows of 2026 W1-W3 match
  `league_roster_snapshots` to 0.01 (`r2-external-espn-weekly-projection-history.md` §1). Its
  retained value for a past week is ESPN's last pre-lock number (§2 of that file).
- **Deviation from the unit text, stated plainly:** the unit names FantasyPros ranks as an ESPN
  proxy for fitting candidates 4 and 5. ESPN's own history for 2021-2024 now exists locally, so it
  is used instead. A rank proxy needs a rank-to-points map whose error would bias the very weight
  being fit, and FantasyPros' terms are personal use only. FantasyPros is not read by this unit.
- *Licence:* ESPN's terms are the Disney Terms of Use (personal, non-commercial; checked in r2 §0).
  Same class as every ESPN read the app already makes. Aggregates only are committed.

## 3. The candidates (fixed now)

`e` missing means the candidate returns `o`. A bye is 0 whatever ESPN says. Only QB/RB/WR/TE are
graded, so only they are blended; K and DEF keep ours.

| id | name | served number | fitted | ladder |
|---|---|---|---|---|
| C1 | `ours` | `o` | 0 | 0 |
| C2 | `espn` | `e` | 0 | 1 |
| C3 | `half` | `0.5 o + 0.5 e` | 0 | 1 |
| C7 | `news` | `e` if the late-news trigger fires, else `o` | 0 (one rule) | 2 |
| C4 | `fit_shrunk` | `w o + (1 - w) e` | 1 | 3 |
| C5 | `pos_phase` | `w[pos][phase] o + (1 - w[pos][phase]) e` | 16 | 4 |
| C6 | `espn_proven` | `e + b[pos][phase] (o - e)` | 16 slopes + 16 gates | 5 |

- **C4.** `w_hat` = least squares of the actual on `[o, e]` with weights ≥ 0 summing to 1
  (`forecast-combination.js:159` `constrainedLeastSquares`). Shrunk toward 50/50 with the
  Stock-Watson form the same module uses (`:577` `shrunk_to_equal`):
  `lambda = max(0, min(1, 1 - kappa K / (T - K - 1)))`, `kappa = 1`, `K = 2`, and `w = lambda w_hat + (1 - lambda) 0.5`.
  `T` counts distinct season-weeks (slates), not rows. The module's own rule is that one weekly
  slate is one forecast period (`:27-32`).
- **C5.** The same fit in each position x phase cell. Phases are weeks 2-4, 5-8, 9-13 and 14-18
  (HX-01's week bands; week 1 uses 2-4). `lambda_c` uses the cell's own slates, and the cell weight
  shrinks toward the pooled C4 weight on the same fit rows: `w_c = lambda_c w_hat_c + (1 - lambda_c) w_C4`.
- **C6.** In each cell, `b_hat_c = sum((o - e)(y - e)) / sum((o - e)^2)`, the no-intercept
  encompassing regression of the miss on our disagreement. This is the master plan's Phase-2
  disagreement slope (`docs/FANTASY-ENGINE-MASTER-PLAN.md:847-851`, acceptance at `:850`). A player-clustered bootstrap
  gives its 90% CI (2,000 draws, seed 1). The cell is **proven** iff the CI's lower bound is above
  0. Then `b_c = clamp(b_hat_c, 0, 1)`; otherwise `b_c = 0` (ESPN alone). Whether `b_hat_c` clears
  the plan's 0.3 bar is reported, descriptive only.
- **C7.** Trigger: `e` exists and either `e = 0` while `o > 0` (ESPN has him out), or his week's
  report status matches `/^(out|doubtful)\b/i`. Triggered, the number is `e`; otherwise `o`.
- **Fit rows.** Decision rows (§4) with an ESPN value and `o ≥ 4`, from the fit seasons only.

## 4. Data, split and population

- **History:** 2022-2024, weeks 2-17. Rows are S-02's `eligibleRows` decision rows
  (`scripts/weekly-construction-grade-lib.mjs:99`: QB/RB/WR/TE, at least one played week before,
  played week - 1). A player who then did not play scores 0. Rows need an ESPN archive value. A
  bye is no `game_lines` row for the engine's team that week, and then `o = e = 0`.
- **Walk-forward:** C4-C6 are fit on 2022 and graded on 2023, then fit on 2022-2023 and graded on
  2024. **Every candidate is graded on the same pooled 2023 + 2024 rows.** 2022 is fit-only.
- **Shipping parameters** are refit on 2022-2024.
- **2025 is not opened.** It is the used-up holdout (STATS-METHOD rule 2). The runner refuses it,
  and ESPN's 2025 file was never pulled.
- **Forward: 2026 week 2.** It is the only played 2026 week with decision rows (week 1 has no
  prior week).
  - *Primary:* `o` is today's served construction replayed for week 2 (fit-2 weekly weights,
    coordinator fit 7, week-2 availability). `e` is ESPN's settled value from
    `league_roster_snapshots` 'final' rows (rostered players, one value per player-week). These
    are the players the served blend would act on.
  - *Sensitivities, reported with no rule attached:* (i) `e` = the ESPN archive (every player,
    the same number); (ii) `e` = ESPN's Thursday capture (`espn_player_market_weekly`, 22:08Z,
    which has no writer in the repo); (iii) `o` = the snapshot the app captured Thursday at
    18:56Z (`weekly_prediction_snapshots`, writer `server/services/weekly-learning.js:49`: the
    ensemble on frozen-2023 weights) x p.
- **Replay configuration B.** `buildPlayerWeekEngine` has `roleRecency` `WEEKLY_ROLE_RECENCY`
  hardcoded at `player-week-engine.js:273`, and `kOverride` is omitted. The k control (S-02
  `assertKControl`) stops the run if `target_share.ALL` is missing or 6.

## 5. Metrics and sign convention

- **Universe (primary).** Pairs of rows in the same season, week and position where C1 (ours)
  projects both players ≥ 4: the start/sit calls the app poses today. Every candidate is scored on
  this one pair set.
- **Pair accuracy (primary).** Scored as `startSitPairAccuracy` scores it
  (`scripts/promote-early-week-weights.mjs:153`): 1 when the higher-projected player scored more,
  0 when not, 0.5 when projections or actuals tie. Differences are candidate − reference, so
  **positive favours the candidate.**
- **Decision grade.** Only the pairs where candidate and reference order the two players
  differently count (a tie in either projection is not a disagreement).
  - Win rate: the share where the candidate's pick scored more, with ties 0.5.
  - Points per decision: the mean of actual(candidate's pick) − actual(reference's pick).
  - Positive favours the candidate.
- **Intervals.** 90% percentile intervals from a player (vertex) pigeonhole bootstrap (Owen 2007):
  players are resampled with replacement, and a pair counts `m_i x m_j` times. 2,000 draws, seed 1.
  `MDE80 = 2.487 x SE`, with `SE` = interval width / 3.29 (S-02 `mde80`, STATS-METHOD rule 4).
- **Secondary, reported with no rule attached:**
  - the house universe (every candidate projects both ≥ 4);
  - played-only rows;
  - MAE on decision rows and on played rows;
  - mean signed error (candidate − actual);
  - the level gap, mean(e − o).
- Every candidate is reported against C1 (ours) and against C2 (ESPN alone).

## 6. Selection rule (history, pooled 2023 + 2024)

1. **good(X)**: the pair-accuracy difference X − C1 is above 0, and its CI's lower bound is above 0.
2. If no candidate is good, the winner is C1 and nothing ships.
3. **Ladder** (fewest fitted parameters first): C1 < C2 = C3 < C7 < C4 < C5 < C6. The champion is
   the first good candidate on the ladder. On an equal rung, the higher pair accuracy wins.
4. **Complexity rule.** Going up the ladder, a more complex good candidate X replaces the champion
   only if PA(X) − PA(champion) is greater than the MDE80 of that paired difference.
5. **Late-news layer.** If the winner is C3, C4, C5 or C6 and C7 is good, the layer is tested:
   "winner + switch" (the trigger fires → `e`, else the winner). It replaces the winner only if its
   difference over the winner is greater than that difference's MDE80.

## 7. Ship rule

The winner ships **ON** only when all three hold:

- **(a)** it is not C1 and it is good (§6);
- **(b)** its history points per decision against C1 are above 0;
- **(c)** it **holds forward** on 2026 week 2, primary rows: the pair-accuracy difference against
  C1 is above 0, and the points per decision against C1 are above 0. This is STATS-METHOD rule 5's
  "holds": the same sign as history, and with a positive point estimate the interval cannot exclude
  zero in the harmful direction. The forward n and MDE80 are printed next to it.

Outcomes:

- (c) fails: the module ships **default-off**, labelled **"unconfirmed forward"**, and the served
  number is ours.
- (a) or (b) fails: the unit is **declined**, and the served number is unchanged.
- **Beats ESPN alone** is stated in one sentence either way: the winner against C2 on history
  (difference, CI, points per decision) and forward.
- If the winner is C2, the served number becomes ESPN's projection wherever it exists, and the
  evidence says so plainly.

## 8. Power, declared before the run

Planning numbers come from HX-01's local `--full` output: 2022-2024, the house universe, ours
against FantasyPros. That file is not committed, so these are **a guess** at this design's SE.

| Window | SE of pair-accuracy difference | SE of points per decision | MDE80, pair accuracy | MDE80, points |
|---|---|---|---|---|
| 3 seasons (HX-01 measured) | 0.0037 | 0.231 pts | — | — |
| 2 seasons (scaled by √(3/2)) | about 0.0045 | about 0.28 pts | about 0.011 | about 0.70 pts |
| 2026 week 2 | about 0.030 | about 1.10 pts | about 0.075 | about 2.7 pts |

One week can confirm a direction at best.

## 9. The grade grades the served code

The candidates are computed by `server/services/weekly-blend.js`'s own functions, which the study
imports. The served ESPN reader and the late-news trigger are the ones graded. After S-03 is
merged, `--assemble` stops if the runner's rebuilt base differs from S-03's
`servedWeekConstruction` on any forward row.

## 10. Literature

- Bates and Granger (1969, *Operational Research Quarterly* 20:451-468) showed that combining two
  forecasts whose errors are not perfectly correlated can beat both.
- Clemen (1989, *IJF* 5:559-583), Stock and Watson (2004, *J. Forecasting* 23:405-430) and Smith
  and Wallis (2009, *Oxford Bull. Econ. Stat.* 71:331-355) found that estimated weights often lose
  to equal weights out of sample (the forecast combination puzzle). That is why C3 is a first-class
  candidate, why C4 is shrunk toward 50/50, and why fitted parameters must pay an MDE.
- Fair and Shiller (1990, *AER* 80:375-389) and Harvey, Leybourne and Newbold (1998, *JBES*
  16:254-259) test whether one forecast carries information another lacks by regressing the
  outcome on the disagreement: C6's gate.
- Owen (2007, *Ann. Appl. Stat.* 1:386-411) gives the pigeonhole bootstrap for statistics over
  pairs that share units.

## 11. Stop conditions

- The k control fails for any graded season.
- A team code is unknown to `game_lines`, or a bye appears in weeks 2-4 (no team had one then).
- A fit is past its cutoff.
- 2025 is requested.
- This file is uncommitted or dirty at `--grade`.
- Pair accuracy from the runner's own pair enumeration differs from `startSitPairAccuracy`'s on the
  same rows by more than 1e-9.
- After S-03 is merged, the rebuilt base differs from `servedWeekConstruction`.

## 12. Known limits, declared now

- **Timing.** ESPN's archived value is its last pre-lock number, so it knows about Sunday
  inactives; ours uses the Friday report. The served blend reads ESPN's latest value too, so that
  timing is part of what is served, but only when the refresh loop runs close to lock. The
  played-only secondary separates skill from timing.
- **Ensemble weights.** 2022-2024 are replayed on `frozen-2023`, because `activeWeeklyWeightSet`
  has no earlier fit. Those weights may have seen the graded seasons. That favours ours, which is
  conservative for "a blend beats ours".
- **Availability rates.** The chance-to-play rates (`nfl_availability_rates`) were fit once and may
  include the graded seasons.
- **2021 examples.** The coordinator examples for 2021 were built with the hand-set k, since no fit
  can end before 2021 (HX-01's note).
- **Coverage.** In production, only players rostered in Nick's leagues have an ESPN value. Free
  agents fall back to ours, so the waiver board mixes two bases. The level gap in §5 sizes that.
