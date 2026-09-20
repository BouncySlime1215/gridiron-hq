# TDD evidence: the manager read says how old its evidence is

**Branch** `claude/project-thread-3xqh5l-accessor-hold`. RED then GREEN, in that
order, in `test/manager-signals-api.test.js`, `server/services/manager-signals.js`
and `server/routes/trades.js`.

## The defect

`GET /api/trades/:leagueId/managers/signals` served `computed_at` — when the
signal **build** ran — and nothing else about time. It never said when the rows
the build read were **collected**, and on the deployed app those are not close
together.

Verified on this tree, not taken on report:

- The only writer of `league_transactions_raw` is
  `scripts/collect-league-transactions.mjs:34` (`grep -rn "INSERT INTO
  league_transactions_raw"` matches that line, and otherwise only test
  fixtures).
- That script is spawned from exactly one place,
  `scripts/refresh-live-data.mjs:99`, whose own header calls itself the
  **off-server** refresh loop: it exists because the in-server scheduler pegged
  the app at 100% CPU on 2026-09-17.
- `fly.toml` declares no `processes` block (`[[mounts]]`, `[[services]]`,
  `[[services.ports]]`, `[[services.http_checks]]` and nothing else).

So nothing on the deployed app has ever written a transaction row. Every
`tx_*` signal, every archetype built from them, and every counterparty price
downstream is computed from rows last collected by hand on Nick's machine, and
no served surface said so.

Second half of the same defect, and the worse one:
`SIGNAL_SOURCES.tx.refreshed` read **`'every refresh tick
(league_transactions_raw)'`**. That string is not documentation —
`signalRowsFor` interpolates it into the `why` served on every signal row
(`manager-signals.js`, `` `${spec.label}; refreshed ${spec.refreshed}` ``), so
the false cadence reached the client once per tx metric per manager.

## The fix

- `transactionsCollected(leagueId, season)` in `manager-signals.js`:
  `MAX(last_seen_at)` as `as_of`, `COUNT(*)` as `rows`, `MIN(first_seen_at)` as
  `first_seen`, the collector named in `collected_by`, and a `reason` when
  there is nothing. Absent table and empty table are **different reasons**,
  never a borrowed stamp.
- `SIGNAL_SOURCES.tx.refreshed` now names the collector and points at
  `transactions.as_of`.
- The payload carries a `transactions` block beside `computed_at`.

**Why the table's own stamps and not `sync_log`.** The collector writes a
`sync_log` row for the job as a whole at the end of its run. But it catches a
per-league failure and continues (`catch (e) { failed++; … }`), so `sync_log`
can say the job ran at 04:15 while one league's cookies expired and its rows
were last touched days earlier. `MAX(last_seen_at)` **for that league** is the
only value that means "the collector reached ESPN for this league". Choosing
the job-level stamp would have reproduced the exact failure this change exists
to remove: a value that looks like a measurement of this league and is not.

**Why it is not hanging off `available`.** The block answers a question about
the table, not about the signal build, so it is served for a league whose
signals were never built — which is precisely the league where someone is
wondering where the data went. Mutation T3 is that rule.

## Retroactive RED is not needed here; the RED is a real commit

`9a2f108` is the failing commit, with its three failures pasted below verbatim,
and the GREEN follows it. The mutation run below is the additional check the
scheduler thread's rule asks for: **a test that no mutation can fail proves
nothing**, and every injection prints APPLIED or NO-OP so that a pattern which
silently did not match cannot be read as a passing result.

```
not ok 6 - read: the payload says when the transactions under it were last collected, and how many
  error: 'the payload carries a transactions block'
  expected: true
  operator: '=='
not ok 7 - read: a league with no collected transactions says so rather than serving a stamp it does not have
  error: 'the block is served even when there is nothing in it'
  expected: true
  operator: '=='
not ok 8 - read: the transactions source does not advertise a refresh the server never runs
  error: 'the deployed app runs no refresh tick that touches this table'
  actual: 'every refresh tick (league_transactions_raw)'
  operator: 'doesNotMatch'
```

## Mutation run, pasted verbatim

```
BASELINE (no mutation): 20 pass, 0 fail
T1  as_of reads the OLDEST collection stamp instead of the newest
    APPLIED -> killed by: the payload says when the transactions under it were last collected, and how many
T2  as_of borrows the signal build stamp when no rows were collected
    APPLIED -> killed by: a league with no collected transactions says so rather than serving a stamp it does not have; a league whose signals were never built still reports its transaction collection
T3  the empty block is omitted instead of explaining itself
    APPLIED -> killed by: a league whose signals were never built still reports its transaction collection
T4  the row count is every league's rows, not this one's
    APPLIED -> killed by: a league with no collected transactions says so rather than serving a stamp it does not have; a league whose signals were never built still reports its transaction collection
T5  first_seen reports the newest first-sight, so the window looks shorter than it is
    APPLIED -> killed by: the payload says when the transactions under it were last collected, and how many
T6  the tx source goes back to advertising a refresh tick the server never runs
    APPLIED -> killed by: the transactions source does not advertise a refresh the server never runs
T7  the block no longer names what writes the table
    APPLIED -> killed by: the payload says when the transactions under it were last collected, and how many
T8  an absent table is reported as clean rather than as never collected
    APPLIED -> killed by: a database with no transactions table at all says the collector has never run here
```

Eight injections, eight applied, eight caught; each of the five new tests is
failed by at least one.

**Two fixture defects the mutation run found, and they are the point of running
it.** T3 and T5 both survived the first pass. T5 survived because every fixture
row shared one `first_seen_at`, so `MIN` and `MAX` returned the same value and
the assertion could not tell them apart — the same shape as the `n = 4` against
`min_n` 4 defect earlier tonight. T3 survived because the only "no rows" test
used a league that *has* signals, so hanging the block off `available` changed
nothing that was asserted. Both were fixed in the test, not the code: one row
now has a later first sighting, and a league with no build at all is asserted.

## Is this well built? (the five questions)

Nick's standing rule, 2026-09-20.

**1. Is it based on stats, or is it made up?** Neither — it is **definitional**,
class D in `docs/NUMBER-PROVENANCE.md`, and that is the right class. Nothing
here is fitted or estimated: `as_of` is a column the collector writes on every
upsert, `rows` is a count, `first_seen` is a column minimum. There is no
threshold, no cap and no default anywhere in the change, which is deliberate —
a served freshness value that was itself estimated would be the same bug one
level up.

**2. How do we know?** Five tests, eight mutations, the run pasted above; the
writer claim re-derived by `grep` on this tree rather than taken from another
thread's report, and the `fly.toml` absence of `processes` read directly. The
one thing NOT established here is how stale the live rows actually are: reading
that needs the deployed database, and the app is on a restart cycle. The change
makes the app able to answer that question; it does not answer it.

**3. Structure.** The accessor sits next to `SIGNAL_SOURCES` and
`unpriceableReason` in `manager-signals.js`, with the other rules about what a
signal row means, rather than in the route — the same line drawn earlier
tonight when the `priceable` join moved out of `trades.js`. A route that
computed its own freshness would be the second consumer able to disagree with
the first.

**4. Should this point anywhere else on the platform?** Yes, and this is one
third of it. The same rows feed `manager-archetypes.js`,
`counterparty-pricing.js` and `trade-tactics.js`, and none of those says how old
its input is either. A trade card prices a counterparty on transaction history
without stating that the history stops at the last manual collection. Routed,
not patched: `trade-tactics.js` and `manager-archetypes.js` are not this
thread's files.

**5. How does it unify?** It is the third instance tonight of one shape, and
the rule is now stated the same way each time: **no served value may carry a
default, or a silence, that is indistinguishable from a measurement it is
not.** The luck read priced on a manager with no scored weeks; the acceptance
tier served an assumed "fair" as a stated one; here a cadence string claimed a
refresh that does not run, and a build stamp stood in for a collection stamp
that was never served. The general fix is the same each time: serve the fact
you have, and name the absence when you do not have one.

## What is deliberately not covered

The collector itself. `scripts/collect-league-transactions.mjs` is a
top-level-await module that reaches ESPN on import, the same reason
`capture-availability-baseline.mjs` had no test before its predicates were
extracted (`docs/tdd/capture-restart-guards.tdd.md`). This change reads what
the collector wrote; it does not exercise the writing.
