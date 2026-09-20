# ESPN market feed on a timer — PR #50

Evidence for `Put ESPN's market feed on a timer; it had a writer nobody called`
and `Skip the ESPN market sync unless the league is the current season`
(`server/services/scheduler.js`, `refreshEspnMarket` and the `espn_market` JOBS
entry).

## Why this file has no RED commit

There was nothing to write a failing test against. `syncEspnMarket` existed,
worked, and had **no caller anywhere** — not a route, not a script, not the
scheduler. A RED commit would have had to assert that a job which did not exist
behaves in some way, which is not a test of the defect; the defect was an
absence. The change is the schedule, and the tests are what pin the schedule's
shape.

So this is the retroactive form of `docs/tdd/week2-numbers.tdd.md`: every rule
named, and each shown failing under a mutation. Its standard — *a test that no
mutation can fail proves nothing* — is what the sweep below pays, and it caught
nothing this time only because a first, wrong mutation was checked rather than
believed (see the last section).

## The defect

`espn-market.js`'s `syncEspnMarket` is the only writer of `espn_player_market`.
Four surfaces read that table:

- `routes/aggregates.js:226` — the fantasy consensus board
- `preseason-model.js:336`
- `manager-archetypes.js:166`
- `consensus-weights.js:526`

Each has been serving whatever the last person to call the function by hand left
behind. Same class as the rest of this thread's findings: **not a bug in the
code that reads, a schedule that was never written for the code that writes.**

Two decisions in the fix are worth more than the schedule itself.

**One league, not a loop.** `espn_player_market`'s key is
`espn_id INTEGER PRIMARY KEY` (`core-and-fantasy.js:595`) — one global row per
player, and the upsert overwrites the `season` column with it. A loop over every
connected league would leave whichever ran last in the table.

**And only if that league is the current season.** A run against a past-season
league is worse than no run at all. `preseason-model.js:336` and
`manager-archetypes.js:166` both filter `WHERE m.season = ?`, so a stale write
makes them go blank — visible, recoverable. `routes/aggregates.js:226` does not:
it joins on `espn_id` with no season filter and reads `adp`, `ppr_rank` and
`injury_status`, none of which is scoring-dependent. Last season's ADP and last
season's injury status land on the live consensus board with nothing marking
them stale. That is why the season check is a hard skip and not a best effort.

## The rules, and the mutation that breaks each one

Seven guarded rules in `test/scheduler-espn-market.test.js`. Baseline:
**7 pass, 0 fail.**

| # | Rule | Test |
|---|------|------|
| 1 | The feed is on a timer at all | `the market feed is on a timer at all` |
| 2 | It runs off the request thread | `it runs off the request thread` |
| 3 | No connected ESPN league is a skip, not a throw | `with no ESPN league connected it skips rather than throwing` |
| 4 | Exactly one league, the newest ESPN season | `it fetches for exactly one league, the newest ESPN season` |
| 5 | A past-season league writes nothing | `it writes nothing when the newest ESPN league is a past season` |
| 6 | Within the season, prefer a league carrying both cookies | `within the current season it prefers a league that carries both cookies` |
| 7 | It asks for more of the pool than the 400 default | `it asks for more of the pool than the default` |

Each mutation applied to `server/services/scheduler.js`, the file's tests run,
the file restored. Output verbatim.

```
=== BASELINE ===
# pass 7
# fail 0
### job-entry-removed -> 0 pass / 7 fail
    not ok 1 - the market feed is on a timer at all
    not ok 2 - it runs off the request thread
    not ok 3 - with no ESPN league connected it skips rather than throwing
    not ok 4 - it fetches for exactly one league, the newest ESPN season
    not ok 5 - it writes nothing when the newest ESPN league is a past season
    not ok 6 - within the current season it prefers a league that carries both cookies
    not ok 7 - it asks for more of the pool than the default
### back-on-the-request-thread -> 6 pass / 1 fail
    not ok 2 - it runs off the request thread
### no-league-throws-instead-of-skipping -> 6 pass / 1 fail
    not ok 3 - with no ESPN league connected it skips rather than throwing
### loops-every-espn-league -> 5 pass / 2 fail
    not ok 4 - it fetches for exactly one league, the newest ESPN season
    not ok 6 - within the current season it prefers a league that carries both cookies
### stale-season-written-anyway -> 6 pass / 1 fail
    not ok 5 - it writes nothing when the newest ESPN league is a past season
### cookie-preference-dropped -> 6 pass / 1 fail
    not ok 6 - within the current season it prefers a league that carries both cookies
### limit-back-to-the-default -> 6 pass / 1 fail
    not ok 7 - it asks for more of the pool than the default
```

What each mutation was:

- **job-entry-removed** — the whole `espn_market` JOBS entry deleted, i.e. the
  state this PR found. All seven fall. This is the control that says the tests
  read the real registry and not a fixture of it.
- **back-on-the-request-thread** — `offThread: true` dropped from the entry.
  `kona_player_info` is the largest ESPN payload the app fetches (17.6 MB
  measured 2026-09-19, before the 400-player filter) and `node:sqlite` is
  synchronous, so parsing it inline is an outage rather than a slow job.
- **no-league-throws-instead-of-skipping** — the `!league` guard removed. On a
  machine with no ESPN league the job would throw every twelve hours and
  `sync_log` would carry a permanent error for a state that is not an error.
- **loops-every-espn-league** — ordering by `season ASC`, i.e. picking an old
  league. Two rules notice: the season one and the cookie preference, because
  both are properties of *which* single league is chosen.
- **stale-season-written-anyway** — the season check removed. This is the
  mutation that matters most, because its damage is the silent kind: the run
  succeeds, `sync_log` reads `ok`, and last season's ADP is on the board.
- **cookie-preference-dropped** — the `(espn_s2 IS NOT NULL AND swid IS NOT
  NULL) DESC` tiebreak removed. `espn-market.js:31` only attaches cookies when
  both are present, and a private league without them throws on the fetch.
- **limit-back-to-the-default** — `{ limit: 1000 }` removed. The default is 400
  (`espn-market.js:18`) and we hold ~800 ESPN ids, so the tail of the pool would
  be definitionally unfetched.

## The first version of one mutation was wrong, and believing it would have been the bug

The first `back-on-the-request-thread` injection reported **7 pass / 0 fail** —
a test that guards nothing, and exactly the finding this sweep exists to
surface. It was not. The substitution pattern ended in `offThread: true, ` with
a trailing space; in the file the entry wraps, so the text is
`offThread: true,\n`. The pattern matched nothing, the file was never mutated,
and the run was the baseline wearing a mutation's name.

Re-run against a pattern verified to have changed the file, the rule fails as
it should. **A mutation result is only evidence if the mutation was applied** —
check the diff, not the intent. A silent no-op injection reads as a green
mutation sweep, which is a stronger false claim than no sweep at all.

## What this file does not settle

Whether the live `espn_player_market` table currently holds a stale season. The
schedule starts fresh from the next run, so anything already in the table
predates this change:

```sql
SELECT season, COUNT(*) FROM espn_player_market GROUP BY season;
```

Any row whose `season` is not 2026 is a hand-run from a past season still being
served by `routes/aggregates.js:226`. The suite cannot see it; only that read
can.
