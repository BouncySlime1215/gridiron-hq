# TDD evidence: chance to play by role (2026-09-18)

**Module:** `server/services/contingency.js` (`weeklyAvailability`, `playerActiveProbability`, `roleStates`, `fitRoleRates`, `buildAvailabilityLookup`, `availabilityScores`, `roleGateDecision`); fit `scripts/fit-availability.mjs` (writes `nfl_availability_role_rates`).
**Source plan:** none. The journeys below come from the workflow task "play-chance".
**Why:** Start/Sit showed healthy starters a 0.57-0.86 chance to play. In 2025, healthy starters recorded a stat in 94.5% of weeks.

## How P(play) was computed for a healthy starter (traced live, 2026 week 2)
`lineup-brain.lineupCall` → `trade-engine.buildAssetUniverse` → `weeklyAvailability(2026, 2)` → `active_probability`, which also multiplies `current_week_ppg`.
1. The player has no row in `nfl_injuries`, so status `''` becomes `none` and practice `''` becomes `none`. The table has no `none|none` cell (n < 30), so it falls back to `none|any` = **0.831**. That cell was fitted only on injury-report rows, so 0.831 is the rate for players who were **on** the practice report with no game status.
2. `if (!report) active = min(active, durability prior)`. The durability prior is games-with-usage / (seasons × 17), shrunk toward a position mean that counts every backup. The QB mean is about 0.36, so Caleb Williams (100% of games played, 2 seasons) gets 0.758.
3. Live result for Nick's starters: Jayden Daniels 0.574, Devaughn Vele 0.564, Egbuka 0.687, Tyler Warren 0.671. None of them is on an injury report.

## User journeys
- As a manager, I want a healthy starter shown at his real chance to play, so Start/Sit doesn't discount him 15-40% and flag him "only plays about 57% of weeks".
- As a manager, I want a player who missed last week priced as likely to miss again, instead of getting the same number as a healthy one.
- As a manager, I want nothing to change for players the new model has no evidence about.

## Pre-registered gate (written before any 2025 number; also in the fit script's comment and `ROLE_GATE`)
- **Event:** a `player_week_usage` row that week, the same event as the existing fit.
- **Role features** (seasons s-1..s, weeks before w only): snap-share tier over the last 3 appearances (starter ≥ .60, rotation ≥ .35, depth ≥ .15, fringe, unknown) and gap, meaning team games missed since his last appearance (g0 / g1 / g2 = 2-3; 4 or more is out of scope and gets today's number).
- **Model:** hierarchical beta-binomial shrinkage, status → practice → [position] → tier → gap. Selection used only 2021-2023 fit and 2024 scoring: byPosition × k ∈ {2,5,10,20,50,100} × durability cap.
- **Validation:** refit on 2021-2024, scored once on 2025 weeks 1-18. The population is every in-scope skill player whose team played that week.
- **Pass (all three):** (1) log loss improves and the player-clustered paired bootstrap (2,000 draws, seed 20260918) 90% CI of mean(candidate − current) is below 0; (2) ECE (10 bins) improves; (3) Q/D/Out rows are no more than 0.01 worse.

## Gate result: PASS (`fit-availability.mjs --report`, scratch DB copy)
Selection picked byPosition = yes, k = 5, no durability cap (2024 log loss 0.391). The "current" arm matches the rates table on file exactly.

| 2025, 8,657 player-weeks, 700 players | current | candidate |
|---|---|---|
| log loss | 0.551 | **0.396**, bootstrap 90% CI [-0.170, -0.141] |
| calibration error (ECE) | 0.074 | **0.017** |
| guard: Q/D/Out rows (n = 669) | 0.289 | **0.257** |
| Brier | 0.186 | 0.125 |

Calibration, predicted vs actual rate:

| predicted bin | current n / mean p / actual | candidate n / mean p / actual |
|---|---|---|
| 0.0-0.1 | 378 / 0.001 / 0.000 | 512 / 0.022 / 0.021 |
| 0.1-0.2 | 36 / 0.190 / 0.333 | 961 / 0.149 / 0.139 |
| 0.2-0.3 | 541 / 0.258 / 0.349 | 342 / 0.261 / 0.243 |
| 0.3-0.4 | 631 / 0.355 / 0.501 | 278 / 0.351 / 0.435 |
| 0.4-0.5 | 865 / 0.455 / 0.553 | 235 / 0.441 / 0.421 |
| 0.5-0.6 | 993 / 0.558 / 0.626 | 404 / 0.574 / 0.577 |
| 0.6-0.7 | 1337 / 0.658 / 0.760 | 1310 / 0.670 / 0.724 |
| 0.7-0.8 | 1350 / 0.746 / 0.833 | 675 / 0.773 / 0.790 |
| 0.8-0.9 | 2497 / 0.834 / 0.800 | 1240 / 0.838 / 0.848 |
| 0.9-1.0 | 29 / 0.911 / 0.862 | 2700 / 0.955 / 0.950 |

## Stress tests (diagnostics after the gate; the decision did not move)
| slice (2025) | n | actual | log loss current → candidate | ECE current → candidate |
|---|---|---|---|---|
| healthy starters (no report, starter, g0) | 1839 | 0.945 | 0.388 → 0.209 | 0.238 → 0.007 |
| played last game (g0) | 6703 | 0.795 | 0.498 → 0.388 | 0.155 → 0.020 |
| missed 1-3 games | 1954 | 0.229 | 0.733 → 0.426 | 0.292 → 0.016 |
| QB / RB / WR / TE | all | | better at every position | better at every position |
| week 2 | 570 | 0.596 | 0.541 → 0.327 | 0.047 → 0.069 |
| **week 1** | 494 | 0.551 | **0.554 → 0.721 (worse)** | **0.066 → 0.199 (worse)** |
| questionable | 291 | 0.608 | 0.663 → 0.589 | 0.025 → 0.059 |

The bootstrap CI is the same for seeds 1, 2 and 3 ([-0.170, -0.141]).

## Start/Sit before → after (real `lineupCall`, 2026 week 2, all 5 leagues, scratch DB)
Ten healthy starters (ESPN ACTIVE, not on any injury report, in a starting slot):

| player | league / slot | P(play) | week points |
|---|---|---|---|
| Jayden Daniels | L3 QB, L4 QB | 0.574 → 0.923 | 10.65 → 17.12 |
| Caleb Williams | L1 QB | 0.758 → 0.923 | 27.24 → 33.18 |
| Josh Allen | L5 QB | 0.831 → 0.923 | 30.61 → 33.99 |
| Bijan Robinson | L2 RB | 0.831 → 0.986 | 25.31 → 30.03 |
| Jonathan Taylor | L3 RB, L5 RB | 0.735 → 0.986 | 17.35 → 23.28 |
| Bucky Irving | L3 RB, L4 RB | 0.653 → 0.943 | 13.50 → 19.50 |
| Javonte Williams | L1 RB | 0.745 → 0.943 | 17.44 → 22.07 |
| David Montgomery | L2 RB | 0.783 → 0.943 | 21.10 → 25.42 |
| CeeDee Lamb | L3 FLEX | 0.823 → 0.959 | 13.30 → 15.50 |
| Tyler Warren | L3 TE, L5 TE | 0.671 → 0.949 | 6.94 → 9.82 |

Warnings removed: Daniels 57%, Taylor 74%, Irving 65%, Warren 67%, Javonte Williams 75%. New warning: Mike Gesicki 58% (TE on 31% of snaps). Lineup changes: L1 Kyren Williams starts over Josh Jacobs (missed 2 straight games, 0.811 → 0.191); L2 Diggs over Chase Brown; L4 Vele over Kalif Raymond.

## Test specification
| # | Guarantee | Test | Type | Result |
|---|---|---|---|---|
| 1 | Tier thresholds and gap buckets as pre-registered | `role tier thresholds…`, `gap buckets…` | unit | PASS |
| 2 | Role features never read the target week | `role features never read the target week…` | unit (DB) | PASS |
| 3 | Gap counts missed team games; a bye is not a miss | `gap counts the team games he missed…` | unit (DB) | PASS |
| 4 | Week 1 reads last season | `week 1 reads the previous season…` | unit (DB) | PASS |
| 5 | Shrinkage math: child = (hits + k·parent)/(n + k) | `fitRoleRates shrinks each cell…` | unit | PASS |
| 6 | Unseen cell falls back to the deepest fitted ancestor, pooled and by position | `role lookup falls back…`, `by-position fits…` | unit | PASS |
| 7 | Healthy starter gets the role cell, not min(0.831, durability) | `a healthy starter who played last week…` | integration | PASS |
| 8 | Missed-last-game starter priced lower | `a starter who missed his team's last game…` | integration | PASS |
| 9 | Out of scope keeps today's number | `a player out of role scope…` | integration | PASS |
| 10 | Listed player: role cell × the same team ratio | `a listed Questionable starter…` | integration | PASS |
| 11 | Durability cap honoured only when selected | `the fitted durability cap is honoured…` | integration | PASS |
| 12 | No role table → every number unchanged | `with no role rates on file…` | integration | PASS |
| 13 | DDL shared by script, loader and tests | `the module exports the DDL…` | unit | PASS |
| 14 | Log loss, Brier, ECE, calibration table | `availabilityScores…` | unit | PASS |
| 15 | Gate passes only when all three rules hold | `the pre-registered gate passes only when…` | unit | PASS |

## RED → GREEN
| Stage | Commit | Evidence |
|---|---|---|
| RED | `948e51d` | 16 tests: pass 2 / fail 14. The behaviour failures are the bug itself: healthy starter `0.283` vs 0.953, a starter who missed last week `0.831` (same as healthy), Q starter `0.66`. The 2 passes are the no-change guards. |
| GREEN | this commit | 17/17 pass. One test-authoring fix (pragma_table_info got a quoted identifier) and one added test for the by-position lookup the selection chose. |

**Command:** `GRIDIRON_DB_PATH=… SCHEDULER_DISABLED=1 NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks --test --test-concurrency=1 test/availability-role.test.js`

**Regression (eval R1/R2):** model-integrity 94/94, role-scenario-engine 9/9, player-availability 15/15, bottom-up-team-total 6/6, decision-inbox 17/17, fantasy-workflows 7/7, find-trades 3/3, model-registry-persistence 22/22, league-roster-schedule 2/2, lineup-evidence 16/16, props-team-volume-dispersion 3/3, trade-evidence 6/6, ros-projection 22/22, ros-projection-wiring 1/1. `player-week-distribution` 6 fail: another agent's intended RED (`4da0e1e`, fake floors), which doesn't touch availability.

**Coverage:** contingency.js lines 77.9%, branches 86.2%, functions 93.8%. Every new line is covered. What's uncovered is untouched legacy code (`cascades`, `handcuffValue`, and the hand-set constants path, which model-integrity covers).

## Eval report (eval-harness)
Capability: C1 healthy starter PASS, C2 missed-last-game PASS, C3 cutoff PASS, C4 out-of-scope unchanged PASS, C5 2025 gate PASS: 5/5 (pass@1). Regression: R1, R2 PASS (deterministic, pass^1 = 100%).

## Known limits and handoff
- **Not live yet.** Role rates are only in the scratch copy. To ship: `node --env-file-if-exists=.env scripts/fit-availability.mjs` against the production DB (rewrites both tables; league/team rates are unchanged), then restart the server. (Since review-fixes, `fittedAvailability` re-reads the tables when their row count or fitted_at changes, so the restart is no longer needed for this.) **Then re-fit the matchup card's spread** (review-fixes, eval-harness finding): `SPREAD_SCALE` 1.63 in lineup-posture.js was fit on a dataset built at 00:01 on 2026-09-18, six minutes before the live `nfl_availability_rates` fit (fitted_at 00:07:01), and the dataset did not record which availability fit priced it; part of 1.63 is the noise the availability discount adds to the edge. Run `scripts/fit-posture-calibration.mjs --rebuild` on a copy after the role rates are written; the script now refuses a cached dataset built under another availability fit.
- **Week 1** of a season is worse than today (role taken from last season: retirements, cuts, offseason IR). This doesn't recur until 2027 week 1. Fix: pre-register a week-1 rule and validate it on 2026 week 1, which is untouched.
- **Mid-week reports.** On 2026-09-18 only 6 of 194 week-2 rows had a game status. A Wednesday/Thursday DNP starter with no status yet matches the final-report "DNP, no designation" cell (veteran rest), so he reads 0.95-0.99 (McConkey 0.991, Flowers 0.948). The old path already used the wrong cell (0.66-0.69). This resolves once Friday's final statuses are ingested (Q/DNP WR starter ≈ 0.62).
- **Missing sources.** Players on IR or reserve aren't on the NFL injury report, and ESPN status isn't read here. A.J. Brown (ESPN IR, played week 1) shows 0.959. Chris Olave (ESPN Questionable, no report row) shows 0.959.
- **Snap-mapping gaps** put a player in the `unknown` tier. Chase Brown has no `player_week_snaps` rows for 2025 wk 14-18 or 2026 wk 1 (`nfl_snaps` has him by name), so he gets the unknown-tier rate of 0.688, not the RB starter rate (0.986) he would likely get with those rows. The same happens to Marvin Harrison Jr. Among player-weeks with 8+ opportunities, 1-3% have no snap row, in 2023-2025 alike.
- `availability()` applies today's `injury_flag` to historical priors. This affects only the current arm and out-of-scope players.
- The league/team rates' shrinkage k is still chosen on 2025. This predates this change and affects both arms equally.
