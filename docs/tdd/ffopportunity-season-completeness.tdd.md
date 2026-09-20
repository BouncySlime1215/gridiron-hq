# ffopportunity season completeness — PR #45

Evidence for `Treat a half-ingested ffopportunity season as missing, not held`
(`server/services/scheduler.js`, `ffOpportunitySeasons`).

## Why this file has no RED commit

The RED/GREEN pair is the shape this repository asks for and it is the right
shape when the test comes first. It did not here: three of the tests that guard
this decision **already existed and already passed**, because they encoded the
bug. `test/scheduler-blocking-jobs.test.js` inserted a single week per season
and asserted that the season counted as held — which is exactly what the old
`SELECT DISTINCT season` did, and exactly what is wrong with it. A RED commit
against that state would have been a commit that deleted three passing tests.

So this is the retroactive form, the one `docs/tdd/week2-numbers.tdd.md` set
the precedent for: every rule the change is supposed to guard is named, and
each one is shown failing under a mutation that breaks it. The standard from
that file holds here — *a test that no mutation can fail proves nothing* — and
the sweep below is what pays it.

## The defect

`ffOpportunitySeasons(season)` decides which ffverse opportunity seasons to
fetch. It asked:

```sql
SELECT DISTINCT season FROM nfl_ffopportunity_weekly
```

One row made a season "held" forever. A run killed after week 3 — a job
timeout, an OOM kill, the watchdog SIGKILL, all of which this scheduler exists
because of — left fifteen weeks missing, and nothing would ever fetch them
again.

Nothing would have reported it, either. The job returns clean, `sync_log` reads
`ok`, and the only symptom is projections that are quietly worse. That is the
same shape as the rest of this area: **a check that confirms a thing ran rather
than what it produced.**

The fix asks for completeness instead:

```sql
SELECT season FROM nfl_ffopportunity_weekly
GROUP BY season HAVING COUNT(DISTINCT week) >= 17
```

17 rather than 18 because the regular season was 17 weeks through 2020, and a
floor a complete season could fail would have us re-fetching against it forever.
`COUNT(DISTINCT week)` rather than `COUNT(*)` because the upsert is keyed on
`(season, week, player_gsis_id)` and one week holds a row per player.

Being wrong in this direction costs one re-download, and `syncFfOpportunity`
upserts, so it is idempotent. Being wrong in the other direction is a permanent
silent gap.

## The rules, and the mutation that breaks each one

Seven guarded rules in `test/scheduler-blocking-jobs.test.js`. Baseline for the
file: **11 pass, 0 fail.**

| # | Rule | Test |
|---|------|------|
| 1 | A complete prior season is not pulled again | `a completed season already held is not pulled again` |
| 2 | A season we hold nothing for is backfilled | `a season we do not hold yet is still backfilled` |
| 3 | A partially held *history* backfills only the gap | `a partially held history backfills only the gap` |
| 4 | A season whose ingestion died partway is fetched again | `a season whose ingestion died partway through is fetched again` |
| 5 | The floor is 17 exactly: 16 is short, 17 is held | `one week short of the floor is not held, and the floor itself is` |
| 6 | Rows are counted by distinct week, not by row | `duplicate rows within a week do not make a season look complete` |
| 7 | The current season is always fetched | `the current season is always fetched, however much of it we hold` |

Each mutation below was applied to `server/services/scheduler.js`, the file's
tests run, and the file restored. Output pasted verbatim.

```
=== BASELINE ===
# pass 11
# fail 0
### distinct-season-again -> 8 pass / 3 fail
    not ok 5 - a season whose ingestion died partway through is fetched again
    not ok 6 - one week short of the floor is not held, and the floor itself is
    not ok 7 - duplicate rows within a week do not make a season look complete
### count-star-not-distinct-week -> 10 pass / 1 fail
    not ok 7 - duplicate rows within a week do not make a season look complete
### floor-drops-to-16 -> 10 pass / 1 fail
    not ok 6 - one week short of the floor is not held, and the floor itself is
### floor-rises-to-18 -> 10 pass / 1 fail
    not ok 6 - one week short of the floor is not held, and the floor itself is
### current-season-also-filtered -> 10 pass / 1 fail
    not ok 8 - the current season is always fetched, however much of it we hold
### lookback-shrinks-to-one -> 5 pass / 6 fail
    not ok 3 - a season we do not hold yet is still backfilled
    not ok 4 - a partially held history backfills only the gap
    not ok 5 - a season whose ingestion died partway through is fetched again
    not ok 6 - one week short of the floor is not held, and the floor itself is
    not ok 7 - duplicate rows within a week do not make a season look complete
    not ok 8 - the current season is always fetched, however much of it we hold
```

What each mutation was:

- **distinct-season-again** — the query back to `SELECT DISTINCT season`, i.e.
  the defect itself. Three rules fall. This is the one that matters: it is the
  proof that the new tests would have caught the shipped bug.
- **count-star-not-distinct-week** — `COUNT(DISTINCT week)` → `COUNT(*)`. A
  single week holding 18 players' rows would count as a complete season. Rule 6
  only.
- **floor-drops-to-16** and **floor-rises-to-18** — the floor is pinned from
  both sides by one test, and both directions fail it. 16 would call a
  short season complete; 18 would call every pre-2021 season incomplete and
  re-fetch it forever.
- **current-season-also-filtered** — folding `season` into the same `.filter()`
  as the prior seasons. Once the current season crosses 17 weeks it stops being
  fetched, mid-season, which is the only case where "held" must never mean
  "done".
- **lookback-shrinks-to-one** — a control. It breaks the function wholesale and
  six of the seven rules notice, which says the tests are reading the return
  value and not a proxy for it.

## Rule 1 has no mutation of its own, and that is a real gap

`a completed season already held is not pulled again` is the only rule here
that no single mutation fails on its own — every mutation that breaks it
(raising the floor, shrinking the lookback) breaks a louder rule first and gets
attributed there. It is guarded, but it is guarded jointly. Naming it is worth
more than inventing a mutation that isolates it artificially.

## What this file does not settle

Whether the *live* database has a half-ingested season in it right now. That is
a read against `/data/data.sqlite` on the deployed machine:

```sql
SELECT season, COUNT(DISTINCT week) weeks FROM nfl_ffopportunity_weekly
GROUP BY season ORDER BY season;
```

Any prior season showing fewer than 17 weeks was silently frozen by the old
query, and this change is what makes the next run repair it. The suite cannot
know; only that read can.
