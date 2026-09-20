# TDD evidence: usage_coverage on GET /api/model/status

**Item:** `usageCoverage()` shipped on #66 with no consumer. `/api/model/status` now
serves it, so the map's `producer-with-no-caller` finding clears and, more to the point,
the number reaches a surface a person reads during a deploy.

**Files owned and changed:** `server/routes/model.js`,
`test/model-status-usage-coverage.test.js`, this document. `server/services/nflverse.js`
is the fantasy-plan thread's and is not touched — this branch carries their #66 by merge
and adds only the caller.

**Branch:** `claude/wiring-map-8f96ur-usage-coverage-hold`, off `main`, carrying #66's
head `e87a3ca` merged in. No PR, by the freeze rule: a plain branch push emails nobody.

---

## The design call, and why it is not what was asked for verbatim

The instruction named `usageCoverage([SEASON - 4, …, SEASON])`. That is right about the
shape and I kept it, as a derived window rather than the expression inline:

```js
const USAGE_LOOKBACK = 5;
const usageWindow = () =>
  Array.from({ length: USAGE_LOOKBACK }, (_, i) => SEASON - (USAGE_LOOKBACK - 1) + i);
```

Two reasons it has to be a window the caller names, and has to be derived:

1. **`usageCoverage()` with no argument answers nothing.** It falls back to
   `[...held.keys()]` — the seasons already held — so `missing` is empty and
   `stamp_disagrees` is false by construction, whatever the feed did. A caller that does
   not say what it *expects* gets a check that can never fail.
2. **A typed-out list of years is the defect this whole area exists to catch.**
   `routes/nfl-betting.js` still carries `'2021,…,2025'` at six sites, and that is how
   `nflverse_weekly_usage` came to stamp itself green for a season it never fetched. A
   window written as `SEASON - n` follows the season over; a list of years does not.

## RED

None, and the reason is in the item itself: the field did not exist, so there was nothing
to make fail. The tests are written against new behaviour and pass on the first run. What
stands in for RED is injection, per this repository's precedent
(`docs/tdd/week2-numbers.tdd.md`, `docs/tdd/boot-restart-cycle.tdd.md`):

| Injected defect | Result |
|---|---|
| `usageCoverage()` with no window | 1 pass, 3 fail — tests 1, 2 and 3. Test 4 passes in both states, correctly: "the disagreement clears once the season is held" is true when the check is vacuous too. |
| `usageCoverage([2021, 2022, 2023, 2024, 2025])`, a typed list | 0 pass, 4 fail |

The second is the one worth reading. A hardcoded window that happens to be five seasons
long and merely sits one year behind fails *every* case, including the one that says a
held season clears the disagreement — because the window it is asking about no longer
contains the season anyone cares about. That is the live defect in
`routes/nfl-betting.js` reproduced exactly, and it is why the derived form is not a
stylistic preference.

## Test specification

| File | Tests | What it pins |
|---|---|---|
| `test/model-status-usage-coverage.test.js` | 4 | The window is the five seasons ending at `NFL_SEASON`, derived from the env rather than typed; a green `sync_log` stamp over a season holding no rows is reported as `stamp_disagrees`, not as staleness; `usage_seasons` alone could not have said it, because a season with no rows has no row to appear in; and the disagreement clears once the season is actually held. |

Fixture: four held seasons, 2026 empty, and a `sync_log` row claiming `ok`. That is the
shape of the live machine as of tonight — `player_week_usage` holds 2021-25 and no 2026.

## What this does not do

It does not fix the feed. `usageCoverage` reports the disagreement; the cause is the
hardcoded season list in `routes/nfl-betting.js` and the per-season green stamp in
`nflverse.js`, which are the fantasy-plan thread's and are being handled there. This is
the surface that makes the lie visible, not the repair.
