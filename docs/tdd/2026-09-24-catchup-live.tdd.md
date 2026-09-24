# CATCHUP-LIVE: catch-up list and speed curve read the live league

## Goal
North-star rows 11-12. The catch-up list names the managers who are out of contention (title
odds < 5%) or checked out (`activity.manager`, else the timing read) and what they would sell,
at what discount on their own market screen. The speed curve prices each speed lever from the
planner's ranked paths ("arrive by week N at cost X"), not from a template.

## RED
`f7f27237` adds `test/campaign-catchup-live.test.js` (10 tests). It fails on the base: no
`sellersRead` / `desperateMoves` in catchup.js, no `speed.js`, no `activityReads` in the adapter.

## GREEN
- `server/services/campaign/catchup.js`: `sellersRead`, `desperateMoves` (best ranked plan through
  each seller, discount = max(0, -his screen %) of the planned step; sellers no plan reaches are
  listed with no gain).
- `server/services/campaign/speed.js` (new): landing model over the ranked plans on the clock;
  levers sequential / parallel (top 3 one-step plans at once, best yes wins) / concede (playbook
  walk-away) / package (2-for-1 first) / all-in; winner per week, cost vs the unhurried winner at
  the deadline (>= 0, non-increasing); waiver and wait priced off the curve.
- `scripts/campaign/league-adapter.mjs`: `activityReads` (engine_state `activity.manager` rows
  first, the timing read as a labelled fallback, no read = no claim).
- Wiring: planner.js builds both; view.js serves `catch_up[].kind/partner/discount_pct` and
  `speed_curve[].lever/p_land/levers`; plans-schema.js declares them optional.

## Measured (league 4, DB copy, `produce-plans.mjs --leagues 4 --no-finder`)
| metric (served plans.json) | before (cloud-fix-03, tree 8581aa39) | after (tree 38fbef06) |
|---|---|---|
| catch-up rows | 2 (swing, deadline) | 5 (3 sellers, swing, deadline) |
| out-of-contention managers named | 0 | 3 (title odds 2.8%, 4.3%, 4.3%) |
| checked-out managers named | 0 | 0 (no `activity.manager` rows in the DB; the timing read flags none) |
| speed levers priced per week | 0 | 2 (sequential 33% land, all-in 12% land) |
| speed curve winner | none (cost 0, net -0.00026 every week) | all-in, net +0.0044 title odds, P(land) 12% |
| rescores / runtime | 532 / 494 s | 532 / 560 s (Mac shared with 2 other producer runs) |
