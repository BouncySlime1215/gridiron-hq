# HX-01: our served start/sit number against public consensus, on past seasons

Work queue HX-01 (§13; plan items C12, C18, S-03). Nick, 2026-09-22 7:20 PM ET: "we should've
been testing on historical data." Measures only; no served number changes.
Pre-registration: `docs/evidence/2026-09-22/historical-consensus-head-to-head-preregistration.md`
(committed before any number, `b635345b`, blob `187c29cb`, unchanged since; the errata found after
the results are in §6a, not in that file).
Branch `claude/local-hx-01-historical-consensus-head-to-head`, base `origin/main` `dd7cec20`
(S-02 #155 and S-00 #154 already merged), plus C-01's branch `claude/local-c-01-startsit-baseline-gate`
merged twice: at `b97d5ea2` (`116ca994`, before the Independent Auditor's C-01 ruling) and at its
PR #160 head `a1447095` (`bbe9e6cd`, round 3). The second carries the ruling (A1-A9: the plan-rule
verdict, A7's null week interval below two week clusters, the amber Lineup panel) and `origin/main`
`a3e2bf35`. **This is a PR stacked on C-01 (#160): open it against C-01's branch and keep that base
until #160 merges, so it can never carry C-01's files onto main ahead of C-01.**

## 0. Round 3 (2026-09-23): what four skeptic reviews changed

| Finding | What changed | Where |
|---|---|---|
| HX-01 carried C-01's pre-ruling instrument, gate and Lineup panel (the green "Beats" chip) | merged C-01's PR #160 head `a1447095` (`bbe9e6cd`) and re-ran everything on it | §2, §5 |
| The 2026 week-2 arm was called "served"; it is the copy's current chain replayed after the fact | renamed OURS-replay; the run prints each fit's stamp against the saved snapshot and the kickoff | §5.6, §6a, ledger `F001`-`F007` |
| Two "served vs ESPN" numbers from different arms and rows | the saved snapshot, A, D and OURS-replay graded against ESPN on one row set; `headToHead` reproduces C-01's own grade on C-01's rows, or the run stops | §5.6, `F008`-`F015` |
| `headToHead` dropped C-01's 8.0 line | its pair line defaults to C-01's `STARTABLE_PPR`; the historical grade passes −Infinity on its common sets, as before | §3, §4b |
| The hand-set-k 2021 coordinator examples reach every graded season, not only 2022 | shares printed (100%, 47.9%, 31.4%); a post-hoc run on the served recipe (from 2022) | §5.8, §6.2 |
| Test liveness X1-X5 | `servedWeekRows` takes the registry and parity-checks both lift reads; the fakes record their arguments; `gameDateLookup`; the pair-accuracy clustering is pinned | §2, §4b |

Every pre-registered number is unchanged: of the 5,455 values in the round-1 output, the 26 that
differ are A7's null week interval in the 8 single-week cells (24 values), the served
coordinator's row count (null → 23,334) and the rewritten coordinator note (§5).

## 1. Audit: extend or build (written before the first test, tree `116ca994`)

What already exists for this surface, found by command on `116ca994`:

| Existing | What it does | Why it is not this grade |
|---|---|---|
| C-01 `server/services/gates/start-sit-gate.js` (`runStartSitGate`) | Grades the replay projection against the season average on 2024-2025 weeks 5-18, and on 2026 forward weeks lays the served snapshot against ESPN's projection (`servedArms`, `espnProjections` at `:294`) | One forward week of consensus, and the replay (`weekly-backtest.js`, 4 tables) is not the served chain; no historical consensus |
| C-01 `server/services/gates/baseline-gate.js` (`gradeDecisions` `:106`, `pigeonholeBootstrap` `:56`) | The one decision instrument: win rate, points per decision, player-clustered (pigeonhole) and week-clustered 90% CIs, MDE80 | **Reused as is.** HX-01 feeds it disagreements |
| S-02 `scripts/weekly-construction-grade-lib.mjs` (`constructArms`, `eligibleRows`, `assertFitCutoff`, `assertContextCutoff`, `assertKControl`, `decisionWinRate` `:196`) | Builds the served construction (arms A-D) from the served functions; grades arms against A on 2024-2026 | **Reused**: the arms and the cutoff asserts. Its `decisionWinRate` clusters by week and position, not by player, so the decision grade goes through C-01's instrument instead |
| `scripts/promote-early-week-weights.mjs:153` `startSitPairAccuracy` | Canonical pair accuracy (`STATS-METHOD.md` rule 6) | **Reused** as the parity check for the pair-accuracy numbers |
| `server/services/historical-adp.js` (`:43` source, 20 FantasyPros hits) | Ingests FantasyPros **preseason** ranks (`ecr_type 'ro'`) | Preseason only; no weekly ECR anywhere: `git grep -n -E "weekly-(qb|rb|wr|te)|fpecr_weekly" -- server scripts` returns nothing |
| `server/services/lineup-brain.js:302` `decisionWinRate(margin)` | The static DECISION_CURVE | A research curve, not a grade (its own comment and `STATS-METHOD.md` rule 6 say so) |
| `scripts/collect-roster-snapshots.mjs` | Stores ESPN's weekly projection for rostered players, current season only (`:220`, `:230-233`) | 2026 only; no past season can be fetched through it |

Absence checks (each with a control that finds a known case):

- No weekly external projection in the engine or its graders:
  `git grep -c -i -E "fantasypros|ecr\b|rotowire|sleeper|consensus"` returns nothing for
  `weekly-ensemble.js`, `weekly-backtest.js`, `fantasy-coordinator.js`, `player-week-engine.js`,
  `gates/start-sit-gate.js`, `gates/baseline-gate.js` and `weekly-construction-grade-lib.mjs`.
  Control: the same grep on `server/services/historical-adp.js` returns 20.
- Pair-accuracy and decision producers on the tree:
  `git grep -n -E "export function (startSitPairAccuracy|decisionRanking|startSitDecisions|pairAccuracy|decisionWinRate|gradeDecisions|pigeonholeBootstrap)" -- server scripts`
  returns 7 lines: `startSitPairAccuracy` (canonical), S-02's `decisionWinRate` and
  `pairAccuracy` (a wrapper of the canonical one), C-01's `pigeonholeBootstrap`,
  `gradeDecisions` and `startSitDecisions`, and lineup-brain's curve reader.
  (`decisionRanking` is a local function in `scripts/promote-volume-shrinkage.mjs:118`, not
  exported, so this grep does not list it; `STATS-METHOD.md` rule 6 names it.)
- Season-average producers: `git grep -n -E "season_to_date\s*[:=]" -- server/services` returns
  the engine head (`weekly-ensemble.js:192`), the replay (`weekly-backtest.js:150,174`) and
  `ros-projection.js:305`. HX-01 reads the engine head, the one inside the served blend.

**Decision: build a thin study on the existing producers, plus one reusable consensus arm in
`scripts/`.**

- No producer of any served number is added. OURS is built by calling the served functions
  (through S-02's `constructArms` and the served `startSitWeekPoints` and
  `weeklyAvailability`), every decision is graded by C-01's `gradeDecisions`, and pair accuracy
  is checked against `startSitPairAccuracy`.
- The consensus arm lives in `scripts/consensus-arm.mjs`, not `server/`: a server module that
  only a script imports is a blocking wiring finding (`scripts/wiring-map.mjs:4244`,
  `module-reaches-no-surface`), and C-01's gate file is C-01's to edit. C-01's gate and S-03
  can import it from `scripts/` (named follow-up: C-01's owner moves it under
  `server/services/gates/` when the gate grows a consensus arm).
- Study code stays in `scripts/` (memory feedback_study_code_not_in_production_modules).
- One mapping is new and has no in-app producer: FantasyPros id → gsis id, from dynastyprocess
  `db_playerids.csv`. The app's existing FantasyPros resolver is by normalized name
  (`historical-adp.js`, `player-identity.js#normalizePlayerName`); HX-01 reports the share of
  id-mapped rows whose names agree under that resolver, so the two can be compared.

**Round 3 re-audit** (tree `bbe9e6cd`). Two producers now exist for "our start/sit number against
ESPN, 2026 week 2": C-01's `servedArms` (`server/services/gates/start-sit-gate.js:386`; the saved
snapshot against ESPN, the plan rule's input) and HX-01's forward rows (OURS-replay). HX-01 does not
unify them, because which arm is "served" is S-12's to settle (`WORK-QUEUE.md` §5, S-12: store the
served `week_points` at lock), but it grades both on one row set and proves `headToHead` gives
C-01's number on C-01's rows (§5.6). For that it reuses C-01's exported readers instead of reading
the tables itself: `servedSnapshots` (`:354`, table `weekly_prediction_snapshots`, writer
`captureWeeklyPredictions`, `server/services/weekly-learning.js:49`, insert `:63`), `espnProjections`
(`:365`), `replayWindow` (`:293`), `substitute` (`:338`) and `STARTABLE_PPR` (`:76`).

## 2. RED and GREEN

Test file `test/historical-consensus-head-to-head.test.js`. Command for every run:
`GRIDIRON_DB_PATH="$(mktemp -u "${TMPDIR:-/tmp}/gridiron-test-XXXXXX").sqlite" SCHEDULER_DISABLED=1 NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks --test --test-reporter=tap test/historical-consensus-head-to-head.test.js`

| Step | Commit | Result |
|---|---|---|
| pre-registration | `b635345b` docs: pre-register HX-01, our served start/sit number against consensus on 2022-2024, before any number | docs only; an ancestor of every number below |
| RED 1 | `5cfc289f` test: HX-01's consensus arm and served rows must use C-01's instrument and the served chain (RED) | Whole file fails: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/scripts/consensus-arm.mjs' imported from …/test/historical-consensus-head-to-head.test.js` (`# tests 1`, `# fail 1`) |
| GREEN 1 | `719ff584` feat: HX-01 consensus arm, served-row library and runner for the historical head-to-head (GREEN) | 25 / 25 pass. The round-1 numbers were produced on this commit (tree `51d5c6a3`). |
| result | `c100bf91` docs: HX-01 result - FantasyPros consensus beat our served start/sit number in every graded season, band and position | the output file, the evidence and ledger rows `F001`-`F007`, in one commit |
| RED 2 | `080ecf1c` test: the week W-1 team, the availability cutoff and the consensus join belong to the tested library, not the runner (RED) | 23 pass, 5 fail: `not ok 11 - withConsensus joins the consensus value …` — `error: 'arm.withConsensus is not a function'`; `not ok 18 - the served chain is the served functions, not copies` (`SERVED_CHAIN.weeklyAvailability` undefined); `not ok 24`, `26`, `27` (servedWeekRows) — `error: "Cannot read properties of undefined (reading 'get')"` |
| GREEN 2 | `789e18ac` feat: servedWeekRows owns the week W-1 team and the availability cutoff; withConsensus owns the join (GREEN) | 28 / 28 pass |
| test fix | `a3a37b7f` test: pin the pair-accuracy interval's sign, the rounding before the lift, a zero chance to play and resolver errors (kills M19, L3, L4, L11) | 32 / 32 pass; tests only |
| refactor | `b2349397` refactor: drop the instrument control's redundant n > 0 guard (sweep 1 survivor M26) | 32 / 32 pass. The round-1 numbers reproduced on this commit (tree `b3bacad5`). |
| merge (round 3) | `bbe9e6cd` chore: merge C-01's current head (a1447095, PR #160) so HX-01 grades with the post-ruling instrument and carries no pre-ruling panel | clean merge, tree `ce88f089`; 32 / 32 pass |
| RED 3 | `eed41c6a` test: servedWeekRows owns the walk-forward fit and the week of every lift read; the game-date key, the pair-accuracy clustering and C-01's startable line are pinned (RED) | 33 pass, 6 fail. `not ok 10 - gameDateLookup keys each game date by season, week and team …` — `error: 'arm.gameDateLookup is not a function'`. `not ok 17 - headToHead defaults to C-01's startable line, and on C-01's rows gives C-01's served-vs-ESPN grade (one producer)` — pairs, agreement and pair accuracy `[28, 0.5714, 0.4286, 0.4286]` where C-01's gate gives `[15, 0.5333, 0.4667, 0.6667]`. `not ok 30 - servedWeekRows takes its fit from the walk-forward registry and refuses one that does not end before the season (skeptic X3)` — `error: 'Missing expected exception.'` at `:481` (a fit through 2024 was allowed to grade 2024). `not ok 31 - servedWeekRows hands the registered fit to constructArms …` — `fitS === FIT`, `fitE === FIT` came back `false, false`. `not ok 33 - servedWeekRows stops when OURS was not lifted by the lift constructArms read …` — `error: 'Missing expected exception.'`. `not ok 38 - the pre-registered coordinator starts its examples at 2021 …` — `undefined` where `2021` was expected |
| GREEN 3 | `f9f75376` feat: servedWeekRows takes the walk-forward fit itself and parity-checks both lift reads; headToHead defaults to C-01's startable line; gameDateLookup owns the leak guard's key (GREEN) | 39 / 39 pass |
| feat | `ed0d3b0a` feat: the runner reports the coordinator's k-excluded share, a post-hoc served-recipe sensitivity, and the forward arm as a replay graded beside C-01's arm on the same rows | runner only; 39 / 39 |
| refactor | `d74d846e` refactor: C-01's instrument applies the pair line to every row, and the runner's call sites get known-nonzero stops | 39 / 39. Sweep 3 ran on this commit (tree `d3ef1527`) |
| test fix | `0ef2d336` test: a kicker pair is not a start/sit pair for the consensus arm either (kills sweep 3 survivor T6) | 39 / 39; tests only |
| docs | `d0aa396b` docs: the served-chain citations follow trade-engine.js after main's merge (lines 327, 371, 384, 474) | comments and one test name. **Section 5's numbers were produced on this commit** (tree `db6f2c94`) |

RED 2 exists because sweep 1 left the runner's two call sites as standing rows (section 4, R1
and R2); the test fix and the refactor close sweep 1's survivors. RED 3 exists because four
skeptics found the fit handoff, the lift week, the game-date key, the pair-accuracy clustering and
C-01's pair line unpinned (section 4b). The X2 and "every lift at the graded week" assertions pass
on the old code too; their liveness proof is the named mutants that die in sweep 3 (X1, X1b, X2).

## 3. What it does

- **`scripts/consensus-arm.mjs`, the reusable consensus arm.** Hand it rows of one shape
  (`season, week, position, player_id, actual` and one value per arm, "higher = start"; a rank
  enters as −rank) and name a policy arm and a baseline arm. It forms every same-week,
  same-position pair, scores both arms' pair accuracy on `startSitPairAccuracy`'s rule (with a
  player-clustered interval on the difference from C-01's `pigeonholeBootstrap`), hands the
  disagreements to C-01's `startSitDecisions` and `gradeDecisions`, and applies the
  pre-registered verdict. It also maps FantasyPros' dated scrapes to NFL weeks, drops every
  player whose game was on or before the scrape (the leak guard), drops the held-out season
  before any id is looked up, builds the common pair set, and runs the Holm family and the
  oracle/identity control, and `withConsensus` joins a consensus value on season, week and
  player. `gameDateLookup` keys each game date by season, week and team for the leak guard (two
  dates for one team-week stop). **The pair line:** `headToHead` hands every row to C-01's
  `startSitDecisions` with a threshold that defaults to C-01's startable line (`STARTABLE_PPR`,
  8.0, `start-sit-gate.js:76`) and scores pair accuracy on the same filter (skill position, both
  arms and the actual finite, both arms at the line); a pair-count check stops if the two ever
  part. So `headToHead(rows, 'policy', 'baseline')` on C-01's forward rows gives C-01's
  served-vs-ESPN grade exactly (test 17, on a seeded copy of C-01's two tables, and the run's
  reconciliation, §5.6). The historical grade's sets are already common sets, so the runner passes
  `threshold: -Infinity`, which reproduces round 1 exactly. S-03 can call it with its candidate
  projection as the policy.
- **`scripts/historical-consensus-lib.mjs`, the served rows.** For each graded week it calls the
  served chain: S-02's `constructArms` (engine → experts → coordinator → lift), the served
  `weeklyAvailability(season, week, { through: season - 1 })`, trade-engine.js's rounding and
  default chance to play, and the served `startSitWeekPoints`. It takes the walk-forward
  registry, not a fit: `gradingFit` inside it refuses a fit whose cutoff is not before the season,
  and that fit goes to `constructArms` as fitS and fitE; each row carries its `fit_through`. Both
  lift reads (B for the parity check, then OURS) go through one call at the graded season and week,
  and two parity checks stop the run: D must be what `startSitWeekPoints` makes of B, and OURS
  must be current_week_ppg times the lift `constructArms` read. Each row carries the team he played
  for in week W−1 (the only team known before the week, which the bye rule and the leak guard
  read). It also holds the walk-forward coordinator registry, the k control per season, the 2025
  refusal, and the two coordinator starts (`PREREGISTERED_COORDINATOR_FROM` 2021,
  `SERVED_COORDINATOR_FROM` 2022, the latter pinned to `fantasy-coordinator.js` by a test).
- **`scripts/historical-consensus-head-to-head.mjs`, the runner.** `--smoke` prints counts and no
  metric; `--full` refuses to run unless the pre-registration is committed and unchanged, and
  writes aggregates only to `docs/evidence/2026-09-22/historical-consensus-head-to-head-output.json`.
  Round 3 adds known-nonzero stops for its own call sites (a season whose leak guard drops no
  row, a row with a known team and no game date, a season graded through weeks 5-14 that removes
  no bye, a season where no row's B differs from A, a graded season with no common-set row, a
  pooled cell whose pair count is not `startSitPairAccuracy`'s) and four report-only sections:
  `coordinator.rows_from_k_excluded_seasons`, `sensitivity.coordinator_served_recipe`,
  `forward.what_ours_is` / `forward.same_rows`, and `forward.c01_reconciliation` (the run stops
  if `headToHead` on C-01's rows is not C-01's grade).
- It reads no leagues column beyond `league_roster_snapshots` (through C-01's
  `espnProjections`), writes nothing to the app database, and adds no table, column, route or
  job.
- **Tables it reads, with their writers** (all read on the local copy, never written):
  `player_week_usage` (`syncWeeklyUsage`, `server/services/nflverse.js:245`, insert `:260`);
  `game_lines` (`syncHistoricalLinesImpl`, `server/services/gamescript.js:42`, insert `:55`, and
  `syncCurrentLines`, `:119`, insert `:134`), read for game dates and by the served lift;
  `nfl_injuries` (`syncInjuries`, `server/services/nfl-advanced.js:358`, insert `:359`), read by
  the served `weeklyAvailability`; `nfl_availability_rates` (`scripts/fit-availability.mjs:414`);
  `league_roster_snapshots` (`writePeriod`, `scripts/collect-roster-snapshots.mjs:109`, insert
  `:113`), 2026 only; `fantasy_coordinator_fits` (`saveFantasyCoordinatorFit`,
  `server/services/fantasy-coordinator.js:368`, insert `:370`); `weekly_ensemble_fits`
  (`saveWeeklyFit`, `server/services/weekly-weight-store.js:140`, insert `:147`);
  `shrinkage_fits` (`saveFit`, `server/services/shrinkage-fit.js:400`); and `players` for the
  gsis id join. The FantasyPros export and the id map are local files under `.local-db/`, not
  tables.

## 4. Mutation sweep

**Sweep 1**, on `719ff584` (GREEN), in a detached worktree of that commit. Harness: a Python
script that swaps one exact string (it must occur exactly once, else NOT-APPLIED), runs the
test file, and restores the file byte for byte; `git status` clean after. Baseline 25 / 0.

| # | Mutant | Result (pass / fail) |
|---|---|---|
| M1 | week band edge 8 → 9 | killed (24 / 1) |
| M2 | a non-numeric ECR is kept | killed (24 / 1) |
| M3 | an escaped CSV quote is dropped | killed (24 / 1) |
| M4 | postseason weeks enter the week bounds | killed (24 / 1) |
| M5 | scrape window 7 → 8 days | killed (24 / 1) |
| M6 | an unknown previous week no longer blocks the mapping | killed (23 / 2) |
| M7 | a scrape on the last game day maps to the next week | killed (24 / 1) |
| M8 | the held-out season reaches the id join | killed (24 / 1) |
| M9 | an older scrape of the week is kept | killed (24 / 1) |
| M10 | rank enters as higher = start | killed (24 / 1) |
| M11 | a player ranked on another position's page is kept | killed (24 / 1) |
| M12 | leak guard lets a game on the scrape date through | killed (24 / 1) |
| M13 | the threshold becomes strict | killed (24 / 1) |
| M14 | an unranked player enters the pair set | killed (24 / 1) |
| M15 | a tie in the arm scores as a call | killed (22 / 3) |
| M16 | **call site:** C-01's `startSitDecisions` gets the arms swapped | killed (22 / 3) |
| M17 | **call site:** C-01 re-thresholds the common set (`threshold: 8`) | killed (22 / 3) |
| M18 | **call site:** one disagreement is not handed to `gradeDecisions` | killed (24 / 1) |
| M19 | the pair-accuracy interval is oriented baseline − policy | **survived** (25 / 0) → fixed, section 4a |
| M20 | "ahead" without the win-rate bound | killed (24 / 1) |
| M21 | "behind" when the bound touches 0 | killed (24 / 1) |
| M22 | one-sided p | killed (24 / 1) |
| M23 | raw p instead of the Holm-adjusted p | killed (24 / 1) |
| M24 | a cell with no p counts as p = 0 in Holm | killed (24 / 1) |
| M25 | the oracle is not the actual points | killed (24 / 1) |
| M26 | `o.n > 0 &&` dropped from the control's pass rule | **survived** (25 / 0): redundant, since a win rate of 1 already needs n > 0; predicted before the run → code simplified, section 4a |
| M27 | band cells keyed by week | killed (24 / 1) |
| M28 | breakout cells keep the weekly table | killed (24 / 1) |
| L1 | default chance to play 0.92 → 0.9 | killed (23 / 2) |
| L2 | `THIS_GAME_MULT` 1 → 1.02 | killed (23 / 2) |
| L3 | `current_week_ppg` not rounded as trade-engine.js:449 | **survived** (25 / 0) → fixed, section 4a |
| L4 | `??` → `\|\|`: an OUT player (p = 0) gets the default 0.92 | **survived** (25 / 0) → fixed, section 4a |
| L5 | non-decision rows enter | killed (24 / 1) |
| L6 | **call site:** the lift keyed on `proj.team_abbr` | killed (24 / 1) |
| L7 | the lift parity stop removed | killed (24 / 1) |
| L8 | the season average reads `last3` | killed (24 / 1) |
| L9 | **designed survivor:** `lambda: 1` → `0` in the `constructArms` call (λ only moves arm S3, which HX-01 never reads) | **survived** (25 / 0), as designed |
| L10 | 2025 passes the holdout guard | killed (24 / 1) |
| L11 | any error from the k resolver becomes an exclusion | **survived** (25 / 0) → fixed, section 4a |
| L12 | the coordinator fit sees the graded season | killed (24 / 1) |
| L13 | an unready coordinator fit is registered | killed (24 / 1) |
| L14 | `gradingFit` does not re-check the cutoff | killed (24 / 1) |
| L15 | a null team is mapped | killed (24 / 1) |
| L16 | an edited pre-registration is accepted | killed (24 / 1) |
| NA1 | **designed not-applied control:** an anchor absent from the file | reported NOT-APPLIED, not counted |

Runner call sites on `719ff584` (the unit suite does not execute the runner, so these were
standing rows): **R1** the leak guard and bye rule read the player's week W−1 team, built in the
runner (`teamAt.get(… week - 1)`); a mutant reading week W's team would use a team known only
after the game. **R2** the runner calls `weeklyAvailability(season, week, { through: season - 1 })`;
a mutant passing `through: season` lets the graded season's games into the durability prior.
Both are moved into the tested library in section 4a.

### 4a. The fixes and sweep 2

| Sweep 1 survivor | Fix | Sweep 2 |
|---|---|---|
| M19 (pair-accuracy interval sign) | test: a policy that is right on every pair and a baseline wrong on every pair must give difference 1 and interval [1, 1] (`a3a37b7f`) | killed (31 / 1) |
| L3 (rounding before the lift) | test: B × p = 8.0049 must round to 8.00 before the 1.25 lift, giving 10, not 10.01 (`a3a37b7f`) | killed (31 / 1) |
| L4 (`??` vs `\|\|`) | test: a chance to play of 0 is valued 0, not 0.92 (`a3a37b7f`) | killed (31 / 1) |
| L11 (resolver errors) | test: an error that is not a k-control failure propagates (`a3a37b7f`) | killed (31 / 1) |
| M26 (redundant guard) | code: the guard removed (`b2349397`) | the mutant no longer applies; M29 below replaces it |
| R1, R2 (runner call sites) | RED 2 / GREEN 2 (`080ecf1c`, `789e18ac`): both now live in `servedWeekRows` | R1, R2 killed below |

**Sweep 2**, on `b2349397` (tree `b3bacad5`), same harness, 49 mutants: every sweep-1 mutant
except M26 and the old NA1, plus:

| # | Mutant | Result |
|---|---|---|
| R1 | **call site:** `team_prev` read at week W instead of W−1 | killed (31 / 1) |
| R2 | **call site:** `weeklyAvailability(..., { through: season })` | killed (31 / 1) |
| R3 | **call site:** `withConsensus` joins last week's value | killed (31 / 1) |
| R4 | the served availability is not called (empty map) | killed (28 / 4) |
| M29 | the identity half of the control's pass rule dropped | **survived** (32 / 0): a baseline graded against itself cannot disagree while C-01's `startSitDecisions` is correct, so no input reaches it; it is a runtime guard on the instrument, named in pre-registration §8.4, and kept |
| L9 | **designed survivor** (as sweep 1) | survived (32 / 0), as designed |
| NA1 | **designed not-applied control** | NOT-APPLIED |

Baseline 32 / 0. All 49 rows came out as expected: 46 killed (every sweep-1 kill again, plus
M19, L3, L4, L11 and R1-R4), 2 explained survivors, 1 not applied; `git status` clean after.

**Standing rows after sweep 2 (runner glue the unit suite does not execute):** R5, the leak
guard's game-date key (`gameDate.get(\`${w}|${t}\`)`); R6, the `removeByes` call on the season's
usage rows; R7, the graded weeks read from the scrape map (`weeksOf`). Round 3 moved R5's key into
the tested library (`gameDateLookup`, section 4b) and gave R5 and R6 run-time stops.

### 4b. Round 3: the skeptics' mutants and sweep 3

A test-liveness skeptic showed five mutants surviving 32 / 32 on `9daa56d7` (X1 second lift read
at week W−1, X2 one-player clustering of the pair-accuracy interval, X3 the served coordinator
handed to the grade, X4 the game-date key shifted a week, X5 `fitS: null`). RED 3 / GREEN 3
(section 2) moved the fit handoff into `servedWeekRows`, made both lift reads one call with two
parity stops, made the fakes record and key the lift by week, moved the game-date key into
`gameDateLookup`, and pinned the clustering against a direct `pigeonholeBootstrap` call. A
structure skeptic showed `headToHead` could not give C-01's number on C-01's rows; its line now
defaults to C-01's.

**Sweep 3**, on `d74d846e` (tree `d3ef1527`), same harness (swap one exact string, which must
occur exactly once, else NOT-APPLIED; run the file; restore byte for byte), in a detached worktree
of that commit. Baseline 39 / 0. 67 mutants: every sweep-2 mutant (4 anchors rewritten for the
new code: M17, L6, L7, L9) plus:

| # | Mutant | Result (pass / fail) |
|---|---|---|
| X1 | skeptic X1: both lift reads at week W−1 | killed (33 / 6) |
| X1b | both lift reads in the season before | killed (38 / 1) |
| X5 | skeptic X5: `constructArms` gets `fitS: null` (B silently becomes A) | killed (38 / 1) |
| X5b | `constructArms` gets `fitE: null` | killed (38 / 1) |
| X3 | skeptic X3: `registry.get(season)` instead of `gradingFit(registry, season)` | killed (38 / 1) |
| P2 | the second lift-parity stop removed | killed (38 / 1) |
| FT | rows stop carrying `fit_through` | killed (38 / 1) |
| X4 | skeptic X4: a game date filed under the next week | killed (38 / 1) |
| X4b | the leak guard reads the next week's game date | killed (38 / 1) |
| X4c | the leak guard reads the season before | killed (38 / 1) |
| X4d | two dates for one team-week: the later row wins silently | killed (38 / 1) |
| X2 | skeptic X2: the pair-accuracy interval clusters on one player of each pair | killed (38 / 1) |
| T1 | `headToHead`'s default line is none instead of `STARTABLE_PPR` | killed (38 / 1) |
| T2 | **call site:** C-01's `startSitDecisions` is not handed the line | killed (38 / 1) |
| T3 | the pair-accuracy filter drops the baseline's line | killed (38 / 1) |
| T4 | the reported line serialises −Infinity as a number | killed (38 / 1) |
| T5 | breakout cells drop the caller's options (the line among them) | killed (38 / 1) |
| T6 | a kicker pair enters the pair-accuracy score | **survived** (39 / 0), predicted before the run (no test handed `headToHead` a non-skill row) → test `0ef2d336` → killed (38 / 1) on re-run |
| M17 | **call site:** C-01 applies its 8.0 line whatever the caller asked (rewritten anchor) | killed (34 / 5) |
| L6 | **call site:** both lift reads keyed on `proj.team_abbr` (rewritten anchor) | killed (33 / 6) |
| L7 | the first lift-parity stop removed (rewritten anchor) | killed (38 / 1) |
| L9 | **designed survivor** (rewritten anchor) | survived (39 / 0), as designed |
| M29 | as sweep 2 | survived (39 / 0), explained in section 4a |
| NA1 | **designed not-applied control** | NOT-APPLIED |

All 67 came out as expected except T6: 63 killed, L9 and M29 the two explained survivors, T6
fixed, NA1 not applied; `git status` clean after the sweep. The T6 re-run used `0ef2d336`'s test
file (baseline 39 / 0; L9 still survived, NA1 still not applied).

**Standing rows after round 3 (runner glue the unit suite does not execute), each with the run-time
stop that now catches it:** R5, the rows handed to `gameDateLookup` (`WHERE season = ?`): the run
stops when a season's leak guard drops no row or a row with a known team has no game date. R6,
the usage rows handed to `removeByes`: stops when a season graded through weeks 5-14 removes no
bye. R7, the graded weeks (`weeksOf`): printed per season (section 5.1). R8, the runner's pair
line (`threshold: -Infinity` on its common sets): stops when a pooled cell's pair count is not
`startSitPairAccuracy`'s. R9, the registry handed to `servedWeekRows`: `gradingFit` inside it
refuses a fit that has seen the season, and a season whose rows all have B = A stops. On this run
the stops' known-nonzero counts were: every graded week dropped at least one Thursday player
(2022 387, 2023 432, 2024 422 in all, 2026 week 2 23), 0 undated rows with a known team, byes
removed 374 / 337 / 343, and B ≠ A on 5,206 of 5,207 / 5,205 of 5,206 / 4,545 of 4,545 decision
rows (2026 week 2: 360 of 360).

## 5. The numbers

**Local copy, not production.** A `sqlite3 .backup` of `~/gridiron-local/data.sqlite` taken
2026-09-22 23:13:57Z (sha256 prefix `d21e0f72fd02081e`, the same before and after the run).
Command (round 3: tree `db6f2c94`, commit `d0aa396b`; pre-registration `b635345b`, blob
`187c29cb`):

```
GRIDIRON_DB_PATH=$PWD/.local-db/data.sqlite SCHEDULER_DISABLED=1 NFL_SEASON=2026 \
  node --max-old-space-size=3072 scripts/historical-consensus-head-to-head.mjs --full
```

598 seconds (2026-09-23 02:03:35Z to 02:13:33Z), exit 0. Every number in this section is read
from `docs/evidence/2026-09-22/historical-consensus-head-to-head-output.json`, written by that run.
**Against round 1** (the same command on `719ff584`, tree `51d5c6a3`, 787 seconds; reproduced then
on `b2349397`, tree `b3bacad5`, 0 differing paths): a JSON walk over both outputs, tree and
timestamps aside, finds 26 of round 1's 5,455 values changed, 0 removed and 187 added. The 26: A7's
week-clustered interval, now null with its note, in the 8 cells that hold one week (the 7 forward
cells and `by_season_band['2024 2-4']`; 3 values each), the served coordinator's row count (null →
23,334) and the rewritten coordinator note. The 187 added are the round-3 keys (`pair_threshold` on
every cell, `coordinator_moved` in every census row, the coordinator scope, `sensitivity`,
`forward.what_ours_is`, `forward.labels`, `forward.same_rows`, `forward.results.ours_vs_espn_c01_rule`,
`forward.c01_reconciliation`). Every pre-registered number below is therefore round 1's.
FantasyPros export: `.local-db/fp-ecr-weekly-wp.csv`, sha256 `005332bb…c8a0`, 29,272 rows, made
by:

```
python3.12 -c "import pandas as pd; e=pd.read_parquet('$HOME/gridiron-local/rnd/loop/data/dp/fpecr_weekly_wp.parquet', columns=['page_type','scrape_date','id','player','pos','team','ecr']); e=e[e.page_type.isin(['weekly-qb','weekly-rb','weekly-wr','weekly-te'])].copy(); d=pd.to_datetime(e.scrape_date.astype(str)); k=((d>='2021-08-01')&(d<='2025-02-28'))|((d>='2026-08-01')&(d<='2026-12-31')); e=e[k]; e['scrape_date']=d[k].dt.strftime('%Y-%m-%d'); e.to_csv('.local-db/fp-ecr-weekly-wp.csv', index=False)"
```

(the calendar window drops the whole 2025 season before anything reads it). Id map:
`.local-db/db_playerids.csv`, sha256 `36016b92…9ca4`, copied from
`~/gridiron-local/rnd/loop/data/dp/`.

Sign convention everywhere: policy − baseline; the policy is OURS unless a row says otherwise.
Positive points per disagreement, a win rate above 0.5 and a positive pair-accuracy difference
favour the policy. Brackets are player-clustered 90% intervals unless marked "week".

### 5.0 The answer

**No. Our served start/sit number did not beat FantasyPros' consensus in any graded season, week
band or position.** Consensus was ahead in all 11 "where" cells, each surviving Holm at family
α = 0.10, and in the pooled 2022-2024 cell. When the two disagreed, our pick outscored
consensus's pick 42.2% of the time [40.7%, 43.8%], and lost 1.86 points per disagreement
[−2.22, −1.47] (week-clustered [−2.12, −1.57]). Pair accuracy: ours 0.635, consensus 0.666
(difference −0.031 [−0.038, −0.025]). Our number was ahead in 5 of the 46 graded weeks
(2023 W7, 2023 W14, 2024 W13, 2024 W15, 2024 W17) and behind in 41.

- **Where the gap is biggest:** weeks 2-4 (−2.41 points per disagreement) and quarterbacks
  (−2.77). **Smallest:** weeks 14-18 (−1.46) and tight ends (−1.29). These are point-estimate
  orderings; the intervals overlap (weeks 2-4 [−3.19, −1.65] against 14-18 [−2.29, −0.61]; QB
  [−3.65, −1.91] against TE [−2.16, −0.49]). By season, descriptive only (no trend test):
  2022 −2.14 [−2.70, −1.60], 2023 −1.83 [−2.53, −1.15], 2024 −1.49 [−2.14, −0.84]. The seasons are
  not like for like: weeks 2-4 are 30.1% of 2022's disagreements and 35.9% of 2023's but 10.6% of
  2024's (no 2024 week 2-3 scrape). On weeks 5-17 alone (no week-18 scrape) the n-weighted means are −1.84, −1.67 and
  −1.43 (from `results.primary.ours_vs_consensus.by_season_band`).
- **The clean check agrees.** Arm D (no availability; every fit ends at or before 2023) against
  consensus in 2024: −1.79 [−2.48, −1.09], consensus ahead. The in-sample pieces of §4 of the
  pre-registration are expected to flatter OURS, and it lost anyway.
- **Against the dumb rules:** our number beats the last-3 average everywhere it can be told
  apart (pooled +1.34 [+0.90, +1.75]). It beats the season average pooled (+0.50
  [+0.12, +0.87]) but in no single season, band or position after Holm, and **not at all among
  players who played** (+0.12 [−0.26, +0.51]) or at the 8.0 startable line (−0.06
  [−0.67, +0.51]). The edge appears only when a player who sat counts as 0, so it most likely
  comes from the chance-to-play factor, not from ordering players who play any better (an
  inference from the two populations, not a separate test).
- **2026 week 2 (forward, one week, an anecdote):** the arm graded there is OURS-replay, the
  copy's current chain replayed after the fact, not a number production is known to have served
  (section 5.6). It is not distinguishable from consensus (−0.41 [−2.29, +1.36]) or from ESPN
  (−0.29 [−2.10, +1.52]). On one row set, the projection the app saved before the week (the arm
  C-01 grades) lost to ESPN (−3.91 [−7.69, −0.18]) and OURS-replay did not (+0.86 [−3.00, +4.58]);
  most of that gap is the weight set, not the rest of the chain.

What this means for the plan: the historical baseline a user actually has (consensus) is the bar,
not the season average. S-03 should be graded against consensus with this arm.

### 5.1 Configuration, controls and the join

- **Configuration B:** `buildPlayerWeekEngine` (`player-week-engine.js:256`), `roleRecency`
  `WEEKLY_ROLE_RECENCY` hardcoded at `:273`, `kOverride` omitted. **k control**
  (`target_share.ALL`): 2022 1.0532, 2023 0.4605, 2024 0.2747, 2026 0.1733. **2021 excluded:**
  "k control failed for predicting 2021: target_share.ALL = missing" (no volume fit can end
  before 2021 on this copy). Weight sets (`activeWeeklyWeightSet`, weeks 2 and 6): `frozen-2023`
  for 2022-2024, `fit-2` for 2026.
- **Coordinator fits** (walk-forward, `fitFantasyCoordinator` on `buildFantasyCoordinatorExamples`
  from 2021, as pre-registered): 2022 ← 2021 (5,280 rows, intercept +0.250), 2023 ← 2021-2022
  (11,029, −0.154), 2024 ← 2021-2023 (16,793, −0.339), 2026 ← the served fit 7 (23,334 rows through
  2025, −0.555). The per-season example counts for 2022 (5,749) and 2023 (5,764) equal S-02's
  committed counts (`weekly-construction-grade-output.json`, `examples`). **The k control over the
  example seasons** passes 2022 (1.0532) and 2023 (0.4605) and excludes 2021 ("target_share.ALL =
  missing"), so the share of each fit's rows built under the hand-set k is 2022 100%, 2023 47.9%,
  2024 31.4% (section 6.2; the served recipe's sensitivity is section 5.8).
- **Round-3 run-time controls** (section 4b): every season's fit reached `constructArms` (B ≠ A
  on 5,206 of 5,207, 5,205 of 5,206 and 4,545 of 4,545 decision rows; 2026 week 2 360 of 360);
  one coordinator cutoff per season (2022 ← 2021, 2023 ← 2022, 2024 ← 2023, 2026 ← 2025, each
  checked inside `servedWeekRows`); every pooled cell's pair count equals `startSitPairAccuracy`'s
  (115,514).
- **Instrument control:** the oracle against consensus had 38,237 disagreements, won all of
  them (+7.18 points each); against OURS, 41,755, all won (+7.58). Consensus against itself and
  OURS against itself: 0 disagreements. Passed.
- **Pair-accuracy parity:** for all five point arms, the pair accuracy on each season's common
  set equals `startSitPairAccuracy` (tolerance 1e-12): 2022 43,836 pairs, 2023 41,142, 2024
  30,536.
- **Served parity:** every graded row's D equals `startSitWeekPoints` on B (the run would have
  stopped otherwise); `matchupSignalActive()` false, so `thisGame.mult` = 1.
- **The consensus join:** 29,272 rows parsed; 1,154 not the week's latest scrape; 268 with no id
  mapping; 312 ranked on a page other than the app's position; 0 duplicates; 27,538 kept
  (2021: 17 weeks, 7,100 rows; 2022: 16, 6,918; 2023: 16, 6,701; 2024: 14, 5,675; 2026: 2,
  1,144). Every selected scrape is a Friday except 2021 week 14 (a Saturday; 2021 is not
  graded). **Weeks graded:** 2022 weeks 2-17, 2023 weeks 2-17, 2024 weeks 4-17: the parquet as the
  R&D loop pulled it has no January scrape (so no week 18 in any season) and no 2024 scrape before
  September 27 (so no 2024 weeks 2-3). **Name check:** of 1,285
  FantasyPros ids with a mapping, 1,269 (0.9875) carry a name that
  `normalizePlayerName` matches to the app's.
- **Rows** (decision rows → byes removed → leak guard → with a consensus rank):

| Season | Decision rows | Byes removed | Game on/before the scrape | Kept | With consensus |
|---|---|---|---|---|---|
| 2022 | 5,207 | 374 | 387 | 4,446 | 4,281 |
| 2023 | 5,206 | 337 | 432 | 4,437 | 4,260 |
| 2024 | 4,545 | 343 | 422 | 3,780 | 3,635 |
| 2026 W2 | 360 | 0 | 23 | 337 | 329 |

  Common pair set (every point arm ≥ 4.0, consensus-ranked), 2022-2024: **5,996 player-weeks**
  (played-only 5,811; at 8.0, 2,892).

### 5.2 OURS against consensus (H1, primary population: DNP scored 0)

| Cell | Pairs | Pair accuracy ours / consensus | Difference | Disagreements | Our win rate | Points per disagreement | MDE80 (points) | Holm p | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| **2022-2024** | 115,514 | 0.6347 / 0.6656 | −0.0309 [−0.0375, −0.0251] | 22,659 | 0.4217 [0.4065, 0.4376] | −1.8558 [−2.2242, −1.4686] | 0.574 | — | consensus ahead |
| 2022 | 43,836 | 0.6344 / 0.6710 | −0.0366 [−0.0467, −0.0262] | 8,577 | 0.4068 [0.3828, 0.4300] | −2.1397 [−2.6951, −1.6015] | 0.817 | 8.1e-10 | consensus ahead |
| 2023 | 41,142 | 0.6357 / 0.6651 | −0.0293 [−0.0399, −0.0192] | 7,997 | 0.4248 [0.3996, 0.4512] | −1.8300 [−2.5305, −1.1459] | 1.040 | 7.3e-5 | consensus ahead |
| 2024 | 30,536 | 0.6339 / 0.6586 | −0.0247 [−0.0360, −0.0137] | 6,085 | 0.4387 [0.4112, 0.4672] | −1.4895 [−2.1402, −0.8361] | 0.966 | 3.8e-4 | consensus ahead |
| weeks 2-4 | 26,048 | 0.6065 / 0.6548 | −0.0483 [−0.0627, −0.0347] | 6,096 | 0.3970 [0.3668, 0.4262] | −2.4133 [−3.1936, −1.6450] | 1.170 | 2.3e-6 | consensus ahead |
| weeks 5-8 | 29,580 | 0.6441 / 0.6729 | −0.0289 [−0.0402, −0.0168] | 5,552 | 0.4236 [0.3927, 0.4541] | −1.8342 [−2.5820, −1.1233] | 1.106 | 1.5e-4 | consensus ahead |
| weeks 9-13 | 29,793 | 0.6411 / 0.6682 | −0.0271 [−0.0388, −0.0154] | 5,542 | 0.4274 [0.3979, 0.4574] | −1.6586 [−2.2903, −1.0106] | 0.967 | 9.9e-5 | consensus ahead |
| weeks 14-18 | 30,093 | 0.6437 / 0.6652 | −0.0214 [−0.0334, −0.0096] | 5,469 | 0.4417 [0.4102, 0.4730] | −1.4561 [−2.2914, −0.6107] | 1.280 | 0.0094 | consensus ahead |
| QB | 11,468 | 0.6213 / 0.6736 | −0.0522 [−0.0739, −0.0334] | 2,768 | 0.3923 [0.3573, 0.4287] | −2.7686 [−3.6496, −1.9110] | 1.313 | 1.4e-6 | consensus ahead |
| RB | 28,756 | 0.6423 / 0.6746 | −0.0323 [−0.0435, −0.0215] | 5,792 | 0.4202 [0.3931, 0.4470] | −2.0392 [−2.6810, −1.4013] | 0.960 | 1.3e-6 | consensus ahead |
| WR | 67,590 | 0.6378 / 0.6648 | −0.0271 [−0.0357, −0.0187] | 12,523 | 0.4274 [0.4042, 0.4488] | −1.6405 [−2.2237, −1.0919] | 0.852 | 1.2e-5 | consensus ahead |
| TE | 7,700 | 0.5999 / 0.6269 | −0.0271 [−0.0467, −0.0098] | 1,576 | 0.4340 [0.3897, 0.4754] | −1.2892 [−2.1571, −0.4923] | 1.245 | 0.010 | consensus ahead |

Week-clustered intervals for the pooled cell: win rate [0.4106, 0.4328], points
[−2.1200, −1.5735].

**MDE, declared against realised** (`STATS-METHOD.md` rule 4). Declared as guesses in the
pre-registration (§9): pooled ±0.02 win rate and ±0.3 points; one season ±0.035 and ±0.5; one
cell up to ±0.06 and ±1.0. Realised MDE80 (1.6449 + 0.8416 times the player-clustered SE):
pooled 0.023 and 0.574; seasons 0.036-0.042 and 0.82-1.04; cells 0.034-0.065 and 0.85-1.31.
The points guess was about half the realised value (the player-clustered SE is larger than the
guess assumed); the win-rate guesses held. In every consensus-ahead cell |points| exceeds MDE80,
TE only barely (1.29 / 1.245 = 1.04; pooled 3.2). The season × band and season × position tables
are in the output file (`results.primary.ours_vs_consensus.by_season_band`, `.by_season_position`),
report-only. One of them, `2024 2-4`, holds a single graded week (2024 week 4), so its
week-clustered interval is null with C-01's A7 note; round 1 printed a one-point "interval" there.
(Round 3 also corrects this table's weeks 2-4 Holm p from 2.4e-6 to 2.3e-6: the output's value is
2.35e-6, unchanged; round 1 rounded it up.)

### 5.3 The dumb rules (H2, same pairs)

| Comparison | Pooled points per disagreement | Our win rate | Pair accuracy (policy / baseline) | Verdict | Holm (11 cells) |
|---|---|---|---|---|---|
| OURS vs season average | +0.4961 [+0.1182, +0.8725] (week [+0.1834, +0.7817]); 21,786 disagreements | 0.5232 [0.5083, 0.5384] | 0.6347 / 0.6260 | ours ahead | no cell survives; by season 2022 +0.57 (ahead, raw), 2023 +0.57 (n.d.), 2024 +0.28 (n.d.); weeks 14-18 −0.42 (n.d.) |
| OURS vs last-3 average | +1.3353 [+0.9012, +1.7511]; 26,201 | 0.5550 [0.5387, 0.5704] | 0.6347 / 0.6098 | ours ahead | 8 of 11 ahead (every season, every band, WR); QB, RB, TE not distinguishable |
| Consensus vs season average (known-direction check) | +2.5779 [+2.2456, +2.8990]; 20,497 | consensus's 0.6114 [0.5978, 0.6248] | 0.6656 / 0.6260 | consensus ahead | not a Holm family |

The known-direction check holds: consensus beats the season average, as the R&D loop measured
on 2023-24 (+0.028 pair accuracy on played rows, a different population; here +0.040 on the
DNP-scored-0 common set).

### 5.4 Attribution and the clean check (report-only)

| Policy vs consensus | Pair accuracy (policy) | Points per disagreement | Our win rate | Verdict |
|---|---|---|---|---|
| OURS (served chain) | 0.6347 | −1.8558 [−2.2242, −1.4686] | 0.4217 | consensus ahead |
| D (no availability) | 0.6395 | −1.9418 [−2.3247, −1.5574] | 0.4129 | consensus ahead |
| A (ensemble alone) | 0.6397 | −2.0234 [−2.4176, −1.6354] | 0.4128 | consensus ahead |
| **D, 2024 only (clean)** | 0.6385 (consensus 0.6586) | −1.7881 [−2.4776, −1.0938] | 0.4291 [0.3995, 0.4608] | consensus ahead |

On the same pairs, OURS's pair accuracy is 0.0048 below D's: the chance-to-play factor reorders
enough close pairs to cost pair accuracy, while its points per disagreement against consensus
is slightly better. No interval was pre-registered for OURS vs D, so this is an observation for
S-04 (availability), not a finding.

### 5.5 The other pre-registered populations (OURS vs consensus)

| Population | Pairs | Points per disagreement | Our win rate | By season | Verdict |
|---|---|---|---|---|---|
| Both players played | 108,851 | −1.9621 [−2.3389, −1.6018] | 0.4188 [0.4035, 0.4343] | 2022 −2.24, 2023 −1.91, 2024 −1.65, each consensus ahead | consensus ahead |
| 8.0 startable line | 27,551 | −2.1544 [−2.7740, −1.5749] | 0.4288 [0.4062, 0.4509] | 2022 −2.35, 2023 −2.51, 2024 −1.54, each consensus ahead | consensus ahead |

OURS vs the season average: played-only +0.1205 [−0.2573, +0.5051] and at 8.0 −0.0563
[−0.6658, +0.5071], both not distinguishable (MDE80 0.57 and 0.87 points). OURS vs last-3:
played-only +1.0470 [+0.6007, +1.4686], at 8.0 +0.8232 [+0.1321, +1.4937], both ours ahead.

### 5.6 Forward: 2026 week 2 (one week, an anecdote)

**What OURS is here: OURS-replay** (`forward.what_ours_is`), the local copy's current chain
replayed on week 2 after the fact: weight set `fit-2` (`weekly_ensemble_fits` id 2, writer
`saveWeeklyFit`, `server/services/weekly-weight-store.js:140`, created 2026-09-18 06:45:22 UTC),
coordinator fit 7 (`fantasy_coordinator_fits`, writer `saveFantasyCoordinatorFit`,
`server/services/fantasy-coordinator.js:368`, created 2026-09-19 02:03:08 UTC, 23,334 rows through
2025) and volume k fit 1 (`shrinkage_fits`, writer `saveFit`, `server/services/shrinkage-fit.js:400`,
fitted 2026-09-18T02:52:00Z). The run checks each stamp: all three came after the projection the
app saved before the week (`weekly_prediction_snapshots`, writer `captureWeeklyPredictions`,
`server/services/weekly-learning.js:49`; 1,183 rows captured 2026-09-17T18:56:10Z, weight set
`frozen-2023`) and after the week's first kickoff (`game_lines` 2026-09-17 20:15, the nflverse
schedule's US Eastern time, 2026-09-18T00:15Z). `server/services/weekly-ensemble.js:4-11` records a
production live read with no promoted weekly fit, and says to treat fit-2's promotion date for weeks
2-4 as unknown. So OURS-replay is **not verified to be what production served**, and the
pre-registration's "the fits production serves" (§10) is wrong (section 6a, erratum 1). None of the
three fits saw a 2026 week (all end in 2025), so the read is still forward.

| Comparison | Rows / pairs | Disagreements | Win rate | Points per disagreement | MDE80 | Verdict |
|---|---|---|---|---|---|---|
| OURS-replay vs consensus (scrape 2026-09-18) | 152 / 3,201 | 837 | 0.4379 [0.3416, 0.5321] | −0.4114 [−2.2923, +1.3633] | 2.72 | not distinguishable |
| OURS-replay vs ESPN, HX-01's 4.0 common set | 124 / 2,139 | 605 | 0.4496 [0.3544, 0.5407] | −0.2871 [−2.1014, +1.5240] | 2.79 | not distinguishable |
| OURS-replay vs ESPN, HX-01's 8.0 common set (every point arm and ESPN ≥ 8.0) | 64 / 565 | 164 | 0.4512 [0.2869, 0.6000] | −0.3120 [−3.9647, +3.2052] | 5.42 | not distinguishable |
| OURS-replay vs ESPN, **C-01's rule** (OURS-replay and ESPN each ≥ 8.0) | 72 / 709 | 219 | 0.4292 [0.2973, 0.5606] | −1.2316 [−4.5917, +2.0997] | 4.97 | not distinguishable |
| OURS-replay vs season average (= last-3 in week 2) | 152 / 3,201 | 954 | 0.5860 [0.5071, 0.6677] | +3.5528 [+1.1320, +6.2563] | 3.95 | ours ahead |
| Consensus vs season average | 152 / 3,201 | 1,044 | 0.6298 [0.5513, 0.7098] | +3.5880 [+1.4463, +5.8217] | 3.30 | consensus ahead |
| ESPN vs season average | 124 / 2,139 | 790 | 0.6051 [0.5207, 0.6930] | +3.6835 [+1.1061, +6.6242] | 4.13 | ESPN ahead |

ESPN: 194 player-weeks from `league_roster_snapshots` final rows (writer `writePeriod`,
`scripts/collect-roster-snapshots.mjs:109`), 0 dropped for conflicting values. Every week-2 cell's
week-clustered interval is null with C-01's A7 note ("fewer than 2 week clusters"). HX-01's 8.0
common set holds every point arm and ESPN to 8.0; C-01's rule holds only the two arms compared, so
the pre-registration's "C-01's 8.0 threshold" (§5.3, §10) mislabelled HX-01's set (erratum 2), and
the C-01-rule row is printed beside it.

**One row set for every arm** (`forward.same_rows`; post hoc, report-only, at a skeptic's
request): the week's 360 decision rows after byes (no leak guard: ESPN's value is at lock) that have
a saved snapshot and an ESPN value, where OURS-replay, the snapshot and ESPN each reach 8.0: 57 rows,
508 pairs, every comparison below on those same pairs.

| Comparison (same 57 rows) | Disagreements | Win rate | Points per disagreement | MDE80 | Verdict |
|---|---|---|---|---|---|
| Saved snapshot vs ESPN | 200 | 0.3750 [0.2446, 0.5128] | −3.9131 [−7.6851, −0.1825] | 5.62 | ESPN ahead |
| OURS-replay vs ESPN | 147 | 0.4898 [0.3101, 0.6557] | +0.8584 [−2.9974, +4.5827] | 5.72 | not distinguishable |
| A (ensemble, today's weight set) vs ESPN | 149 | 0.4966 [0.3396, 0.6460] | −0.3667 [−4.0383, +3.0855] | 5.49 | not distinguishable |
| D (coordinated ensemble × lift) vs ESPN | 148 | 0.5000 [0.3522, 0.6485] | +0.3846 [−3.2993, +3.7407] | 5.35 | not distinguishable |
| OURS-replay vs saved snapshot | 181 | 0.6298 [0.4718, 0.7725] | +5.0210 [+0.9954, +9.2004] | 6.33 | not distinguishable (points bound above 0, win-rate bound not above 0.5) |
| A (today's weight set) vs saved snapshot | 169 | 0.6450 [0.4925, 0.7968] | +4.3076 [+0.3773, +8.7988] | 6.32 | not distinguishable (same reason) |

Reading, one week, an anecdote: on the same rows the projection the app saved before the week lost
to ESPN and OURS-replay did not. The ensemble alone with today's weight set already accounts for
most of the difference against the saved snapshot (+4.31 of +5.02), so most of the gap between
C-01's number and HX-01's is the weight set (fit-2's weeks 2-4 rule against frozen-2023), not the
coordinator, the chance to play or the lift. Round 1 said the two results "point the same way"
and HX-01's was "smaller": that compared different arms on different rows and is withdrawn
(erratum 2).

**C-01's number through the consensus arm** (`forward.c01_reconciliation`). C-01's `servedArms`
(the saved snapshot against ESPN at lock, the plan rule's input) on C-01's week-2 replay rows (153
with both values) gives 784 pairs, 286 disagreements, win rate 0.3776 [0.2537, 0.5057], −3.4207
[−6.5246, −0.3637] points, ESPN ahead. `headToHead(rows, 'policy', 'baseline')` with its default
line on the same rows gives the same value in every field compared (pairs, agreement, both pair
accuracies, disagreements, players, win rate, points, both intervals, SEs, MDE80); the run stops if
they ever differ. C-01's replay champion for week 2 is fit-2 while the saved snapshot used
frozen-2023 (`same_weights: false`), the split C-01b's row in the work queue already names.

**Which arm counts as "served" is not settled here.** The follow-up that settles it is S-12
(`WORK-QUEUE.md` §5: store the `week_points` the page served, next to the ensemble's, at lock;
it needs a migration, N9). Then C-01's plan rule and HX-01 grade that one arm through one call
(`headToHead`, whose default line is C-01's). Until then C-01's verdict input is the saved
snapshot, HX-01's forward rows are OURS-replay, and neither is called "served".

Logged as `F001`-`F015` in `docs/evidence/HOLDOUT-LEDGER.md` (F001-F007 relabelled from round 1,
numbers unchanged; F008-F015 new).

### 5.7 Holdout looks

- **2025:** 0 looks. The export drops the 2025 window by date, the schedule read excludes 2025,
  `ecrConsensus` drops a 2025 row before its id is looked up (`excluded_season` 0 on this run),
  the lib refuses season 2025, and the runner stops if a 2025 row reaches the grade. The
  post-hoc sensitivity (section 5.8) reads 2022-2024 only.
- **2026:** one forward read (week 2), rows `F001`-`F015`. The job-fit query
  `SELECT id, through_season, through_week, promoted FROM weekly_ensemble_fits WHERE through_season >= 2026`
  returned no rows on the copy (control: the table has 2 rows).

### 5.8 Post hoc: the coordinator on the served recipe (report-only, not pre-registered)

The pre-registered coordinator trains on examples from 2021 (§4); the served recipe trains from
2022 (`fantasy-coordinator.js:290`, `:391`, `:501`; S-02's `FIT_FROM = 2022`,
`scripts/weekly-construction-grade.mjs:42`; the served fit 7's 23,334 rows are the 2022-2025
examples, 5,749 + 5,764 + 5,827 + 5,994). Added after the results at a skeptic's request,
`sensitivity.coordinator_served_recipe` refits the coordinator on examples from 2022 (2023 ← 2022,
5,749 rows; 2024 ← 2022-2023, 11,513 rows) and grades the OURS built on it on the same primary rows
and pairs, everything else identical. 2022 cannot be fit that way: no example season from 2022 ends
before 2022.

| Cell | Arm | Pairs | Pair accuracy (arm / consensus) | Disagreements | Win rate | Points per disagreement | Verdict |
|---|---|---|---|---|---|---|---|
| 2023-2024 | pre-registered (from 2021) | 71,678 | 0.6350 / 0.6623 | 14,082 | 0.4308 [0.4104, 0.4504] | −1.6828 [−2.1847, −1.1931] | consensus ahead |
| 2023-2024 | served recipe (from 2022) | 71,678 | 0.6362 / 0.6623 | 13,697 | 0.4320 [0.4110, 0.4516] | −1.6385 [−2.1543, −1.1561] | consensus ahead |
| 2023 | pre-registered | 41,142 | 0.6357 / 0.6651 | 7,997 | 0.4248 [0.3996, 0.4512] | −1.8300 [−2.5305, −1.1459] | consensus ahead |
| 2023 | served recipe | 41,142 | 0.6370 / 0.6651 | 7,764 | 0.4256 [0.3985, 0.4513] | −1.8053 [−2.4723, −1.1206] | consensus ahead |
| 2024 | pre-registered | 30,536 | 0.6339 / 0.6586 | 6,085 | 0.4387 [0.4112, 0.4672] | −1.4895 [−2.1402, −0.8361] | consensus ahead |
| 2024 | served recipe | 30,536 | 0.6353 / 0.6586 | 5,933 | 0.4403 [0.4127, 0.4682] | −1.4203 [−2.0669, −0.7798] | consensus ahead |

Served recipe against the pre-registered coordinator directly, same pairs: 602 disagreements
pooled, win rate 0.5689 [0.5036, 0.6307], +1.9682 [+0.5738, +3.3447] points per disagreement
(served recipe ahead); 2023 alone +1.6693 [+0.0434, +3.3995] and 2024 alone +2.4550
[+0.2470, +4.8438], each not distinguishable under the pre-registered rule (win-rate bound not above
0.5). The served recipe moves B on all 3,824 rows and OURS on 3,821, but changes the call on only 602
of 71,678 pairs. So the hand-set-k 2021 examples cost OURS a little where the two disagree, and the
verdict against consensus does not depend on them: consensus is ahead with either coordinator,
pooled and in each season. Report-only: no Holm family, no verdict changes.

## 6. Known defects and limits

1. **Leaks that flatter OURS** (pre-registration §4): 2022-2023 ensemble weights fit on 2023;
   availability rates fit on 2021-2024. OURS lost anyway, and the fully clean cell (D, 2024)
   lost too. A win would have been an upper bound; the losses are robust to these leaks.
2. **The coordinator departs from configuration B, and from the served recipe, in every graded
   season, not only 2022.** Its examples start at 2021, as pre-registered (§4), and the 2021
   examples are built by engines that run the hand-set `K.share = 6`: the k control over the
   example seasons excludes 2021 ("target_share.ALL = missing"; `coordinator.examples_k_control`).
   Share of each fit's training rows from 2021 (`coordinator.rows_from_k_excluded_seasons`): 2022
   5,280 of 5,280 (100%), 2023 5,280 of 11,029 (47.9%), 2024 5,280 of 16,793 (31.4%). The served
   recipe starts at 2022 (section 5.8), so "OURS is built by calling the served chain" holds for the
   functions, not for the coordinator's training window. Round 1 disclosed this for 2022 only
   (erratum 3). Standing rule 3's k control never ran on this training replay, and whether it must
   is the Independent Auditor's call (open question). The post-hoc served-recipe run (section 5.8)
   moves the pooled 2023-2024 grade against consensus from −1.68 to −1.64 points per disagreement,
   consensus ahead either way, and arm A, which has no coordinator, loses in every season too
   (2022 −2.3989, 2023 −1.8584, 2024 −1.7091).
3. **ECR scoring basis** for 2021-2024 is assumed PPR (the current file's pages are the PPR
   pages; the historical parquet as pulled has no page column): a guess.
4. **Timing:** ECR is a Friday scrape and OURS uses the Friday injury report; neither sees
   Sunday inactives. ESPN's 2026 value is at lock, which is a timing edge for ESPN.
5. **Pool, not rosters:** pairs are league-wide, as in C-01 and S-02.
6. **Coverage:** 2021 not graded (k control); no week-18 scrape in any season; 2024 weeks 2-3
   have no scrape, so the 2-4 band is 2022-2023 plus 2024 week 4.
7. **The common set is vetoed by every arm** (house rule): a player one arm rates below 4.0, or
   consensus does not rank, is not in any pair.
8. **Lift team:** keyed on the engine's team at the cutoff, not the page's `players.team_abbr`
   (today's team); the one deliberate difference from the page (pre-registration §2).
9. **Standing rule 3:** these magnitudes are rig magnitudes. They stay here for the Auditor;
   anything that reaches Nick's page carries the direction only.
10. **The chance to play is priced as this copy serves it:** on the pooled path, because
    `nfl_availability_role_rates` is absent on the copy (no such table: `SELECT count(*) FROM sqlite_master WHERE name='nfl_availability_role_rates'` returns 0, control: 284 tables) (`contingency.js:592` warned so on every
    run); production may hold the role rates. ESPN's live designations reach
    `weeklyAvailability` only for the live period (`contingency.js:273-306`), so the replayed
    2026 week 2 used the NFL injury report alone, while the number served that week could also
    have read ESPN's statuses.
11. **The forward arm is a replay** (section 5.6): OURS-replay is the copy's current chain, and
    which week-2 arm production served is unverified until S-12 stores it.

## 6a. Pre-registration errata (found after the results; the pre-registration file is unchanged)

Filed 2026-09-23, in round 3. None changes a pre-registered rule, population, metric or number;
each corrects a label or a disclosure.

1. **§10 "OURS with the fits production serves (fit-2 weights, the served coordinator fit and the
   stored volume k, all through 2025)".** Wrong: they are the local copy's current fits, all created
   after the projection the app saved before week 2 and after the week's first kickoff, and
   production's weight set that week is unverified (section 5.6). The arm is OURS-replay. §4's
   "2026 week 2 is clean for every piece" still holds in the sense that every piece ends in 2025,
   not in the sense of "served".
2. **§5.3 "the threshold at 8.0 (C-01's startable line)" and §10 "also printed at C-01's 8.0
   threshold so it can be laid beside C-01's 0.378".** HX-01's 8.0 set holds every point arm and
   ESPN to 8.0; C-01's rule holds only the two arms compared. The C-01-rule value is now printed
   beside it (`F008`), and the arm C-01 grades is graded on one row set with HX-01's (`F009`-`F015`).
   Round 1's "Same direction (ESPN ahead), smaller" is withdrawn.
3. **§4, coordinator row, "buildFantasyCoordinatorExamples from 2021".** Run as pre-registered.
   Round 1's evidence disclosed its hand-set-k consequence for 2022 only; it reaches every graded
   season (item 2 above).

## 7. Nick's five questions

1. **Well built?** Yes, as a study. It calls the served functions instead of copying them (S-02's
   `constructArms`, the served `weeklyAvailability` and `startSitWeekPoints`), grades every
   decision with C-01's one instrument, checks pair accuracy against the canonical producer on
   every run, and stops on the k control, a fit cutoff, either lift-parity miss, a 2025 row, an
   uncommitted pre-registration, or a call site that feeds nothing (section 4b). 39 tests; three
   mutation sweeps (sweep 3: 67 mutants, 63 killed, one survivor fixed by a test, two explained).
2. **Stats or made up?** Stats: a pre-registered, walk-forward replay over 2022-2024 (46 weeks,
   115,514 same-position pairs, 22,659 disagreements with consensus), graded against FantasyPros'
   weekly consensus with player-clustered and week-clustered intervals and Holm. The PPR basis of
   the historical ECR pages is a guess (section 6.3).
3. **How we know:** backtest on 2022, 2023 and 2024 (2021 not gradable, 2025 not opened), metric
   decision win rate and points per disagreement, result consensus ahead in every season, band and
   position (pooled −1.86 [−2.22, −1.47] points per disagreement, win rate 0.422). 2026 week 2 is
   an anecdote: OURS-replay (a replay, not proven to be the served number) is not distinguishable
   from consensus or ESPN, and on one row set the projection the app saved before the week lost to
   ESPN (section 5.6).
4. **Pointed anywhere else?** Yes: (a) C-01's gate now grades against ESPN (Auditor ruling), and
   `headToHead` gives C-01's own number on C-01's rows, so C-01 can call it rather than keep a second
   grader; (b) S-03's pre-registration should take consensus as its baseline; (c) S-04 (availability)
   should look at the 0.0048 pair-accuracy cost in section 5.4; (d) S-12 settles which week-2 arm
   was served; (e) the "why" engine could cite ESPN's number, never FantasyPros' (licence,
   pre-registration §12).
5. **How it unifies:** one decision instrument (C-01's `gradeDecisions` and `startSitDecisions`),
   one pair line (C-01's `STARTABLE_PPR`, the default), one pair-accuracy rule
   (`startSitPairAccuracy`), one served chain (S-02's `constructArms` plus the served
   `startSitWeekPoints`), C-01's own readers for the saved snapshot and ESPN, one holdout ledger
   (`F001`-`F015`), and one arm that C-01 and S-03 can both call, proven equal to C-01's grade on
   C-01's rows.

## 8. Merge-gate lines

- **Gap closed:** no historical, walk-forward grade of the served start/sit number against a
  consensus a user actually has existed; the only consensus read was one forward week in C-01
  (`server/services/gates/start-sit-gate.js:294` `espnProjections`, tree `116ca994`; `:365` on
  `bbe9e6cd`). Round 3: the arm's pair line, the fit handoff, the lift week, the game-date key and
  the interval clustering were unpinned on `9daa56d7` (section 4b).
- **Incumbent, by command:** the served chain as the served code resolves it (`buildPlayerWeekEngine`
  → coordinator → `weeklyAvailability` → `startSitWeekPoints`), replayed by
  `node scripts/historical-consensus-head-to-head.mjs --full`; weight sets `frozen-2023` for
  2022-2024 (`activeWeeklyWeightSet`, section 5.1).
- **Does not cover:** a per-roster (per-league) start/sit; each league's own scoring (PPR only);
  Sunday-morning inactives; 2021 (no fit ends before it), 2025 (held out) and any 2026 week after
  week 2; which week-2 arm production served (S-12); FantasyPros values in any served number
  (licence).
- **What would make it wrong:** a non-PPR historical ECR page set (section 6.3); an id crosswalk
  error (the name check agrees on 98.75%); a leak in the Friday scrape dates (the leak guard drops
  every game on or before the scrape); a C-01 instrument change after `a1447095` (the arm is pinned
  to C-01's functions by identity and to C-01's grade by the reconciliation; re-run `--full`, about
  10 minutes, after any C-01 change).
- **Stacked PR:** base `origin/main` `dd7cec20` plus C-01's branch at `b97d5ea2` (`116ca994`) and at
  PR #160's head `a1447095` (`bbe9e6cd`); HX-01's own commits start at `b635345b`. Open the PR
  against C-01's branch and keep that base until #160 merges; after #160 squash-merges, merging
  main into this branch was simulated clean by the wiring skeptic (0 conflicts, empty diff).
- **Wiring:** `node scripts/wiring-map.mjs --check` on `d0aa396b` (tree `db6f2c94`): exit 0, "no
  missing-feed findings" (the files are scripts, which the map treats as surfaces). The full
  `npm run check` is the Gate phase's single run, not run here.
