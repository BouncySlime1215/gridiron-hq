---
name: gridiron-charting-box-contamination-2026-09-22
description: Third instance of the feed-zero contamination pattern — chartingSummary's raw AVG(defense_box) — fixed with NULLIF plus a bound season; held unpushed at ce75775/1f37be6.
metadata:
  type: project
---

`server/services/nfl-formations.js`, `chartingSummary`. Found and fixed
2026-09-22 ~07:20Z on branch `claude/project-thread-2oztzw`, **committed but NOT
pushed**: `ce75775` RED, `1f37be6` GREEN. Evidence
`docs/tdd/charting-summary-box.tdd.md`.

## The defect
`mean_defenders_in_box` came from `AVG(CAST(defense_box AS REAL))` over every
charted row. The feed writes `0` where the box was never counted, so those rows
averaged in as real observations of zero defenders. `formationDistribution`, one
function above in the SAME file, already wrapped the identical measurement in
`NULLIF`; the sibling read never got it. Fixture: 4.50 published where the
measurement is 6.00.

**Third instance of one pattern** — see [[gridiron-participation-not-dead-after-2023]].
The other two were the participation columns and `formationDistribution` itself.
Every mean in `nfl-formations.js` now treats a feed zero the same way.

## The overcorrection line, and why four mutations defend it
`play_action`, `motion`, `screen`, `rpo`, `no_huddle`, `trick`,
`out_of_pocket` are genuine 0/1 flags — a zero is a real measurement. `NULLIF`
across the SELECT turns every rate into "share of plays that had it" = 1.0 by
construction, from real data, nothing throwing. **Overcorrection is the more
expensive error**: the `n_blitzers` case measured 3.5x wrong (1.3095 vs a true
0.3786), worse than the original bug. M2/M4/M6 and the flag assertions exist
only to hold this line.

## Second defect, same function: string-built SQL
Season was interpolated (`WHERE season = ${Number(season)}`). Not injectable,
but a non-numeric season reached SQLite as the bare token `NaN` → parsed as a
column name → `ERR_SQLITE_ERROR: no such column: NaN`, i.e. a bad parameter
became a 500. Now bound, per CLAUDE.md parameterised-queries-only.

**Lesson worth keeping:** the first fix also carried a `Number.isFinite` guard.
Its mutation **survived** — a bound NaN already matches no row and falls through
to the existing empty answer. The guard was dead code and was REMOVED, rather
than kept by writing a test to justify it. A surviving mutation does not always
mean "add an assertion"; sometimes it means the code is redundant.

## Verification
RED failed 2 of 5; fix green; **8 mutations injected, 8 killed**. Full
`npm run check` green all five stages: **3030 tests, 2989 pass, 0 fail, 41
skipped, exit 0**, build and smoke through. Tree hash and `node_modules` both
verified unchanged across the run, per [[gridiron-suite-figure-rule]].
Only ONE green check so far — a second is needed if the 2x rule is reinstated
before these push.

## NOT established
Live magnitude is unmeasured: the container's scratch DB holds **zero**
`nfl_play_charting` rows (and its `nfl_play_formations` is pre-migration-070,
lacking the four new columns). Defect, direction and fix are proven; how far off
production currently reads is not. Needs an ingest against the real feed.

## Scope note
Route 2 (`nfl-weekly-feature-store.js:149,160`, three contaminated AVG()s
reaching the SERVED store) is the same bug on a file **not allocated to this
thread** — grants are only `source-registry.js`, `nfl-feature-coverage.js`,
`nfl-model-growth.js:200` ([[gridiron-rd-cleanup-file-grants-2026-09-22]]).
Left untouched and flagged for assignment rather than edited across the
ownership line.
