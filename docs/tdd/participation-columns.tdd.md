# Participation's charted columns, and the half of them that are not measurements

RED `b1dab12` · GREEN `1d25b4c` · migration `070_play_formations_participation_columns`

Package #9 item 2: nflverse participation carries columns `ingestFormations`
reads past and throws away. Store four of them — pressure, time to throw,
man/zone and coverage shell. Nothing in this repo had an equivalent for
coverage shell or pressure.

## Intake — two of package #9's three premises did not survive checking

| claim | verdict |
|---|---|
| "v2 is unwired, grep finds nothing importing it" | **false.** `scripts/backfill-feature-store.mjs:78` and `scripts/grade-feature-vector.mjs:58` both import it. Its conclusion — no *served* impact — may still hold, but not for that reason. |
| "ingestFormations/ingestCharting work, just never invoked" | **false.** `nfl-model-growth.js:200-201`, `routes/nfl-betting.js:1545-1546`, `scripts/nfl-2022-2025-rebuild.mjs:132,137`, and `test/ftn-charting.test.js`. |
| "the columns exist and are discarded" | **true**, and the basis for this unit. |

The real defect in that neighbourhood was not what the package described.
`nfl-model-growth.js:200` reads:

```js
if (season <= 2023) await attempt('formation_participation', () => ingestFormations(season), detail.ingestion);
```

That is the same false premise — "nflverse participation ends after 2023" —
that commit `1d8f6aa` corrected in this file's own doc comment earlier the same
night. The comment was fixed; the gate was not. Verified against the real
assets rather than inferred, range request, `docs/evidence/` script in this
commit:

```
participation 2022 -> HTTP 206      2024 -> HTTP 206
participation 2023 -> HTTP 206      2025 -> HTTP 206
participation 2026 -> HTTP 404      (current season, never published)
```

Two seasons of free data the repo already knows how to ingest are dropped on a
wrong constant. `nfl-model-growth.js` is not this thread's file; routed up.

## The measurement that shaped the implementation

`docs/evidence/participation-dropback-contamination.mjs`, run against the real
2024 file, 45,919 rows:

```
was_pressure non-blank            45,905
  on a charted dropback           22,408
  NOT a dropback                  23,497   (51.2%)
  of those, reading TRUE              20

pressure rate over every non-blank row   0.1539
pressure rate over dropbacks only        0.3145
```

Half the rows carry `was_pressure` on a play that was never a dropback — runs,
kneels, punts, kicks — and they read `FALSE`. Stored as `0` they halve the
pressure rate. A blank-means-null rule does not catch this, because the cell is
not blank.

**Why the discriminator is coverage charted and not `time_to_throw`:**

```
charted dropbacks with no time_to_throw   2,689
  of those, pressured                     1,990   (74%)
```

Those are the sacks and scrambles — the most pressured plays in football.
Gating on `time_to_throw` would null out the pressure signal exactly where it
is strongest. Measured before choosing, not after.

## The same contamination, already live in two stored columns

```
number_of_pass_rushers   zeros 23,754 of 45,905
  mean, every non-blank row   2.0798
  mean, dropbacks only        4.2548

defenders_in_box         zeros  9,219 of 45,905
  mean, every non-blank row   4.8726
  mean, dropbacks only        5.8410
```

A defense with zero defenders in the box is not a measurement. And
`formationDistribution` already knew: it filters `defenders_in_box > 0` for its
histogram while leaving the zeros in `AVG()` two lines above. Both means now
use `NULLIF` on the same sentinel the histogram already rejects — in scope
because it is this file and it is the same bug.

**Out of scope and routed up:** `nfl-weekly-feature-store.js:149` does
`AVG(defenders_in_box), AVG(pass_rushers)` with no filter, and that is the
*served* feature store. Changing its semantics is not an additive registration
and is not this thread's call.

## The upsert

The insert was `ON CONFLICT DO NOTHING`. Widening the table alone would leave
every row stored before this migration NULL in the new columns forever, because
a re-ingest is a no-op. `ingestCharting` hit exactly this at migration 059 and
switched to `DO UPDATE`; the same fix, on the sibling table. A test asserts it
by storing a narrow row first and re-ingesting over it.

## Mutation testing — nine injected, nine caught

| # | injected | result |
|---|---|---|
| 1 | store pressure on every row | 1 fail |
| 2 | gate on `time_to_throw` instead of coverage | 1 fail |
| 3 | upsert carries only the old columns | 2 fail |
| 4 | zeros back in the box mean | 1 fail |
| 5 | store `0` instead of NULL off a dropback | 1 fail |
| 6 | drop the coverage shell | 3 fail |
| 7 | drop the man/zone label | 1 fail |
| 8 | zeros back in the rusher mean | 1 fail |
| 9 | `NULLIF` on the wrong sentinel | 1 fail |

Mutation 8 **survived the first pass.** The rusher mean had no assertion, so
the `NULLIF` on `pass_rushers` was untested even though the box-count one next
to it was. The test was wrong, not the implementation; the assertion was added
and the mutation then died. Recorded rather than quietly fixed, because a
mutation that survives is the only signal that a passing test is not testing
anything.

## Deliberately not stored

`route` is in the same file and is not added here. The nflverse route taxonomy
changed after 2022 — six labels exist only in 2022, seven only from 2023 — so a
fit spanning that boundary fails silently, and the column needs that documented
at the storage layer before it is worth having. The R&D thread also measured
route mix at r2 0.770 with actual aDOT, which play-by-play already carries free,
so it is not the part of this file worth reaching for first. `offense_players`
and `offense_positions` are likewise left for whoever needs them.

## The five questions

**Well built?** Additive: a migration mirroring the one that did this to the
sibling table, four nullable columns, an upsert that matches the sibling
ingest's, and one SQL fix in the same file. Nine mutations caught. No existing
column's stored values change.

**Stats or made up?** Measured, on the real file, with the script committed.
45,919 rows for 2024; the column-presence check ran across 2022, 2023, 2024 and
2025 and all four target columns are present in every one.

**How do we know?** Run `docs/evidence/participation-dropback-contamination.mjs
2024` and the numbers reproduce. It downloads free data and needs no key.

**Pointed anywhere else?** The contamination shape is: a file that writes a
real-looking value where the concept does not apply. That is the second
instance tonight, after `off_fourth_down_rate` — and in both, the wrong number
was roughly half or double the right one, with nothing throwing. Worth a sweep
of any other column read straight out of a wide upstream file.

**How does it unify?** Coverage shell and pressure are the first of their kind
stored here, and they join on `(game_id, play_id)` to everything already in
`nfl_play_formations`, so nothing parallel is introduced.
