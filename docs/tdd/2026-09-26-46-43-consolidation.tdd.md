# 46 BENCH-CONSOLIDATION FINDER + 43 ROSTER-SPOT VALUE: evidence (2026-09-26)

Shadow behind `GRIDIRON_CONSOLIDATION` ('1' or 'shadow'; there is no 'on', and preview never turns it on).

## Changes

1. `server/services/campaign/consolidation.js` (new, pure):
   - `findConsolidations`: depth-only 2-for-1 and 3-for-1 packages for one Blue chip (83+), screened on
     his screen (`paths.js#SCREEN_WINDOW`) and Nick's cap (0; +12% only on a 2-for-1), then rescored on the
     planner's dice and the confirm dice. A row needs lineup points AND title odds up on both.
   - Every row passes `never-give.js#ruleVerdict` (the one rule gate) and trade memory (`stepPasses`).
   - It fails closed with no board, an unread trade ledger, or no confirm dice.
   - `rosterSpotValue` (43): a freed spot is filled from this league's wire. The pick is the free agent
     who raises the starting lineup most (RL-9-3's rule in `trade-engine.js#lineupValue`), on ros_ppg.
2. `planner.js`: one call after the catch-up list, only with the flag on. It returns `consolidation`.
3. `produce-plans.mjs`: writes `_run.inputs.consolidation` only when present (flag off: byte-identical).
4. `league-adapter.mjs`: `lineupPpg(list)`, the existing `startersOf` summed on ros_ppg.

## RED -> GREEN

- RED `ab3dc0d7`: `test/campaign-consolidation.test.js` alone, `ERR_MODULE_NOT_FOUND` for consolidation.js (pass 0, fail 1).
- GREEN `0d06a4ca`: 18 / 18 pass.

## What the tests prove

| rule | test |
|---|---|
| 160 / 80 / 277 and Nick's Blue chips never given | `Nick's rules are never broken`, property test (300 worlds) |
| gets are Blue chip 83+; never 290, a sold player, a blocked manager's player, or one under the floor | same two tests |
| +12% only on a depth-only 2-for-1; a 3-for-1 never overpays; premium 0 turns it off; a looser max_overpay never loosens it | `3-for-1 never overpays`, `premium 0`, `looser max_overpay`, planner test (fixture plans uncapped, finder stays at 0) |
| lineup points and title odds rise on both dice | `lineup points must rise`, `title odds ... AND on the confirm dice` |
| no buy-backs / reversals | `trade memory` |
| fails closed | `fails closed ...`, `planner: flag on with no board` |
| flag off changes nothing; flag on moves no served field | `planner: flag off -> no consolidation key; flag on -> ... served plan unchanged` |
| ids only (public repo) | `ids only in the report` |
