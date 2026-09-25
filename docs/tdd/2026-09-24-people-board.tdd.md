# PEOPLE-BOARD v3: War Room people rail on the one reader + hub (TDD record)

> RETIRED 2026-09-25. The client rail went with the War Room shell (#457); its server payload
> (`view.people`, `buildPeopleBoard`, `peopleBoardFlag`, `GRIDIRON_WARROOM_PEOPLE_ENABLED`), its
> study script and `test/warroom-people-board.test.js` were dropped after (nothing read them).
> Trades -> People (ManagerCard) reads the manager-profile routes; the weekly offer budget line
> reads the plan's partners directly. Kept as the record of what was built.

Branch `claude/local-people-board-v3`. Base: `origin/claude/local-integration-4` (#340 = main +
batch 4: PEOPLE-01 reader, PULSE-01, CRED-01, HUB-PUBLISH-PEOPLE) with #305's two commits
(`e58be5aa` RED, `31f96e88` GREEN) replayed on top. Replaces #305. Spec: WAR-ROOM-UI.md v3
"RIGHT, THE PEOPLE BOARD"; FIELD-REGISTRY.md (one producer per field, hub rule).

## What changed from #305

| #305 | now |
|---|---|
| its own profile read behind `warroom-clones.js` + `/war-room/clones` (a second reader, ruling 1/17) | gone: #340 removed the clone panel; the board reads the hub (`people/hub-read.js`) only |
| client join of `partners` + clone rows (`peopleTiles`) | server join `war-room-view.js#buildPeopleBoard`, served as `view.people`; the client formats only |
| tap -> clone panel with his row | tap -> the Next move deck shows only the plan's moves with him (`focusView`), "All moves" clears |
| greyed = clone standing | Nick's notes over the models: can't reach him = `never` (last), not a buyer = `last` (before him), hard negotiator = pill |

## Slots and their one producer

| slot | producer | when it has no row |
|---|---|---|
| P(responds) | plan `partners[].p_responds` (campaign planner over people.counterpart) | unknown: "did not score him", or the partners section's reason |
| fatigue | plan `partners[].offers_logged` (FIX-07 sentThisWeek) of `destination.tolerances.max_offers_per_manager_week` | unknown: no offers count |
| Nick's word | people.counterpart `override` (the one reader's nick block) off the hub; people.profile `nick` as fallback | no pill |
| approach | people.profile labels off the hub | unknown with the reader's reason |
| mood, in market | people_pulse via `pulse.js#recentPulse` (7 / 21 days); plan tone label as mood fallback | unknown ("no statement ...", "migration 098 not applied") |
| his word | people_credibility via `credibility.js#readCredibility` (WANT_PLAYER, SHOP, 7 d) | unknown ("no graded statement", "migration 099 not applied") |
| last contact | nothing produces it | always unknown with the reason |

Request thread: SELECTs only, through lazy imports, cached per league for 30 s
(`cachedPeopleInputs`). Flag: `warroom-flag.js#peopleBoardFlag` (GRIDIRON_WARROOM_PEOPLE_ENABLED=1,
needs the War Room, on under preview mode); off, `view.people` is absent and the grid is
byte-identical to before.

## Tests

`test/warroom-people-board.test.js`: 17 pass. Neighbours green on this tree: war-room-layout 8,
war-room-view 16, war-room-deck 9, warroom-coach-dock 6, warroom-l4-default 9, warroom-polish 12,
warroom-plans-contract 14, people-reader-ratchet 6, preview-mode 3, fix-02-warroom-flag-nick 10,
fix-07-warroom-inputs 15, warroom-coach 22, warroom-e2e 15 (+1 pre-existing TODO). `tsc --noEmit`
clean, `scripts/lint.mjs` clean, `scripts/wiring-map.mjs --check` exit 0.

## Real data (local copy, counts only)

`scripts/study/people-board-check.mjs 4 [reps] [--cold]` on a copy of the app DB and chat DB, after
running the people producers on the copy (migrations 098/099, `scripts/people/credibility.mjs`,
`scripts/people/pulse.mjs`, one engine tick of people-profile + people-counterpart). See the PR body.
