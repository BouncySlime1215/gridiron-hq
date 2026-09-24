# TDD evidence: FIX-230-1, the War Room's WR-3 tap controls

**Item:** the War Room showed "disabled with reason" placeholders where Nick's own plan
inputs belong: the risk-mode chip and "+ Add a stop" were disabled with "is Coach's
(FIX-06)", there was no way to change the goal or a tolerance, and a counter reply was
logged with no note. The request route and validator from #230 already accepted every
kind; only the controls were missing.

**Files changed:** `client/src/components/warroom/{requests.ts, controls.ts, Sheet.tsx,
ObjectiveSheet.tsx, RiskModeSheet.tsx, ToleranceSliders.tsx, AddStopSheet.tsx,
TradeoffPreview.tsx, UndoBar.tsx, ReplyTable.tsx, deck.ts, NextMoveDeck.tsx, TopStrip.tsx,
Itinerary.tsx, WarRoom.tsx, warroom.css, coach/CoachDock.tsx}`,
`test/fix-230-1-warroom-controls.test.js`, `test/fixtures/warroom-contract/consumer-reads.js`.

## What each control posts

All go to `POST /api/warroom/:leagueId/requests` through `requests.ts`, with
`source: 'nick'`. Shapes come from `server/services/warroom-actions/schema.js`
(`REQUEST_RULES`); the plan-changing ones are built by Coach's `requestFor`, so a tap and a
confirmed Coach proposal record the same row.

| control | kind | payload |
|---|---|---|
| ObjectiveSheet, Set goal | `objective.set` | `{ goal, player_id? , points_per_week?, arrive_by? }` |
| RiskModeSheet, Confirm (after Review) | `mode.set` | `{ mode, until_week }` |
| ToleranceSliders, Save | `tolerance.set` | `{ key, value }` |
| AddStopSheet, Confirm (after the preview) | `stop.add` | `{ stop: { kind, label, player_id?, week? } }` |
| ReplyTable counter form, Log counter | `offer.reply` | `{ move_id, reply: 'counter', counter_note? }` |
| Undo (inside 10 minutes) | `retract` | `{ request_id }` |

The preview is Coach's `previewFor` over `plans.stop_tradeoffs`, keyed
`add:<kind>:<player_id | week | label>` and `mode:<mode>[:until:<wk>]`. A missing key renders
"Trade-off not computed yet: ...", with no number. The Coach dock and the sheets now draw it
with one component, `TradeoffPreview.tsx`.

## RED

Commit `b8d25f29679d07fffdd1e2fbb685499c03c4849c`, the test file only.

```
$ node --import ./test/offline-guard.mjs --experimental-test-module-mocks --test test/fix-230-1-warroom-controls.test.js
#   code: 'ERR_MODULE_NOT_FOUND',
#   url: 'file:///tmp/gridiron-warroom-QnfnxY/controls.mjs'
not ok 1 - test/fix-230-1-warroom-controls.test.js
# tests 1
# pass 0
# fail 1
```

It failed because the controls did not exist yet (`controls.ts` was the first missing
module). `npm ci` had been run first, so this was not the fresh-clone
`ERR_MODULE_NOT_FOUND`: the helper compiles `client/src/components/warroom/*` into a temp
directory, and `controls.mjs` was absent there.

## GREEN

Commit `7ea49830e9881a3643a894edbd0c62c3b57f3549`.

```
test/fix-230-1-warroom-controls.test.js     8 tests, 8 pass, 0 fail
  ok 1 - objective: one Set goal posts exactly one objective.set, for every goal kind
  ok 2 - risk mode: choosing a mode posts nothing; Confirm posts exactly one mode.set
  ok 3 - add stop: the stop_tradeoffs preview renders before Confirm exists; one Confirm posts one stop.add
  ok 4 - tolerance: one Save posts exactly one tolerance.set; out of range posts nothing
  ok 5 - counter form: one Log counter posts exactly one offer.reply with the counter note
  ok 6 - Undo inside 10 minutes posts one retract for that id; after 10 minutes it posts nothing
  ok 7 - a failed post rejects with its cause (the sheet shows it); nothing is swallowed
  ok 8 - the War Room wires the sheets in, and the WR-3 placeholders are gone
```

The mocked post counts every call and forwards it to the real `/api/warroom` route on a
migrated database, so each payload was accepted by the server's validator, and the retract
was accepted inside the server's own 10-minute window.

All War Room test files together (`war-room-{deck,layout,view}`, `warroom-{coach,coach-dock,
plans-contract}`, `fix-02-warroom-flag-nick`, `fix-07-warroom-inputs`, this file):
107 tests, 107 pass, 0 fail. One failure came up along the way:
`warroom-plans-contract` pins each consumer read to a file that still mentions it. The
`stop_tradeoffs` reads moved from `CoachDock.tsx` to `TradeoffPreview.tsx`, so
`consumer-reads.js` now points there.

`npm run typecheck` 0 · `npm run lint` 0 · `npm run build` 0 · `npm run check:wiring` 0
(no new findings; every new module is reached from `WarRoom.tsx`).

## Not confirmed

- There is no browser run or screenshot. The repo's TSX harness renders to static markup,
  so a tap is tested through the pure step it calls (`controls.ts`, `requests.ts`,
  `deck.ts`), and the render tests check what is on screen at each step.
- The producer writes `stop_tradeoffs` only for the stops and modes it priced
  (`server/services/campaign/view.js`). It writes no `objective:` or `tolerance:` keys, so
  those previews read "not computed yet" until it does.
