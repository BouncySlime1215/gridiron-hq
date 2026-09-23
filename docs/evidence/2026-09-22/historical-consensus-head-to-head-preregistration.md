# Pre-registration: our served start/sit number against public consensus, graded on past seasons (HX-01)

Written and committed **before any HX-01 number is run**. Work queue HX-01 (plan items C12, C18,
S-03). Tree: branch `claude/local-hx-01-historical-consensus-head-to-head` at `116ca994`, which is
`origin/main` `dd7cec20` (S-02 #155 and S-00 #154 merged) plus C-01's branch
`claude/local-c-01-startsit-baseline-gate` at `b97d5ea2`, merged so this unit grades decisions
with C-01's one instrument (`server/services/gates/baseline-gate.js`). Nothing below was
measured on outcomes. The only probe run before this file is the configuration check in §3
(which seasons have a fitted volume k), which reads no outcome.

## 1. The question

Nick, 2026-09-22 7:20 PM ET: "we should've been testing on historical data." C-01's forward arm
found our served projection lost to ESPN's projection on 2026 week 2 (win rate 0.378 over 286
disagreements). One week is an anecdote. This unit asks the question on past seasons:

> **Did our served weekly model ever beat public consensus on start/sit calls, where, and by how
> much?**

- **H1 (primary).** On same-position start/sit pairs in 2022-2024, weeks 2-18, graded
  walk-forward, the start/sit calls made by our served number win a share of their
  disagreements with FantasyPros' weekly expert consensus rank (ECR) that is different from
  one half. Two-sided. The answer is reported whichever way it falls.
- **H2 (the dumb rules).** The same test of our served number against the player's
  season-to-date PPR average, and against his last-3 average.

HX-01 changes no served number. It adds a study and a reusable consensus arm, and reports a
verdict. There is no model to ship ON or OFF, so "declined" is not an outcome of this unit; a
loss to consensus is a finding, and it is reported as one.

## 2. The arms (what each rule would start)

All five arms are values for one player-week. A start/sit call between two same-position
players starts the one the arm values higher.

| Arm | What it is | Producer (tree `116ca994`) |
|---|---|---|
| **OURS** | The served Start/Sit number: `round2(round2(B × thisGame.mult × p) × lift)`, `thisGame.mult` = 1 (matchup signal off), 0 on a bye | `B` from S-02's `constructArms` (`scripts/weekly-construction-grade-lib.mjs`), which calls the served `buildPlayerWeekEngine` (`player-week-engine.js:256`), `weeklyExpertValues` (`fantasy-coordinator.js:407`) and `coordinateFantasy` (`:457`); `p` = `weeklyAvailability(season, week, { through: season - 1 })` (`contingency.js:933`), default 0.92 when absent, exactly as `trade-engine.js:304,346`; the product as `trade-engine.js:359,449`; the lift by calling the served `startSitWeekPoints` (`lineup-brain.js:356`, `vegasLift` at `waiver-brain.js:162`) |
| D | The served construction before availability: `B × lift` | S-02's arm D (`constructArms`) |
| A | The weekly ensemble alone, `proj.ppg` (what `weekly_prediction_snapshots` stores and C-01 replays) | `buildPlayerWeekEngine(...).ppg` |
| **CONSENSUS** | FantasyPros weekly ECR for his position; lower rank = start. Order value = −ECR | dynastyprocess `db_fpecr.parquet`, `ecr_type = 'wp'`, pages `weekly-qb/rb/wr/te` (benchmark only, §12) |
| **STD** | His season-to-date PPR average (games played this season before the week) | the engine's own head, `weekly-ensemble.js:192` (`season_to_date`), the same number C-01's baseline uses |
| **L3** | His average over his last three games played this season | the engine's own head `last3` (`weekly-ensemble.js:193`) |

The lift is keyed on the engine's team at the cutoff (`proj.team`), as S-02 does. The page keys it
on `players.team_abbr`, which is today's team: on a past season that would price a player on a
team he did not play for, so it is not used for history. This is the one deliberate difference
from the page, and it is named in the output.

**Comparisons** (policy vs baseline; sign = policy − baseline):

1. OURS vs CONSENSUS (H1, primary).
2. OURS vs STD, OURS vs L3 (H2).
3. CONSENSUS vs STD (known-direction check: the R&D loop measured ECR ahead of the
   season-to-date average on 2023-24, +0.028 pair accuracy on played rows; a direction check, not
   a stop).
4. D vs CONSENSUS, A vs CONSENSUS (attribution: how much of OURS's result comes from availability,
   the coordinator and the lift). Report-only.

## 3. Seasons, weeks and the held-out season

- **Requested:** 2021-2024. **Graded:** the seasons whose configuration-B k control passes.
  A configuration probe before this file (no outcome read):
  `activeKVectorFor(WEEKLY_ROLE_RECENCY, { predictingSeason })` returns a fitted
  `target_share.ALL` for 2022, 2023 and 2024 and **null for 2021**, because
  `player_week_usage` starts in 2021, so `fitAllK(2020)` has nothing to fit
  (`shrinkage-fit.js:560-575`). The engine would then run the hand-set `K.share = 6`, which
  configuration B forbids. So **2021 is not graded**, and the output says so; the run
  re-checks all four seasons and stops on any graded season that fails.
- **Weeks:** 2-18 of each graded season that have a FantasyPros scrape mapped to them (§5.2).
  Week 1 has no in-season history.
- **2025 is not opened.** It is the used-up holdout (`docs/evidence/HOLDOUT-LEDGER.md`, 153 rows
  before this unit). The ECR export drops the whole 2025 season window before any join, the lib
  refuses season 2025 (`assertNotHoldout`), and no 2025 outcome is read. HX-01 adds no `L` row.
- **2026 is forward.** The 2026 weeks already played with a prior week: week 2 only on the local
  copy (`player_week_usage` 2026 holds weeks 1-2). Reported as forward, one week, an anecdote;
  logged as an `F` row in `HOLDOUT-LEDGER.md` in the result commit.

## 4. Walk-forward status of every fitted piece of OURS

"Each graded season uses fits that end before it." The served code resolves some fits
cutoff-safe by itself; the rest are listed with the direction their leak pushes.

| Piece | How the served code resolves it for season S | 2022 | 2023 | 2024 | 2026 W2 |
|---|---|---|---|---|---|
| Volume k (`shrinkage-fit.js:535,560`) | refit on seasons ≤ S−1 when the stored fit is not before S | ≤2021 | ≤2022 | ≤2023 | stored fit through 2025 |
| Ensemble weights (`weekly-weight-store.js:28`) | newest promoted fit ending before (S, W), else `WEEKLY_ENSEMBLE_WEIGHTS` "fit on 2023 only" (`weekly-ensemble.js:13,75`) | **fit on 2023 (a later season)** | **fit on 2023 (in-sample)** | fit on 2023 (clean) | fit-2, through 2025 |
| Coordinator (`fantasy-coordinator.js:339`) | this unit refits on examples ≤ S−1 (`buildFantasyCoordinatorExamples` from 2021), S-02's registry pattern and cutoff asserts | ≤2021 | ≤2022 | ≤2023 | served fit, through 2025 |
| Coordinator's training feature `ensemble_shift` | examples are built by the served engine, which applies the 2023 weights to every season | carries the 2023 weights | same | clean for 2024 (2023 ≤ 2023) | clean |
| Game-script lift (`gamescript.js:369-389`) | fit on team-games before (S, W); falls back to the all-seasons model when fewer than 100 (`:374`) | as-of | as-of | as-of | as-of |
| Availability rates (`contingency.js:592`, table `nfl_availability_rates`) | not cutoff-aware; `scripts/fit-availability.mjs:48` fits on 2021-2024 | **in-sample** | **in-sample** | **in-sample** | clean |
| Durability prior (`contingency.js:73`) | games through S−1, but it also reads today's `player_metrics` injury flags (`:78`) | today's flags | today's flags | today's flags | as served |

Every in-sample or later-season fit in the table is expected to flatter OURS (a fit that has seen
the graded season fits it better). Today's injury flags are the exception: for a past season they
are noise, expected to cost OURS a little rather than help it. So:

- **A loss by OURS is robust** to the flattering leaks: a clean replay would be expected to lose by at
  least as much.
- **A win by OURS on 2022-2024 is an upper bound**, labelled "not walk-forward clean".
- **One historical cell is fully clean:** arm D in 2024 (no availability; weights, coordinator,
  k and lift all end at or before 2023). D vs CONSENSUS in 2024 is reported as the clean check.
- 2026 week 2 is clean for every piece.

## 5. Population, pairs and the consensus join

### 5.1 Player-weeks

For a graded season S and week W:

1. **Decision rows.** Position QB/RB/WR/TE, an engine projection, at least one game played
   earlier in season S, and a game played in week W−1 (S-02's `eligibleRows`, `decision`
   flag; the same population C-01 grades). His actual is his PPR points in week W
   (`backtest.js:26` `actuals`, `scoreLine`), **0 if he did not play**.
2. **Byes removed** with C-01's `removeByes` (`start-sit-gate.js`): his week W−1 team has no
   row in week W.
3. **Leak guard.** His week W−1 team's game date (`game_lines.gameday`, season S, week W) must be
   strictly after the ECR scrape date used for week W. A Thursday game with a Friday scrape is
   dropped, for every arm, so all arms grade the same rows.
4. **Ranked by consensus.** He has an ECR on the page for his app position that week. A player
   ranked on a different position's page is dropped and counted.

### 5.2 FantasyPros scrape to NFL week

Scrapes are dated (`scrape_date`). A scrape dated d is assigned to the regular-season week (S, W)
whose last game date is on or after d, whose previous week's last game date is before d, and
whose last game is at most 7 days after d. When several scrapes land on one week, the latest is
used. Game dates come from `game_lines` (weeks 1-18 only). Mapping and leak guard are the R&D
validator's stricter rule (`~/gridiron-local/rnd/loop/LOOP-LOG.md`, "Round 1 assess
consensus-weekly-gate").

Player identity: FantasyPros id → gsis id by dynastyprocess `db_playerids.csv`, → app player by
`players.gsis_id`. The count of unmapped rows is reported. A name cross-check
(`player-identity.js#normalizePlayerName` on both names) reports the share of mapped rows whose
names agree, as a control that the id map is not wrong.

### 5.3 The common pair set

A pair is two different players in the same (season, week, position), each passing §5.1 and each
valued **≥ 4.0 by every point arm** (OURS, D, A, STD, L3), the house common-set rule of
`startSitPairAccuracy` (`scripts/promote-early-week-weights.mjs:153`, canonical per
`STATS-METHOD.md` rule 6). CONSENSUS has no points; "ranked that week" is its condition. Every
comparison in §2 is graded on this one pair set, so the numbers are comparable.

- **Primary population:** DNP scored 0 (a manager who starts a player who sits gets 0).
- **Secondary:** both players played in week W (availability-neutral ordering skill).
- **Sensitivity:** the threshold at 8.0 (C-01's startable line) instead of 4.0.

## 6. Metrics and sign convention

For each comparison (policy P vs baseline Q) on a set of pairs:

- **Pair accuracy** of each arm, house rule: 1 when the arm's higher-valued player scored more,
  0 when less, 0.5 when either the values or the actuals tie. The difference P − Q gets a
  player-clustered 90% interval from C-01's `pigeonholeBootstrap` (Owen 2007) over the two
  players of each pair, 2000 draws, seed 1. The run stops if this pair accuracy for a point arm
  differs from `startSitPairAccuracy` on the same rows.
- **Decisions:** the pairs where P and Q order the two players strictly and differently (a tie
  is no call), oriented so "ours" is P's pick. Graded by C-01's `gradeDecisions`: decision win
  rate (a tie counts half), points per decision (P's pick minus Q's pick, actual points), each
  with a player-clustered 90% interval (pigeonhole) and a week-clustered 90% interval
  (`pairedBootstrapDiff`, season-week groups), and MDE80 = (1.6449 + 0.8416) × the
  player-clustered SE.
- **Sign:** P − Q. Positive points per decision, a win rate above 0.5, and a positive pair
  accuracy difference favour P. P is OURS in every H1/H2 comparison.

Breakouts: pooled 2022-2024; each season; each week band (2-4, 5-8, 9-13, 14-18) pooled over
seasons; each position pooled over seasons. Season × band and season × position tables are
report-only.

## 7. Verdict rule

For one cell:

- **"ours ahead"**: player-clustered points-per-decision CI lower bound > 0 **and**
  player-clustered win-rate CI lower bound > 0.5 (C-01's G1 and G3);
- **"consensus ahead"** (or "baseline ahead"): player-clustered points CI upper bound < 0;
- otherwise **"not distinguishable"**; no disagreements → "no disagreements".
- The week-clustered interval is printed beside it (C-01's G2) and is not part of the verdict.

**The headline** answers the question in this order:

1. **Ever, overall:** the pooled 2022-2024 cell, OURS vs CONSENSUS, primary population.
2. **Where:** the 11 cells (3 seasons, 4 week bands, 4 positions), OURS vs CONSENSUS, primary
   population. Multiplicity: Holm (`server/services/stats-util.js#holm`) at family α = 0.10 on
   the two-sided normal p-value 2(1 − Φ(|points per decision / player-clustered SE|)), Φ from
   `stats-util.js#normalCdf`. A cell is reported as a win or a loss **only when its CI verdict and
   its Holm-adjusted p < 0.10 agree**; the raw CI verdict is printed beside it.
3. **By how much:** points per decision and win rate with both intervals, and pair accuracy for
   both arms.
4. **Clean check:** D vs CONSENSUS in 2024 (§4).

A win by OURS in any 2022-2024 cell carries "not walk-forward clean (§4)". The same rule is
applied to H2 (OURS vs STD, OURS vs L3) and reported in the same shape.

## 8. Stop conditions and controls (run before any metric is kept)

1. **k control** (standing rule 3): per requested season, stop the grade of any season whose
   `target_share.ALL` is missing or 6. 2021 is expected to be excluded here (§3).
2. **Coordinator cutoff:** each season's fit is built from examples ≤ S−1
   (S-02 `assertFitCutoff`) and checked at the grading call (S-02 `assertContextCutoff`).
3. **Served parity, every row:** OURS equals what the served `startSitWeekPoints` returns for
   `{ team_abbr: proj.team, position, current_week_ppg: round2(B × 1 × p) }`, and D equals
   `startSitWeekPoints` on `current_week_ppg = B` (S-02's check). Any mismatch stops the run.
4. **Known-nonzero instrument control:** an oracle policy (value = actual points) must win every
   disagreement it has with CONSENSUS with points per decision > 0, and an identity policy
   (OURS compared with itself) must have zero disagreements. Otherwise no verdict is drawn.
5. **Consensus join control:** the number of ECR rows mapped, unmapped and position-mismatched,
   the name-agreement share, and the leak-guard drop count are printed per season. A season
   with no ECR row after the join stops.
6. **Holdout guard:** any 2025 row reaching the grade stops the run.
7. **Pre-registration guard:** `--full` refuses to run unless this file is committed and
   unchanged (the S-02 runner's rule).

## 9. Minimum detectable effect (declared from expected SEs; a guess, restated from the run)

- Pooled 2022-2024, OURS vs CONSENSUS: about ±0.02 in win rate and ±0.3 points per decision.
- One season: about ±0.035 and ±0.5.
- One cell (a week band or a position): up to ±0.06 and ±1.0 (QB and TE have the fewest
  pairs).

These are guesses scaled from S-02's decision-win-rate intervals (1,851 disagreements, SE about
0.02) and C-01's week-2 interval; the realised MDE80 is printed for every cell, and every
"not distinguishable" cell is read through it (`STATS-METHOD.md` rule 4).

## 10. The forward read, 2026 week 2 (reported as forward, not a verdict)

OURS with the fits production serves (fit-2 weights, the served coordinator fit and the stored
volume k, all through 2025; `weeklyAvailability(2026, 2, { through: 2025 })`), graded against:

- **CONSENSUS**: the ECR scrape dated 2026-09-18, mapped to week 2 by §5.2;
- **ESPN**: ESPN's weekly projection for rostered players, from C-01's `espnProjections`
  (`league_roster_snapshots`, `source = 'final'`, one value per player-week, conflicting values
  dropped), a point arm held to the same ≥ 4.0 rule;
- **STD** and **L3**.

Same metrics and verdict labels, marked "one week: anecdote". The ESPN comparison is also
printed at C-01's 8.0 threshold so it can be laid beside C-01's 0.378 (which graded the
ensemble snapshot, not the full served chain). Rule 5 in `STATS-METHOD.md`: this is a 2026
forward look, logged as an `F` row. The run also lists every `weekly_ensemble_fits` row with
`through_season >= 2026` on the copy (expected none).

## 11. What would make this wrong

- The ECR scoring basis. The current dynastyprocess file maps `weekly-rb/wr/te` to FantasyPros'
  PPR pages (`ppr-rb.php`, `ppr-wr.php`, `ppr-te.php`); the historical parquet as pulled has no
  page column, so the 2021-2024 rows are assumed to be the same pages (guess). A standard-scoring
  ECR would hand OURS an advantage on pass-catching backs.
- Timing. ECR is a Friday scrape. OURS uses the week's final injury report (`nfl_injuries`,
  also Friday). Neither sees Sunday-morning inactives.
- The pool. Pairs are league-wide, not one roster's choices (as in C-01 and S-02).
- The leaks in §4 (all flatter OURS).

## 12. Licence and terms (read before any measurement)

- **dynastyprocess/data** (source of `db_fpecr.parquet` and `db_playerids.csv`): `master/LICENSE`
  is GPL-3.0 (35,149 bytes; `gh api repos/dynastyprocess/data/license` → `GPL-3.0`, read
  2026-09-22). `LICENSE.md`, `LICENSE.txt` and `COPYING` return 404 on `master`; the repo has no
  `main` or `gh-pages` branch; `README.md` (2,082 bytes) carries no licence text. GPL-3.0 cannot
  grant rights in the FantasyPros data it scrapes.
- **FantasyPros Terms of Use** (https://www.fantasypros.com/about/legal/, read 2026-09-22,
  "effective as of July 1, 2010"): "Except for a single copy made for personal use only, you may
  not copy, reproduce, modify, republish, upload, post, transmit, or distribute any documents or
  information from this site in any form or by any means without prior written permission."
- **How this unit uses it:** benchmark only, on Nick's machine. The raw rows stay in
  `.local-db/` (git-excluded) and are never committed, never served and never shown. Only
  aggregate grades (rates, differences, counts) are committed, per the coordinator's HX-01 note.
  **Open question for Nick:** the fleet licence rule (memory
  gridiron-licence-before-measurement-rule, step 2) refuses a source with a personal-use clause;
  the coordinator's note allows benchmark-only use with aggregates. The repo already ingests the
  same file for preseason ranks (`server/services/historical-adp.js:43`). Whether committing
  aggregate grades derived from FantasyPros ranks to a public repo is within "personal use" is
  Nick's call.
- **ESPN** (2026 forward only): first-party to the synced leagues, already stored by main's
  roster-snapshot step; no new fetch.
- **Not used:** Sleeper/RotoWire weekly projections (the R&D loop found past-week values
  re-stamped after the week, so no historical value can be shown to be pregame; the endpoint is
  undocumented). ESPN projections for 2021-2024: the app's own ESPN client reads each league's
  current season only (`scripts/collect-roster-snapshots.mjs:220,230-233`; `fetchBoxscore` at `:175`
  is internal), so they are **not available**; no new fetch is written.

## 13. Literature

Combined and consensus forecasts are hard to beat: across decades of forecasting studies a
simple average of experts usually matches or beats any single model (Clemen 1989, *International
Journal of Forecasting* 5(4):559-583; Genre, Kenny, Meyler and Timmermann 2013, *IJF*
29(1):108-121), so the prior expectation is that FantasyPros' consensus is the harder baseline,
not the season average. Forecasts should be judged by the decisions they drive, not only by
error (Granger and Pesaran 2000, *Journal of Forecasting* 19(7):537-560), which is why the
primary metric is the decision win rate. A start/sit pair involves two players who each recur
across many pairs, a crossed design whose correct resampling unit is the pigeonhole bootstrap
(Owen 2007, *Annals of Applied Statistics* 1(2):386-411); minimum detectable effects follow
Bloom (1995, *Evaluation Review* 19(5):547-556), and Holm (1979, *Scandinavian Journal of
Statistics* 6(2):65-70) controls the family of 11 "where" cells.

## 14. Output

`docs/evidence/2026-09-22/historical-consensus-head-to-head-output.json`: aggregates only (no
player rows, no FantasyPros values, no league or manager data), labelled "local copy, not
production", with the tree, this file's commit and blob, the k control, the walk-forward table,
the join counts, every cell, and the forward read. Magnitudes stay in the evidence for the
Auditor; anything that reaches Nick's page carries direction only (standing rule 3).
