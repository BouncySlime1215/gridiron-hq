# TDD evidence (retroactive): what the projections are computed from

**What this is.** Commit `10396d6` ("Settings: say what the projections are
actually computed from", PR #53) added
`client/src/components/DataBehindNumbers.tsx` (118 lines), mounted it with 2
lines in `client/src/pages/Settings.tsx`, and committed
`test/data-behind-numbers.test.js` (6 tests).

There is no RED commit. Nothing here fixes a broken function; the code it
describes was already correct and already serving the numbers. What was
missing was anyone rendering them, and that is not a state a test can be
written to fail against first in any meaningful way. A RED commit would have
been a test asserting the absence of a component nobody had asked for yet.

**How the retroactive RED was shown.** Each guarded rule was reverted in the
shipped source — one mutation at a time, a real edit, run, then restored.
Seven mutations, one per rule, every one caught. Run at `10396d6` on
2026-09-20.

| Guarded rule | Mutation | Test that failed |
|---|---|---|
| A season with no rows is absent from the list, not a zero in it | `usageSeasons()` fills the gap seasons with `{rows: 0}` | 1 |
| The counts are the ones the query produces | `COUNT(DISTINCT player_id)` → `COUNT(player_id)` | 2 |
| The endpoint serves every field the card reads | `players_with_gsis` renamed on `/status` | 3 |
| The season comes from the league, never the calendar | `active?.season` → `new Date().getFullYear()` | 4 |
| The warning is driven by a row count, not a short list | `(thisSeason?.rows ?? 0) === 0` → `!thisSeason` | 5 |
| The card is mounted | `<DataBehindNumbers />` removed from Settings.tsx | 6 |
| It links out rather than restating what Start/Sit owns | the link sentence replaced with the basis itself | 6 |

7 mutations, 7 caught, 0 that no test noticed.

## The failure this card exists for

The app has one failure mode it repeats: healthy-looking and not working.

The live case: `POST /api/model/sync` ran its season list as
`[SEASON-5 … SEASON-1]`, so every completed season was re-fetched and the
season being played never was. `player_week_usage` held about eight thousand
rows for each prior year and zero for the current one, every source reported
`ok`, and nothing on any screen was different — the projections simply
carried on being computed from last year. The counts that would have shown it
were served by `/api/model/status` the whole time, and rendered on a page
that has since been deleted.

So this is not a dashboard. It answers one question — is this season's data
in here — and it is loudest in the case where nothing else in the app is.

## The two rules that are not obvious

**Test 1 is why the list alone is not enough.** A season with no rows does
not appear in `usageSeasons()` at all; it is not a zero. So a card that
renders the list and nothing else shows 2024 and 2025 and looks complete on
exactly the machine where 2026 is missing. The warning has to be driven by
asking about a specific season, which is what `missingThisSeason` does.

**Test 3 is the inverse of this repo's usual check.** The usual one is: a
served field nothing renders is a silent disclosure. This one is: a rendered
field nothing serves is a card that goes blank, or lies, on the day someone
edits the route. Both directions are pinned.

**Test 4 names a bug that already shipped.** `draft-assist.js` reads the
calendar year for the season and is wrong every January. The card takes the
season from the league the user is actually playing in.

## Mutation output, pasted

### f7 — a zero row invented for the absent season

```text
not ok 1 - a season with no rows is missing from the list, not a zero in it
# tests 6
# pass 5
# fail 1
```

### f6 — rows counted where distinct players were meant

```text
not ok 2 - the counts the card prints are the ones the query actually produces
  error: |-
    2 !== 1
# tests 6
# pass 5
# fail 1
```

### f4 — the served field renamed under the card

```text
not ok 3 - the endpoint serves every field the card renders
  error: '/status no longer serves players_with_gsis'
# tests 6
# pass 5
# fail 1
```

### f1 — the calendar year instead of the league's season

```text
not ok 4 - the season it asks about comes from the league, never the calendar
  error: "the season under test is the league's own"
# tests 6
# pass 5
# fail 1
```

### f2 — the warning driven by the list rather than the count

```text
not ok 5 - the missing-season warning is driven by a row count, not by the list being short
# tests 6
# pass 5
# fail 1
```

### f3 — the card unmounted

```text
not ok 6 - the card is mounted, and does not restate what other surfaces own
# tests 6
# pass 5
# fail 1
```

### f5 — the card restating the availability basis instead of linking to it

```text
not ok 6 - the card is mounted, and does not restate what other surfaces own
  error: 'it does not restate the basis itself'
# tests 6
# pass 5
# fail 1
```

Chance-to-play basis belongs to Start/Sit and per-league sync times to the
league cards. Two accounts of one number is how they drift apart, so the card
links to both rather than repeating either.

## Files touched that belong to other PRs

`server/services/nflverse.js` (f6, f7) and `server/routes/model.js` (f4)
belong to the fantasy-plan and wiring-map threads respectively. Both
mutations were applied and restored, never committed. They are here because
tests 1 to 3 run the real `usageSeasons()` against a fixture database and
read the real route source, rather than asserting against a mock that would
agree with whatever the card expects.

## What this does not claim

No live read backs this. The fixture is two prior seasons loaded and the
season being played completely absent — the live shape of the defect — but it
is a fixture, built in an isolated temp SQLite database, not a reading of the
deployed volume.
