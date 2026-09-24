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

## Liveness: mutants (four War Room test files; control run fails 0)

| mutant | where | result |
|---|---|---|
| M1 unwrap returns `.value` whatever the status | `coach/warroomCoach.ts` unwrap | **survived** on the first sweep: no test gave a failed field a value. Added the assertion in `warroom-coach.test.js` ("a field that failed its check is hidden even if a value leaked into it"); now **killed** (1 fail) |
| M2 hook posts `confirmed: false` | `coach/useWarRoomCoach.ts` confirm (call site) | killed (1) |
| M3 `warRoomEnabled()` always true | `warroom-actions/store.js` | killed (3) |
| M4 WarRoom passes `plans: null` to the hook | `WarRoom.tsx` (call site) | killed (1) |
| M5 dealLine reads the move itself, not `steps[0]` | `coach/warroomCoach.ts` dealLine | killed (2) |
| M6 cost/gain printed signed | `coach/CoachDock.tsx` fmt | killed (1) |

Not-applied control: every mutant was a `sed` on the named line followed by
`git checkout`; `git status --porcelain` was empty after the sweep, apart from
the one test file edited for M1.

## Sweep fix FIX-282-1 (2026-09-24)

- **Rebase onto FIX-04.** The local rebaser already did this with merge commit `2374025b`,
  which contains #287's head `cf1148a5`. `WarRoom.tsx` mounts `coach/CoachDock` and
  `useWarRoomCoach` and passes #287's contract view as `plans`. The panels read `targets`,
  `flip_map` and `brain_report`. The placeholder `warroom/CoachDock.tsx` stays deleted.
- **One reason source.** `plans-schema.js` on this branch is byte-identical to #272's
  (`git diff origin/claude/cloud-fix-03 -- server/services/campaign/plans-schema.js` is
  empty). `warroom-actions/schema.js` re-exports its `SKIP_REASONS` / `DECLINE_REASONS`,
  and `test/warroom-coach-dock.test.js` pins them as the same object.
- **Defect found by re-running against the producer fixture.** The dock formatted a
  trade-off as points only when `source === 'sim.title'`. FIX-03's producer writes
  `stop_tradeoffs` values with `source: 'plan.path', unit: 'title_odds'`, so Coach's
  add_stop preview on the real output read "Costs: 0, 0 extra step(s) / Gains: 0 / Net: 0".
  `fmt` now keys on `unit === 'title_odds'`. A field with no `unit` falls back to
  `source === 'sim.title'`, which the hand-written ui-contract fixture relies on. The
  producer also writes `sim.title` with units `probability` and `points_per_week`, so
  keying on the source was wrong in both directions.
- **RED** (`test: FIX-282-1 RED …`): the new add_stop test on `producer-plans.json`
  league 1 (`add:get:21`) fails. The new layout test (targets / flip_map / brain_report
  panels on every drawn producer league, and Coach mounted on the same view) already passes.
- **GREEN**: the six War Room files pass 75/75: war-room-deck, war-room-layout,
  war-room-view, warroom-coach-dock, warroom-coach and warroom-plans-contract.
- **Mutants:** (M7) `fmt` keyed on source only → 1 fail. (M8) `fmt` keyed on unit only,
  with no fallback → 1 fail, on the hand fixture. (M9) the TargetPicker fed `catch_up`
  → 1 fail. (M10) FlipMap fed `alternatives` → 2 fail. All four killed.
