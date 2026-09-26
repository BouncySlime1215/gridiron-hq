# PRODUCER-SPEED: the planner under 60 s with SEARCH-WIDE on (plan item 32, 2026-09-26)

Source: batch-D plan item 32, "the planner under 60 s with SEARCH-WIDE on (incremental rescore,
cache reuse), measured before -> after". Built on `main` 8089afd0. Flag `GRIDIRON_PRODUCER_SPEED=1`
(its own flag; preview mode does not turn it on), only on top of PRODUCER-FAST's fast lineups.

## 0. Profile

Ten-team fixture (`test/fixtures/producer-speed-league.mjs`, real season simulator, 1200 runs),
PRODUCER-FAST on, cold rescore cache, SEARCH-WIDE on, a made-up blue-chip board so the wide search
scores extra paths (241 of them). `node --cpu-prof`, self time:

| self ms | function |
|---|---|
| 10 299 | `season-sim.js#playSeasons` (Map per run per week) |
|  4 116 | `teamPointsFast` |
|  1 121 | `tradeImpact` |

Two causes: (1) every rescore solved each changed roster twice (the adapter's `rescore`, then again
inside `tradeImpact`, whose overrides always name both teams), and the wide search re-solves the same
post-trade roster for every path sharing a leg; (2) the regular season looked each team's week up in
two Maps and built a Map per run and week.

## 1. Tests (RED first)

`test/campaign-producer-speed-wide.test.js` (9 tests, six-team fixture).

```
# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../scripts/campaign/points-memo.mjs' imported from .../test/campaign-producer-speed-wide.test.js
# pass 0
# fail 1
```

## 2. Change (GREEN, 9/9)

1. `scripts/campaign/points-memo.mjs#pointsMemo`: lineup totals per world (keyed on the world's
   draws, shared by every spread copy), per roster id list in order, LRU at 256 rosters. The adapter
   uses it for its own solve and hands it to `tradeImpact` as the world's `teamPoints`.
2. `season-sim.js#regularSeasonTable` (`tradeImpactWorld({ fastSeasons })`): the regular season on
   index arrays; same operations in the same order per team (offset added first, pf week by week,
   wins in whole/half steps, the median game on the same sorted scores). Falls back to the Map loop
   when the table lacks a team or week.
3. `bench-producer.mjs --wide` and mode `speed`; `_run.inputs.producer_speed` (only when on).

## 3. Evidence (ten-team fixture, SEARCH-WIDE on, cold cache, 3 alternating runs)

| run | plan ms (median) | values | flip | search | confirm rescore | rescores | plan sha1 |
|---|---|---|---|---|---|---|---|
| before (flag off) | 20 650 (20 442-21 430) | 4 885 | 6 640 | 7 120 | 620 | 639 | b1d266c98b |
| after (flag on) | 8 952 (8 897-9 088) | 1 960 | 2 417 | 2 922 | 288 | 639 | b1d266c98b |

SEARCH-WIDE off, same fixture: 14 149 -> 6 074 ms, plan sha1 6f71844d6a both.
Per rescore ~30 ms -> ~12 ms. The fixture's wide search stops at 241 of its 2 400-rescore budget
(its fair bands enumerate no more). At the full budget the projection is ~85 s before and ~35 s after.
That is a projection, not a measurement: league 4 is measured on the Mac (PR "Needs local measurement").
