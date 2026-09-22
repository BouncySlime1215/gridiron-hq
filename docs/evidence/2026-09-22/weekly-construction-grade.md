# S-02 result: grade of the served weekly construction

**Local copy, not production.** A `sqlite3 .backup` of `~/gridiron-local/data.sqlite` taken
2026-09-22 16:18 local. Pre-registration: `weekly-construction-grade-preregistration.md`
(commit `dd4d2055`, before any number), and **amendment 1**
(`weekly-construction-grade-preregistration-amendment-1.md`, commit `8c241cb4`, after the audits
and before any new number). Full output: `weekly-construction-grade-output.json`. Numbers in
sections 3-9 were produced by `scripts/weekly-construction-grade.mjs --full` at commit `4cdfbe12`
(tree `a8585493`). The claims audit's reproduction on `0f397736` reproduced every block of that
output (section 10). Sections 6b and 9a are amendment 1's report-only diagnostics.

## 1. The answer

**Read this first.** Every verdict below grades the weekly construction **before availability
and the game factor**. The number Start/Sit shows is
`round2(B × thisGame.mult × active_probability × lift)` (trade-engine.js:346, :359;
lineup-brain.js:356-363). On this copy that last factor is large: the page's number is a median
0.61 of arm D, and the weekly starter proxy's mean page number is 0.69 of its mean arm D
(section 9a). An MAE verdict
between arms that differ mainly by level can flip once p multiplies them (amendment 1 §1, §4).
**So S-03 must not remove the lift, move the coordinator to another base or change its level
on these verdicts.** The decision grade for S-03 is the served-chain grade, run jointly with
S-04 (availability) and A-11 (level target) (amendment 1 §4).

On the pre-availability construction:

1. **The betting-line lift does not improve accuracy.** In weeks 2-4 it makes the number
   significantly worse. In weeks 5-17 it does not help, and it is worse once DNPs are counted.
   It fails the rule. It wins slightly on start/sit calls (section 5), a ranking effect that the
   MAE rule does not reward.
2. **Every coordinator arm passes**: served (B), served with lift (D), structural base (S1) and
   the ensemble-residual refit (S2). By the rule's tie-break the winner is **S1** in both
   windows: the correction added to the structural head, which is PR #57's construction. The
   2026 week-2 forward check holds on this basis.
3. **All of the coordinator's gain is a level shift.** It moves almost every number down by
   about the same amount (the fit's intercept is −0.51; population signed error +0.011 → −0.612). It changes 2 of
   67,943 start/sit pairs in weeks 5-17. In weeks 5-17, S1 beats B by 0.0007 MAE, while the
   smallest effect detectable against A is 0.024 (B) to 0.036 (S1), so the rule's choice of S1
   over B is not a measured difference.
4. **The population mean is not the lineup level.** The population mean sits near zero (A) or
   below it (B) because projections under 10 points read low. The weekly starter proxy reads **high**, given
   that he plays, under the ensemble in 2025 (+1.01 [+0.63, +1.40]) and near zero in 2024
   (+0.23 [−0.19, +0.65]). The coordinator's shift moves starters toward zero in 2025 (B +0.39)
   and past it in 2024 (B −0.44). Section 6b. The earlier "a nine-starter lineup would read
   3.7 to 5.5 points low" was not measured. It is withdrawn.

Sign conventions: ΔMAE = MAE(arm) − MAE(A), negative = arm better. Signed error =
prediction − actual, negative = reads low. ΔSpearman positive = arm better. Win rate − 0.5
positive = the arm's start/sit calls beat "start the higher A projection".

## 2. The arms (prereg §3)

A = the ensemble (`proj.ppg`). B = A + coordinator (served form). C = A × lift. D = B × lift:
**the served construction before availability and the game factor, with the lift keyed on the
engine's team** (the page keys it on `players.team_abbr`; 56 of 522 playing assets differ on this
copy's week 3, section 9a). S1 = structural + coordinator. S2 = A + a coordinator refit on the
ensemble residual. S3 = A × lift^λ, with λ chosen on 2024: weeks 2-4 λ = 1 (so S3 = C), weeks
5-17 λ = 0 (so S3 = A).

## 3. 2025 held out, weeks 5-17 (4,185 played rows, 4,333 decision rows)

| Arm | MAE | Signed error | Spearman | DNP-incl. MAE | ΔMAE vs A [90% CI] | MDE80 | ΔDNP [90% CI] | Rule |
|---|---|---|---|---|---|---|---|---|
| A | 4.3270 | +0.011 | 0.6951 | 4.7312 | — | — | — | — |
| B | 4.2563 | −0.612 | 0.6951 | 4.5583 | −0.0704 [−0.0862, −0.0540] | 0.024 | −0.1729 [−0.1893, −0.1569] | pass |
| C | 4.3364 | +0.103 | 0.6954 | 4.7435 | +0.0093 [−0.0009, +0.0193] | 0.015 | +0.0122 [+0.0022, +0.0220] | **fail** |
| D | 4.2573 | −0.526 | 0.6954 | 4.5634 | −0.0695 [−0.0864, −0.0532] | 0.025 | −0.1678 [−0.1844, −0.1511] | pass |
| S1 | 4.2556 | −0.413 | 0.6948 | 4.6058 | −0.0713 [−0.0947, −0.0466] | 0.036 | −0.1252 [−0.1487, −0.1014] | pass |
| S2 | 4.2635 | −0.427 | 0.6951 | 4.5955 | −0.0634 [−0.0746, −0.0520] | 0.017 | −0.1357 [−0.1470, −0.1247] | pass |
| S3 | = A (λ = 0) | | | | 0 | 0 | 0 | fail |

Marginals (report-only): lift given coordinator, D vs B: +0.0009 [−0.0083, +0.0101].
Coordinator given lift, D vs C: −0.0788 [−0.0953, −0.0623].

C's decline: its MDE at 80% power is 0.015 points, 0.35% of A's MAE. An effect that size would
have been detected. "No gain" here is measured, not underpowered.

## 4. 2025 held out, weeks 2-4 (969 played rows, 1,071 decision rows)

| Arm | MAE | ΔMAE vs A [90% CI] | MDE80 | ΔSpearman | ΔDNP [90% CI] | Rule |
|---|---|---|---|---|---|---|
| A | 4.4532 | — | — | — | — | — |
| B | 4.3680 | −0.0850 [−0.1144, −0.0565] | 0.044 | −0.0001 | −0.1502 [−0.1799, −0.1205] | pass |
| C | 4.4835 | **+0.0300 [+0.0137, +0.0465]** | 0.025 | +0.0002 | +0.0312 [+0.0159, +0.0463] | **fail (worse)** |
| D | 4.3860 | −0.0671 [−0.0969, −0.0381] | 0.044 | +0.0002 | −0.1304 [−0.1605, −0.1011] | pass |
| S1 | 4.1913 | −0.2611 [−0.3419, −0.1788] | 0.123 | +0.0232 | −0.2353 [−0.3114, −0.1591] | pass |
| S2 | 4.3773 | −0.0757 [−0.0967, −0.0551] | 0.031 | +0.0000 | −0.1234 [−0.1444, −0.1022] | pass |
| S3 | = C (λ = 1) | +0.0300 | | | | fail |

S1's large win in weeks 2-4 is mostly the structural head beating the frozen ensemble on 1-3
games, which fit-2's early rule already serves on the copy. With the base pinned to that rule
(section 7), S1 and B are the same number.

## 5. Start/sit decisions (Nick's rule d)

Common pair set: same week and position, every arm projects both players at 4 or more,
DNP = 0. Win rate counts only the pairs where the arm and A disagree. Pre-availability basis:
the page's p differs by player (it prices injury designations), so it can reorder real calls,
and these metrics do not include it.

| | Weeks 5-17 | Weeks 2-4 |
|---|---|---|
| Pairs | 67,943 | 18,023 |
| Pair accuracy A / B / C / D / S1 | 0.6281 / 0.6282 / 0.6302 / 0.6302 / 0.6307 | 0.6348 / 0.6349 / 0.6355 / 0.6355 / 0.6425 |
| B: disagreements with A | 2 | 1 |
| C: win rate on 1,851 / 354 disagreements | **0.537**, rate − 0.5 [+0.005, +0.070] | 0.521 [−0.038, +0.086] |
| D: win rate on 1,739 / 328 | 0.539 [+0.005, +0.072] | 0.523 [−0.037, +0.086] |
| S1: win rate on 5,022 / 2,180 | 0.518 [−0.008, +0.043] | 0.532 [−0.018, +0.081] |

- The coordinator changes no start/sit call. Its effect is on the level of the number.
  What that level is for the players a lineup starts is section 6b, not the population mean.
- The lift fails on error but wins slightly on calls in weeks 5-17: when it disagrees with A,
  it is right 53.7% of the time and A 46.3%. A mean-preserving lift (ranking only) is an
  untested idea that needs its own pre-registration.

By position, weeks 5-17, ΔMAE of C vs A (report-only): RB −0.018 [−0.034, −0.002] (helps),
WR +0.028 [+0.012, +0.044] (hurts), TE +0.012 [−0.005, +0.029], QB +0.002 [−0.040, +0.044].
The hand-set RB split is the only part that helps.

## 6. m0 (defined jointly with WQ A-11, prereg §8)

`m0 = predictionWeightedMedianRatio(pred, actual)` (level-information-decomposition.js:41) over
the arm's 2024 played rows in the window, applied to 2025 as a diagnostic.

| Window | m0(A) from 2024 | 2025 headroom of A × m0 | Coordinator B's gain |
|---|---|---|---|
| 5-17 | 0.8991 | 0.0882 | 0.0704 |
| 2-4 | 0.8808 | 0.1770 | 0.0850 |

m0 < 1 means the ensemble sits above the median outcome. A median-level correction lowers MAE
and moves the population mean error negative, the same trade the coordinator makes. The
headroom has no interval; A-11 grades it with one. m0 is defined on the pre-availability
number. Applied to the page number it would stack a second level cut on the one p already
makes, so A-11 must set its level target on the number after availability (amendment 1 §4).

### 6a. Reconciliation with the level baselines already on record

| Source | Predictor | Weights | Season / split | Window | Population | Value |
|---|---|---|---|---|---|---|
| weekly-ensemble.js:86-88 | not stated at the source (guess: the replay) | "promoted weights" | 2021-2025, each | not stated | not stated | mean signed error −0.26 / −0.17 / −0.31 / −0.58 / −0.32 |
| R25-LEVEL-VS-INFORMATION-RESULTS.md:45-46 | replay (`replaySeasonWeekly`, R37 rider) | shipped `WEEKLY_ENSEMBLE_WEIGHTS` | 2023 bias split | weeks 5-18 | n = 4,389 | m0 = 0.9126 |
| same file :48-49, 2024 | replay | shipped | 2024 | weeks 5-18 | n = 4,419 | signed error −0.52 (recorded there as actual − pred +0.5201) |
| S-02 (this unit) | live engine (`buildPlayerWeekEngine`) | `frozen-2023` = `WEEKLY_ENSEMBLE_WEIGHTS` (weekly-weight-store.js:69) | 2024 fit split | weeks 5-17 | played rows, ≥ 1 prior played week (4,082) | signed error −0.205 [−0.358, −0.042]; m0 = 0.8991 |
| S-02 | same | same | 2025 held out | weeks 5-17 | same rules (4,185) | signed error +0.011 [−0.138, +0.156] |

Same weights, so the gap is predictor, window and population. In the two seasons both sources
cover, the engine reads about 0.3 points higher than the replay (2024: −0.21 against −0.52 and
−0.58; 2025: +0.01 against −0.32). The cause is a **guess**, not measured here: the live engine
reads 23 tables and the replay 4 (R25 pre-registration :40-42). `replaySeasonWeekly` was not
run in this unit. **A-11 starts from the engine value** (m0 = 0.8991 on 2024 weeks 5-17),
because the engine is the served path and the replay's equivalence to it is unestablished (R37).
But the level A-11 targets must be set on the post-availability number.

The accept-list entry for `level-information-decomposition.js` (docs/wiring/annotations.json:117)
says it is "imported only by scripts/r25-level-vs-information.mjs". S-02's library is now a
second importer, and the entry's retirement condition is keyed to the replay band above.
That file belongs to the Fantasy plan thread (rule 9). The stale text is reported to it, not
edited here.

### 6b. Level by projection band (amendment 1 §3.2, report-only)

Mean signed error (prediction − actual), player-clustered 90% CI. "Starters" = each week's top
QB 12 / RB 30 / WR 36 / TE 12 by A among that week's graded rows. "Played" = level given he
plays. "Decision" = DNP counted as 0, the level a lineup total carries **before availability**
(no arm has a chance-to-play term). Rows: the claims audit's dump from its reproduction run
(section 10). The reproduction stop passed for both seasons: every arm's `n_played`,
`n_decision`, `mae` and `signed_error` in both 2025 windows, and A's λ = 0 MAE and m0 of arms
A-S2 in both 2024 windows, match the committed output to 4 decimal places.

2025 held out, weeks 5-17:

| Row set | n | A | B | C | D | S1 | S2 |
|---|---|---|---|---|---|---|---|
| Played, all | 4,185 | +0.011 [−0.138, +0.156] | −0.612 [−0.761, −0.467] | +0.103 | −0.526 | −0.413 | −0.427 |
| Played, A ≥ 10 | 1,305 | +0.809 [+0.469, +1.156] | +0.188 [−0.152, +0.534] | +1.037 | +0.407 | +0.040 | +0.371 |
| Played, A < 10 | 2,880 | −0.350 [−0.503, −0.203] | −0.974 [−1.127, −0.826] | −0.321 | −0.949 | −0.619 | −0.788 |
| Starters, played | 1,041 | +1.014 [+0.631, +1.401] | +0.392 [+0.010, +0.780] | +1.268 | +0.637 [+0.261, +1.039] | +0.153 [−0.236, +0.561] | +0.576 |
| Starters, decision | 1,050 | +2.720 [+2.337, +3.126] | +2.099 [+1.716, +2.505] | +2.939 | +2.309 | +1.866 | +2.282 |

2024 fit split, weeks 5-17:

| Row set | n | A | B | D | S1 |
|---|---|---|---|---|---|
| Played, all | 4,082 | −0.205 [−0.358, −0.042] | −0.873 [−1.026, −0.710] | −0.786 | −0.699 |
| Played, A ≥ 10 | 1,353 | +0.087 [−0.296, +0.455] | −0.580 [−0.962, −0.212] | −0.374 | −0.783 |
| Starters, played | 1,041 | +0.225 [−0.189, +0.645] | −0.441 [−0.855, −0.021] | −0.201 [−0.601, +0.216] | −0.826 [−1.277, −0.383] |
| Starters, decision | 1,051 | +1.930 [+1.506, +2.357] | +1.264 [+0.839, +1.691] | +1.470 | +0.896 |

Weeks 2-4 are in `weekly-construction-level-bands-2025.json` / `-2024.json`: 2025 starters,
played: A +2.229, B +1.610, S1 +0.659; 2024: A +1.477, B +0.813, S1 −0.460.

What this says:

- Projections under 10 points read low (A −0.35 in both seasons) and pull the population mean
  down. For projections of 10 or more, and for the starter proxy, the ensemble reads **high** in
  2025 and near zero in 2024.
- For starters, given that they play, the coordinator's shift leaves them still high in 2025
  (B +0.39 [+0.01, +0.78]) and low in 2024 (B −0.44 [−0.86, −0.02]). The sign of the starters' level is season-dependent, so no
  single "reads low" or "reads high" figure carries between seasons.
- With DNPs counted, every arm reads 0.9 to 2.9 points high per starter-week in weeks 5-17
  (both seasons), because no arm prices the chance he does not play. The page's p exists for that. How far p over- or
  under-corrects on starters is **not measured**: it needs p on historical rows, which is
  amendment 1 §4's joint grade. Section 9a shows the size of p on this copy's week 3.

## 7. Sensitivity: base pinned to the copy's served 2026 set (fit-2), report-only

| Window | Base | B | C | D | S1 | S2 |
|---|---|---|---|---|---|---|
| 2-4 | fit-2 early rule (structural for 1-3 games); A MAE 4.3175 | −0.126 pass | +0.012 fail | −0.122 pass | −0.126 pass | −0.099 pass |
| 5-17 | fit-2 vector, **in-sample for 2025**; A MAE 4.3422 | −0.025 pass | +0.012 fail | −0.019 pass | −0.087 pass | −0.031 pass |

The lift fails on both bases. The coordinator passes on both.

## 8. Forward: 2026 week 2 (304 played rows, 360 decision rows)

The copy serves the structural head in week 2 (fit-2 early rule), so A = structural there and
S1 = B.

| Arm | ΔMAE vs A [90% CI] | ΔDNP |
|---|---|---|
| B = S1 | −0.135 [−0.191, −0.079] | −0.207 |
| C | −0.026 [−0.064, +0.011] | −0.016 |
| D | −0.160 [−0.220, −0.096] | −0.223 |
| S2 | −0.103 [−0.141, −0.062] | −0.155 |

Forward check for the winner S1, on the pre-availability basis: both point estimates ≤ 0.
It is not a served-chain verdict (section 1). For weeks 5-17 it is a proxy (no 2026 week 5-17
rows exist), and it cannot separate S1 from B. S-03 re-runs `--forward-only` after week 4.

Equivalence of later commits: `--forward-only` on `9eed700d` reproduced this section's numbers
(TDD evidence file, section 5a).

## 9. Fits

| Fit | Rows | Intercept | ensemble_shift k | game_script k | Cutoff |
|---|---|---|---|---|---|
| structural residual, 2022-2023 | 11,513 | −0.567 | 0.095 | 0.055 | 2024 rows |
| structural residual, 2022-2024 | 17,340 | −0.508 | 0.090 | 0.048 | 2025 grade |
| ensemble residual, 2022-2024 | 17,340 | −0.392 | 0 | 0.023 | 2025 grade (S2) |
| served (id 7, through 2025) | 23,334 | −0.555 | 0.066 | 0.041 | 2026 forward |

- The served refit function on 2022-2025 of this copy reproduces stored fit 7 exactly (max
  coefficient difference 0).
- `boom_bust_signal` shrinks to 0 in every fit.
- Refit on the ensemble residual, `ensemble_shift` also shrinks to 0. What remains is the
  intercept plus a small game-script term.
- Examples per season: 5,749 / 5,764 / 5,827 / 5,994 rows, all 18 weeks present (no week was
  skipped by fantasy-coordinator.js:305).

## 9a. The page's number against the arms, 2026 week 3 (amendment 1 §3.1, report-only)

`scripts/weekly-construction-grade.mjs --consumer-parity` on commit `9b541006`
(tree `cf32a7da`), same copy. Output: `weekly-construction-consumer-parity.json`. Week 3 has no
actuals, so this is a decomposition, not a grade. `assetUniverse` ran on a synthetic 12-team
PPR league object, so no `leagues` row was read.

- **Identity holds on every asset.** 1,196 QB/RB/WR/TE assets have an engine projection and a
  coordinator correction. On all 1,196 the served `fantasy_coordinator.corrected_ppg` equals the
  study's arm B, and `current_week_ppg` equals `+(B × thisGame.mult × active_probability).toFixed(2)`
  (0 when there is no game). The check stops on the first miss; it did not stop.
- 674 of the 1,196 have no game this week because they have no team (`players.team_id` NULL).
  None has a bye: all 32 teams play in week 3 on the copy, while weeks 5-8 have 30, 28, 28 and 28
  (control, `game_lines`). Of 364 skill players with a 2026 week-2 usage row, 6 have no team.
- On the 522 playing assets, the page's week number differs from `round2(arm D)` on 521.
  `thisGame.mult` is 1 on every one, so the gap is p (and the team key on 56 of them).
  Page / arm D: q10 0.263, q25 0.431, **median 0.610**, q75 0.748, q90 0.831.
- `active_probability` on playing assets: median 0.607. For the 492 with no injury status:
  median 0.630, and **85.6% sit exactly at their durability prior**. The availability basis is
  `pooled` (`nfl_availability_role_rates` missing). contingency.js:697-698 records that healthy
  starters actually played 94.5% of the time while this path said 0.708.
- **Starter proxy** (top QB 12 / RB 30 / WR 36 / TE 12 by arm D, n = 90): mean arm D 14.564,
  mean page number 10.035, median p 0.746. On this copy, availability takes about 4.5 points
  off the average starter-week before the page shows it: far more than the coordinator's 0.6.

## 10. Holdout looks

No `docs/evidence/HOLDOUT-LEDGER.md` on origin/main, so the looks are recorded here.

| Unit | Date (UTC) | Hypothesis | Metric | Result |
|---|---|---|---|---|
| S-02 | 2026-09-22 ~20:36 | (run 1) | — | Stopped at the example build to add the context cutoff guard. No 2025 row was graded. Not a look. |
| S-02 | 2026-09-22 20:45:17 | Each of coordinator / lift / both / S1 / S2 / S3 beats the ensemble on 2025 weeks 2-4 and 5-17 | ΔMAE player-clustered 90% CI, ΔSpearman, ΔDNP-MAE (matchups.js:33-35) | B, D, S1, S2 pass in both windows. C and S3 fail. Winner S1. Pre-availability basis (amendment 1). |
| S-02 claims audit | 2026-09-22 21:02:18 | Reproduction of the 20:45 look (the runner at `0f397736` plus three row-dump lines), plus the audit's own signed error by band | Same as the 20:45 look | Reproduced: `held_out`, `fit_split`, `forward`, `decisions` identical to the committed output; `fits` identical except the `through` field added by `7ef8bc44`. |
| S-02 (amendment 1 §3.2) | 2026-09-22 21:28:22 | Descriptive: level by projection band and starter proxy, on the audit's dumped rows | Mean signed error, player-clustered 90% CI | Section 6b. No rule, no decision. |

2025 had already been the test season for several earlier units (STRUCTURE-MAP M13).

## 11. Commands

```
sqlite3 ~/gridiron-local/data.sqlite ".backup '<wt>/.local-db/data.sqlite'"
GRIDIRON_DB_PATH=<wt>/.local-db/data.sqlite SCHEDULER_DISABLED=1 NFL_SEASON=2026 \
  node --max-old-space-size=3072 scripts/weekly-construction-grade.mjs --full
# S-03, after 2026 week 4 (never reopens 2025):
... scripts/weekly-construction-grade.mjs --forward-only \
  --lambda-from docs/evidence/2026-09-22/weekly-construction-grade-output.json --out <file>
# Amendment 1 §3.1, the copy's current week:
... scripts/weekly-construction-grade.mjs --consumer-parity \
  --out docs/evidence/2026-09-22/weekly-construction-consumer-parity.json
# Amendment 1 §3.2, on dumped rows (--rows-dir writes them; the files are not committed):
GRIDIRON_DB_PATH=<copy> SCHEDULER_DISABLED=1 node scripts/weekly-construction-level-bands.mjs \
  --season 2025 --rows <rows-2025.ndjson> --out docs/evidence/2026-09-22/weekly-construction-level-bands-2025.json
```

Configuration: `buildPlayerWeekEngine` (live path), `WEEKLY_ROLE_RECENCY`, no `kOverride`.
k control passed: target_share k = 0.2747 / 0.2086 / 0.1733 for predicting 2024 / 2025 / 2026,
not 6. Weight sets: 2022-2025 `frozen-2023` (= `WEEKLY_ENSEMBLE_WEIGHTS`), 2026 fit-2. PPR.
No availability term and no game factor in the arms. Run-time parity: on every graded row
(12,489 in the 2024 fit split and 2025), `round2(D)` equals `startSitWeekPoints` given B as
`current_week_ppg`. That checks **the lift step only**, not the page number: the page multiplies
B by `thisGame.mult × active_probability` first (section 9a). On the 360 forward rows, B also
equals `weeklyProjectionFor`.

Rows files used for section 6b (claims audit dump, not committed): `rows-held.ndjson` sha256
`476309e9…88b9` (6,336 rows), `rows-split.ndjson` sha256 `e8f6fa01…b05f` (6,153 rows).

## 12. What would make this wrong

- **Availability.** The verdicts are on the construction before availability. On this copy
  p is the pooled path and takes about 31% off the average starter-week (section 9a). S-04
  changes p; A-11 sets the level target on the number after p. The decision grade is amendment 1
  §4, not this file.
- **The level target.** The rule scores MAE, which rewards the median. The coordinator passes as
  a pure level shift. Whether that shift helps what the page shows depends on p's level and on
  whether served numbers should aim at the median or the mean (A-11).
- Local copy, not production. Production may serve different weekly weights.
- PPR for every arm, not each league's scoring.
- The lift reads the engine's team at the cutoff, not `players.team_abbr`.
- The forward check is one week, in the weeks 2-4 regime.
- Multiplicity: 12 tests. The 8 passes have CIs far from 0 (B's upper bound in weeks 5-17 is
  −0.054), well beyond the ~0.6 false passes expected by chance.
