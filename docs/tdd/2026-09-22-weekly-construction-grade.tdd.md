# S-02: grade of the served weekly construction

Unit S-02 (WORK-QUEUE §5, plan item A2). Measures only; S-03 applies the result.
Pre-registration: `docs/evidence/2026-09-22/weekly-construction-grade-preregistration.md`
(commit `dd4d2055`, before any number). Result: `docs/evidence/2026-09-22/weekly-construction-grade.md`.
Branch `claude/local-s-02-weekly-construction-grade`, base `d6d7bd5a`.

## 1. Audit: extend or build (written before the first test, tree `d6d7bd5a`)

What already exists for this surface, and why none of it grades the served number:

| Existing | What it grades | Why it is not this grade |
|---|---|---|
| `weekly-backtest.js#replaySeasonWeekly` (:88) | a prediction head over the replay's own structural projection | Reads 4 tables; the live `buildPlayerWeekEngine` reads 23 (memory gridiron-replay-is-not-the-live-path). No coordinator, no lift. |
| `fantasy-coordinator.js#fantasyCoordinatorWalkForward` (:501) | `structural + correction` vs `structural` | Grades the correction on the structural base (:522). Production adds it to the ensemble (trade-engine.js:354). No lift. |
| `matchups.js` test (:28-52) | home/away and DvP multipliers on the replay blend | Not `vegasLift`. Its ship rule (:33-35) is the one this unit reuses. |
| `start-sit-decision-curve.md` §6 | a research baseline's win-rate curve | Says in its own caveat that production has `vegasLift` and the baseline does not (:131-135). |
| `git grep -il vegasLift d6d7bd5a -- docs` | 8 files (7 Markdown plus `wiring-map.json`) | All describe it; none grades it. Control: the same grep finds `start-sit-decision-curve.md`, a known mention. |
| PR #57 (draft) | changes the coordinator base to structural | A code change without a grade of the alternatives. Arm S1 grades its construction. |

**Decision: build a thin study script, reuse every producer.** The study adds no producer of
any served number. Every arm calls the served functions: `buildPlayerWeekEngine`,
`weeklyExpertValues`, `coordinateFantasy`, `fitFantasyCoordinator`,
`buildFantasyCoordinatorExamples`, `vegasLift`. Every metric reuses an existing helper:
`actuals`, `spearman`, `pairedBootstrapDiff`, `startSitPairAccuracy`,
`predictionWeightedMedianRatio`. Study code lives in `scripts/`, not in a production module
(memory feedback_study_code_not_in_production_modules).

## 2. RED and GREEN

Test file `test/weekly-construction-grade.test.js`. Command for every run:
`GRIDIRON_DB_PATH=$(mktemp -u …).sqlite SCHEDULER_DISABLED=1 NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks --test --test-reporter=tap test/weekly-construction-grade.test.js`

| Step | Commit | Result |
|---|---|---|
| RED 1 | `1000caa4` test: S-02 arms must be the served functions in the served order (RED) | Whole file fails: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/scripts/weekly-construction-grade-lib.mjs'` |
| GREEN 1 | `abae0470` feat: S-02 study library and runner for the weekly construction grade (GREEN) | 24 / 24 pass |
| RED 2 | `5f72a188` test: every fit that grades a season must end before it (RED) | `not ok 25 - assertContextCutoff: every fit that grades season S must end before S` — `error: 'lib.assertContextCutoff is not a function'` (24 pass, 1 fail) |
| GREEN 2 | `4cdfbe12` feat: check the fit cutoff on the context each grade receives (GREEN) | 25 / 25 pass. **The numbers were produced on this commit.** |
| RED 3 | `1c84d880` test: the season-to-fit mapping lives in one tested place (RED) | `not ok 26 - gradingContext maps each graded season to its registered fits, and the cutoff travels with the fit` — `error: 'lib.gradingContext is not a function'` (25 pass, 1 fail) |
| GREEN 3 | `7ef8bc44` refactor: one tested season-to-fit registry for every S-02 grade (GREEN) | 26 / 26 pass |
| fix | `9eed700d` fix: re-check the fit cutoff against the season the runner grades | 26 / 26 pass; kills runner mutant R2 |

RED 2 and RED 3 exist because a mutation found a hole (section 4, rows R1 and R2).

## 3. What it does

- `scripts/weekly-construction-grade-lib.mjs`: the seven arms (`constructArms`), the population
  (`eligibleRows`), the metrics (`armSummary`, `compareArms`, `pairAccuracy`, `decisionWinRate`,
  `m0For`, `headroom`, `lambdaMaes`/`fitLambda`), the rule (`shipVerdict`, `selectWinner`,
  `forwardVerdict`, `mde80`), and the guards (`assertKControl`, `assertFitCutoff`,
  `assertContextCutoff`, `gradingContext`).
- `scripts/weekly-construction-grade.mjs`: the runner. It refuses the original database. It
  refuses `--full` unless the pre-registration is committed and unchanged. It stops on the k
  control, an unready or late fit, a parity miss, or an empty window. Output is aggregates only.
- The arms reproduce the served paths. Tests pin the served functions by identity, and pin
  arm D against `startSitWeekPoints` through the real `vegasLift`. At run time, every graded
  row was checked against `startSitWeekPoints`, and every forward row against
  `weeklyProjectionFor`. The served refit function reproduces stored fit 7 exactly.
- No served code, table, column or route changes. No migration.

## 4. Mutation sweep

Library mutants run against the test file on `9eed700d` (script: a Python harness that swaps
one exact string, runs the file, restores it; `git status` clean after).

| # | Mutant | Result (pass / fail) |
|---|---|---|
| M1 | arm B's coordinator base → structural | killed (23 / 3) |
| M2 | arm D lifts the uncoordinated base | killed (20 / 6) |
| M3 | lift dropped | killed (20 / 6) |
| M4 | no `ready` check on the fit | killed (25 / 1) |
| M5 | S1 on the ensemble base | killed (23 / 3) |
| M6 | S2 uses the structural-residual fit | killed (25 / 1) |
| M7 | S3 `m * λ` instead of `m ** λ` | killed (25 / 1) |
| M8 | retarget adds the shift | killed (25 / 1) |
| M9 | population drops the prior-week rule | killed (25 / 1) |
| M10 | DNP actual not 0 | killed (25 / 1) |
| M11 | window 5-17 includes week 18 | killed (25 / 1) |
| M12 | ship rule accepts a CI touching 0 | killed (25 / 1) |
| M13 | Spearman tolerance −0.003 | killed (25 / 1) |
| M14 | DNP rule strict `< 0` | killed (25 / 1) |
| M15 | MDE with z 1.645 | killed (25 / 1) |
| M16 | win rate counts agreements | killed (25 / 1) |
| M17 | tie-break to more components | killed (25 / 1) |
| M18 | nothing passes → serve D | killed (25 / 1) |
| M19 | forward AND → OR | killed (25 / 1) |
| M20 | k control ignores share 6 | killed (25 / 1) |
| M21 | fit cutoff off by one | killed (25 / 1) |
| M22 | context cutoff allows the graded season | killed (24 / 2) |
| M23 | **call site:** `vegasLift` injected as a wrapper copy | killed (25 / 1) |
| M24 | **call site:** lift reads `proj.team_abbr` | killed (20 / 6) |
| M25 | registry: 2025 graded by the ≤2025 pair | killed (25 / 1) |
| M26 | registry: 2026 coordinator arms use the refit, not the served fit | killed (25 / 1) |
| M27 | registry guard removed | killed (25 / 1) |
| designed survivor | `round2` via `Number()` instead of unary `+` (equivalent) | **survived** (26 / 0), as designed |
| not-applied control | target string absent from the file | reported NOT APPLIED, not counted |

Runner call-site mutants (the unit suite does not execute the runner, so these are standing rows):

| # | Mutant | Result |
|---|---|---|
| R1 | on `1c84d880` (the `4cdfbe12` runner plus RED 3): the 2025 grade gets the ≤2025 fits under the ≤2024 label | **survived**: 25 / 1, the one failure being RED 3 itself, which does not look at the runner. The run-time guard returned `true`. Fixed by `1c84d880` + `7ef8bc44`: the cutoff now travels with the fit, and no call site picks a fit. |
| R2 | the runner asks `gradingContext` for season + 1 while grading 2025 | On `7ef8bc44` it would pass `gradingContext`'s own check, which tests the season it was asked for (not run; read from the code). Killed on `9eed700d` by the call-site re-check: `cutoff: fitSThrough = 2025 may not grade 2025` (shown by a direct call with the registry shape). |

## 5. The numbers

All from `node --max-old-space-size=3072 scripts/weekly-construction-grade.mjs --full` on
`4cdfbe12`, local copy, not production. Output file:
`docs/evidence/2026-09-22/weekly-construction-grade-output.json`. The tables are in the result
file. In short, 2025 weeks 5-17, ΔMAE vs the ensemble (negative = better), player-clustered
90% CI:

| Arm | ΔMAE | Rule |
|---|---|---|
| B coordinator (served) | −0.0704 [−0.0862, −0.0540] | pass |
| C lift | +0.0093 [−0.0009, +0.0193], MDE 0.015 | fail |
| D both (served today) | −0.0695 [−0.0864, −0.0532] | pass |
| S1 structural + coordinator | −0.0713 [−0.0947, −0.0466] | pass, pre-registered winner |
| S2 ensemble-residual refit | −0.0634 [−0.0746, −0.0520] | pass |

Weeks 2-4: the lift is significantly worse (+0.0300 [+0.0137, +0.0465]). B, D, S1 and S2
pass. Forward 2026 week 2: winner holds (−0.135 [−0.191, −0.079]).

Equivalence of the later commits: `--forward-only` on `9eed700d` against the same copy gives
the same forward block (section 5a).

### 5a. Forward reproduction on the final head

`GRIDIRON_DB_PATH=<copy> SCHEDULER_DISABLED=1 NFL_SEASON=2026 node --max-old-space-size=3072 scripts/weekly-construction-grade.mjs --forward-only --lambda-from docs/evidence/2026-09-22/weekly-construction-grade-output.json --out <scratch>/forward-final.json`
on `9eed700d`, same copy, exit 0. Compared with the `--full` output from `4cdfbe12`:

- `forward.all` (every arm, every comparison, every verdict): byte-identical after key sort.
- Forward rows per week and parity rows checked (360): identical.
- Every fit summary (split, held-out, forward, served): identical coefficients, shrinkage and
  row counts. The only difference is the `through` field the refactor added to each entry.

The 2025 and 2024 blocks were not re-run (that would be a second look at 2025). They go
through the same `constructArms`, which is unchanged since `abae0470`. The only change on
their path is which object hands them the same fits.

## 6. Known defects and limits

- **The coordinator's gain is a level shift.** Spearman is unchanged and it changes 2 of 67,943
  start/sit pairs. The rule scores MAE (median-optimal), so any downward level move toward the
  median passes it. The summing consumers need the mean level. S-03 should not ship a level
  shift before A-11 decides the level target.
- S1 beats B by 0.0007 MAE in weeks 5-17. The rule's pick between them is not a measured
  difference.
- The lift wins slightly on start/sit calls (53.7% of disagreements in weeks 5-17) while
  failing on error. A mean-preserving lift is untested.
- Local copy, not production. PPR only. The lift uses the engine's team at the cutoff.
- The forward check is one week in the weeks 2-4 regime.
- 2025 has been reused as a test season by earlier units (STRUCTURE-MAP M13).

## 7. Nick's five questions

1. **Well built?** Yes, for a measurement. Every arm calls the served functions, pinned by
   identity tests and checked row by row against `startSitWeekPoints` and
   `weeklyProjectionFor`. 27 of 27 real mutants are killed. Two runner holes were found by
   mutation and fixed.
2. **Stats or made up?** Stats. Backtest on 2025 held out, fit ≤ 2024, player-clustered
   bootstrap, and a pre-registered rule. The lift's RB split and clamp are hand-set constants
   in the served code; this unit graded them and did not change them.
3. **How we know:** 2025 weeks 2-4 (969 rows) and 5-17 (4,185 rows), MAE, DNP-included MAE,
   pair accuracy and decision win rate, plus a one-week 2026 forward check. Numbers in section 5
   and the result file.
4. **Pointed anywhere else on the platform?** No. No served code changes. S-03 applies the
   result to trade-engine.js:350-359, fantasy-coordinator.js:378-382 and waiver-brain.js:162-185.
   S-01 then puts one "this week" function everywhere.
5. **How it unifies:** One m0 definition for A-11 (`predictionWeightedMedianRatio` on the 2024
   fit split; m0(A) = 0.8991 in weeks 5-17). One ship rule (matchups.js:33-35). One grading
   harness on the live engine that S-03 re-runs `--forward-only`. It also measures the
   disagreement STRUCTURE-MAP D1 names: the lifted (a) vs unlifted (c) week number. The lift
   does not earn its place, so removing it (S-03) closes that gap in the direction of (c).

Defect or gap closed: the served weekly construction (trade-engine.js:347-359 on `d6d7bd5a`,
lineup-brain.js:356-363) had never been graded. Incumbent: arm D, by the command above. Not
covered: availability (S-04), league scoring, the level target (A-11). What would make it
wrong: production weights differ from the copy's, or the median-vs-mean level question goes
the other way.
