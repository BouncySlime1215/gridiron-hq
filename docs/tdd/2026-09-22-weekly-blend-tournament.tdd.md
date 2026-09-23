# BLEND-01: one producer for the served weekly number, blended with ESPN's by a pre-registered tournament

Unit BLEND-01 (WORK-QUEUE §15; plan item C12 / Structure). Branch
`claude/local-blend-01-weekly-blend-tournament` from `origin/main` `a3e2bf35`. Pre-registration:
`docs/evidence/2026-09-22/weekly-blend-tournament-preregistration.md`, committed before any number.
All data runs are on a **local copy, not production** (`.local-db/data.sqlite`, a `.backup` of
`~/gridiron-local/data.sqlite` taken 2026-09-22 19:57 ET).

## 1. Audit: extend or build (written before the first test, tree `a3e2bf35`)

**Verdict: build a new served module and a study; extend the producer at one call site.**
Nothing on main blends ESPN's weekly projection into any weekly number. Command:
`git grep -c -i -E "projected_points|league_roster_snapshots" -- <file>` returns 0 for
`weekly-ensemble.js`, `weekly-backtest.js`, `fantasy-coordinator.js` and `trade-engine.js`, and 1
for `lineup-brain.js`, where the hit (`:686`) is a lineup-total output field, not a read.
Known-nonzero control: 8 in `scripts/collect-roster-snapshots.mjs`.

| Existing | file:line on `a3e2bf35` | What it does today | Decision |
|---|---|---|---|
| The producer | `server/services/trade-engine.js:384` `currentWeekPpg` → `current_week_ppg` (`:474`) | this week's number: base x `thisGame.mult` x `active_probability`, 0 on a bye | **extend at this one line**. Every weekly page reads it (next row) |
| Its readers (STRUCTURE-MAP D1 a-d) | `lineup-brain.js:356` `startSitWeekPoints`; `trade-engine.js:2675` `lineupDiffWeekPoints`; `waiver-wire.js:127` `weekPpg`; `lineup-posture.js:68` `weekPpg`; `TradeCard.tsx:79` | Start/Sit, the League Hub card, the waiver board, the matchup card and the trade pill all read `current_week_ppg` | **no edit**: blending where the number is made reaches all five |
| S-03 (local branch, not merged) | `trade-engine.js:352-367` on its branch; `fantasy-coordinator.js:710` `servedWeekConstruction` | serves only a promoted coordinator fit on its own base; switches the betting-line lift off; promoting fit 7 in both windows | **stack on it, never edit its lines**. The study rebuilds its base from merged functions and checks parity once merged |
| ESPN's weekly projection | `league_roster_snapshots.projected_points`, writer `scripts/collect-roster-snapshots.mjs:109` `writePeriod` (value built `:92`) | every rostered player, per league and period; `live` rows updated each refresh tick, `final` rows from the boxscore; only reader today is `bluff-detector.js:111` (names only) | **reuse as the blend's ESPN input; no migration** |
| ESPN id → our player | `players.espn_id`, written by `server/services/espn-draft.js:135` `resolveEspnPlayers` (`:167` update, `:172` insert); the collector maps the same way (`collect-roster-snapshots.mjs:52` `playerIndex`) | the app's one ESPN id mapping | **reuse**: the reader keys on `players.espn_id` |
| Combination maths | `server/services/forecast-combination.js:159` `constrainedLeastSquares`; `:577` `shrunk_to_equal` (Stock-Watson) | betting-only today (plus `opportunity-model.js`, which imports `solveLinear` only) | **reuse** `constrainedLeastSquares` for fitted weights and the Stock-Watson shrinkage form, with T counted as weekly slates (`:27-32`) |
| Grading pieces (S-02, #155) | `scripts/weekly-construction-grade-lib.mjs:99` `eligibleRows`, `:276` `assertKControl`, `:286` `assertFitCutoff`, `:123` `mde80`, `:196` `decisionWinRate` | the decision-row population, the replay guards, MDE | **reuse**. S-02 clusters its CIs by week x position; the unit asks for player-clustered intervals, so the pair bootstrap is new |
| Pair accuracy | `scripts/promote-early-week-weights.mjs:153` `startSitPairAccuracy` | house start/sit pair metric | **reuse** as the parity check on the runner's own pair enumeration |
| Served snapshot | `weekly_prediction_snapshots`, writer `server/services/weekly-learning.js:49` `captureWeeklyPredictions` (insert `:63`) | 2026 W2 only: the ensemble on frozen-2023 weights, 18:56Z Thursday | **forward sensitivity** (what was served then) |
| ESPN Thursday capture | `espn_player_market_weekly` (no writer in the repo) | one W2 capture, 22:08Z Thursday | **forward sensitivity only** |
| ESPN archive | R&D loop `~/gridiron-local/rnd/loop/data/espn_proj_hist/` (`r2-external-espn-weekly-projection-history.md`) | ESPN's weekly projection for 2021-2024 and 2026, the same number the app stores | **history input, local only, never committed** |
| HX-01 (local branch, not merged) | `scripts/historical-consensus-lib.mjs` on its branch | our served number replayed 2022-2024 against FantasyPros | **not imported** (not merged). Same replay shape rebuilt here; follow-up: swap in its served-row library once merged |
| C-01 (local branch, not merged) | `server/services/gates/start-sit-gate.js` on its branch | the start/sit gate, with ESPN as arm B on W2 | **not imported**. Its "one value per player-week, conflicting leagues dropped" rule is reused |
| RL-1-1 (queued) | migration 071 `espn_proj` column | same-cutoff ESPN capture for free agents | **not built** (no migration in this unit) |

**Other producers of "this week's points" this unit does not change** (STRUCTURE-MAP D1):
- (e) the raw `ppg`/`proj` fields;
- (f) `ceiling-lineup.js`;
- (g) `news-fantasy-impact.js`;
- (h) `season-sim.js`;
- (i) `fantasy-coordinator.js` `weeklyProjectionFor` (never rendered).

Named, not edited. The follow-ups are S-01, S-05 and S-06. The floor, ceiling and mean
(`weekDist`, `WEEK_MARGINAL`) stay on our distribution; that is a named follow-up in §7.

## 2. TDD record

| Step | Commit | Subject | Liveness |
|---|---|---|---|
| Pre-registration | `7c443485` | docs: BLEND-01 audit and pre-registration of the weekly blend tournament, before any number | the runner's `--grade` refuses a dirty or uncommitted pre-registration |
| RED (module, study) | `73eb777f` | test: the weekly blend's seven candidates, its fallbacks, its ESPN reader and the tournament's rules (RED) | run in a clean worktree at `73eb777f`: both files fail, `# tests 1 # fail 1` each, with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/weekly-blend.js'` and `'.../scripts/weekly-blend-tournament-lib.mjs'` (new modules) |
| GREEN (module, study) | `45f17e38` | feat: the weekly blend module and the tournament runner, graded on the served functions (GREEN) | `test/weekly-blend.test.js` 7/7, `test/weekly-blend-tournament.test.js` 15/15 |
| RED (diagnostic) | `ef5b5360` | test: the tournament reports how much of the gap is our chance-to-play multiplier, labelled a diagnostic (RED) | `not ok 16 - the availability diagnostic grades our base without the chance to play, on the primary pairs`: `lib.availabilityDiagnostic is not a function` |
| GREEN (diagnostic) | `ac6ac5b8` | feat: the tournament reports how much of the gap is our chance-to-play multiplier (GREEN) | 16/16 |
| Result | `91fdf3f4` | docs: BLEND-01 tournament result: ESPN's weekly projection alone wins; no blend of ours beats it | output committed after the pre-registration (`7c443485` is its ancestor) |
| Stack | `c99c6ef8` | chore: merge S-03's branch head (8ddebcd8) so the blend wires on top of the served construction it changes | S-03 not on origin/main; this PR is stacked on it |
| RED (call site) | `62fb95ba` | test: the producer serves the tournament's decision through one call site, labelled per player (RED) | `test/weekly-blend-wiring.test.js` 1/6: `not ok 1 - the blend is on for this fixture ...` with `Cannot read properties of undefined (reading 'on')` (no `context.week_blend`); `not ok 2 - current_week_ppg is the served candidate of ours and ESPN's number, and says so` with `'13.25 vs 16.624000000000002'` (ours served, blend expected); also `not ok 3`, `4`, `6`. `test/weekly-blend.test.js` 5/8: `not ok 8 - SERVED_BLEND is the committed tournament decision, not a hand-set switch`, and the `no_game` label (`not ok 4`, `6`) |
| GREEN (call site) | `e55864be` | feat: this week's number is served through the tournament's blend at the one producer line (GREEN) | 8/8, 6/6, 16/16; the 20 existing files that touch the producer or its readers pass (§4.7) |

Test 5 of the wiring file (Start/Sit's `week_points` and `adj_ppg` read `current_week_ppg`) also
passes on the unwired code: it pins the consumers, not the call site. Its liveness comes from the
consumer mutants C12 and C13 in §5, not from RED.

## 3. What it does

- **`server/services/weekly-blend.js`** (served): the seven pre-registered candidates as
  functions, one place that decides the fallbacks (no game → 0, K/DEF → ours, no ESPN value →
  ours, each labelled), the late-news trigger, and `SERVED_BLEND`, the tournament's recorded
  decision. `servedWeekBlend` is the one entry point. `espnWeekProjections` reads ESPN's weekly
  projection from `league_roster_snapshots` for this league and identically scored leagues
  (current period, rostered rows, one value per player, disagreeing leagues dropped) and never
  selects a league's cookies. No migration.
- **`trade-engine.js` `buildAssetUniverse`** (the one call site): our number (the served
  construction x this game's factor x his chance to play, 0 with no game) goes through
  `servedWeekBlend` where `currentWeekPpg` is made, so `current_week_ppg` and everything built
  from it (Start/Sit's `week_points`, the League Hub card, the waiver board, the matchup card, the
  trade pill, the trade horizon's `adj_ppg`) read one producer. Each asset carries `week_blend`
  (basis, share on ours, ESPN's number); `context.week_blend` carries the sentence, the verdict
  and ESPN's capture state. `league_roster_snapshots` joins the asset cache's inputs, so a new
  ESPN capture refreshes the number.
- **`scripts/weekly-blend-tournament.mjs` + `-lib.mjs`** (study, never served): `--assemble`
  replays our served number for 2022-2024 and 2026 week 2 beside ESPN's number (counts only);
  `--grade` fits walk-forward, grades every candidate on one pair set with a player bootstrap,
  applies the selection, complexity and ship rules, and writes aggregates only.

## 4. The numbers (local copy, not production)

Every number below comes from
`GRIDIRON_DB_PATH=<worktree>/.local-db/data.sqlite SCHEDULER_DISABLED=1 NFL_SEASON=2026 nice -n 10 node --max-old-space-size=3072 scripts/weekly-blend-tournament.mjs --grade --rows-dir .local-db/blend-rows`,
run on tree `ac6ac5b8` (write-tree `a26d4395`), output
`docs/evidence/2026-09-22/weekly-blend-tournament-output.json`. It was first run on `45f17e38`.
The second run added only a labelled diagnostic and one key rename, and every pre-registered
section of the two outputs is byte-identical (compared field by field). Rows come from
`--assemble`, run twice on the same code (`45f17e38`, byte-identical files). The 2026 rows were
re-assembled after the S-03 merge (`--assemble --forward-only`): 360/360 rows passed parity
against S-03's `servedWeekConstruction`, and the file is byte-identical.

- **Configuration.** Replays run in configuration B (`buildPlayerWeekEngine`, `WEEKLY_ROLE_RECENCY`
  hardcoded at `player-week-engine.js:273`, no `kOverride`).
  - The k control read the fitted volume k: 1.053 (2022), 0.461 (2023), 0.275 (2024), 0.173
    (2026). None was 6.
  - Weight sets: `frozen-2023` for 2022-2024, `fit-2` for 2026.
  - Coordinator fits, walk-forward:

    | Season graded | Fit seen through | Examples | Intercept |
    |---|---|---|---|
    | 2022 | ≤ 2021 | 5,280 | +0.250 |
    | 2023 | ≤ 2022 | 11,029 | −0.154 |
    | 2024 | ≤ 2023 | 16,793 | −0.339 |
    | 2026 | fit 7, through 2025 | — | −0.555 |

    Every decision row got the coordinator's base (0 ensemble fallbacks).
- **Held-out season.** 2025 was not opened. Interval: 90%, player pigeonhole bootstrap, 2,000
  draws, seed 1. Sign: candidate − reference, positive favours the candidate.
- **Rows.**

  | Season | Decision rows | With an ESPN value |
  |---|---|---|
  | 2022 (fit-only) | 5,207 | 5,160 |
  | 2023 | 5,206 | 5,153 |
  | 2024 | 5,236 | 5,185 |

  2026 week 2 has 360 decision rows. ESPN's settled value covers 153 of them (194 player-weeks, 0
  conflicting across leagues), the archive 344, the Thursday capture 342, and the snapshot 360.
- **Parity.** 108,905 primary pairs. The runner's pair accuracy equals `startSitPairAccuracy`'s for
  all seven candidates, and its ESPN-vs-ours win rate equals S-02 `decisionWinRate`'s (0.6153).

### 4.1 History, pooled 2023 + 2024 (the verdict)

10,338 rows, 691 players, 108,905 pairs where ours projects both ≥ 4.

| candidate | pair accuracy | − ours [90% CI] | MDE80 | disagreements | win rate | points per decision [90% CI] | − ESPN [90% CI] |
|---|---|---|---|---|---|---|---|
| ours (C1) | 0.6359 | — | — | — | — | — | −0.0471 [−0.0546, −0.0395] |
| **ESPN (C2)** | **0.6830** | **+0.0471 [+0.0395, +0.0546]** | 0.0113 | 22,217 | 61.5% | **+2.70 [+2.28, +3.15]** | — |
| 50/50 (C3) | 0.6783 | +0.0424 [+0.0368, +0.0486] | 0.0089 | 13,709 | 66.8% | +3.90 [+3.46, +4.32] | −0.0047 [−0.0081, −0.0011] |
| late news (C7) | 0.6527 | +0.0167 [+0.0136, +0.0201] | 0.0049 | 2,011 | 95.2% | +9.16 [+8.25, +10.06] | −0.0303 [−0.0368, −0.0236] |
| fit, shrunk (C4) | 0.6829 | +0.0469 [+0.0399, +0.0541] | 0.0107 | 20,088 | 62.7% | +2.95 [+2.54, +3.38] | −0.0001 [−0.0016, +0.0014] |
| position x phase (C5) | 0.6829 | +0.0470 [+0.0400, +0.0542] | 0.0108 | 20,250 | 62.6% | +2.93 [+2.50, +3.36] | −0.0001 [−0.0014, +0.0013] |
| ESPN + proven (C6) | 0.6830 | +0.0470 [+0.0395, +0.0545] | 0.0113 | 21,773 | 61.8% | +2.75 [+2.33, +3.20] | 0.0000 [−0.0007, +0.0006] |

**Selection (pre-registered §6).**
- All six candidates are good against ours.
- The champion is ESPN: the first good rung; 50/50 shares the rung with lower pair accuracy.
- No climb clears its MDE against ESPN:

  | Candidate | Difference over ESPN | MDE80 |
  |---|---|---|
  | late news | −0.0303 | 0.0100 |
  | fit, shrunk | −0.0001 | 0.0022 |
  | position x phase | −0.0001 | 0.0021 |
  | ESPN + proven | 0.0000 | 0.0010 |

- **Winner: ESPN alone.**
- The late-news layer is not tested, because the winner is not a blend: ESPN already is ESPN's
  latest.

**Fits (shipping parameters, 2022-2024, 7,469 fit rows, 48 slates).**
- C4's share on ours is `w_hat` 0.087, shrunk to 0.105 (lambda 0.956). Walk-forward, it was 0.159
  for 2023 (fit on 2022) and 0.120 for 2024 (fit on 2022-2023).
- C6 proves a positive slope in 6 of 16 cells: QB 2-4 0.19, QB 5-8 0.18, RB 2-4 0.13, RB 9-13
  0.18, WR 5-8 0.15, TE 2-4 0.25. None clears the plan's 0.3 bar. Even there, C6 does not order
  better than ESPN alone.

### 4.2 Secondary views (no rule attached)

- **Played only** (drops the at-lock zeros): ESPN − ours +0.0308 [+0.0240, +0.0382], +1.99
  points per decision [+1.58, +2.41]. The best blend against ESPN is 0.0000. So ESPN's edge is not
  only news timing.
- **House universe** (every candidate projects both ≥ 4): ESPN − ours +0.0318 [+0.0243, +0.0390].
- **By season:** 2023 +0.0472 [+0.0378, +0.0577]; 2024 +0.0469 [+0.0366, +0.0576].
- **MAE** on decision rows: ours 4.118, ESPN 3.633, C4 3.615, C3 3.690. **Mean signed error**
  (prediction − actual): ours −2.00, ESPN +0.10. Our number runs about 2 points low on these rows,
  and 3.5 points below ESPN where ours ≥ 4 (the level gap, ESPN − ours: +2.10 on all rows, +3.52
  where ours ≥ 4).

### 4.3 Forward, 2026 week 2 (shipping parameters; one week, so direction only)

| view | rows / pairs | ESPN − ours, pair accuracy [90% CI] | MDE80 | points per decision [90% CI] |
|---|---|---|---|---|
| **primary**: replayed served number vs ESPN settled (rostered) | 153 / 2,778 | **+0.052 [−0.002, +0.102]** | 0.079 | **+1.39 [−0.52, +3.16]** (807 calls, 59.0%) |
| archive (every player) | 344 / 4,314 | +0.065 [+0.022, +0.110] | 0.066 | +1.97 [+0.37, +3.60] |
| Thursday capture | 342 / 4,314 | +0.036 [−0.008, +0.082] | 0.067 | +0.69 [−1.02, +2.37] |
| Thursday snapshot as ours | 153 / 1,796 | +0.067 [−0.001, +0.135] | 0.103 | +2.94 [+0.37, +5.67] |

**Ship rule (pre-registered §7).**
- (a) ESPN is good against ours on history.
- (b) Its history points per decision are +2.70 > 0.
- (c) Forward, the pair-accuracy difference (+0.052) and the points per decision (+1.39) are both
  above 0, so it holds.
- **Verdict: shipped, ON.**

**Does it beat ESPN alone? No.** The winner is ESPN alone. No blend of our number with ESPN's beat
ESPN. The closest was ESPN plus our proven correction, 0.0000 [−0.0007, +0.0006] with an MDE80 of
0.0010. So any information our number adds on top of ESPN's is below about 0.001-0.002 of pair
accuracy at 80% power.

### 4.4 What is going on: the chance-to-play diagnostic (not pre-registered, no rule attached)

On the same 108,905 pairs:
- For 5,963 startable rows with no injury designation, our chance to play averages **0.694**, but
  **94.9%** of those players played.
- Our base with no multiplier: +0.0069 [+0.0012, +0.0128] over ours.
- Our base with the multiplier kept only for designated players: **+0.0116 [+0.0059, +0.0177]**,
  +1.00 points per decision.
- ESPN still beats that best version by 0.0354 [0.0287, 0.0420].

So about a quarter of ESPN's 0.047 lead is our chance-to-play layer. The rest is ESPN's better
base projection and its at-lock news.

**The served function shows the same.** For 2026 week 3 (`weeklyAvailability(2026, 3, { through: 2025 })`,
the producer's own call, on the `pooled` path because `nfl_availability_role_rates` is absent),
the 119 players ESPN projects ≥ 8 with no designation get active_probability 0.730 on average
(range 0.241-0.831). The durability prior averages 0.728. Command:
`GRIDIRON_DB_PATH=.local-db/data.sqlite NFL_SEASON=2026 node docs/evidence/2026-09-22/blend-01/availability-check.mjs`.
This is `contingency.js`, another unit's file: reported, not edited (§6).

### 4.5 The served number (consumer check)

Command: `GRIDIRON_DB_PATH=.local-db/data.sqlite NFL_SEASON=2026 node docs/evidence/2026-09-22/blend-01/consumer-check.mjs`,
2026 week 3, through the real `assetUniverse` and `startSitWeekPoints` on `e55864be`.

| Check | Result, each of 5 ESPN leagues |
|---|---|
| Players served ESPN's number (`blend`) | 166; 0 differ from ESPN's projection |
| Players keeping ours (`no_espn_value`) | 400 |
| Players with no team or game (`no_game`, 0 as before) | 8,074 |
| Start/Sit `week_points` ≠ `current_week_ppg` | 0 |
| `context.week_blend` | `on=true`, `candidate=espn`, `verdict=shipped`, ESPN `present`: 756 rows, 194 players, 0 conflicting, 5 identically scored leagues, captured 2026-09-22T22:55Z |

Coverage (`docs/evidence/2026-09-22/blend-01/coverage-check.mjs`): all 5 ESPN leagues score identically, so a
player rostered in any of them has ESPN's number in all of them. Per league, 14-53 of the
166 covered skill players are free agents there.

### 4.6 Holdout looks

2025 was not opened: the runner refuses it, and ESPN's 2025 file was never pulled. The looks at
2026 week 2 are rows F005-F009 of `docs/evidence/HOLDOUT-LEDGER.md`:
- the primary rule-5 check;
- three report-only sensitivities;
- the reproduction run, which spends the week again.

### 4.7 Targeted tests on the head

Each test file was run with
`node --experimental-test-module-mocks --test --test-reporter=tap test/<file>.test.js`,
`SCHEDULER_DISABLED=1`, and `GRIDIRON_DB_PATH` on a fresh temporary path.

- The new files: `weekly-blend` 8/8, `weekly-blend-wiring` 6/6, `weekly-blend-tournament` 16/16.
- Existing files that touch the producer or its readers, 183 passing tests, 0 failing:

  | File | Pass | File | Pass |
  |---|---|---|---|
  | served-weekly-construction | 18 | availability-honest-degradation | 8 |
  | fantasy-coordinator | 8 | availability-fit-loader | 7 |
  | asset-cache-stamps | 5 | posture-calibration | 6 |
  | hand-fed-table-states | 10 | lineup-floor-objective | 3 |
  | lineup-surfaces-agree | 2 | start-sit-decision-curve | 12 |
  | ros-projection-wiring | 1 | weekly-construction-grade | 48 |
  | decision-leftovers-waivers | 7 | ceiling-lineup-weekly-agreement | 3 |
  | decision-leftovers-lineup | 10 | ceiling-lineup-recency | 6 |
  | decision-leftovers-home-away | 5 | lineup-diff-urgency | 10 |
  | waiver-kicker-defense | 7 | waiver-confidence-is-hand-set | 7 |

- `npm run check` was not run here; the Gate phase runs it once.

## 5. Mutation sweep

**How it ran.** Runner `docs/evidence/2026-09-22/blend-01/mutate.mjs` (specs `mutants.json` and
`mutants-consumers.json` beside it), the shared `mutate-run-v1.sh` shape rebuilt for this Mac;
the shared script was not edited.
- Each run uses a fresh detached worktree of `e55864be` (tree `781aeba0`).
- A mutant is applied only when its anchor occurs exactly once; otherwise the row is NOT-APPLIED.
- The file's sha256 is taken before and after, the tests run, and the file is restored and
  re-hashed.

**The runs.**
- Run 1: the three blend test files, baseline 30 pass / 0 fail.
- Run 2 (consumers): `test/weekly-blend-wiring.test.js`, baseline 6/0.
- Every row, with its exact before and after text, is in `docs/tdd/sweeps/weekly-blend.mutations.json`.

**Result: 29 of 29 real mutants killed.** The designed survivor survived, and the not-applied
control was not applied.

| id | kind | mutant | sha256 before→after | reds | verdict | first red test |
|---|---|---|---|---|---|---|
| U1 | unit | late-news trigger fires on ESPN 0 when ours is 0 | c69cd5c7→4fb2bbc8 | 1 | KILLED | the late-news trigger: ESPN at 0 while ours is not, or Out/Doubtful; nothing else |
| U2 | unit | late-news status widened to Questionable | c69cd5c7→e389e49b | 1 | KILLED | same |
| U3 | unit | week 4 leaves the 2-4 band | c69cd5c7→067df903 | 2 | KILLED | phaseFor puts each week in its pre-registered band |
| U4 | unit | 50/50 becomes 60/40 | c69cd5c7→0341ca83 | 3 | KILLED | each candidate computes exactly its pre-registered formula |
| U5 | unit | ESPN-alone returns ours | c69cd5c7→3fc2eeaf | 1 | KILLED | same |
| U6 | unit | no game serves ours, not 0 | c69cd5c7→7b79db32 | 2 | KILLED | the fallbacks are decided once and labelled |
| U7 | unit | kickers blended | c69cd5c7→466c3888 | 2 | KILLED | same |
| U8 | unit | ESPN reader keeps dropped players | c69cd5c7→eac9ca62 | 1 | KILLED | ESPN's number: this league and identically scored leagues, current period, rostered, one value |
| U9 | unit | leagues 1 point apart still give a value | c69cd5c7→051035dd | 1 | KILLED | same |
| U10 | unit | ESPN reader ignores scoring | c69cd5c7→0e9420cb | 1 | KILLED | same |
| U11 | unit | ESPN reader reads earlier periods | c69cd5c7→575744f8 | 1 | KILLED | same |
| U12 | unit | served switch ignored | c69cd5c7→e9d05fd4 | 1 | KILLED | the served switch: off serves ours, labelled; on serves the recorded candidate |
| U13 | unit | espn_proven unproven cell takes 0.5 of ours | c69cd5c7→0d8cbd5e | 1 | KILLED | each candidate computes exactly its pre-registered formula |
| U14 | unit | pos_phase missing cell uses 0.5 | c69cd5c7→cddf3a1f | 1 | KILLED | same |
| U15 | unit | late-news layer ignored on a blend | c69cd5c7→829c7e33 | 4 | KILLED | late news: the news candidate and the layer take ESPN only when the trigger fires |
| U16 | unit | served decision drifts from the grade (`'espn'`→`'half'`) | c69cd5c7→5e7b5b8b | 1 | KILLED | SERVED_BLEND is the committed tournament decision, not a hand-set switch |
| S1 | designed survivor | `0.5 * x.ours + 0.5 * x.espn` → `(x.ours + x.espn) / 2` (exactly equal in binary floating point) | c69cd5c7→3e6a1a17 | 0 | SURVIVED (equivalent, by design) | — |
| N1 | not-applied control | anchor `const BLEND_DISABLED = true;` absent | c69cd5c7 | 0 | NOT-APPLIED | — |
| C1 | call site | passes no ESPN number | 8125a062→f264ee6c | 3 | KILLED | current_week_ppg is the served candidate of ours and ESPN's number, and says so |
| C2 | call site | `currentWeekPpg` ignores the blend | 8125a062→06d84df1 | 3 | KILLED | same |
| C3 | call site | wrong week (`target.week + 4`) | 8125a062→cdca6a00 | 2 | KILLED | same |
| C4 | call site | wrong position (`'QB'`) | 8125a062→0eb89bde | 2 | KILLED | same |
| C5 | call site | drops the report status | 8125a062→656c2bde | 1 | KILLED | late news: his week's Out status switches him to ESPN's number |
| C6 | call site | every player has a game | 8125a062→d618a6bc | 1 | KILLED | a player ESPN has no number for keeps ours, labelled; a player with no game is 0 |
| C7 | call site | drops the injected `SERVED_BLEND` | 8125a062→e3c38d12 | 3 | KILLED | current_week_ppg is the served candidate ... |
| C8 | call site | `league_roster_snapshots` out of the cache inputs | 8125a062→198776cb | 1 | KILLED | a new ESPN capture refreshes the cached universe |
| C9 | call site | ESPN read for last week | 8125a062→fd3ecb92 | 4 | KILLED | the blend is on for this fixture and ESPN has a number for one WR (known-nonzero control) |
| C10 | call site | surface loses `week_blend` | 8125a062→2cf1ef6e | 2 | KILLED | same |
| C11 | call site | asset loses ESPN's number | 8125a062→be33b723 | 1 | KILLED | current_week_ppg is the served candidate ... |
| C12 | consumer | trade horizon reads the unblended week | 8125a062→ff56fd34 | 1 | KILLED | Start/Sit's week_points and the trade horizon's adj_ppg read the blended number |
| C13 | consumer | Start/Sit reads `adj_ppg` first (`lineup-brain.js`) | 2a12811e→cd6433af | 1 | KILLED | same |

## 6. Known defects and limits

**What this change leaves wrong, most important first:**

1. **The waiver board compares two bases.** Players ESPN covers get ESPN's number; everyone else
   keeps ours. ESPN covers 194 players, the ones rostered in any of Nick's 5 identically scored
   leagues. Ours runs low: mean signed error −2.00, and −3.52 against ESPN where ours ≥ 4 (§4.2),
   mostly from the chance-to-play layer (item 2). A free agent nobody rosters is therefore priced
   about 3 points under the rostered players he is compared with, so the weekly-gain part of a
   waiver call understates him. The rest-of-season part (`ros_ppg`) is unchanged. Two fixes:
   calibrate chance to play (item 2), or capture ESPN's number for free agents (RL-1-1's column;
   needs a table, so Nick's word).
2. **Our chance to play is miscalibrated. This is reported, not edited: `contingency.js` is
   another unit's file.** Healthy startable players get an average of 0.69 in the replay and
   0.73 in the served week-3 call, yet about 95% of them play (§4.4). `weeklyAvailability` runs on
   the `pooled` path with the durability prior near 0.73. Removing the multiplier for undesignated
   players recovers +0.0116 of pair accuracy. It is the biggest fixable piece of "why ESPN wins".
3. **Calibrations fit on our level now read ESPN's level for covered players.** These are
   `lineup-brain.js:268` `DECISION_CURVE`, the posture spread (`lineup-posture.js`, S-16) and the
   waiver `MIN_GAIN`. C-10 and S-16 should refit on the served basis.
4. **Floor, ceiling and mean stay on our distribution.** `weekDist` and `WEEK_MARGINAL` are not
   re-centred on ESPN's number, so a covered player's `avg` can differ from his `week_points`.
   S-14 (provenance chips) should render `week_blend.basis`; re-centring is its own unit.
5. **Production depends on the refresh loop.** Only `scripts/collect-roster-snapshots.mjs`, run by
   `refresh-live-data.mjs`, writes `league_roster_snapshots`. Where that loop does not run,
   every player keeps ours (`no_espn_value`), and `context.week_blend.espn.state` reads `empty`
   (labelled, not silent). ESPN's number is only as fresh as the last capture (`captured_at` is
   on the surface). There is no staleness cut-off; none was pre-registered.

**Study limits:**

- `frozen-2023` ensemble weights replay 2022-2024, and they may have seen those seasons. That
  favours ours, which is conservative for this result.
- The 2021 coordinator examples used the hand-set k.
- The availability rates were fit once.
- ESPN's archived value is its last pre-lock number. The served number has that timing only
  when the loop runs near lock; the played-only view (+0.031) shows the edge is not only timing.
- The forward check is one week.
- HX-01 is not merged, so the runner rebuilds the served rows itself. Swap in HX-01's library
  once it lands.

**Producers of "this week's points" still separate** (STRUCTURE-MAP D1 e-i):
- the raw `ppg` and `proj` fields;
- `ceiling-lineup.js`;
- `news-fantasy-impact.js`;
- `season-sim.js`;
- `weeklyProjectionFor`.

## 7. Nick's five questions

1. **Well built?** Yes, with the limits in §6.
   - One served module: the seven candidates are functions the study itself grades.
   - One call site, with labels on every player.
   - The ESPN reader uses parameterised SQL and never selects cookies.
   - No migration from this unit. S-03's additive `072_fantasy_coordinator_fit_promotion` arrives
     with the stack.
   - 30 new tests pass, plus the 183 existing tests on the producer's readers. The mutation sweep
     is in §5.
2. **Stats or made up?** Stats. The tournament was pre-registered (`7c443485`) before any number
   existed. The served choice, ESPN alone, has no fitted or hand-set parameter.
3. **How we know.**
   - Backtest, 2023-2024 walk-forward (2022 fit-only): 10,338 rows, 108,905 start/sit pairs.
     Pair accuracy is 0.636 for ours and 0.683 for ESPN, +0.047 [+0.040, +0.055]. ESPN wins 61.5%
     of the 22,217 calls where they disagree, +2.70 points per call.
   - Forward, 2026 week 2: +0.052 [−0.002, +0.102], +1.39 points per call. That is one week,
     direction only.
   - No blend beat ESPN alone.
4. **Pointed anywhere else?** Yes. Every page that reads `current_week_ppg`: Start/Sit, the
   League Hub card, the waiver board, the matchup card, the trade pill, and the trade horizon's
   `adj_ppg`. Not the ceiling lineup, the news tracker, the season sim, `weeklyProjectionFor`, or
   the floor/ceiling distribution (§6).
5. **How it unifies.** One producer (`servedWeekBlend`, at `trade-engine.js` `currentWeekPpg`).
   One switch (`SERVED_BLEND`, pinned by test to the committed decision). One ESPN reader, over
   the table the refresh loop already writes.

**Also:**
- **Defect fixed:** the served weekly number ignored ESPN's projection
  (`trade-engine.js:384` on `a3e2bf35`), which orders start/sit calls better.
- **Incumbent, by command:** S-03's served construction, rebuilt by the runner and checked 360/360
  against `servedWeekConstruction`.
- **Not covered:** see §6.
- **What would make it wrong:**
  - ESPN's archived weekly values being post-game revisions (r2 §2 found no sign on 2026 week 2);
  - ESPN's 2026 projections degrading, which a weekly forward re-check would catch;
  - the refresh loop not running where the app is served (then nothing changes, and it is
    labelled).

## 8. For the PR and the coordinator

- **Stacked on S-03.** The branch merges S-03's head `8ddebcd8`, which is not on origin/main.
  Merge S-03 first, then this. S-03 brings its own additive migration
  `072_fantasy_coordinator_fit_promotion`; this unit adds no migration.
- **Deviation from the unit text, stated in the pre-registration §2.** The history uses ESPN's own
  archived weekly projections (the same number the app stores; R&D r2), not FantasyPros ranks as a
  proxy. FantasyPros is not read.
- **What ships is ESPN alone, not a blend.** The pre-registered complexity rule kept the simplest
  good candidate, and no blend beat it.
- **This is a projection change, so it goes to the Independent Auditor before merge** (standing
  rule 2).
- **Follow-ups this unit names but does not build:**
  - chance-to-play calibration (`contingency.js`, D2), the biggest fixable part of the gap;
  - free-agent ESPN coverage (RL-1-1);
  - a `DECISION_CURVE` and posture refit on the served basis (C-10, S-16);
  - per-player chips for `week_blend.basis` (S-14);
  - swapping in HX-01's served-row library once it merges.
