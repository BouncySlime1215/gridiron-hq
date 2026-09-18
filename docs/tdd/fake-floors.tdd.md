# TDD evidence: fake floors (2026-09-18)

**Status: FIX HELD BACK, NOT SHIPPED.** The fix is written, tested (12/12 green) and saved as a
patch (below). It did not ship because gate G1 failed as pre-registered. A control run shows the
failure has nothing to do with the fix: G1's harness never calls this function, and the unchanged
engine fails G1 with identical numbers. The gate was not moved. A person has to decide on a re-gate
(options at the end).

**Module:** `server/services/player-week-engine.js#playerWeekDistribution`, the per-player weekly
floor (p10), ceiling (p90), average, boom and bust shown on roster, trade and waiver assets
(trade-engine.js `floor/ceiling/avg/boom/bust`) and on the `/projections/:playerId` card.

## The bug
The sampler returns 0 for a week the player does not play (DNP). The ensemble shift (blend minus
structural) was then added to **every** draw, so a DNP week scored the shift. With P(play) under 0.9
and a positive shift, more than 10% of draws sit exactly at the shift and every played draw is above
it. So the floor **is** the shift. The average is also inflated by (1 - P(play)) x shift.

Live, 2026 week 2, league 1 assets (snapshot of production taken 02:30):
- 99 of the 99 players projected over 5 with a positive shift had floor = shift (99 of all 485 projected over 5).
- 482 of those 485 players carry P(play) under 0.9. That is a separate problem (chance to play is too low).

## User journeys
- As a manager, I want a player's floor to be what he scores in a bad week, not a number copied from his last game's surprise.
- As a manager, I want a week he sits to count as 0 in his average, so a player who might sit is not priced like one who plays.

## The fix (held back)
Draw `runs - k` weeks with the player active, add the shift and clamp at 0, then add exactly
k = round((1 - P(play)) x runs) zeros. The seed is unchanged. At P(play) = 1, k = 0 and the output is
bit-identical to the old engine. This matches how the trade engine's `lineupSpread` already treats
a week he sits.

## RED -> GREEN
| Stage | Commit | Evidence |
|---|---|---|
| RED | `4da0e1e` | 10 tests against unchanged `e2ba4c4` engine: 6 fail, 4 pass. C1 p05 = 8 (the +8 shift), want 0. C2 Caleb case p10 = 13.9 = shift. C3 DNP share 0, want exactly 0.24. C4 mean 16.49, want 0.6 x 22.15 = 13.29. C5 P(play) 0: mean 6 (the shift). C6 P(play) -0.3: mean 30 (the shift). |
| GREEN (working tree, not committed) | none | Same file with the fix: 10/10, then 12/12 after R6/R7 were added. Three consecutive runs 12/12 (pass^3). Patch re-verified 12/12 in a scratch copy. |
| Held back | this commit | Engine restored to HEAD (only my hunks reversed; `git diff HEAD` on the engine is empty). The test file on the branch now fails C1-C6 on purpose (RED, awaiting GREEN) and passes R1-R3 and R5-R7. |

## Test specification (`test/player-week-distribution.test.js`)
| # | What is guaranteed | Old engine | Fixed engine |
|---|---|---|---|
| C1 | A DNP week scores 0 (+8 shift, P(play) 0.5: p05 = p10 = p25 = 0) | FAIL | PASS |
| C2 | Caleb-shaped QB, +13.9 shift, P(play) 0.76: floor 0, not 13.9 | FAIL | PASS |
| C3 | Exactly round((1-p) x runs) draws are 0; a DNP week can't boom (p 0.76 / 0.57 / 0.9) | FAIL | PASS |
| C4 | Average = P(play) x played-week average (within 2%) | FAIL | PASS |
| C5 | P(play) 0: every number is 0, bust rate 1 | FAIL | PASS |
| C6 | P(play) is clamped to [0, 1] | FAIL | PASS |
| R1 | P(play) 1: identical to the old engine (golden values from `e2ba4c4`, incl. a game-script mult) | PASS | PASS |
| R2 | Same inputs give the same numbers | PASS | PASS |
| R3 | A negative shift still clamps at 0 | PASS | PASS |
| R5 | Cached and uncached calls agree | PASS | PASS |
| R6 | A non-numeric P(play) plays every week, as the old sampler did | PASS | PASS |
| R7 | A player with no ensemble shift is treated as shift 0, and a week he sits is 0 | PASS | PASS |

Coverage (`--experimental-test-coverage`, lcov): every line of `playerWeekDistribution` runs, and
17 of its 19 branches are hit, including the new NaN branch. The two branches never hit are the old
unknown-position fallbacks (`?? 18`, `?? 8`), which this change does not touch.

Consumer suites run with the fix in place, all green: model-integrity 94/94, role-scenario-engine 9/9,
bottom-up-team-total 6/6, props-team-volume-dispersion 3/3, find-trades 3/3, trade-evidence 6/6,
fantasy-workflows 7/7, decision-inbox 17/17, league-roster-schedule 2/2,
weekly-prediction-snapshot-mode-migration 3/3.

## Gate (pre-registered before any shipping run; scratchpad `step1b/fake-floors/GATE.md`)
| Gate | Rule | Result | Verdict |
|---|---|---|---|
| G1 | 2025 harness, weeks 5-18, distributions on, default draws: coverage_80 in [0.78, 0.82], calibration <= 0.111, CRPS <= 3.078 | 0.776 / 0.111 / 3.083 | **FAIL** |
| G2 | Live week 2: no player with P(play) < 0.9 and a positive shift has floor = shift (unless it's a genuine p10) | 93 failures before, **0** after | PASS |

**Why G1 failed (control and explanation; these runs do not change the verdict):**
| Run | Engine | Draws per player-week | coverage_80 | calibration | CRPS |
|---|---|---|---|---|---|
| G1 as pre-registered | fixed | 200 (harness default) | 0.776 | 0.111 | 3.083 |
| Control | old (`HEAD`) | 200 | 0.776 | 0.111 | 3.083 |
| Explanation | fixed | 300 | 0.782 | 0.111 | 3.078 |
| Explanation | old | 300 | 0.782 | 0.111 | 3.078 |

The fixed and old engines match to every PIT bin (527, 316, 376, 428, 473, 467, 518, 475, 442, 510).
`weekly-backtest.js` imports only `sampleWeeks` and never reaches `playerWeekDistribution`. The
"live" 0.782 / 3.078 come from `scripts/fit-weekly-coverage.mjs`, which uses 300 draws. My gate
used 200. That is a mistake in how I wrote the gate, not an effect of the fix.

## Diagnostic D1 (pre-registered, does not decide shipping)
2025 weeks 5-18, production engine. Players who played the week before; a week they then sat
counts as 0. Metric: average quantile loss over the 7 printed percentiles (lower is better).
Player-clustered paired bootstrap, seed 20260918.
| Rows | n | Before | After | 90% CI of change |
|---|---|---|---|---|
| All | 4,692 | 1.239 | 1.229 | -0.013 to -0.007 |
| P(play) < 0.9 and positive shift | 1,328 | 1.562 | 1.526 | -0.046 to -0.026 |
| Did not play | 1,087 | 0.546 | 0.488 | -0.068 to -0.049 |
| Played | 3,605 | 1.447 | 1.452 | +0.002 to +0.007 |

The fix helps where the bug lives and costs a little on weeks the player plays. The card average
was already about 0.9 points too low against real outcomes, and it gets slightly lower (-0.93 to
-1.01). The fake inflation was partly offsetting a P(play) that is too low: in 2025 only 20 of these
4,692 rows had P(play) of 0.9 or higher. The two fixes should land together.

## Nick's league-1 roster, 2026 week 2 (asset universe, what roster/trade/waiver screens show)
| Player | Shift | P(play) | Floor before | Floor after | Avg before | Avg after |
|---|---|---|---|---|---|---|
| Caleb Williams QB | +13.9 | 0.76 | 13.9 | 0 | 28.8 | 25.6 |
| Kyle Monangai RB | +8.1 | 0.81 | 8.1 | 0 | 16.6 | 14.9 |
| Javonte Williams RB | +7.3 | 0.74 | 7.3 | 0 | 18.8 | 16.9 |
| Trey McBride TE | +4.7 | 0.68 | 4.7 | 0 | 17.2 | 16.0 |
| Patrick Mahomes QB | +3.0 | 0.86 | 3.0 | 0 | 18.3 | 18.0 |
| Kyren Williams RB | +1.6 | 0.70 | 1.6 | 0 | 11.2 | 10.4 |

The `/projections/:playerId` card (4,000 draws, game-script mult) gives these same floors, before (13.9, 8.1, 7.3, 4.7, 3.0, 1.6) and after (all 0).

A floor of 0 is honest for the P(play) the app holds today, but those P(play) values are too low.
**Illustration only** (fixed engine, P(play) 0.98, the rate healthy starters played at in 2025, mult 1):
Caleb 20.5, Monangai 10.4, Javonte 11.4, McBride 9.6, Mahomes 8.6, Kyren 5.1. These are still centred
on the week-2 blend, which leans 80% on the week-1 score. That is a separate item.

## Known gaps and follow-ups
- **The trade-engine.js comment is stale once this ships.** The note near `lineupSpread` says `playerWeekDistribution` "also adds the shift to weeks the player does not play". That file isn't mine, so I didn't edit it.
- `scripts/fit-posture-calibration.mjs` rebuilt the old buggy spread. Live posture now uses a positional CV instead of this distribution, so the live app is not affected, but the script's description is stale.
- A pre-existing cache collision: `activeProbability` NaN and null serialize to the same cache key but behave differently (NaN plays every week, null sits). No live caller passes either (all use `?? 1` or `?? 0.92`). I did not change it.
- G2's "genuine p10" allowance of 0.5 points let 18 baseline rows with shifts under 0.55 pass as genuine. That does not affect the after-fix verdict: after the fix, no candidate row is left at all.

## Re-gate options (for a person to decide; the gate was not moved)
1. Pre-register G1 as "identical to the pre-fix engine under the same config" (it is, bit for bit), or re-run it at 300 draws against the live figures. Then apply the patch.
2. Ship this together with the chance-to-play fix, so floors don't drop to 0 for healthy starters in the meantime.

To ship after a re-gate:
```
git apply <scratch>/step1b/fake-floors/fake-floors.engine.patch
# run test/player-week-distribution.test.js (expect 12/12), then
git commit --only -m "TDD GREEN: fake floors ..." -- server/services/player-week-engine.js
```

The code change in the patch (its doc comment is in the patch file):
```diff
   for (let i = 0; i < cacheKey.length; i++) seed = Math.imul(seed ^ cacheKey.charCodeAt(i), 16777619);
+  // NaN plays, as it did in the old sampler's `random() > p` test; out of range clamps.
+  const pPlay = Number(activeProbability);
+  const playShare = Number.isNaN(pPlay) ? 1 : Math.min(1, Math.max(0, pPlay));
+  const dnpWeeks = Math.round((1 - playShare) * runs);
   const samples = withRandomSeed(seed >>> 0, () =>
-    sampleWeeks(projection.params, runs, scoring, mult, activeProbability)
-      .map(value => Math.max(0, value + shift)));
+    sampleWeeks(projection.params, runs - dnpWeeks, scoring, mult, 1)
+      .map(value => Math.max(0, value + shift)))
+    .concat(new Array(dnpWeeks).fill(0));
```

## Source plan
There was no `*.plan.md`. The journeys and evals come from the orchestrator's task text, which was
treated as data. I found nothing in it that needed flagging.
