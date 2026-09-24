# CAMPAIGN-01: the War Room plans producer (2026-09-23)

Unit 4 of NORTH-STAR-PLAN.md (rows 1, 2, 5, 6, 7, 8, 9, 10, 11, 12, 17-20, 22 + the
swipe deck + the chat-psychology ruling). Extends the ACQ-FLIP prototype (PR #227,
`scripts/study/acq-flip-proto.mjs`) into a producer that writes, per league, the
plans JSON the War Room reads (WAR-ROOM-UI.md sections 2-4; WR-1 reads it through
`war-room-view.js#normalisePlans`).

## 0. Audit (extend or build)

- The prototype's pure scoring (`pathExpectation`, `flipSpread`, `screenFair`, ...) is
  study code; production must not import study code, so the formulas were promoted
  to `server/services/campaign/paths.js` unchanged in meaning (same expectation, SE
  and stranded terms; `test/acq-flip-proto.test.js` still covers the study copy).
- The fast rescore (`season-sim.js#tradeImpactWorld`, RL-19-2) and today's
  P(accept) (`counterparty-pricing.js#readDeal` -> `trade-acceptance.js#acceptanceBand`
  midpoint) are reused as-is, through an adapter (`scripts/campaign/league-adapter.mjs`).
- Chat reads reuse `manager-signals.js#openChatDb`, `manager-identity.js#identityMap` and
  `counterparty-pricing.js#negotiationProfilesFor`. Timing reuses
  `trade-tactics.js#timingRead` / `sendWindow`.
- Decision: **build** new files; the only edit to an existing file is one opt-in step
  in the refresh loop.

## 1. Tests (RED first)

`test/campaign-producer.test.js` (23 tests) on `test/fixtures/campaign-league.mjs`, a
made-up four-team league (no real data), plus two tests appended to
`test/refresh-loop-steps.test.js`.

RED (commit `d7356007`, implementation absent):

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/campaign/planner.js'
✖ CAMPAIGN-01: the War Room producer runs after manager signals only when GRIDIRON_WARROOM_ENABLED=1
✖ CAMPAIGN-01: the producer's outcome is recorded as sync_log warroom_plans (ok / partial / error)
```

GREEN (commit `55569ac8`): `campaign-producer.test.js` 23/23, `refresh-loop-steps.test.js`
+ `preview-mode.test.js` + `acq-flip-proto.test.js` 32/32.

What the required checks assert:

| check | test |
|---|---|
| mode changes the plan on the same dice | three modes, identical `worldsBuilt` seeds, three different first moves; all-in has the higher landing and the lower expectation |
| fatigue cap respected | a manager already at his weekly cap appears in no deck card; the counter adds sent + planned offers |
| feasibility math | season-average hit rate from per-run weekly points, first week at target, cost, bye + injury warnings; player target by the step clock + deadline |
| catch-up ordering | free -> flip -> desperate -> swing -> timing, gain order inside a kind; the planner's list keeps it |
| confirm on fresh dice | the second world is built on `confirmSeed(planSeed, ...)`, never equal to the planning seed |
| JSON matches the contract | `validateEntry` (typed fields, no value on failed/unknown, known sources, reply kinds, NextMove keys) is empty; WR-1 keys (`producer`, `leagues[]`, `acq.best`, `acq.title_now`) present |

## 2. Hand-set constants (not fitted; each labelled where it is shown)

`BASE_RESPONDS` 0.5, `CHECKED_OUT_RESPONDS` 0.05, skip weights, `SAFE_LAMBDA` 1,
`ALL_IN_MIN_COMPLETE` 0.03, slider defaults per mode, `DAYS_PER_STEP` 2,
`BAD_NEWS_P` 0.3, `NUDGE_HOURS` 24 / `SWITCH_HOURS` 48. Chat labels steer nothing
(shadow score only) until EVAL-01 lets them earn weight.

## 3. Real-league run

Run locally on a DB copy; numbers stay local (league data). See the PR body's
"Benchmarks" for runtime and rescore counts.

### Benchmarks (local DB copy of 2026-09-23 ~21:00, machine load average 13-35 from other work)

| league | runtime | rescores | adapter + world | values | flip map | search | confirm world | confirm rescore | playbook + reports |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 320 s | 416 | (not split yet) | | | | | | |
| 4 (chat league) | 497 s | 518 | 54 s | 128 s | 163 s | 140 s | 10 s | 1.4 s | 0.2 s |

About 0.3 s per exact rescore (1,200 paired runs). All five leagues take roughly
30-40 minutes on a loaded machine, so the refresh loop LAUNCHES the producer detached
(lock file, no second copy) instead of blocking its 15-minute tick; plans refresh
every run, which is every 30-40 minutes today. Both runs: every section typed, the
contract check empty, every deck card "holds" on fresh dice; league 4's chat labels
read (engagement, tone, open-to-trade, negotiation "no holds", loves/hates counts).

Refresh loop step: 22/22 in `refresh-loop-steps.test.js` (launch only with the flag,
after manager signals; no second launch while the lock holder is alive; a stale lock
is cleared; the last finished run is recorded ok / partial / error, and a run that
stopped without a summary line is an error, not the previous run's ok).
