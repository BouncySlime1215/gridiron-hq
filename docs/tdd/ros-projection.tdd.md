# TDD evidence — rest-of-season projection (2026-09-18)

**Modules:** new `server/services/ros-projection.js`, new `scripts/fit-ros-projection.mjs`; consumer `server/services/trade-engine.js#buildAssetUniverse` (the `ros_ppg` / `playoff_ppg` lines; `adj_ppg` reads the new `ros_ppg` through its unchanged formula).
**Why:** `ros_ppg` was the weekly blend, which at week 2 is 80% the week-1 score. Rest-of-season value, trade value (`adj_ppg`), waiver stash value, roster risk and the trade finder all read it. Live, free agent Jalen Coker showed `ros_ppg` 29.9 (33.8 PPR in week 1) and a +23.9 claim; Jaylen Waddle showed 2.72 (1.2 in week 1) and was the suggested drop.

## Source plan
No `*.plan.md`. The task text from the step-1b workflow was the plan. Journeys were written during this run.

## User journeys
- J1 As a manager, I want a free agent's rest-of-season value to reflect more than one big week, so one 33.8-point game does not make him a WR1 claim.
- J2 As a manager, I want a proven starter to survive one dud week, so the waiver board does not tell me to drop him.
- J3 As a manager, I want this week's number to stay the weekly blend (Start/Sit unchanged), while trades and waiver stashes use the rest-of-season model.
- J4 As the maintainer, I want the fit and the gate re-runnable and cutoff-safe: fit on seasons before the graded one, gate written before scoring.

## Gate (pre-registered before any candidate was scored)
The full text is in the header of `scripts/fit-ros-projection.mjs` and in the step-1b scratch `GATE.md`. Summary:
- Target: mean PPR points per game played over weeks w+1..18, w in {1,2,3,4,6,8,10}, information from before week w+1 only. Players: QB/RB/WR/TE with at least one game in weeks 1..w.
- Candidates: (a) current weekly blend; (b) structural head; (c) preseason prior (market curve or structural through s-1); (d) `alpha*b + (1-alpha)*[n/(n+k)*season_to_date + k/(n+k)*prior]`, fit on seasons before s. Structure (which prior; one k or one per position) chosen by 2-fold player cross-validation inside the training seasons.
- PASS = (d) beats (a) with a significant player-clustered paired bootstrap (90% interval) pooled over w 1-4 in both 2024 and 2025, has lower MAE at each of w 1-4, and is not significantly worse pooled over w 6-10.

## Gate result: PASS (12 of 12 checks)
Mean points-per-game error over the rest of the season (lower is better):

| Season (fit on) | w1 old→new | w2 | w3 | w4 | w1-4 pooled diff [90% CI] | w6-10 pooled diff [90% CI] |
|---|---|---|---|---|---|---|
| 2024 (2023) | 3.83→2.47 | 3.13→2.36 | 2.90→2.42 | 2.91→2.51 | −0.72 [−0.86, −0.58] | −0.08 [−0.18, +0.03] |
| 2025 (2023+24) | 3.58→2.37 | 3.12→2.32 | 2.85→2.42 | 2.79→2.44 | −0.67 [−0.80, −0.54] | −0.16 [−0.25, −0.06] |
| 2023 (2022), not gated | 3.96→2.63 | 3.12→2.41 | 2.97→2.42 | 2.84→2.42 | −0.72 [−0.88, −0.57] | −0.14 [−0.24, −0.04] |

Rank correlation (Spearman) is higher or equal for the new model at every w in 2024 and 2025, except 2024 w10 (0.78 vs 0.79). The new model also beats the structural head alone early (2024 −0.15, 2025 −0.10, both significant) and ties it later.

Shipped fit (same procedure on 2023-2025, 9,009 rows): market prior, one k = 4, alpha = 0.5. So after one game the in-season rate gets 20% of the non-structural half.

**Reported, not gated:** when did-not-play weeks count as zeros, the new model is worse than the old number from week 6 on (2025 w10 3.35 vs 3.07). `ros_ppg` is per game played with no availability term, as before. Anything that wants expected points per calendar week has to apply availability itself.

**Stress check (after the gate, diagnostic only):** limited to fantasy-relevant players (market prior at least 10 ppg), the early win is larger. 2024 w1-4: 4.56→3.14 (−1.41 [−1.69, −1.13]). 2025: 4.08→3.06 (−1.03 [−1.32, −0.74]). Spearman rises 0.45→0.57 and 0.49→0.63.

## RED → GREEN
| Stage | Commit | Evidence |
|---|---|---|
| RED | `1f9898a` | Both new files fail to load: `ERR_MODULE_NOT_FOUND ... ros-projection.js` (compile-time RED, missing implementation). The commit message says "24 tests". The actual count was 22 unit tests plus 1 wiring test. |
| GREEN (module) | this commit | After writing `ros-projection.js`: `test/ros-projection.test.js` 22/22 pass. The wiring test still failed (`0 !== 1`: trade-engine never calls the ROS model). |
| Setup fix + RED re-check | this commit | The first wiring RED was mixed up with a setup bug. `routes/tradelab.js` imports trade-engine, so the mock was registered too late. After moving the mock above the route imports, the fixed test was run against HEAD's unwired `trade-engine.js` in a throwaway git worktree: `0 !== 1`, a clean RED. |
| Gate | — | `node scripts/fit-ros-projection.mjs` on a VACUUM INTO copy of the live DB: VERDICT PASS (table above). The 2025 run happened once. A `--smoke` run on 2022/2023 only came first, to debug without touching the validation seasons. |
| GREEN (wiring) | this commit | `ROS_PARAMS` set to the live fit and trade-engine wired: 23/23 pass. |
| Coverage tests | this commit | 2 tests added after GREEN, for `rosPriorMap` and the `kFor` null branch. They passed on first run because they test existing behaviour: 25/25. |

Commands (repo runner):
```
GRIDIRON_DB_PATH="$(mktemp -u "${TMPDIR:-/tmp}/gridiron-test-XXXXXX").sqlite" SCHEDULER_DISABLED=1 NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks --test --test-concurrency=1 test/ros-projection.test.js test/ros-projection-wiring.test.js
  -> tests 25, pass 25, fail 0
GRIDIRON_DB_PATH=<scratch copy> node scripts/fit-ros-projection.mjs --out validation.json
  -> VERDICT: PASS, exit 0
```

## Test specification
| # | What is guaranteed | Test | Type | Result |
|---|---|---|---|---|
| 1 | One big week moves the ROS rate by n/(n+k) of the gap, not all of it (J1) | `ros-projection.test.js: J1 ...` | unit | PASS |
| 2 | One dud leaves a strong prior mostly intact (J2) | `J2 ...` | unit | PASS |
| 3 | With no games the update is alpha·structural + (1−alpha)·prior; with many games it converges on season-to-date | `with no in-season games ...`, `as games accumulate ...` | unit | PASS |
| 4 | Missing prior, structural or position falls back or returns null, never NaN | `missing inputs fall back ...`, `kFor ...` | unit | PASS |
| 5 | Market prior falls back to the structural prior; c_struct never reads the market | `priorFor ...` | unit | PASS |
| 6 | The grid fit recovers known truths (prior-perfect → max k; season-to-date-perfect → min k; structural-perfect → alpha 1; per-position k) | 4 `fitRosParams ...` tests | unit | PASS |
| 7 | The player split is deterministic, and the structure CV picks the right prior | `foldOf ...`, `selectRosStructure ...` | unit | PASS |
| 8 | The gate rule passes and fails exactly as pre-registered (late regression, a single lost early week, a missing season) | 4 `evaluateRosGate ...` tests | unit | PASS |
| 9 | Only exact-PPR scoring may use the PPR market curve | `isStandardPpr ...` | unit | PASS |
| 10 | In-season history counts only this season before the target week, in league scoring | `inSeasonHistory ...` | integration (temp DB) | PASS |
| 11 | The structural prior uses last season only, is memoised per season and scoring, and has no market prior without a board | `rosPriorMap ...` | integration (temp DB) | PASS |
| 12 | Only players who have played, at a fitted position, get an entry; no params = nothing ships | `buildRosProjections ...` (2 tests) | unit | PASS |
| 13 | The shipped params are the gated fit and are frozen | `the shipped fit is the gated one ...` | unit | PASS |
| 14 | trade-engine: ros_ppg from the ROS model; ppg unchanged; adj_ppg = 0.25·current + 0.75·ros; playoff_ppg on the ROS basis; ros_basis exposed; no entry → weekly number kept (J3) | `ros-projection-wiring.test.js` | integration (temp DB, mocked ROS module) | PASS |

## Regression evals (eval-harness)
Baseline before any edit: find-trades, trade-evidence, trade-verify, fantasy-workflows, decision-inbox, post-draft-plan and league-roster-schedule, 64/64. After: those plus league-brain, lineup-evidence, model-integrity, pick-reasoning and waiver-brain (every test file touching the asset universe's consumers), 204/204. `node --check` passes on all five files.

## Coverage and known gaps
`--experimental-test-coverage` on `ros-projection.js`: lines 98.64%, branches 83.43%, functions 100%. Lines 318-322 are uncovered: the market-board join inside `rosPriorMap`, which needs a real draft board. On the DB copy it was exercised directly: 284 of 344 2023 week-1 skill players and 273 of 360 2026 players have a market prior.
- Players with no game yet this season (injured all year so far, or week 1 of a new season) get no ROS entry and keep the weekly number, because the gate only graded players with at least one game.
- `proj` (the rest-of-season total) is still `weeklyPpg × weeks left`. It was not in the owned lines. It is display-only (plus a `> 0` filter), but it still carries the week-1 inflation.
- The gate compared against the fit-1 blend. The early-week blend item running in parallel changes the weekly number, not `ros_ppg`.
- The first asset-universe build in each server process is about 2 s slower (3.8 s → 5.9 s on the copy) because the market curve is fit once. The prior map is then memoised.

## Before / after (live DB copy, 2026 week 2, league 4 "Transfer portal", Nick's team)
| Player | ros_ppg before → after | adj_ppg before → after | Basis after |
|---|---|---|---|
| Jalen Coker (FA) | 29.90 → 14.29 | 29.16 → 17.46 | 1 game at 33.8, market prior 9.41 |
| Jaylen Waddle | 2.72 → 9.86 | 2.40 → 7.76 | 1 game at 1.2, market prior 13.34 |

Nick's top 10 by adj_ppg, before → after: see the step-1b handoff. Daniels 15.63→16.20, Chase Brown 17.29→15.97, Irving 17.85→14.69, Achane (new) 14.13, McConkey 16.56→13.43, Samuel 16.26→12.87, Raymond 14.86→11.21, Vele 16.18→10.53, A.J. Brown (new) 10.24, Juwan Johnson 12.50→10.02. Antonio Williams and Dontayvion Wicks drop out.

## Merge evidence
RED `1f9898a` → GREEN (this commit). If squashed, keep the gate table and the RED/GREEN table above.
