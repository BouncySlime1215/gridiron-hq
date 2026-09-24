# UI-ENG-5: chess path stepper in the War Room (TDD record)

Branch `claude/cloud-ui-eng-5`, built on #231 (`claude/cloud-war-room-ui`, head `cce5005e`),
with origin/main `ea947d4b` merged in. Spec: WAR-ROOM-UI.md v2 (handoff package), sections
1 (one dashboard, phone deck) and 3.4 (itinerary), plus CHESS-01a (#258) for the path shape.

## What it adds

One panel, "Chess path", in the War Room one-dashboard grid (grid area `path`, the middle
column across rows 2-3; Stops and Flip map now share the fourth column) and one page of the
phone swipe deck. It draws the planner's searched multi-step paths (trade, claim, flip):

| part | producer field (CHESS-01a `titleChess()` output, plans entry `chess`) | state when absent |
|---|---|---|
| path order, "Path 1 of N" | `paths[]`, producer order, top 5 | `unknown` "did not run (default-off)" / "found no path" |
| P(all land), expected, if all land (± SE, inside-the-noise) | `p_complete`, `expected_title_delta`, `full_title_delta(_se)`, `full_clears_noise` | `unknown` per number |
| vs the best single offer | `vs_best_single.{full_title_delta, full_title_delta_se, expected_title_delta}` | row not drawn for the best single itself |
| each step: kind chip, line, P(yes) | `steps[i].kind`, `partner_id/give/get` or `claim/drop`, `p_accept` | claim priced `not_modelled`: `unknown` "rival claims are not modelled", shown as "not modelled (rival claims)", never 100% |
| title odds after each step | `steps[i].title_delta_after` (± `title_delta_se`), shown "vs today"; the level only if the producer writes `steps[i].title_after` | level: `unknown` "keeps the change against today, not the level" |
| if the step fails: what you keep | the search's own rule (stop at the first refusal, keep what is done): step k-1's `title_delta_after` | step 1: "You keep today's roster and odds." |
| if the step fails: backup branch | the first other path, in producer order, that shares steps 1..k-1 and makes a different move at step k (selection, no arithmetic) | `unknown` "No backup searched for this step" |

The view serves no new number: war-room-view.js `chessPath()` selects and words producer
fields. A failed search, a failed league run (`entry.error`) and a failed sanity check
(`sanity_composed_equals_direct: false`) hide the whole panel as `failed`, with no value anywhere.

Compact panel: the branch of the selected step only (tap a step). Big (Expand swaps it into the
NEXT MOVE slot, or the phone deck): every step's branch.

## RED

`04384d2c` test: UI-ENG-5 RED, chess path stepper in the War Room

```
$ node --test test/war-room-chess-path.test.js     # on 04384d2c
error: "Cannot read properties of undefined (reading 'value')"      x4
error: "Cannot read properties of undefined (reading 'status')"     x2
error: "Cannot read properties of undefined (reading 'preview')"    x1
error: "Cannot find module '.../ChessPath.mjs' imported from .../test/helpers/warroom-tsx.mjs"   x3
# pass 0 / # fail 11
```

## GREEN

`96c22373` feat: chess path stepper in the War Room (UI-ENG-5 GREEN): 11/11. Test copy change in
the same commit: the tile label is "P(all land)" (was "All steps land", which truncated in the
compact column) and the claim reads "not modelled (rival claims)".

Two tests added after the mutation sweep (below) found M1 and M6 surviving:
"a backup must share the steps before it, even when a different path ranks higher" and
"a failed league run or a failed sanity check hides the chess path too". 13/13.

## Mutation sweep (liveness)

`node docs/tdd/sweeps/ui-eng-5-chess-path-mutations.mjs`: one string mutant at a time, run `test/war-room-chess-path.test.js` +
`test/war-room-layout.test.js`, restore. Unit and call-site mutants both.

| mutant | first sweep (11 tests) | after the two added tests (13) |
|---|---|---|
| M1 backup: drop the shared-prefix check | SURVIVED | killed (1) |
| M2 backup: allow the same move as the backup | killed (2) | killed (3) |
| M3 claim `not_modelled` priced as its p (100%) | killed (3) | killed (3) |
| M4 keep = this step, not the previous one | killed (1) | killed (1) |
| M5 call site: `chessPath(n, entry.acq)` instead of `entry.chess` | killed (10) | killed (11) |
| M6 call site: failed league run leaves chess visible | SURVIVED | killed (1) |
| M7 client: compact shows every branch | killed (1) | killed (1) |
| M8 client: no branch unless big | killed (1) | killed (1) |
| M9 client: claim unknown shows the generic state | killed (1) | killed (1) |
| M10 grid: `path` area removed | killed (2) | killed (2) |
| CONTROL (designed to survive): reword the path note, not asserted | survived | survived |
| CONTROL (designed not-applied): pattern absent | not applied | not applied |

## Screens

Rendered from the real components (esbuild bundle of WarRoom.tsx over the view built from
`test/fixtures/war-room-plans.json` + `test/fixtures/war-room-chess.json`, preview on), Chromium
via Playwright: desktop 1440x900 light, dark, expanded (panel swapped into the NEXT MOVE slot,
step 3 selected); phone 375x812 light and dark (deck scrolled to "Chess path"). All five:
`scrollWidth == innerWidth` and `scrollHeight == innerHeight` (no page scroll), no page errors.
Compact: selecting step 3 leaves exactly one branch drawn (`[data-branch="3"]`); the path pager
moves to "Path 2 of 4".

## Nick's five questions

1. **Well built?** One pure mapper in the existing view (`war-room-view.js#chessPath`), one
   component (`ChessPath.tsx`, 93 lines), typed fields end to end; `finalize()` still strips
   values from hidden fields; 13 tests, 10/10 mutants killed.
2. **Stats or made up?** Neither: no new number. Every digit is CHESS-01a's (P(accept) is today's
   acceptanceBand midpoint, a guess until E1 passes; odds changes are season-sim deltas with SE).
3. **How we know:** fixture tests and mutants only. Nothing is backtested here; CHESS-01a itself
   has not beaten single trades in a replay yet (its own default-off reason).
4. **Pointed anywhere else?** The War Room tab only (Trade Brain, behind `GRIDIRON_WARROOM_ENABLED`
   or preview). No route, nav or App.tsx change; nav stays 8.
5. **How it unifies:** it reads the one War Room view through the one fetch (`useWarRoom.ts`);
   the backup branch reuses the search's own "stop at first refusal" rule instead of a new one.

- **Gap fixed:** the War Room showed only the first step of a plan (NextMoveDeck) and a flat stop
  list (Itinerary.tsx) with no per-step odds-after or failure branch; CHESS-01a's multi-step
  paths had no War Room surface at all.
- **Incumbent:** `git grep -n chess -- client/src/components/warroom` on `cce5005e`: 0 hits (control: `git grep -n NextMoveDeck cce5005e -- client/src/components/warroom`: 3 hits).
- **Not covered:** the producer does not yet write `chess` into the plans file (CHESS-01a #258
  returns it from `titleChess()`; the campaign producer #233 does not carry it), and
  `plans-schema.js` (WARROOM-CONTRACT) has no `chess` key yet. Until one lands the panel shows
  "Chess paths not computed yet". Title-odds levels per step need the producer to write
  `title_after`.
- **What would make it wrong:** a producer that writes `paths[]` in a different order from its
  ranking (the backup rule takes "first in order"), or a CHESS-01a change to the step keys
  (`p_accept`, `title_delta_after`, `p_basis`).

## Sweep fixes FIX-290-1, -2, -3 (2026-09-24)

`origin/main` was merged in (merge commit `8fff6e3e`). That merge brings FIX-04's contract-reading view
(#287), #230's Coach and #233's producer. All five conflicts (war-room-view.js, WarRoom.tsx, types.ts,
preview-mode.js, war-room-layout.test.js) were resolved to main's side. The stepper was then rebuilt on
that contract.

RED `89586b67`: `test/war-room-chess-path.test.js` fails at import (`campaign/chess.js` missing), and
`war-room-layout` fails on the missing `path`/`clones` areas.

GREEN: chess-path 21/21 and layout 7/7. The War Room, warroom, campaign, fix-0*, reasoning and coach
suites: 369/369. `npm run typecheck`, `npm run lint` and `npm run check:wiring` all exit 0.

- **FIX-290-2, producer and contract.** `plans-schema.js` has a `chess` section: ids and numbers only.
  `campaign/chess.js#chessSection` maps titleChess() output into it. `toEntry` writes it for every league,
  and `buildPlansFile` takes a `chess` loader. `produce-plans.mjs#chessLoader` loads `title-chess.js`
  lazily (#258 is not merged yet) and reads the engine's `findTradeSequences(...).chess`. Each league gets
  a typed unknown when:
  - `title-chess.js` is absent (#258 not merged)
  - the chess flag is off
  - the search was not run

  `validatePlans` stays empty on the regenerated producer fixture, which now carries league 1's search.
  The war-room-view mapper is gone: the view passes the section through.
- **FIX-290-1, the RED.**
  - Every step's `change_after` carries `clears_2se`, and the client greys a step that does not clear.
  - Steps go one per week from the current week, the deadline week is shown, and no trade or flip step
    after `deadline_week` is written. A cut path's totals come from its kept steps, and its paired
    comparison is dropped.
  - `replay_passed` (`GRIDIRON_CHESS_REPLAY_PASSED`, never set by preview) gates the stepper. Without it
    the panel shows "Path search is off: it has not beaten single trades in the replay test yet
    (CHESS-01-b)."
  - Every path has an `argument` slot, typed unknown with JEV-01c's reason, and the steps still draw.
- **FIX-290-3, grid and coach.** The grid is `next next path stops` / `next next clones flip_map`: one
  grid with both areas, #270's panel fills `clones`, and it is still one viewport tall. `path` is a Coach
  `focus_panel` id on both sides (warroom-actions/schema.js, coach/warroomCoach.ts), with
  `COACH_PANEL_AREA.path = 'path'` and the intent word "chess".

Mutation sweep (`node docs/tdd/sweeps/ui-eng-5-chess-path-mutations.mjs`): 17 mutants covering the
producer, contract, toEntry, buildPlansFile, client, grid and coach ids, and all 17 are killed. M1
(backup prefix check) survived the first sweep because the rewrite had dropped the test for it; that
test was restored and M1 is now killed. Control "reword the hint" survived; control "pattern absent"
was not applied.
