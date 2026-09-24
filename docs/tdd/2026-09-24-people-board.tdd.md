# PEOPLE-BOARD: War Room people rail (TDD record)

Branch `claude/cloud-war-room-people-board-1824z8`. Base: `origin/claude/cloud-fix-03`
(`d7736fe8`) + `origin/claude/cloud-fix-04` merged (`d436691a`) + the four UI-ENG-4
commits cherry-picked from `origin/claude/cloud-ui-eng-4` (its merge of main left out;
FIX-03 already carries main). Spec: WAR-ROOM-UI.md v3 "RIGHT, THE PEOPLE BOARD";
PEOPLE-FLOW.md sections 4-5.

## Integration fixes (before the unit)

| where | what broke | fix |
|---|---|---|
| `test/warroom-plans-contract.test.js` | FIX-04's BrainCheckCard reads `brain_report`, which FIX-03 marks PENDING (FIX-05): the reads gate failed 4 reads | the reads gate lets a read on a PENDING path through, as the mismatch gate beside it already does |
| `test/war-room-{view,deck,layout}.test.js` | FIX-03 replaced `producer-plans.json` with the real producer's output (me = 1, P-ids); 7 FIX-04 tests assert main's hand-built fixture | main's fixture restored as `warroom-contract/view-plans.json`, the three sections FIX-03 made required written `unknown`; it validates |
| `CloneBoard.tsx` / `types.ts` | UI-ENG-4 passed `guess` to FIX-04's `SourceTag` (no such prop); `Field` lacked the contract's `unit`/`guess` | prop dropped (the tag reads `calibrated`); `unit?`, `guess?` added to `Field` |

## What it adds

A `people` panel: desktop, a column between the panels and Coach, rows 2-4; phone, the
deck page right after Next move. One tile per league-mate (Nick's roster left out), a
join by roster id of two existing reads; the client computes nothing.

| slot | from | when absent |
|---|---|---|
| P(responds) | contract `partners[].p_responds` + `basis` (campaign/partners.js) | unknown: "not scored as a partner this run", or the partners section's own reason |
| fatigue budget | `partners[].offers_logged` of `destination.tolerances.max_offers_per_manager_week` | unknown: "No offers log for him this week" |
| in market | clone row `wants` (profile-reader wants, 7-day full / 21-day gone decay, with age) + `partners[].roster_holes` | the clone row's own unknown ("quiet in chat ...") |
| his word (credibility) | clone row `credibility` (bluff-detector record, else profile label) | clone row's unknown |
| mood | `partners[].chat_labels` `tone:*` (chat.labels) | unknown: no tone label; the mood clock is not built |
| last contact | nothing produces it | always unknown with the reason |
| approach | clone row profile trait: style, else no-holds, else posture label | unknown with the profile's reason |

Greyed and sorted last: clone standing `excluded` / `deprioritised` (Nick's word:
not reachable, not doing trades, not active) with Nick's labels as the reason; or a
partner the plan marks `blocked` ("marked as never trading"). Tap a tile ->
`openClone(team)`: the clone panel swaps into the big slot showing only his row, with
"All managers" to clear; Esc / Back restore as before.

Flag: `warroom-flag.js#peopleBoardFlag` (`GRIDIRON_WARROOM_PEOPLE_ENABLED=1`, never on
without the War Room, on under `preview-mode.js#previewUnconfirmed`), listed in
preview-mode.js. It rides on `GET /trades/:id/war-room/clones` as `people_board`. Off,
the grid areas, panel list and root style are byte-identical to before (tested).

## RED

`e58be5aa` test: War Room people board, one tile per manager behind its flag (PEOPLE-BOARD RED)

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/gridiron-warroom-SVvTPY/PeopleBoard.mjs'
not ok 1 - test/warroom-people-board.test.js
# pass 0 / # fail 1
```

## GREEN

`test/warroom-people-board.test.js`: 18 pass, 0 fail. `npm run typecheck` clean, `npm run
lint` clean, `npm run build` ok.

Full suite (`npm test`, this tree): 4948 tests, 4906 pass, 0 fail, 42 skipped, 647 s.

`npm run check:wiring` exits 1 here and on the base before this unit: 14
`module-reaches-no-surface` findings, all `server/services/campaign/*.js` (FIX-03's
producer modules, launched as a detached script the walker does not see). Nothing in
this unit adds a finding.

## Mutation sweep (test/warroom-people-board.test.js)

| mutation | caught by |
|---|---|
| greyed tiles not sorted last | order test (1 fail) |
| a `blocked` partner not greyed | grey + order tests (2 fail) |
| Nick's own roster kept | first run: survived (no read carried it); a partner entry for Nick's roster added to the test, now 1 fail |
| a tap's `initialFocus` not swapping the clone panel into the big slot | focus test (1 fail) |

## Real data

`scripts/study/people-board-check.mjs <league>` builds the view and clone rows as the
routes do, joins them with the client's `peopleTiles()`, and prints counts only (tiles,
greyed by whose word, per-slot ok / unknown / failed with the unknown reasons). Run on
the contract fixture (league 1, empty app DB): 3 tiles, P(responds) and fatigue ok on 3,
mood ok on 1, clone slots unknown "This league has not synced its rosters yet." League 4
runs on the Mac's DB copy (PR body, LOCAL line).
