# nfl_depth stored nothing and said nothing

**Date:** 2026-09-22
**Branch:** `claude/project-thread-o3wt2p-depth-zero-loud`
**Files:** `test/depth-zero-rows-loud.test.js` (new, 6 tests)

## What prompted it

A production read on 2026-09-22 at 15:37Z: `nfl_depth` **0 rows**, while
`nfl_snaps` held 128,146, `nfl_injuries` 28,411 and `nfl_qbr_weekly` 574. Snaps
and depth charts are fetched by the same function, in the same loop, from the
same release host, so the difference is not the network.

## Why depth can store nothing while the fetch succeeds

Depth charts through 2024 publish a **week**, not a publication timestamp. Each
row is therefore dated from `game_lines` through `historicalWeekAvailability`
(`server/services/nfl-advanced.js:288-296`), which reads a `gameday` for the
row's season, week and team. With no schedule loaded there is no availability
boundary, every row is dropped, and the fetch itself still succeeded.

That path used to return `rows: 0, failures: []` and report six seasons loaded.
A source producing nothing while calling itself healthy is the exact shape
CLAUDE.md names: a layer goes inert and the surface says so nowhere.

`nfl-advanced.js:273-280` now throws instead, and names `game_lines` rather
than the symptom.

## This is a pin, not a RED/GREEN pair, and saying so matters

**The guard already exists on `main`.** It landed in `83332628`. A test written
today passes on the first run, so there is no honest RED commit to make here —
manufacturing one by reverting production code and calling the revert a RED
would be theatre.

What was missing is the test. Before this file, **nothing in `test/` mentioned
`syncDepthCharts` or the zero-row message**: `test/nfl-advanced-depth.test.js`
is 15 lines and covers `depthChartReleaseUrl` and `normalizeDepthTeam` only. So
the guard could have been deleted, weakened, or had its remedy sentence dropped,
and every suite would still have been green.

The load-bearing evidence for a pin is therefore not RED-then-GREEN. It is the
mutation sweep below, which is what proves the tests would notice.

## What the six tests assert

1. A sync that downloads rows and stores none **throws**, rather than returning
   a success with `rows: 0`.
2. The error **names the dependency to fix** — `game_lines is empty` and
   `syncHistoricalLines` — not just the symptom. "0 rows" alone sends a person
   to read the depth feed, and the cause is a different table.
3. **Nothing is written when the guard fires.** A throw that left half a season
   behind would be worse than the silence it replaced.
4. With the schedule loaded, the **same feed stores its rows and does not
   throw** — so the guard's claim is true and it does not fire spuriously.
5. A feed that cannot be fetched at all reports **`Every depth-chart season
   failed`**, not the storage error. Both modes end in zero rows and they have
   nothing to do with each other, so a person must be able to tell them apart.
6. One season failing to download **does not condemn a season that stored
   rows**: 3 rows, 1 season loaded, 1 failure recorded, no throw.

### A trap this file avoids

`_historicalAvailability` and `_weekCache` are module-level caches keyed by
season. Reusing one season across the empty-schedule and loaded-schedule tests
would serve the cached `null` and the loaded-schedule test would pass for the
wrong reason. Every test uses a different season on purpose.

## Mutation sweep

Each mutation was applied with `perl -0pi`, **verified applied by comparing the
file's md5 before and after** — a grep-based applied-check produced a false
"applied + survived" earlier today — then the suite was re-run and the source
restored from a pristine copy.

| # | mutation | result | tests that caught it |
| --- | --- | --- | --- |
| M1 | delete the zero-row throw | KILLED (2) | 1, 2 |
| M2 | drop `syncHistoricalLines` from the message | KILLED (1) | 2 |
| M3 | always take the non-empty-schedule branch | KILLED (1) | 2 |
| M4 | delete the all-seasons-failed throw | KILLED (1) | 5 |
| M5 | widen the partial guard to `failures.length >= 0` | KILLED (4) | 1, 2, 4, 6 |

5 applied, 5 killed, 0 survived, 0 invalid.

**Test 3 deliberately survives M1**, and that is correct rather than a gap: it
pins that nothing is half-written, which stays true whether or not the function
throws afterwards. Reported here rather than left for a reader to notice.

## What this does NOT establish

- **It does not say what happened in production.** The whole ingestion block in
  `nfl-model-growth.js` is gated at `:186` on
  `before.finalized_week > 0 && (force || coreLag)`, and `finalized_week` is
  itself read from `game_lines`. So the live zero could be the scheduler brake
  (`SCHEDULER_DISABLED=1`, never ran), a skipped block (`finalized_week === 0`),
  or a swallowed throw. Three statements against the production database
  discriminate; they are not run here and nothing in this file assumes an answer.
- **It does not fix the caller.** `attempt()` (`nfl-model-growth.js:149-153`)
  catches this throw into `detail[name] = { error }`, `depth_charts` is
  `required: false` at `:90`, and the run's `status` at `:286-288` consults only
  `finalized_week`, `requiredLag` and `detail.fit?.error`. So even with this
  guard deployed, a depth failure still reports `status: 'ok'`. That is a
  separate change on a file this branch does not touch.
- **No live feed is read.** The suite runs under the enforced offline guard and
  every fetch here is stubbed, so this pins the join and the reporting, never
  the upstream CSV's real columns.
- **The 2025+ timestamped schema is not covered.** It resolves its week through
  `weekFromDate`, which also reads `game_lines.gameday`, so it may carry the
  same dependency — unverified, because it depends on whether the live feed
  still ships a `week` column.

## The five questions

- **Well built?** It pins behaviour that already exists and was untested, and
  the sweep is what shows the pin holds rather than the count of tests.
- **Stats or made up?** Neither. Read today: `nfl-advanced.js:273-280` and
  `:288-296`; `test/nfl-advanced-depth.test.js` is 15 lines and covers neither;
  `game_lines.gameday` exists, confirmed by `PRAGMA table_info` on a freshly
  migrated database rather than assumed from the schema file.
- **How do we know?** Six tests, five mutations killed, source md5-verified
  before and after each.
- **Pointed anywhere else?** Every consumer of positional rank — `RB1` is a
  depth-chart fact — and the same swallow shape covers every other ingestion
  step in that cycle, not only depth.
- **How does it unify?** One rule: a job that writes zero rows says so, and says
  which dependency it was waiting on.
