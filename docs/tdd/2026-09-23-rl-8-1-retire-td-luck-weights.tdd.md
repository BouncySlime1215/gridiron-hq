# RL-8-1: retire the in-season td_luck weights (consensus prices them)

Unit: RL-8-1 (WORK-QUEUE section 9, round 8; plan items TM-02 / TR-05 / AI-08 / S-19).
Base tree: origin/main `3ac59fea`. Branch: `claude/local-rl-8-1-retire-td-luck-weights`.
Source finding: R&D r8 external package `rnd/loop/r8-external-regression-tag-priced.md` (local, not in the repo).

## 1. Audit: what exists (extend or build)

Commands run on `3ac59fea`:

- `grep -rnI -i -E 'td_luck|tdLuck|td_regression|tdRegression|fpoe|td-regression' server client/src test`
- `grep -rnI "player-case\|regressionCandidates\|touchdownRates" server client/src scripts`
- `git grep -n "regressionForLeague" -- server client test`

Producers of the "touchdown luck" concept on origin/main:

| where | what | reaches |
|---|---|---|
| `server/services/td-regression.js` `regressionCandidates` | fitted expected-TD board (hot = `negative_regression`, cold = `positive_regression`) | only the two consumers below |
| `server/services/player-case.js:214-233` | `td_luck` factor, weight `min(1.2, abs(ppg_swing)/2)`; a single factor at 1.2 alone clears the ±0.8 verdict line (`player-case.js:246-249`) | `lineup-brain.js:565` `safeCase` -> `lineupCall` `football` -> Start/Sit page (`client/src/pages/Lineup.tsx:338`, `net_lean` colour and verdict line) |
| `server/services/lineup-brain.js:533-545` | `evidence` map of hot/cold text -> `caution` / `upside` fields on every Start/Sit call | `client/src/pages/Lineup.tsx:358-374` ("Running hot" / "Due to score" lines) |
| `server/services/gridiron-model.js:150-160` | registry entry `fantasy.td_regression`, `baseAuthority: 'advisory'` (may inform and rank) | `modelMap()` / `ask()` |
| `server/services/preseason-model.js:478,533,556` | `td_luck_pg_1`, last season's points over expected per game, a fitted and tested PRESEASON feature | preseason model; KEPT by this unit |
| `server/services/td-regression.js:344` `regressionForLeague` | league join | no caller (definition only) |

No trade value reads it: the r8 package greps `trade-engine.js ros-projection.js trade-horizon.js news-lag-trader.js routes/trades.js title-odds-trades.js opportunity-model.js` for `regression|td_luck|tdLuck|fpoe|over.expected` and gets 0 hits; this unit did not re-run that grep beyond the whole-tree grep above, whose only in-season consumers are player-case.js and lineup-brain.js.

Decision: **extend (subtract), not build.** Nothing new is produced. The in-season weight and flag are deleted from the two consumers, the registry entry is demoted from `advisory` to `research` (may inform, may not rank or decide) with the r8 reason as its refusal, and the td-regression.js header claim ("the most reliable inefficiency", "the profitable half") is rewritten. The preseason feature is untouched and pinned by a test.

Why (r8, graded 2021-24, 2025 not opened, 2026 not graded): after consensus ROS ECR, one PPR point per game of FPOE is worth about 0 ROS points per game (it is worth -0.20 to -0.33 without ECR, the known-nonzero control); pair-accuracy gain over ECR is +0.0000 to -0.0003; humans in 1,363 real Sleeper 1-for-1 trades price about 73% of it (b_fpoe -0.059 [-0.154, +0.041] vs placebo -0.220). R2 internal separately found the next-week Start/Sit value nil and the name join broken. Those numbers are the r8 package's, produced by the scripts it names; this unit did not re-run them.

Not statistical: this unit adds no model number and runs no grade, so no pre-registration and no holdout look (nothing is appended to `docs/evidence/HOLDOUT-LEDGER.md`).

## 2. RED / GREEN

- RED: `test: RED for retiring the in-season td_luck weights (RL-8-1)` `76af38ee`. `test/td-luck-retired.test.js` on that commit: 6 of 7 fail, 1 pass (the preseason pin, which is meant to pass before and after). Failing assertions, inline:
  - test 1: `no td_luck factor on the hot starter` (the flagged starter carried `td_luck:negative:1.2`);
  - test 2: `a hot flag moves no factor, lean or verdict`;
  - test 3: `lineupCall (and the football case under it) must not call regressionCandidates` (`2 !== 0`);
  - test 4: `player-case.js still reads the touchdown-luck signal`;
  - test 5: `expected: 'research'`, `actual: 'advisory'`;
  - test 6: header matched `/most reliable inefficiency|profitable half|almost nobody plays it/i`.
- GREEN: `fix: retire the in-season td_luck weights from the verdict and Start/Sit (RL-8-1)` `37cc0a2d`. Same file: 7 of 7 pass.

Command (both): `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/t.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/td-luck-retired.test.js`

## 3. What it does

- `server/services/player-case.js`: the `td_luck` factor, its `TOUCHES` entry, the `regression` option, the memoised board (`safeRegression`) and the `clearPlayerCaseCache` export (no caller: `grep -rnI clearPlayerCaseCache server client/src test` on `3ac59fea` hit only its definition) are deleted. The football case no longer reads td-regression.js.
- `server/services/lineup-brain.js`: the hot/cold `evidence` map and the `caution` / `upside` fields on every Start/Sit call are deleted; the td-regression import is gone.
- `client/src/pages/Lineup.tsx`: the "Running hot" / "Due to score" lines that read those two fields are removed; the "Betting market" line is kept. No page, tab or route removed (nav stays 8).
- `server/services/gridiron-model.js`: `fantasy.td_regression` demoted `advisory` -> `research` (may inform, may not rank). Not `retired`: that authority means "measured negative on a sealed audit", and r8 measured it priced, not negative. The refusal now says "Priced by consensus; not a trade or start/sit edge".
- `server/services/td-regression.js`: header rewritten. It measures the gap and says plainly that it is priced, may explain a line and must not weight one.
- `server/services/preseason-model.js`: untouched (`git diff origin/main...HEAD -- server/services/preseason-model.js` is empty); `td_luck_pg_1` pinned by test 7.

No table, column, migration or route added or removed.

## 4. Numbers (with commands)

- Liveness on the old code, same fixture (`3ac59fea` player-case.js and lineup-brain.js restored into the worktree, a scratch copy of the test with a probe, then reverted): hot starter's verdict flagged = "The football points against him this week." (`net_lean -1.2`, caution "5 touchdowns on 1.4 expected — running hot…"); unflagged = "Nothing about this matchup stands out either way." The td_luck factor alone flipped the verdict.
- Same probe: the lineup itself (slot, who he beat, margin, label, win rate) was already identical flagged vs unflagged on `3ac59fea` (`same_decision: true`). The solver never read td_luck; it moved the verdict line, the lean colour and the flag text only. So Start/Sit decision win rate vs the "start highest projection" baseline is unchanged by construction, and no historical replay applies: no start is added, dropped or swapped. Fixture evidence, not a season grade.
- Adjacent targeted tests on `37cc0a2d`, all exit 0: td-regression 1/1, redzone-tiers 8/8, gridiron-model 12/12, start-sit-ceiling-uncalibrated 7/7 (renders the Lineup page), lineup-evidence 16/16, lineup-surfaces-agree 2/2, decision-leftovers-lineup 10/10, lineup-floor-objective 3/3, preseason-model 20/20, wiring-map 90/90. Full `npm run check` left to the Gate phase.
- The r8 effect sizes quoted in section 1 are the r8 package's, not re-run here. The human-pricing arm's minimum detectable effect is 0.148 ROS points per week per trade (r8, section 2b), so "not distinguishable from 0" there is bounded, not "no effect".

## 5. Mutation sweep (on `37cc0a2d`, each mutant applied, test file run, reverted)

| mutant | applied | failing tests | result |
|---|---|---|---|
| M1 unit: player-case.js restored to `3ac59fea` (factor + board read) | yes | 1,2,3,4 | killed |
| M2 unit: lineup-brain.js restored to `3ac59fea` (flag + board read) | yes | 1,3,4 | killed |
| M3 call site: `caution: 'running hot'` re-added on the Start/Sit call object | yes | 1 | killed |
| M4 registry `research` -> `advisory` | yes | 5 | killed |
| M5 header claim restored | yes | 6 | killed |
| M6 preseason `td_luck_pg_1` renamed in FEATURE_NAMES | yes | 7 | killed |
| S1 designed survivor: player-case verdict threshold 0.8 -> 0.9 | yes | none | survived (by design: these tests pin flagged == unflagged, not the threshold) |
| C1 not-applied control: pattern absent from player-case.js | no (diff empty) | none | control holds |

## 6. Known defects / not covered

- `td-regression.js:344` `regressionForLeague` still has no caller (definition only). Left in place; follow-up: delete it or wire it as an explanation-only line.
- The r8 package also asks to strike "regression" as a value input in the WORK-QUEUE TM-02 / TR-05 rows and rescope AI-08 in TRADE-MACHINE-PLAN.md:151. Those files are not in this repo (`docs/handoff/local` does not exist on origin/main); the coordinator owns them.
- `client/src/pages/Lineup.tsx` is edited (3 elements removed). If another thread holds that file, this edit needs its owner's grant.
- The r8 test used player ROS points, not lineup points, and Sleeper managers, not ESPN managers (r8 caveats). The removal does not depend on it: the flag never changed a start.

## 7. Nick's five questions

1. Well built? Yes: pure subtraction plus a registry demotion; 7 tests, 6 killed mutants, a designed survivor and a not-applied control.
2. Stats or made up? The reason is r8's measured result (2021-24, consensus ECR, 1,363 real trades); this unit adds no number.
3. How we know: r8 backtest 2021-24 (ECR-adjusted FPOE slope about 0 ROS points per game; humans price about 73%). Here: fixture test that the verdict and the Start/Sit call are identical flagged vs unflagged.
4. Pointed anywhere else? Only the Start/Sit page read it (football verdict + two flag lines). No trade value, waiver or finder rank read it.
5. How it unifies: one producer (td-regression.js) stays as a readable board; zero decision paths weight it; the registry says so at the point of use.

## Holdout looks

None. 2025 not opened; no 2026 week graded.
