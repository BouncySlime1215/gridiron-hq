# S-02: grade of the served weekly construction

Unit S-02 (WORK-QUEUE §5, plan item A2). Measures only; S-03 applies the result.
Pre-registration: `docs/evidence/2026-09-22/weekly-construction-grade-preregistration.md`
(commit `dd4d2055`, before any number), plus amendment 1
(`…-preregistration-amendment-1.md`, commit `8c241cb4`, after the three audits and before any
new number). Result: `docs/evidence/2026-09-22/weekly-construction-grade.md`.
Branch `claude/local-s-02-weekly-construction-grade`, base `d6d7bd5a`.

**Scope after the audits.** The arms are the weekly construction **before availability and the
game factor**; the page multiplies B by `thisGame.mult × active_probability` first
(trade-engine.js:359). The verdicts grade that construction, not the page number, and S-03 must
not act on them. The decision grade is the served-chain grade in amendment 1 §4, run jointly
with S-04 and A-11.

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
| amendment | `8c241cb4` docs: S-02 pre-registration amendment 1, before any new number | docs only; committed before every number in sections 5b-5c |
| RED 4 | `a19e0e54` test: pin S-02's metric producers, served-call arguments and window bookkeeping (RED) | 33 pass, 10 fail. The 10 are the new-API tests, e.g. `not ok 34 - gradeWindow grades every candidate as arm-vs-A, and the verdicts follow` — `error: 'lib.gradeWindow is not a function'`; `not ok 36 - lambdaForWeek …` — `error: 'lib.lambdaForWeek is not a function'`; `not ok 39 - consumerDecomposition …` — `error: 'lib.consumerDecomposition is not a function'`. The 7 that pass on the old library are liveness-proved by the audit's mutants (section 4a). |
| GREEN 4 | `17e0b84b` feat: move S-02's window grading into the tested library, add amendment 1 diagnostics (GREEN) | 44 / 44 pass (includes `summarizeConsumerParity`'s test, added with it; liveness by N11, N14) |
| test fix | `c94adb9e` test: pin the level-band edge and every reproduction field (kills N8, N10) | 44 / 44 pass; N8 and N10 had survived on `17e0b84b` |
| RED 5 | `bc570529` test: the consumer summary must split 'no game this week' into bye and no team (RED) | `not ok 44 - summarizeConsumerParity …` — `Expected values to be strictly deep-equal: + undefined - { bye_with_team: 1, no_team: 1, total: 2 }` (43 pass, 1 fail) |
| GREEN 5 | `9b541006` feat: split the consumer summary's no-game count into bye and no team (GREEN) | 44 / 44 pass |
| test fix | `b3528a56` test: pin compareArms' Spearman sign, gradeWeekRows' served-call arguments and gradeWindow's per-arm outputs | 48 / 48 pass. Tests only, no library change. Kills the 13 survivors of the liveness re-check (section 4b), all 44 / 0 on the previous test file. |

RED 2 and RED 3 exist because a mutation found a hole (section 4, rows R1 and R2). RED 4 exists
because the audits' mutants survived (section 4a). RED 5 exists because the first
`--consumer-parity` run counted 674 teamless players as byes. The `b3528a56` test fix exists because
the liveness re-check found survivors on `5809d845` (section 4b).

## 3. What it does

- `scripts/weekly-construction-grade-lib.mjs`: the seven arms (`constructArms`), the population
  (`eligibleRows`), the metrics (`armSummary`, `compareArms`, `pairAccuracy`, `decisionWinRate`,
  `m0For`, `headroom`, `lambdaMaes`/`fitLambda`), the rule (`shipVerdict`, `selectWinner`,
  `forwardVerdict`, `mde80`), and the guards (`assertKControl`, `assertFitCutoff`,
  `assertContextCutoff`, `gradingContext`).
- `scripts/weekly-construction-grade.mjs`: the runner. It refuses the original database. It
  refuses `--full` unless the pre-registration is committed and unchanged. It stops on the k
  control, an unready or late fit, a parity miss, or an empty window. Output is aggregates only.
- The arms reproduce the served construction **up to the lift step**. Tests pin the served
  functions by identity, pin the arguments handed to `weeklyExpertValues` and `vegasLift`, and
  pin arm D against `startSitWeekPoints` through the real `vegasLift`. At run time every graded
  row's `round2(D)` equals `startSitWeekPoints` given B as `current_week_ppg` (the lift step
  only), and every forward row's B equals `weeklyProjectionFor`. The served refit function
  reproduces stored fit 7 exactly. **The arms are not the page number:** the page multiplies B by
  `thisGame.mult × active_probability` first. `--consumer-parity` shows the exact decomposition
  on 1,196 of 1,196 assets (section 5b).
- Amendment 1 moved `gradeWindow`, the per-week λ (`lambdaForWeek`) and the per-week row build
  (`gradeWeekRows`) into the tested library; the runner no longer calls `compareArms` itself
  (`grep -c compareArms scripts/weekly-construction-grade.mjs` = 0). The runner reads each
  graded row's λ back against the λ recorded in the report (`assertS3UsedLambda`).
- Amendment 1 diagnostics: `consumerDecomposition` + `summarizeConsumerParity`
  (`--consumer-parity`), and `starterProxy` / `meanSignedError` / `levelBands` /
  `reproductionMismatches` (`scripts/weekly-construction-level-bands.mjs`). `--rows-dir` writes the
  graded row objects (local, never committed).
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

Runner call-site mutants on the original runner (the unit suite does not execute the runner, so these are standing rows):

| # | Mutant | Result |
|---|---|---|
| R1 | on `1c84d880` (the `4cdfbe12` runner plus RED 3): the 2025 grade gets the ≤2025 fits under the ≤2024 label | **survived**: 25 / 1, the one failure being RED 3 itself, which does not look at the runner. The run-time guard returned `true`. Fixed by `1c84d880` + `7ef8bc44`: the cutoff now travels with the fit, and no call site picks a fit. |
| R2 | the runner asks `gradingContext` for season + 1 while grading 2025 | On `7ef8bc44` it would pass `gradingContext`'s own check, which tests the season it was asked for (not run; read from the code). Killed on `9eed700d` by the call-site re-check: `cutoff: fitSThrough = 2025 may not grade 2025` (shown by a direct call with the registry shape). |

### 4a. Amendment 1 sweep (the audits' survivors, their new homes, and the new code)

The liveness audit ran eight more mutants on `0f397736`, and all eight survived 26 / 26: U1, U2,
U3, C1, C2, M0 in the library, C3 and C4 at runner call sites. The sweep above was therefore
incomplete: it killed every mutant it listed, but it did not list these.

Harness: scratchpad `s02b/mutate2.py` (swap one exact string in the library, run the test file,
restore; `git status` of code clean after). Run on `9b541006` (the first pass, on `17e0b84b`, left N8 and N10 alive; both tests were fixed). Results (pass / fail):

| # | Origin | Mutant | Result on `9b541006` |
|---|---|---|---|
| U1 | audit | compareArms dMAE sign flipped | killed (41 / 3) |
| U2 | audit | compareArms dMAE CI not player-clustered | killed (43 / 1) |
| U3 | audit | armSummary DNP-included MAE on played rows | killed (43 / 1) |
| C1 | audit | call site: vegasLift gets the previous week | killed (43 / 1) |
| C2 | audit | call site: weeklyExpertValues gets the wrong season | killed (43 / 1) |
| M0 | audit | m0For on DNP-included decision rows | killed (43 / 1) |
| C3 | audit, new home | gradeWindow: arm and reference swapped | killed (43 / 1) |
| C4 | audit, new home | gradeWeekRows: S3 ignores the window lambda | killed (43 / 1) |
| N1 | this pass | lambdaForWeek reads one window for every week | killed (41 / 3) |
| N2 | this pass | assertS3UsedLambda disabled | killed (43 / 1) |
| N3 | this pass | consumerDecomposition leaves p out | killed (43 / 1) |
| N4 | this pass | consumerDecomposition never flags a team difference | killed (43 / 1) |
| N5 | this pass | meanSignedError sign flipped | killed (42 / 2) |
| N6 | this pass | meanSignedError CI not clustered | killed (43 / 1) |
| N7 | this pass | starterProxy keeps the bottom N | killed (42 / 2) |
| N8 | this pass | levelBands band edge: A = 10 lost | killed (43 / 1); **survived** on `17e0b84b` (44 / 0), fixed by `c94adb9e` |
| N9 | this pass | levelBands starters on played rows twice | killed (43 / 1) |
| N10 | this pass | reproductionMismatches ignores signed_error | killed (43 / 1); **survived** on `17e0b84b` (44 / 0), fixed by `c94adb9e` |
| N11 | this pass | summary counts byes as page differences | killed (43 / 1) |
| N12 | this pass | gradeWindow light returns everything | killed (43 / 1) |
| N13 | this pass | gradeWindow marginal reversed | killed (43 / 1) |
| N14 | this pass | summary starter page mean reads arm D | killed (43 / 1) |
| N15 | this pass | summary counts teamless players as byes | killed (43 / 1) |
| N16 | this pass | summary counts a missing team as a team change | killed (43 / 1) |
| EQ | designed survivor | designed survivor (equivalent destructuring) | **survived** (44 / 0), as designed |
| NA | designed not-applied control | designed not-applied control | reported NOT APPLIED, not counted |
| K1 | known-kill control | known-kill control: S2 on the structural base | killed (42 / 2) |

Runner call sites after amendment 1 (standing rows, not executed by the unit suite):

| # | Mutant | Status |
|---|---|---|
| C3 (runner) | arm and reference swapped at the runner's `compareArms` call | Gone: the runner has no `compareArms` call (`grep -c` = 0). The same swap inside `lib.gradeWindow` is killed (C3 above). |
| C4 (runner) | the held-out grade handed `lib.UNIT_LAMBDA` instead of the fit-split λ | Stopped at run time by `lib.assertS3UsedLambda(held, recordedLambda(report))`, which reads the λ recorded in `report.fit_split`, not the variable the grade was handed. The assert itself is unit-tested (N2). Not demonstrated on the copy: the only forward weeks (week 2, λ = 1) cannot tell λ = 1 from `UNIT_LAMBDA`, and a demonstration on 2025 would be a new look. Read from the code. |


### 4b. Liveness re-check survivors (on `5809d845`, closed by `b3528a56`)

The liveness re-check ran its own sweep on `5809d845` (tree `34cacc1c`, its worktree
`wt/S-02-recheck`, since removed) and found three blocking survivors: U1d, G2/G3 and DW1. The
same sweep left U1e, U3c, G1, BP1 and HM1 alive too. This pass added four more mutants of the
same kind (U1f, G4, DW2, DW3). The library was right each time; the tests did not look.

What each survivor would have done to the committed result (the re-check's reading, checked by a
python read of `weekly-construction-grade-output.json`; no mutant was run on real rows): under
U1d, window 2-4 S1's ΔSpearman +0.0232 reads -0.0232, S1 fails the rule, and the 2-4 winner
changes from S1 to B (pass set B, D, S1, S2; MAE B 4.368, D 4.386, S2 4.377). Under DW1, weeks 5-17 C's decision win rate 0.537, CI on rate - 0.5
[+0.005, +0.070], reads 0.463 with a CI below 0. G2 and G3 would probably be caught at run time
by stop condition 3a (D against `startSitWeekPoints` at the true season and week), read from the
code, not run. No committed number changes in this pass: the code that produced them is
unchanged (`git diff 5809d845 b3528a56 -- scripts/` prints nothing).

Harness: scratchpad `s02c/mutate.py` (the re-check's `mutate2.py` pointed at this worktree, plus
U1f, G4, DW2, DW3) and `s02c/run.sh` (the test command in section 2). "Before" runs the
`5809d845` test file (copied to an untracked `test/zz-s02-before.test.js`, deleted after);
"after" runs the `b3528a56` test file, tree `eb68e0fa`. `git status --porcelain` printed `''`
after the after-sweep. Results (pass / fail):

| # | Mutant | Before (`5809d845` tests) | After (`b3528a56`) | Killed by |
|---|---|---|---|---|
| U1d | compareArms ΔSpearman sign flipped (lib:160) | survived 44 / 0 | killed 47 / 1 | compareArms: dSpearman is arm minus reference … |
| U1e | compareArms MDE % of ΔMAE on the arm's MAE, not the reference's | survived 44 / 0 | killed 47 / 1 | same |
| U1f | compareArms MDE % of ΔDNP on the arm's MAE | survived 44 / 0 | killed 47 / 1 | same |
| G1 | gradeWeekRows drops scoring | survived 44 / 0 | killed 47 / 1 | gradeWeekRows hands the served expert and lift functions … |
| G2 | gradeWeekRows hands constructArms season - 1 | survived 44 / 0 | killed 47 / 1 | same |
| G3 | gradeWeekRows hands constructArms week - 1 | survived 44 / 0 | killed 47 / 1 | same |
| G4 | gradeWeekRows hands constructArms a fixed season 2025 | survived 44 / 0 | killed 47 / 1 | same (2024 week 6 case) |
| DW1 | gradeWindow decision win rate with arm and base swapped (lib:383) | survived 44 / 0 | killed 47 / 1 | gradeWindow (full): each candidate's decision win rate … |
| DW2 | gradeWindow decision win rate on the two-arm pair set, not the common set | survived 44 / 0 | killed 47 / 1 | same |
| DW3 | gradeWindow decision win rate on every row, not decision rows | survived 44 / 0 | killed 47 / 1 | same |
| BP1 | gradeWindow position split with arm and reference swapped | survived 44 / 0 | killed 47 / 1 | same |
| HM1 | gradeWindow headroom uses m0 of A for every arm | survived 44 / 0 | killed 47 / 1 | same |
| U3c | armSummary n_decision counts played rows | survived 44 / 0 | killed 47 / 1 | armSummary counts played rows and decision rows apart |
| EQ | designed survivor (equivalent reduce order) | survived 44 / 0 | **survived** 48 / 0, as designed | - |
| NA | designed not-applied control | NOT APPLIED | NOT APPLIED | - |
| K1 | known-kill control: S2 on the structural base | killed 42 / 2 | killed 46 / 2 | arm S2 uses its own fit … |

The after-sweep also re-ran every other mutant in the re-check list on `b3528a56`: U1, U2, U1b,
U2b, U2c, U1c, C3, C3b, C4, C4b, C4c, C4d, C4e, C1, C2, C2b, C2c, C1b, M0, M0b, U3, U3b, H1, H2,
H3, P1, P2, P3. All 28 killed (fail counts 1 to 4). Nothing that was killed before came back.

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

The 2025 and 2024 blocks were not re-run by the builder (that would be a second look at 2025).
They go through the same `constructArms`, which is unchanged since `abae0470`. The claims
audit's reproduction run (the runner at `0f397736` plus three row-dump lines, holdout look at
21:02:18Z) produced `held_out`, `fit_split`, `forward` and `decisions` blocks identical to the
committed output, and `fits` identical except the added `through` field (python comparison of
the two JSON files, sorted keys).

### 5b. Consumer decomposition, 2026 week 3 (amendment 1 §3.1)

`GRIDIRON_DB_PATH=<copy> SCHEDULER_DISABLED=1 NFL_SEASON=2026 node --max-old-space-size=3072 scripts/weekly-construction-grade.mjs --consumer-parity --out docs/evidence/2026-09-22/weekly-construction-consumer-parity.json`
on `9b541006` (tree `cf32a7da`), exit 0, 9 s. 1,196 assets checked; B parity 1,196 / 1,196;
`current_week_ppg = B × mult × p` on 1,196 / 1,196. 674 have no team (`players.team_id` NULL), 0
have a bye (control: 32 teams play week 3 in `game_lines`, 30 in week 5). Page / arm D median
0.610. p median 0.607 (0.630 for the 492 with no injury status, 85.6% of them exactly at their
durability prior; basis `pooled`). Starter proxy: mean arm D 14.564, mean page 10.035. Result
file section 9a.

### 5c. Level by projection band (amendment 1 §3.2)

`GRIDIRON_DB_PATH=<copy> SCHEDULER_DISABLED=1 node scripts/weekly-construction-level-bands.mjs --season 2025 --rows <audit>/rows-held.ndjson --out docs/evidence/2026-09-22/weekly-construction-level-bands-2025.json`
and the same with `--season 2024 --rows <audit>/rows-split.ndjson`, on `9b541006`'s library,
exit 0 both. The reproduction stop passed for both seasons (no mismatch printed; a mismatch
throws before any band). 2025 weeks 5-17, starters given they play: A +1.014 [+0.631, +1.401],
B +0.392 [+0.010, +0.780], S1 +0.153 [−0.236, +0.561]. 2024: A +0.225 [−0.189, +0.645],
B −0.441 [−0.855, −0.021]. Result file section 6b.

## 6. Known defects and limits

- **Not the page number.** The arms stop before `thisGame.mult × active_probability`. On this
  copy p takes about 31% off the average starter-week (section 5b). An MAE verdict between arms
  that differ by level can flip once p multiplies them; the wiring audit found that flip on 2024
  (the fit split). S-03 must not act on these verdicts; amendment 1 §4 is the decision grade.
- **The coordinator's gain is a level shift.** Spearman is unchanged and it changes 2 of 67,943
  start/sit pairs. The rule scores MAE (median-optimal), so a downward level move toward the
  median passes it. For the weekly starter proxy the level is season-dependent (section 5c): the
  earlier claim that lineup totals would read 3.7-5.5 points low was nine times the population
  mean, not a measurement, and is withdrawn.
- S1 beats B by 0.0007 MAE in weeks 5-17. The rule's pick between them is not a measured
  difference.
- The lift wins slightly on start/sit calls (53.7% of disagreements in weeks 5-17) while
  failing on error. A mean-preserving lift is untested.
- Local copy, not production. PPR only. The lift uses the engine's team at the cutoff.
- The forward check is one week in the weeks 2-4 regime.
- 2025 has been reused as a test season by earlier units (STRUCTURE-MAP M13).

## 7. Nick's five questions

1. **Well built?** Yes, for a measurement of the construction before availability. Every arm
   calls the served functions, pinned by identity and by the arguments they receive, and checked
   row by row against `startSitWeekPoints` (lift step) and `weeklyProjectionFor`. The page number
   is decomposed onto the arms exactly (1,196 / 1,196). 27 of 27 original mutants, every
   amendment-1 mutant and every re-check mutant are killed (sections 4a-4b: 41 of 41 on
   `b3528a56`, plus the known-kill control; the designed survivor lives and the not-applied
   control is reported). Four runner holes were found by mutation; the
   runner no longer holds the grading call sites.
2. **Stats or made up?** Stats. Backtest on 2025 held out, fit ≤ 2024, player-clustered
   bootstrap, and a pre-registered rule. One figure was made up and is withdrawn: "a nine-starter
   lineup would read 3.7-5.5 points low". The lift's RB split and clamp are hand-set constants
   in the served code; this unit graded them and did not change them.
3. **How we know:** 2025 weeks 2-4 (969 rows) and 5-17 (4,185 rows), MAE, DNP-included MAE,
   pair accuracy and decision win rate, plus a one-week 2026 forward check. Numbers in section 5
   and the result file.
4. **Pointed anywhere else on the platform?** No. No served code changes. S-03 applies the
   result to trade-engine.js:350-359, fantasy-coordinator.js:378-382 and waiver-brain.js:162-185.
   S-01 then puts one "this week" function everywhere.
5. **How it unifies:** One m0 definition for A-11 (`predictionWeightedMedianRatio` on the 2024
   fit split, live engine; m0(A) = 0.8991 in weeks 5-17), reconciled against the two replay
   values on record (result file 6a). One ship rule (matchups.js:33-35). One grading harness on
   the live engine that S-03 re-runs `--forward-only`, and one decomposition that ties the study's
   arms to the page's producer (`--consumer-parity`). It measures the STRUCTURE-MAP D1
   disagreement (lifted vs unlifted week number) on the pre-availability basis only; whether
   removing the lift closes it on the page is the served-chain grade's call.

Defect or gap closed: the weekly construction (trade-engine.js:347-355 on `d6d7bd5a`,
lineup-brain.js:356-363) had never been graded; it is now graded before availability, and the
page's number is decomposed onto it. Incumbent: arm D × `thisGame.mult` × p, by
`--consumer-parity`. Not covered: the page number's own grade (amendment 1 §4, joint with S-04
and A-11), league scoring, the level target (A-11). What would make it wrong: production weights
or p differ from the copy's, or the served-chain grade reverses the verdicts (the wiring audit's
2024 run says it may).

Findings for other owners (reported, not edited, rule 9):
- docs/wiring/annotations.json:117 (Fantasy plan thread): "imported only by
  scripts/r25-level-vs-information.mjs" is stale; S-02's library also imports
  `level-information-decomposition.js`, and the retirement condition is keyed to the replay band.
- 6 of 364 skill players with a 2026 week-2 usage row have `players.team_id` NULL on the copy
  (sqlite3 query), so their `current_week_ppg` is 0 (trade-engine.js:334-337, :359). Writers of
  that column include server/routes/espn.js:101, :110, server/services/espn-draft.js:172 and
  server/services/nflverse.js:143 (not traced further).
