# Telling a lying usage stamp from a stale one, on the route a person reaches

RED `84bae8a` · GREEN = the commit this file arrives in (a commit cannot record its own hash) · branch off `main` `791b131`, on top of `e87a3ca`

---

## The five questions

**Is it well built?** It is one derived field on one existing route, computed by
a function that already exists and is already tested (`usageCoverage`,
`server/services/nflverse.js:416`, covered by `test/nflverse-usage-truth.test.js`).
The route gains no query, no cache and no new failure mode: it calls a read that
counts rows in a table it already has open.

**Are the numbers real stats or made up?** Real, and that is the entire point of
the change. Every other source on this route is judged by its own `sync_log`
stamp — a claim the last run wrote about itself. This field counts rows in
`player_week_usage` and then reports whether that stamp agrees with the count.

**How do we know?** Six tests, each one killed by at least one defect injection
against the finished code (table below). The RED was the field's absence; the
mutations are the proof the assertions constrain the shape rather than its
existence.

**Is it pointed anywhere else on the platform?** Yes, and that is why it moved.
The first version of this change put the field on `GET /api/model/status`, whose
only caller in the tree is `client/src/pages/Model.tsx` — a page no file imports
and no `<Route>` declares. It would have read as wired in every report and no
human could have reached it. `/setup-status` is called by
`client/src/components/DataSetupBanner.tsx:24`, which `App.tsx` renders on every
page.

**How does it unify?** The banner already renders `missing.map(m => m.label)`,
so the disagreement surfaces with no client change at all. It arrives as its own
row rather than folded into the never-run rows because it needs a different fix:
the never-run rows mean "run this", and this one means running it is what
already happened.

---

## What was wrong

`nflverse_weekly_usage` stamped itself `ok` for a season it never fetched. The
season window was a hardcoded list that stopped at 2025 while the season rolled
to 2026, and every freshness surface in the app — `source-registry.js`, the
scheduler's staleness check, the health payload — reads `sync_log` and therefore
reported a complete feed.

`usageCoverage()` (PR #66, commit `e87a3ca`) fixed the reading. Nothing a person
can open called it.

## The three states, and why only one is new

| state | `sync_log` | rows held | what it means |
|---|---|---|---|
| never run | no row | missing | no claim has been made; a fresh clone |
| stale | `error` | missing | the feed says it failed, and it did |
| **lying** | **`ok`** | **missing** | **the feed says it succeeded, and wrote nothing** |

Staleness is the only failure the surfaces beside this one can already describe.
Never-run is the state every fresh clone is in. A check that cannot separate the
third from the other two adds nothing.

## Why the caller has to name its window

`usageCoverage()` with no argument defaults `wanted` to the seasons already
held, so `missing` is empty by construction, `stamp_disagrees` is false whatever
the feed did, and the check can never fail. The caller is the one that knows
what it expects, so `USAGE_LOOKBACK = 5` and `usageWindow()` live at the call
site. Derived from `NFL_SEASON`, not typed out — a hardcoded list of years is
the original defect.

Five seasons, matching the window `POST /sync-all` fetches
(`server/routes/model.js:629`), so the question asked here is the same question
that endpoint answers with its work.

## RED

`node --test test/setup-status-usage-coverage.test.js` on `e87a3ca`: **6 fail, 0 pass.**

```
not ok 1 the window is the five seasons ending at NFL_SEASON, derived and not typed out
        Cannot read properties of undefined (reading 'seasons')
not ok 2 THE POINT: a green stamp over a season with no rows is reported as a disagreement
        Cannot read properties of undefined (reading 'missing')
not ok 3 the banner is told, and told in words that are not the never-run words
        the disagreement must appear in the list the banner renders, not only in detail
not ok 4 STALE IS NOT LYING: a failed stamp over the same missing season is not a disagreement
        Cannot read properties of undefined (reading 'missing')
not ok 5 NEVER RUN IS NOT LYING EITHER: a feed with no row has made no claim to contradict
        Cannot read properties of undefined (reading 'never_run')
not ok 6 once the season is held the disagreement clears
        Cannot read properties of undefined (reading 'missing')
```

Five of those six fail on the field being absent, which is a weak RED: it proves
the field is new, not that the assertions constrain it. The mutations below are
what make the difference.

## Defect injection against GREEN

Each row is one edit to the finished handler, the suite re-run, the edit reverted.
A test that no mutation can fail proves nothing.

**Rows are named by TEST TITLE, not by ordinal.** "test 6 fails" names nothing once a
test is inserted above it, and this table was written that way once already. Each row
also carries the sha256 of `server/routes/model.js` as the edit was measured, so a row
cannot be a description of an edit that was never applied — including the control,
whose checksum differs from GREEN while its result does not.

GREEN `server/routes/model.js` sha256 `bca51a0250ee`, 6 tests, 6 pass.

| # | injected defect | sha256 | pass/fail | killed by |
|---|---|---|---|---|
| M1 | `USAGE_LOOKBACK = 4` — window is four seasons | `e18133a81e08` | 5 / 1 | *the window is the five seasons ending at NFL_SEASON* |
| M2 | `usageCoverage()` — the caller names no window | `ee67c402200c` | 2 / 4 | *the window …*, *THE POINT …*, *the banner is told …*, *STALE IS NOT LYING …* |
| M3 | `if (missing.length > 0)` — any missing season counts as a lie | `832388941023` | 4 / 2 | *STALE IS NOT LYING …*, *NEVER RUN IS NOT LYING EITHER …* |
| M4 | label reworded as "Weekly usage never run for …" | `6f6ac18de0a6` | 5 / 1 | *the banner is told, and told in words that are not the never-run words* |
| M5 | label drops the season it names | `719abd774eab` | 5 / 1 | *the banner is told …* |
| M6 | the row is built but never reaches `missing` | `200a01ebfd02` | 5 / 1 | *the banner is told …* |
| M7 | `if (true)` — the gate is removed, the row is pushed always | `5dd1178ded6d` | 3 / 3 | *STALE IS NOT LYING …*, *NEVER RUN IS NOT LYING EITHER …*, *once the season is held the disagreement clears* |
| M8 | NO-OP CONTROL: one word of a comment changed | `54a3541bcc51` | 6 / 0 | none, correctly |

M2 is the one that matters: it is the real defect this route would otherwise have
shipped — a field present in the payload, reporting on a window it derived from the
answer, permanently green. Four of the six tests refuse it.

M6 is the second: the field can be correct in `usage_coverage` and still never reach
the list the banner renders. *the banner is told …* is the only test that reads the
banner's own input, and it is the only one that catches it.

**M7 is here because the table without it was incomplete, and the gap was found by
somebody else.** Six rows and not one of them killed *once the season is held the
disagreement clears* — the test that says the row goes away when the data arrives.
Every mutation above either widens the gate (M3) or damages the label (M4, M5, M6),
and a test asserting the row is ABSENT survives all of them. Removing the gate
entirely is the mutation that shape needs, and it takes three tests with it: the two
that say a stale or never-run feed is not a lie, and the one that says a fed season is
not a lie either. A row asserting absence needs a mutation that asserts presence
unconditionally; nothing else reaches it.

The rule this is evidence for: a test that no row in the table turns red gets a row
that kills it, or a written reason why none can. Not a note that it was checked.

## GREEN

`node --test test/setup-status-usage-coverage.test.js`: **6 pass, 0 fail.**

Implementation: `server/routes/model.js` — the `usageCoverage` import, the
`USAGE_LOOKBACK`/`usageWindow()` pair beside `SEASON`, and the block in the
`/setup-status` handler. 46 lines added, 2 changed.

## The field

```js
usage_coverage: {
  job: 'nflverse_weekly_usage',
  seasons: [2022, 2023, 2024, 2025, 2026],   // derived from NFL_SEASON
  per_season: [{ season, rows, players, held }],
  missing: [2026],                           // seasons in the window with no rows
  never_run: false,                          // no sync_log row at all
  stamp: { status, at, consecutive_failures } | null,
  stamp_disagrees: true                      // stamp says ok AND missing is non-empty
}
```

And, when `stamp_disagrees`, one extra row in the existing `missing` list:

```js
{ source: 'nflverse_weekly_usage_seasons',
  label: 'Weekly usage reports success but holds no rows for 2026' }
```

`needs_setup` follows from `missing.length > 0`, unchanged.

## What this does not do

It does not fix the feed. `usageCoverage` reads; nothing here writes, syncs or
schedules. A disagreement stays on the banner until someone fetches 2026, and
the banner's own "Update now" button is the wrong remedy for it — that button
reruns the sync that already reported success. Rewording the banner for this
case is the client half and belongs to whoever owns
`client/src/components/DataSetupBanner.tsx`.

It also does not check the snap-counts feed, which has the same shape and the
same stamp (`nflverse_snap_counts`, written by the same `recordUsageRun`). One
feed, one window, one route.
