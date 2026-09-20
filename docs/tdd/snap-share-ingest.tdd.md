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

Base `server/services/nflverse.js` = `6fbaf79b3ebf`. Every row is applied one at a time from
that clean base by a runner that hashes the file before and after, prints the exact before and
after text itself so no row here is retyped from memory, and reports a pattern matching nothing
— or matching more than one place — as a NO-OP rather than as evidence. The file is restored to
`6fbaf79b3ebf` at the end, which the runner also prints.

| # | mutation | hash after | result |
|---|---|---|---|
| S1 | rescale an out-of-range share by 100 instead of refusing it | `a6ed4d5ef3b5` | 3 fail |
| S2 | store a bad share as `0` rather than as labelled absence | `64986ff5f1af` | 3 fail |
| S3 | widen the required range to 0–100, so a wrong-scale file passes | `c3d3b34176bc` | 4 fail |
| S4 | stop counting unmatched players in the **snap** loop | `dafa6c0db9e5` | 1 fail |
| S4x | *control:* the same mutation written without an anchor | `6fbaf79b3ebf` | **NO-OP, 2 matches** |
| S5 | stop counting out-of-range shares | `9c0284ea811d` | 2 fail |
| S6 | restore `?? null`, so a NaN is kept and reads as out of range | `f8a11142aba2` | 1 fail |
| S7 | drop the whole row when the share is unusable | `380e929acc14` | 3 fail |
| S8 | normalise a missing observation to `0` instead of to `null` | `e94730bf2039` | 2 fail |

Exact texts, as the runner printed them:

- **S1** `ok: false, value: null, observed,` → `ok: true, value: observed / 100, observed,`
- **S2** `ok: false, value: null, observed,` → `ok: false, value: 0, observed,`
- **S3** `  min: 0, max: 1,` → `  min: 0, max: 100,`
- **S4** the snap loop's `if (!pid) { unmatched++; continue; }` → `if (!pid) { continue; }`,
  anchored on the preceding comment line
- **S4x** `      if (!pid) { unmatched++; continue; }` → `      if (!pid) { continue; }`
- **S5** `        outOfRange++;\n` → `` (removed)
- **S6** `observed: Number.isFinite(observed) ? observed : null,` → `observed: observed ?? null,`
- **S7** `stmt.run(pid, …, share.value);` → `if (!share.ok) continue;` before the same line
- **S8** `… ? observed : null,` → `… ? observed : 0,`

### S4x is in the table on purpose

S4's pattern, written the obvious way, appears **twice** in this file: the usage loop's
`if (!pid) { unmatched++; continue; }` and the snap loop's. A sweep that replaced the first
occurrence would have mutated `syncPlayerWeekUsage`, watched a snap test fail for an unrelated
reason, and recorded S4 as caught. S4x is that naive pattern, kept as a row so the ambiguity is
on the record rather than in a note, and the runner refuses it: two matches, nothing applied,
file hash unchanged at `6fbaf79b3ebf`. S4 is the anchored version.

### Correction: S6 did not pass, and the earlier table was wrong

**The first version of this table recorded `S6 | report a missing share as out of range | 1
fail`. That figure is withdrawn.** Re-run with hashes, the mutation survived: **0 fail**. The
suite did not enforce the separation this file's own prose calls the reason the function exists.
The response was to write the missing test, not to weaken the mutation.

The gap turned out to be wider than the mutation. `snapShareVerdict` read
`observed: observed ?? null`, and `??` catches only `null` and `undefined` — **a `NaN` survives
it**. The ingest loop distinguishes "out of range" from "absent" with `share.observed != null`,
and `NaN != null` is `true`, so a non-finite observation was counted and sampled as a unit
change upstream: precisely the conflation the function exists to prevent. `observed` is now
normalised with `Number.isFinite`.

**Reachability, stated honestly.** No live sync could trip this. `numAt` (`nflverse.js:58`)
already returns `null` for a non-finite value, so `syncSnapCounts` never hands `snapShareVerdict`
a `NaN`. This is a contract defect in an exported function that is called directly and tested
directly, not a live fault in the ingest — and the fix is what makes S6 and S8 catchable, which
is why it is here rather than deferred.

Two tests carry it: the pure-verdict test now asserts `observed` is `null` for each of `null`,
`undefined` and `NaN`, and a new ingest test asserts that a row with a blank `offense_pct`
reports `out_of_range: 0` with no samples, while still storing the row with its snap count
intact. S7 now fails 3 rather than 2, because the new ingest test catches it too.

## Numbers

RED: 9 tests, 1 passed, 8 failed. The one that passed is the existing postseason filter, which
was already correct and is pinned so this change cannot break it. GREEN: 9 passed, 0 failed.

After the S6 correction the targeted file is **10 tests, 10 passed, 0 failed**. The tenth is the
new ingest test; the pure-verdict test gained an assertion rather than a test of its own, since
the claim it enforces belongs to the case it already covered.

The whole ingest is exercised, not just the pure helper: `fetchCsv` uses global `fetch`, so the
test stubs it and drives `syncSnapCounts` end to end against a temp database, including the
case that matters most — a **whole file** on the wrong scale, where every row is plausible on
its own scale and every consumer silently stops discriminating.

Full local check `npm run check` on the corrected tree: exit 0 — **2,960 tests, 2,919 passed,
0 failed, 41 skipped**; typecheck, lint and build clean; `start:smoke` passed on an isolated
database (32 teams). The commit before the correction measured 2,959 / 2,918; the one test of
difference is the new ingest test. CI is not consulted: the Actions allowance is spent and the
workflow is off.

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
