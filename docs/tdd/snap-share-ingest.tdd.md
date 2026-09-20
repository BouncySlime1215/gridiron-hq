# The snap-share ingest, and the number it cannot be

2026-09-20. `server/services/nflverse.js`, `test/snap-share-ingest.test.js`. Off `main`.

## Why 0 to 1 is not a style choice

`player_week_snaps.offense_pct` is stored raw, and its scale is load-bearing in two consumers
that **do not fail** when it is wrong:

- `role-changepoint.js:29` confirms a role change on `snapDelta >= 0.08` — an **absolute**
  difference of two `offense_pct` values. On a 0–1 scale that is eight percentage points. On a
  0–100 scale it is eight hundredths of one percentage point, so `snapConfirms` is true for
  essentially every player and the confirmation step silently stops filtering.
- `contingency.js#roleTier` bands at 0.60 / 0.35 / 0.15. On a 0–100 scale every player in the
  league is a `starter`.

Both keep returning plausible verdicts. So the required range is derived from what the
consumers do, not asserted about the upstream file, and `SNAP_SHARE_RANGE.required_by` names
them — a range with no statement of what it protects gets widened by the next reader.

## Why it must never rescale

Dividing an 84.7 by 100 is the obvious repair and the dangerous one: it would also turn a
genuinely corrupt row into a plausible one, permanently and invisibly. An unusable value is
stored as `NULL` — the labelled-absence state every consumer already handles, since all of them
filter nulls — and counted in the sync's report, with up to ten samples, so an upstream unit
change surfaces as a number somebody reads rather than as a season of quietly undiscriminating
role tiers. A mutation that rescales is the first in the table below.

**The snap COUNT is stored either way.** An unusable share does not make the appearance
unreal, and `offense_snaps > 0` is what `contingency.js` filters on, so dropping the row would
lose real evidence that the player was on the field. A mutation for that is S7.

**Absent and out-of-range are different reasons.** "The source had no value" and "the source
had a value that cannot be a share" call for different responses, and one message for both
would hide the second inside the first.

## The second defect, in the same function

An unmatched player was dropped with a bare `continue` and no counter — while
`syncPlayerWeekUsage`, directly above in the same file, has always counted its unmatched rows.
So a sync that name-matched a third of the league returned the same shape as one that matched
all of it: `{ season, inserted }`. It now returns `unmatched` too.

That matters here more than elsewhere, because `snap_counts` keys on `pfr_player_id`, which
this database does not carry, so the join is a normalised name plus position — the most
fragile match in the file and the one with no count on it.

## One quantity, two tables — recorded, not fixed

`nflverse.js#syncSnapCounts` writes `player_week_snaps`, keyed on our `player_id`.
`nfl-advanced.js#syncSnaps` writes `nfl_snaps`, keyed on the raw player name and team. **Both
read the same file**, `snap_counts/snap_counts_<season>.csv` from the same nflverse release.

Nothing asserts the two agree, and their failure modes differ: one drops players it cannot
name-match (now counted), the other keeps whatever name it was given. Consumers are split
across both — `role-changepoint.js` and `contingency.js` read `player_week_snaps`, while
`nfl-advanced.js`'s own depth logic reads `nfl_snaps`. So the two can disagree about the same
player-week with nothing reporting it, and one sync can run while the other does not.

Not fixed here because the fix is a decision, not a guard: either one table with two indexes,
or a consistency check that reports disagreement. `nfl-advanced.js` is not in this change's
scope and the guard is worth having on its own.

## Mutations

| # | mutation | result |
|---|---|---|
| S1 | silently rescale an out-of-range share by 100 | 3 fail |
| S2 | store a bad share as `0` rather than absent | 3 fail |
| S3 | widen the range to 0–100 | 4 fail |
| S4 | stop counting unmatched players | 1 fail |
| S5 | stop counting out-of-range shares | 2 fail |
| S6 | report a missing share as out of range | 1 fail |
| S7 | drop the whole row when the share is unusable | 2 fail |

S1 and S4 were invalid on the first attempt — S1's pattern did not match, and S4's pattern
appeared **twice** in the file (the usage loop at :257 and the snap loop at :343), so a naive
replacement would have mutated the wrong function and "caught" it with an unrelated test. Both
were re-run against the snap loop only. Every mutation was applied and the file confirmed
changed first; a pattern that did not match is reported as a NO-OP and is not evidence.

## Numbers

RED: 9 tests, 1 passed, 8 failed. The one that passed is the existing postseason filter, which
was already correct and is pinned so this change cannot break it. GREEN: 9 passed, 0 failed.

The whole ingest is exercised, not just the pure helper: `fetchCsv` uses global `fetch`, so the
test stubs it and drives `syncSnapCounts` end to end against a temp database, including the
case that matters most — a **whole file** on the wrong scale, where every row is plausible on
its own scale and every consumer silently stops discriminating.

Full local check `npm run check`: exit 0 — 2,959 tests, 2,918 passed, 0 failed, 41 skipped;
typecheck, lint and build clean; `start:smoke` passed on an isolated database.

## The five questions

**Is this well built?** The guard states what it protects and why, refuses rather than repairs,
and separates "absent" from "impossible". The report carries counts *and* samples, because a
count nobody can investigate does not get acted on.

**Is this based on stats, or is it made up?** The range is read off two consumers' own
thresholds in the code, cited by file and line. Nothing is asserted about what nflverse
currently serves — the guard's job is to make the requirement explicit and to report a
violation, which holds whatever the source does today.

**How do we know?** Seven mutations, all failing, including the two tempting wrong fixes
(rescale, and store a zero).

**Should this data be pointed anywhere else on the platform?** The `out_of_range` count belongs
on the sync report a human reads; `recordSync` is already imported in this file and routing the
count there is a follow-up, not this change. And `nfl_snaps` holds the same quantity from the
same file with nothing comparing them — recorded above.

**How does it unify?** It makes one ingest report what the other already did (`unmatched`), and
it writes down, once, the scale two separate consumers had each assumed silently.
