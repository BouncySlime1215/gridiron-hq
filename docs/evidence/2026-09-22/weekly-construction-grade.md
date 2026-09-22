# S-02 result: grade of the served weekly construction

**Local copy, not production.** A `sqlite3 .backup` of `~/gridiron-local/data.sqlite` taken
2026-09-22 16:18 local. Pre-registration: `weekly-construction-grade-preregistration.md`
(commit `dd4d2055`, before any number). Full output: `weekly-construction-grade-output.json`.
Numbers produced by `scripts/weekly-construction-grade.mjs --full` at commit `4cdfbe12`
(tree `a8585493`). Later commits change no number (section 8).

## 1. The answer

1. **The betting-line lift fails.** In weeks 2-4 it makes the number significantly worse. In
   weeks 5-17 it does not help, and it is worse once DNPs are counted. By the rule, the lift goes off.
2. **Every coordinator arm passes**: served (B), served with lift (D), structural base (S1) and
   the ensemble-residual refit (S2). The pre-registered winner is **S1** in both windows: the
   correction added to the structural head, which is the construction PR #57 proposes. The 2026
   week-2 forward check holds.
3. **Read point 2 with this caveat.** All of the coordinator's gain is a level shift. It moves
   every number down about 0.62 points (the fit's intercept is −0.51). It changes 2 of 67,943
   start/sit pairs in weeks 5-17. A plain level correction (A-11's m0, a diagnostic with no
   interval) would cut MAE more on the same rows: 0.088, against the coordinator's 0.070. In weeks 5-17, S1 beats B by 0.0007 MAE,
   while the smallest effect detectable against A is 0.024 (B) to 0.036 (S1). So the rule's
   choice of S1 over B is not a measured difference.

Sign conventions: ΔMAE = MAE(arm) − MAE(A), negative = arm better. Signed error =
prediction − actual. ΔSpearman positive = arm better. Win rate − 0.5 positive = the arm's
start/sit calls beat "start the higher m0 projection".

## 2. The arms (prereg §3)

A = the ensemble (`proj.ppg`). B = A + coordinator (served form). C = A × lift. D = B × lift
(Start/Sit today). S1 = structural + coordinator. S2 = A + a coordinator refit on the ensemble
residual. S3 = A × lift^λ, with λ chosen on 2024: weeks 2-4 λ = 1 (so S3 = C), weeks 5-17
λ = 0 (so S3 = A).

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
DNP = 0. Win rate counts only the pairs where the arm and A disagree.

| | Weeks 5-17 | Weeks 2-4 |
|---|---|---|
| Pairs | 67,943 | 18,023 |
| Pair accuracy A / B / C / D / S1 | 0.6281 / 0.6282 / 0.6302 / 0.6302 / 0.6307 | 0.6348 / 0.6349 / 0.6355 / 0.6355 / 0.6425 |
| B: disagreements with A | 2 | 1 |
| C: win rate on 1,851 / 354 disagreements | **0.537**, rate − 0.5 [+0.005, +0.070] | 0.521 [−0.038, +0.086] |
| D: win rate on 1,739 / 328 | 0.539 [+0.005, +0.072] | 0.523 [−0.037, +0.086] |
| S1: win rate on 5,022 / 2,180 | 0.518 [−0.008, +0.043] | 0.532 [−0.018, +0.081] |

- The coordinator changes no start/sit call. Its effect is on the level of the number, which
  matters for anything that adds numbers up (lineup totals, trade deltas).
- The lift fails on error but wins slightly on calls in weeks 5-17: when it disagrees with m0,
  it is right 53.7% of the time and m0 46.3%. The pre-registered rule is on error, so the lift
  is off. A mean-preserving lift (ranking only) is an untested idea that
  needs its own pre-registration.

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
and makes the mean error negative, the same trade the coordinator makes. m0(A) = 0.8991 is
A-11's starting value. The headroom has no interval; A-11 grades it with one.

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

Forward verdict for the winner S1: **on** (both point estimates ≤ 0). For weeks 5-17 this is a
proxy (no 2026 week 5-17 rows exist), and it cannot separate S1 from B. S-03 re-runs
`--forward-only` after week 4.

Equivalence of later commits: `--forward-only` on the final head reproduces this section's
numbers (see the TDD evidence file).

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

## 10. Holdout looks

No `docs/evidence/HOLDOUT-LEDGER.md` on origin/main, so the looks are recorded here.

| Unit | Date (UTC) | Hypothesis | Metric | Result |
|---|---|---|---|---|
| S-02 | 2026-09-22 ~20:36 | (run 1) | — | Stopped at the example build to add the context cutoff guard. No 2025 row was graded. Not a look. |
| S-02 | 2026-09-22 20:45:17 | Each of coordinator / lift / both / S1 / S2 / S3 beats the ensemble on 2025 weeks 2-4 and 5-17 | ΔMAE player-clustered 90% CI, ΔSpearman, ΔDNP-MAE (matchups.js:33-35) | B, D, S1, S2 pass in both windows. C and S3 fail. Winner S1. |

2025 had already been the test season for several earlier units (STRUCTURE-MAP M13).

## 11. Commands

```
sqlite3 ~/gridiron-local/data.sqlite ".backup '<wt>/.local-db/data.sqlite'"
GRIDIRON_DB_PATH=<wt>/.local-db/data.sqlite SCHEDULER_DISABLED=1 NFL_SEASON=2026 \
  node --max-old-space-size=3072 scripts/weekly-construction-grade.mjs --full
# S-03, after 2026 week 4 (never reopens 2025):
... scripts/weekly-construction-grade.mjs --forward-only \
  --lambda-from docs/evidence/2026-09-22/weekly-construction-grade-output.json --out <file>
```

Configuration: `buildPlayerWeekEngine` (live path), `WEEKLY_ROLE_RECENCY`, no `kOverride`.
k control passed: target_share k = 0.2747 / 0.2086 / 0.1733 for predicting 2024 / 2025 / 2026,
not 6. Weight sets: 2022-2025 frozen per-position vectors, 2026 fit-2. PPR. No availability
term. Parity with the served functions held on every graded row: 12,489 rows (2024 fit split
and 2025) against `startSitWeekPoints`, and the 360 forward rows against both
`startSitWeekPoints` and `weeklyProjectionFor`.

## 12. What would make this wrong

- **The level trade.** The rule scores MAE, which rewards the median. Every passing arm moves
  the mean error from about 0 to between −0.41 and −0.61 per player-week. A nine-starter lineup
  total would read about 3.7 to 5.5 points low. Whether served numbers should target the median
  or the mean is A-11's question, and S-03 should not ship a level shift before it is answered.
- Local copy, not production. Production may serve different weekly weights.
- PPR for every arm, not each league's scoring.
- The lift reads the engine's team at the cutoff, not `players.team_id`.
- The forward check is one week, in the weeks 2-4 regime.
- Multiplicity: 12 tests. The 8 passes have CIs far from 0 (B's upper bound in weeks 5-17 is
  −0.054), well beyond the ~0.6 false passes expected by chance.
