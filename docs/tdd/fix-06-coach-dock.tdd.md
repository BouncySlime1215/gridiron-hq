# TDD evidence: FIX-06, Coach docks in the War Room and reads the same keys

Spec: `docs/handoff/local/INTEGRATION-AUDIT-0923.md` (branch
`claude/handoff-package-2026-09-22`) section 4c rows C1, C2, C4, C5, section 7
(one flag reader) and section 8 FIX-06.

Base: `origin/main` `ea947d4` (#238 merged) + #231 head `cce5005` + #230 head
`d328590`, merged in that order with no conflicts. FIX-03 and FIX-04 have no PR
yet, so the War Room view (#231 `war-room-view.js`) is still the pre-contract
shape. Coach is written against the contract; see "Not confirmed" below.

Built in a cloud session, 2026-09-24. No local DB, no chat DB. LLM spend: $0.

Runner:

    GRIDIRON_DB_PATH=<tmp>.sqlite SCHEDULER_DISABLED=1 NODE_OPTIONS='--import ./test/offline-guard.mjs' \
      node --experimental-test-module-mocks --test --test-concurrency=1 \
      test/warroom-coach-dock.test.js test/warroom-coach.test.js test/warroom-plans-contract.test.js \
      test/war-room-layout.test.js test/war-room-deck.test.js test/war-room-view.test.js

## RED (tests only, on the merged base)

63 tests, 52 pass, 11 fail:

| failing test | cause on the base |
|---|---|
| add_stop ... renders the producer's cost / gain / net | Coach's `unwrap()` steps into a field only when it carries `producer`; contract fields carry `source`, so `stop_tradeoffs` is never unwrapped and the preview reads "not computed yet" |
| the War Room mounts the real Coach dock | WarRoom.tsx mounts #231's placeholder `CoachDock.tsx` (disabled input, "Not built yet") |
| Coach focus_panel names map onto the War Room grid | no mapping exists |
| skip and decline reasons are one list | `SKIP_REASONS` = `dont_like_player, costs_too_much, ...`; plans-schema.js exports none |
| store.js reads the switch only through warroom-flag.js | store.js reads `process.env.GRIDIRON_WARROOM_ENABLED` itself |
| schema: plug_in binds only to whitelisted engine fields | `suggestions`, `flips`, `brain_check.checks`, `roster.bye_holes`, `title.odds_by_week` still accepted |
| next advances the swipe deck | footer reads `move.partner`, not `move.steps[0].partner` |
| a plan-changing action does nothing until Confirm | preview `unknown` (the unwrap bug) |
| footer carries destination, stops left, next move | `dest.goal.label` / bare `arrive_by` / top-level deal |
| plug_in reads a whitelisted field | contract typed fields not unwrapped |
| the WR-3 route records each input | `deck.skip` reason `cost` refused |

Passing on RED and kept: "Confirm writes exactly one stop.add with confirmed = 1"
(#230's record path already worked; only the preview was blind).

## GREEN

Same six files: 63 tests, 63 pass. Full `npm test`: 4880 tests, 0 fail.
`npm run typecheck`, `npm run lint`, `npm run build`,
`node scripts/wiring-map.mjs --check` (exit 0, with the five `warroom/coach/*`
exemptions removed) all clean.
