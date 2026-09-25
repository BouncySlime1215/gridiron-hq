# SOURCE-TABLES: the graders' two missing source tables

RED `48a0119` · GREEN follows · `test/source-tables.test.js`, 17 cases.

## What was missing

The graders already run on every refresh tick (`scripts/refresh-live-data.mjs`
step `brain_report`). Two of them had nothing to grade because their source
tables were never built:

- **E7** (luck vs decision) reads `weekly_autopsy`: "needs 4 more weeks (source
  table weekly_autopsy is not built yet)".
- **E4-live** (planner vs simple baselines, 2026) reads `planner_move_outcomes`:
  "source table planner_move_outcomes is not built yet".

## What this adds

- `server/services/eval/sources/weekly-autopsy.js`: one row per team per
  finished week from the final lineups in `league_roster_snapshots`: actual
  points of the starters, their ESPN projections, and the best legal lineup on
  those projections (`espn-lineup.js#bestLineup`, now taking the league's own
  `lineupSlotCounts`; league 4's lineup stays the default for every existing
  caller).
- `server/services/eval/sources/planner-move-outcomes.js`: captures each week's
  planner move (the served `next_move`), the finder's best offer (the producer's
  own `pickFinderBest`, extracted from `league-adapter.mjs#finderBest` so one
  rule picks it for both) and a greedy fair 1-for-1, once, before the week is
  final; after it is final, re-prices each arm's first step with
  `season-sim.js#tradeImpact` on the captured seed.
- `scripts/eval/produce-source-tables.mjs` and the tick step `source_tables`
  before `brain_report`.

All of it is off unless `GRIDIRON_SOURCE_TABLES=1`. Off, the tick starts no
process and no table is created, so the brain report reads exactly as before.

## RED

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/eval/sources/weekly-autopsy.js'
# tests 1
# pass 0
# fail 1
```

## GREEN

```
# tests 17
# pass 17
# fail 0
```

## One fixture fault found on the way

The first greedy test expected a running back upgrade that the fixture's
one-RB lineup function could never reward (the starter at 18 points kept the
slot). The test was wrong, not the code: the lineup function now fills two RB
slots, like the league. The Olave case was also strengthened: unblocked, greedy
takes him; blocked, it does not.

## Batch B item 8 (2026-09-25)

- STEP 0: merged origin/main (6eb3aed, contains decf7ebf). One conflict, an import line in
  `scripts/refresh-live-data.mjs` (both imports kept). `never-give.js` is now main's own file; this
  branch no longer adds it.
- RED `ac4dad3`: greedy must export no never-give list of its own and must block Olave by id only.
  2 of 22 fail.
- GREEN: `GREEDY_NEVER_GIVE`, `GREEDY_NEVER_GET` and the name list `GREEDY_NEVER_GET_NAMES` are
  deleted; `greedyMove` defaults to `PINNED_NEVER_GIVE` / `PINNED_NEVER_GET` from main. 22 of 22 pass.
- Items 2 and 3 of the plan (no market values = "not graded"; no `settled_at` on a reprice error)
  were already fixed in `2ab19d5` and are unchanged.
