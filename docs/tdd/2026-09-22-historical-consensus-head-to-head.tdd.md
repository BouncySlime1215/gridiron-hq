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

## 2. RED and GREEN

Test file `test/historical-consensus-head-to-head.test.js`. Command for every run:
`GRIDIRON_DB_PATH="$(mktemp -u "${TMPDIR:-/tmp}/gridiron-test-XXXXXX").sqlite" SCHEDULER_DISABLED=1 NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks --test --test-reporter=tap test/historical-consensus-head-to-head.test.js`

| Step | Commit | Result |
|---|---|---|
| pre-registration | `b635345b` docs: pre-register HX-01, our served start/sit number against consensus on 2022-2024, before any number | docs only; an ancestor of every number below |
| RED 1 | `5cfc289f` test: HX-01's consensus arm and served rows must use C-01's instrument and the served chain (RED) | Whole file fails: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/scripts/consensus-arm.mjs' imported from …/test/historical-consensus-head-to-head.test.js` (`# tests 1`, `# fail 1`) |
| GREEN 1 | `719ff584` feat: HX-01 consensus arm, served-row library and runner for the historical head-to-head (GREEN) | 25 / 25 pass. **The numbers in section 5 were produced on this commit** (tree `51d5c6a3`). |

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
  oracle/identity control. C-01's gate can call `headToHead(rows, 'policy', 'espn')` on its
  forward rows today; S-03 can call it with its candidate projection as the policy.
- **`scripts/historical-consensus-lib.mjs`, the served rows.** For each graded week it calls the
  served chain: S-02's `constructArms` (engine → experts → coordinator → lift), the served
  `weeklyAvailability(season, week, { through: season - 1 })`, trade-engine.js's rounding and
  default chance to play, and the served `startSitWeekPoints`. It stops when arm D is not what
  `startSitWeekPoints` makes of B. It also holds the walk-forward coordinator registry, the k
  control per season, and the 2025 refusal.
- **`scripts/historical-consensus-head-to-head.mjs`, the runner.** `--smoke` prints counts and no
  metric; `--full` refuses to run unless the pre-registration is committed and unchanged, and
  writes aggregates only to `docs/evidence/2026-09-22/historical-consensus-head-to-head-output.json`.
- It reads no leagues column beyond `league_roster_snapshots` (through C-01's
  `espnProjections`), writes nothing to the app database, and adds no table, column, route or
  job.

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

(Section 4a, the fixes and sweep 2, follows once they land.)

## 5. The numbers

**Local copy, not production.** A `sqlite3 .backup` of `~/gridiron-local/data.sqlite` taken
2026-09-22 23:13:57Z. Command (tree `51d5c6a3`, commit `719ff584`, pre-registration `b635345b`,
blob `187c29cb`):

```
GRIDIRON_DB_PATH=$PWD/.local-db/data.sqlite SCHEDULER_DISABLED=1 NFL_SEASON=2026 \
  node --max-old-space-size=3072 scripts/historical-consensus-head-to-head.mjs --full
```

787 seconds (23:46:56Z to 00:00:02Z), exit 0. Every number in this section is read from
`docs/evidence/2026-09-22/historical-consensus-head-to-head-output.json`, written by that run.
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
  (−2.77). **Smallest:** weeks 14-18 (−1.46) and tight ends (−1.29). It shrinks by season:
  2022 −2.14, 2023 −1.83, 2024 −1.49.
- **The clean check agrees.** Arm D (no availability; every fit ends at or before 2023) against
  consensus in 2024: −1.79 [−2.48, −1.09], consensus ahead. The in-sample pieces of §4 of the
  pre-registration flatter OURS, and it lost anyway.
- **Against the dumb rules:** our number beats the last-3 average everywhere it can be told
  apart (pooled +1.34 [+0.90, +1.75]). It beats the season average pooled (+0.50
  [+0.12, +0.87]) but in no single season, band or position after Holm, and **not at all among
  players who played** (+0.12 [−0.26, +0.51]) or at the 8.0 startable line (−0.06
  [−0.67, +0.51]). Its edge over the season average is the chance-to-play factor avoiding
  zeros, not better ordering of players who play.
- **2026 week 2 (forward, one week, an anecdote):** consensus and ESPN both point ahead of ours,
  neither distinguishable (ours vs consensus −0.41 [−2.29, +1.36]; ours vs ESPN −0.29
  [−2.10, +1.52]). C-01's 0.378 graded a different arm (section 5.6).

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
  from 2021): 2022 ← 2021 (5,280 rows, intercept +0.250), 2023 ← 2021-2022 (11,029, −0.154),
  2024 ← 2021-2023 (16,793, −0.339), 2026 ← the served fit (through 2025, −0.555). The per-season
  example counts for 2022 (5,749) and 2023 (5,764) equal S-02's committed counts
  (`weekly-construction-grade-output.json`, `examples`).
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
| weeks 2-4 | 26,048 | 0.6065 / 0.6548 | −0.0483 [−0.0627, −0.0347] | 6,096 | 0.3970 [0.3668, 0.4262] | −2.4133 [−3.1936, −1.6450] | 1.170 | 2.4e-6 | consensus ahead |
| weeks 5-8 | 29,580 | 0.6441 / 0.6729 | −0.0289 [−0.0402, −0.0168] | 5,552 | 0.4236 [0.3927, 0.4541] | −1.8342 [−2.5820, −1.1233] | 1.106 | 1.5e-4 | consensus ahead |
| weeks 9-13 | 29,793 | 0.6411 / 0.6682 | −0.0271 [−0.0388, −0.0154] | 5,542 | 0.4274 [0.3979, 0.4574] | −1.6586 [−2.2903, −1.0106] | 0.967 | 9.9e-5 | consensus ahead |
| weeks 14-18 | 30,093 | 0.6437 / 0.6652 | −0.0214 [−0.0334, −0.0096] | 5,469 | 0.4417 [0.4102, 0.4730] | −1.4561 [−2.2914, −0.6107] | 1.280 | 0.0094 | consensus ahead |
| QB | 11,468 | 0.6213 / 0.6736 | −0.0522 [−0.0739, −0.0334] | 2,768 | 0.3923 [0.3573, 0.4287] | −2.7686 [−3.6496, −1.9110] | 1.313 | 1.4e-6 | consensus ahead |
| RB | 28,756 | 0.6423 / 0.6746 | −0.0323 [−0.0435, −0.0215] | 5,792 | 0.4202 [0.3931, 0.4470] | −2.0392 [−2.6810, −1.4013] | 0.960 | 1.3e-6 | consensus ahead |
| WR | 67,590 | 0.6378 / 0.6648 | −0.0271 [−0.0357, −0.0187] | 12,523 | 0.4274 [0.4042, 0.4488] | −1.6405 [−2.2237, −1.0919] | 0.852 | 1.2e-5 | consensus ahead |
| TE | 7,700 | 0.5999 / 0.6269 | −0.0271 [−0.0467, −0.0098] | 1,576 | 0.4340 [0.3897, 0.4754] | −1.2892 [−2.1571, −0.4923] | 1.245 | 0.010 | consensus ahead |

Week-clustered intervals for the pooled cell: win rate [0.4106, 0.4328], points
[−2.1200, −1.5735]. The season × band and season × position tables are in the output file
(`results.primary.ours_vs_consensus.by_season_band`, `.by_season_position`), report-only.

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

Fits as served (fit-2 weights, the served coordinator, the stored volume k; all through 2025).
Week-clustered intervals are degenerate with one week and are not quoted.

| Comparison | Rows / pairs | Disagreements | Our win rate | Points per disagreement | MDE80 | Verdict |
|---|---|---|---|---|---|---|
| OURS vs consensus (scrape 2026-09-18) | 152 / 3,201 | 837 | 0.4379 [0.3416, 0.5321] | −0.4114 [−2.2923, +1.3633] | 2.72 | not distinguishable |
| OURS vs ESPN (rostered, at lock) | 124 / 2,139 | 605 | 0.4496 [0.3544, 0.5407] | −0.2871 [−2.1014, +1.5240] | 2.79 | not distinguishable |
| OURS vs ESPN at 8.0 | 64 / 565 | 164 | 0.4512 [0.2869, 0.6000] | −0.3120 [−3.9647, +3.2052] | 5.42 | not distinguishable |
| OURS vs season average (= last-3 in week 2) | 152 / 3,201 | 954 | 0.5860 [0.5071, 0.6677] | +3.5528 [+1.1320, +6.2563] | 3.95 | ours ahead |
| Consensus vs season average | 152 / 3,201 | 1,044 | 0.6298 | +3.5880 [+1.4463, +5.8217] | 3.30 | consensus ahead |
| ESPN vs season average | 124 / 2,139 | 790 | 0.6051 | +3.6835 [+1.1061, +6.6242] | 4.13 | ESPN ahead |

ESPN: 194 player-weeks from `league_roster_snapshots` final rows, 0 dropped for conflicting
values. **Beside C-01's 0.378 (286 disagreements):** C-01 graded the ensemble snapshot stored
before week 2 (`weekly_prediction_snapshots`, captured under the frozen-2023 weights, no
availability) on its replay rows at 8.0; HX-01 grades today's served chain (fit-2, which serves
the structural head alone to players with 1-3 games in weeks 2-4, the coordinator, the lift and
the chance to play). Same direction (ESPN ahead), smaller, and not distinguishable in one week.
Logged as `F001`-`F007` in `docs/evidence/HOLDOUT-LEDGER.md`.

### 5.7 Holdout looks

- **2025:** 0 looks. The export drops the 2025 window by date, the schedule read excludes 2025,
  `ecrConsensus` drops a 2025 row before its id is looked up (`excluded_season` 0 on this run),
  the lib refuses season 2025, and the runner stops if a 2025 row reaches the grade.
- **2026:** one forward read (week 2), rows `F001`-`F007`. The job-fit query
  `SELECT id, through_season, through_week, promoted FROM weekly_ensemble_fits WHERE through_season >= 2026`
  returned no rows on the copy (control: the table has 2 rows).

## 6. Known defects and limits

1. **Leaks that flatter OURS** (pre-registration §4): 2022-2023 ensemble weights fit on 2023;
   availability rates fit on 2021-2024. OURS lost anyway, and the fully clean cell (D, 2024)
   lost too. A win would have been an upper bound; the losses are robust to these leaks.
2. **The 2022 coordinator was trained on 2021 examples built under the hand-set K**, since no
   volume fit can end before 2021. The pre-registration did not spell this out; it is disclosed
   here. S-02 measured that the coordinator changes almost no start/sit call (2 of 67,943 pairs),
   so it cannot move these grades materially (direction only; S-02's rig).
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

## 7. Nick's five questions

1. **Well built?** Yes, as a study. It calls the served functions instead of copying them (S-02's
   `constructArms`, the served `weeklyAvailability` and `startSitWeekPoints`), grades every
   decision with C-01's one instrument, checks pair accuracy against the canonical producer on
   every run, and stops on the k control, a fit cutoff, a lift-parity miss, a 2025 row or an
   uncommitted pre-registration. 25 tests; mutation sweep in section 4.
2. **Stats or made up?** Stats: a pre-registered, walk-forward replay over 2022-2024 (46 weeks,
   115,514 same-position pairs, 22,659 disagreements with consensus), graded against FantasyPros'
   weekly consensus with player-clustered and week-clustered intervals and Holm. The PPR basis of
   the historical ECR pages is a guess (section 6.3).
3. **How we know:** backtest on 2022, 2023 and 2024 (2021 not gradable, 2025 not opened), metric
   decision win rate and points per disagreement, result consensus ahead in every season, band and
   position (pooled −1.86 [−2.22, −1.47] points per disagreement, win rate 0.422); 2026 week 2
   forward points the same way and is not distinguishable.
4. **Pointed anywhere else?** Yes: (a) C-01's gate should grade against consensus (ESPN, first-party)
   with `headToHead`, not only against the season average, which our number beats only through the
   chance to play; (b) S-03's pre-registration should take consensus as its baseline; (c) S-04
   (availability) should look at the 0.0048 pair-accuracy cost in section 5.4; (d) the "why"
   engine could cite ESPN's number, never FantasyPros' (licence, pre-registration §12).
5. **How it unifies:** one decision instrument (C-01's `gradeDecisions`), one pair-accuracy rule
   (`startSitPairAccuracy`), one served chain (S-02's `constructArms` plus the served
   `startSitWeekPoints`), one holdout ledger (`F001`-`F007`), and one arm that C-01 and S-03 can
   both call.
