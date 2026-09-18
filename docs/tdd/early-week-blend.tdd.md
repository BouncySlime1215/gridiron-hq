# TDD evidence — early-week-blend (2026-09-18)

## 1. Source plan
No `*.plan.md`. Journeys and acceptance criteria come from the workflow task "ITEM: early-week-blend"
(week-2 blend puts 80% of the projection on the week-1 score; weights were fit on weeks 5-18 and applied
from week 2). The gate was pre-registered before any candidate was graded, in the item's scratch
`GATE.md` and, verbatim, in the header of `scripts/promote-early-week-weights.mjs`.

## 2. User journeys
- As Nick setting a week-2 lineup, I want a player's projection not to be mostly his week-1 box score,
  so a 33.8-point week-1 fluke (Jalen Coker) or a 1.2-point dud (Jaylen Waddle) does not decide start/sit,
  waivers and trades.
- As the maintainer, I want weeks 5-18 (the validated MAE 4.333 path) and the week-1 cold start to be
  byte-for-byte unchanged, and a stored fit to reproduce exactly what was graded.

## 3. Task report

| Behavior | Validation command | RED | GREEN |
|---|---|---|---|
| Early buckets in `weeklyEnsemblePrediction`, `prior_weeks` on the production context, `weeklyEnsembleWeightsFor` / `weeklyEnsembleMode` / `weeklyWeightSetForWeek` | runner on `test/weekly-early-week-blend.test.js` | 15 of 18 fail on missing behavior (commit 42723ce) | 19/19 pass |
| Store serves `early` only in its week window, refuses malformed blocks, round-trips bit for bit, `carryEarlyWeights` | same | fail ("week 1 must not carry early", "Missing expected exception: non-convex", "not a function") | pass |
| Promotion script helpers (grid fit, shrinkage k, pair accuracy, gate verdict, weight-set builder, bucket fits) | same | fail (module not found) | pass (fitBuckets test added after GREEN for coverage) |
| The ship decision (G1-G3 in 2024 and 2025) | `node scripts/promote-early-week-weights.mjs --dry-run` on a VACUUM copy, then without `--dry-run` on server/data.sqlite | n/a | (b) PASS; (c), (d) FAIL G2; dry and production runs produced identical numbers |
| Stored row = graded model | post-save checks inside the script plus a fresh-process read | n/a | `round_trip.failures = []`; fit-2 served in weeks 2-4 only |

Runner: `GRIDIRON_DB_PATH="$(mktemp -u …).sqlite" SCHEDULER_DISABLED=1 NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks --test --test-concurrency=1 <file>`

RED (42723ce): `tests 18, pass 3, fail 15`. The 3 passing tests are regression guards on today's
behavior: a set with no `early` predicts as before; a bare array or unknown position still returns structural.
GREEN: `tests 19, pass 19, fail 0`.

## 4. Test specification

| # | What is guaranteed | Test | Type | Result |
|---|---|---|---|---|
| 1 | Production context carries `prior_weeks` for 1-3 games; a 4+ history keeps its exact old shape | production context carries prior_weeks… | unit | PASS |
| 2 | Early weights apply only for 1-3 prior games, and only in the window when the context has a week | early bucket weights replace the live vector only… | unit | PASS |
| 3 | A set without `early` predicts exactly as before for any prior_weeks and week | a weight set without early… | unit (regression) | PASS |
| 4 | The `weightSet[position]` 5-array contract is kept (bare array / unknown position → structural) | the position-array contract is kept… | unit (regression) | PASS |
| 5 | A bucket missing a position falls back to that position's live vector, never structural | an early bucket missing a position… | unit | PASS |
| 6 | Audit helpers report the vector and mode that actually ran (`early_week_bucket_n`) | weeklyEnsembleWeightsFor and weeklyEnsembleMode… | unit | PASS |
| 7 | `weeklyWeightSetForWeek` drops `early` outside the window, never touches position vectors or the input | weeklyWeightSetForWeek drops early… | unit | PASS |
| 8 | `activeWeeklyWeightSet` serves `early` in weeks 2-4 only; `latestWeeklyWeightSet` is unstripped | activeWeeklyWeightSet serves early buckets… | integration (temp DB) | PASS |
| 9 | `saveWeeklyFit` refuses 8 kinds of malformed early block and writes nothing | saveWeeklyFit refuses a malformed early block… | integration | PASS |
| 10 | Stored row reproduces graded predictions bit for bit; weeks 5+ equal live | the stored row reproduces the graded predictions… | integration | PASS |
| 11 | Re-promoting weeks 5-18 carries the early buckets | carryEarlyWeights… | unit | PASS |
| 12-19 | Script imports without running main; shrinkage vector; grid fit recovers truth; k recovered; common-pair-set accuracy; gate verdict fails on each rule; bucket fits honour the 200-row rules; stored-shape builder | promotion-script tests | unit | PASS |
| G | Pre-registered gate G1-G3, 2024 and 2025 | `scripts/promote-early-week-weights.mjs` | eval (code grader) | (b) PASS |

## 5. Gate results (walk-forward; weeks 2-4; played player-weeks; fit on 2021..s-1)

| season | n | (a) live fit-1 | (b) structural only | (c) fitted buckets | (d) k/(n+k) | (b) vs (a), 90% CI (player-clustered) |
|---|---|---|---|---|---|---|
| 2024 | 929 | 4.7233 | **4.4867** | 4.4713 | 4.4768 | -0.2313 [-0.3575, -0.1053] |
| 2025 | 969 | 4.7099 | **4.3175** | 4.3304 | 4.3252 | -0.3965 [-0.5222, -0.2725] |

- Verdicts: (b) PASS. (c) and (d) beat (a) significantly in both seasons but fail G2 in 2025 (worse than (b)).
  G3: 0 of 15,175 week 5-18 contexts moved (7,462 in 2024, 7,713 in 2025) for every candidate.
- (c) architecture: global both times (per-position lost on 2023, 4.8557 vs 4.8555; on 2024 it was 0.0017 lower,
  4.4696 vs 4.4713, not significant).
  (d) k = 5.4 (fit ≤2023), 5.75 (fit ≤2024).
- Report only. Start/sit pair accuracy (one common pair set): 2024 0.605 → 0.626 (16,878 pairs); 2025
  0.621 → 0.647 (18,092 pairs). Decision MAE with DNP = 0: 4.580 → 4.526, 4.626 → 4.414. Spearman
  0.656 → 0.691, 0.661 → 0.718. 2025 CRPS 3.38 → 3.015, 80% coverage 0.756 → 0.811.
- Stress test (report only; (b) needs no fit, so 2022-2023 are also out of sample for it). Structural-only
  beats live on weeks 2-4 in 2022 (-0.574), 2023 (-0.343), 2024 and 2025, all significant. With 1 prior
  game it's significant in all four seasons, with 2 prior games in 3 of 4. With 3 prior games (mostly
  week 4) it's a wash: 2023-2025 CIs straddle 0, and week-4-only in 2024 is +0.072 [-0.095, 0.241].
  So the gain comes from weeks 2-3.

## 6. Production
`saveWeeklyFit` → fit-2, data_hash `e1:early-week:b:fixed:buckets1-3:weeks2-4:2021-2025:grid0.05:live-fit-1`,
through 2025-W18, promoted. Its QB/RB/WR/TE vectors are fit-1's, byte for byte. `activeWeeklyWeightSet({2026, week})`
serves `early` only for weeks 2-4. On a post-save copy at 2026 week 2, all 360 players with one prior game are
served the structural head. Coker WR 14.3 (week-1 score 33.8), Waddle 8.81 (1.2), Caleb Williams 19.86
(37.26). The columns candidate_mae 4.3175 / champion_mae 4.7099 / coverage_80 0.811 describe **weeks 2-4
held-out 2025**, not weeks 5-18.

## 7. Coverage and known gaps
`--experimental-test-coverage` on the new test file: weekly-ensemble.js 100% lines / 92% branches;
weekly-weight-store.js 95.1% lines (uncovered: pre-existing non-integer-season throw and `weeklyFitHistory`);
promote-early-week-weights.mjs 46.6% lines / 96% branches. The uncovered lines are `main()`, the harness
orchestration, which the two logged real runs cover instead of a unit test.
Regression: model-integrity 94/94, weekly-prediction-snapshot-mode-migration 3/3, and 11 more dependent
files green. player-week-distribution fails 6/12. Those are the fake-floors item's RED tests (daf43c0, fix
held back), unrelated to this change.
Known gaps (not in this item's files):
- `player-week-engine.js` still records `engine.weights = weightChampion.weights[position]` (fit-1's vector)
  for early-week players. It should use `weeklyEnsembleWeightsFor(context, weights)`. `engine.mode` is already
  correct (`early_week_bucket_1`).
- `weekly-learning.js#retrainWeeklyWeights` builds a candidate with no `early`. If it ever promotes, weeks 2-4
  lose the fix. It should wrap its candidate in `carryEarlyWeights(candidate, champion.weights)`.
- A week 2-4 cold start (no current-season usage loaded yet) passes one prior-season average as
  priorWeeks. It gets bucket 1, i.e. the structural head.
- `test/model-integrity.test.js` pins the exact context shape for 4 prior games. So `prior_weeks` is set
  only for 1-3 games. Making it unconditional means updating that assertion.

## 8. Eval report (eval-harness)
Capability: C1 early weights by prior_weeks PASS; C2 production context prior_weeks PASS; C3 window in
store PASS; C4 round trip PASS (unit and real); C5 gate G1-G3 in 2024 and 2025 PASS for (b). 5/5.
Regression: R1 no-early sets unchanged PASS; R2 bare-array/unknown-position contract PASS; R3 weeks
5-18 identical (0/15,175 moved), week 1 has no early PASS; R4 existing suites PASS. 4/4.
The gate reproduced exactly on two runs (dry run on a copy, then production). Status: shipped.

## 9. Merge evidence
RED 42723ce (tests only, 15/18 failing). GREEN: this commit (implementation, promotion script,
coverage test, this report). The production row fit-2 was written by the GREEN code's script.
