# HX-01: our served start/sit number against public consensus, on past seasons

Work queue HX-01 (§13; plan items C12, C18, S-03). Nick, 2026-09-22 7:20 PM ET: "we should've
been testing on historical data." Measures only; no served number changes.
Pre-registration: `docs/evidence/2026-09-22/historical-consensus-head-to-head-preregistration.md`
(committed before any number; sha in §2).
Branch `claude/local-hx-01-historical-consensus-head-to-head`, base `origin/main` `dd7cec20`
(S-02 #155 and S-00 #154 already merged), **plus C-01's branch
`claude/local-c-01-startsit-baseline-gate` at `b97d5ea2` merged in (`116ca994`)**, so this is a PR
stacked on C-01: merge C-01 first.

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

(Sections 2 onward are written as the work lands.)
