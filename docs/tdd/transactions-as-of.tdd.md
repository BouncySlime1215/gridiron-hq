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

---

# Part 2: the two trade-path consumers (RED `788193d`, GREEN below)

The manager read states its collection date. The two reads that sit between it
and a trade card did not, and they are the ones Nick actually sees: `timingRead`
tells him when a manager last declined one of his offers, `vetoClimate` prices
how vetoable a package is, and `selfRead` paces his own next offer — all three
from the same rows nothing on the deployed app collects.

Three surfaces, one accessor, one field name. `transactionsCollected` is
imported into `trade-tactics.js` and `counterparty-pricing.js` and the result is
`Object.freeze`d, because in `timingRead` one league-level block is shared by
every roster object and a caller mutating it would change every manager's date
at once.

Where each one sits, and why there:

- **`timingRead`** — on the per-roster object, beside its existing `source` and
  `fitted`. A manager with no decisions gets the date too: "we have not looked
  since Thursday" and "he has done nothing" are different answers, and the
  blank object is what a quiet manager returns.
- **`vetoClimate`** — set **before** the `!tx.length` early return. That return
  is exactly where a league with nothing collected looked identical to a league
  with no veto history.
- **`selfRead`** — set **before** the `me == null` early return, for the same
  reason: without it, a league Nick has not claimed and a league nobody has ever
  collected look the same, and the reason names only the first.

One improvement that falls out for free. All three functions wrap their read in
`try { … } catch { tx = [] }` — a bare catch that turns a missing table into "no
transactions", which is the shape CLAUDE.md names as having shipped two real
bugs here. The catches are untouched (not this change's scope), but the block now
distinguishes the two states: an absent table reports "the collector has never
run here" rather than passing as an empty collection.

## Mutation run, pasted verbatim

```
BASELINE (no mutation): 36 pass, 0 fail
C1  the timing read drops the block from the per-manager object
    APPLIED -> killed by: G5d; G5d3
C2  the timing read's date tracks the READ cutoff instead of the collection
    APPLIED -> killed by: G5d; G5d3
C3  the veto climate sets the block AFTER the no-transactions early return
    APPLIED -> killed by: G5d2
C4  selfRead sets the block after the no-roster early return, so the unavailable path has no date
    APPLIED -> killed by: G5d4
C5  the veto climate rolls its own MAX() instead of the shared accessor, and drifts
    APPLIED -> killed by: G5d2; G5d3
C6  selfRead reports every league's collection, not this league's
    APPLIED -> killed by: G5d3
```

Six injections, six applied, six caught.

**C4 survived the first pass, and the reason is worth recording.** `selfRead`'s
`me == null` branch — a league with no roster marked as Nick's — had **no test
at all**, in any file: every fixture league in `trade-tactics.test.js` and
`valuation-map.test.js` is created with `my_team_id` defaulted to `'1'`. So the
mutation that moved the collection date below that early return changed nothing
any test could see. Fixed by adding league 33 with a null `my_team_id` and
G5d4. That is the third fixture-level blind spot the mutation discipline found
tonight, all of the same kind: **a branch a fixture cannot reach is a branch no
assertion protects, however many assertions are written about it.**

**C2 and C5 are the two that matter most**, and neither is a strawman:

- **C2** makes the date track `now`, the read cutoff. `timingRead` already takes
  `now` to stay cutoff-safe, so conflating "what I read" with "when it arrived"
  is the natural mistake, and it would make the date appear to advance on every
  call while the rows sat still. G5d asserts the date is unmoved when the cutoff
  moves a clock-day forward.
- **C5** re-rolls the query locally instead of calling the shared accessor, and
  drifts. G5d3 catches it because it asserts the three reads are `deepEqual` to
  each other, not that each is individually plausible. That is the difference
  between testing a value and testing the unification, and it is the only
  assertion in this change that would survive someone "tidying up" the import.

## The five questions, for Part 2

**1. Stats or made up?** Definitional, class D, exactly as Part 1 — a column
maximum, a count, a column minimum. No threshold introduced.

**2. How do we know?** Four tests, six mutations, the run above; all six applied.

**3. Structure.** Neither consumer computes its own date; both call the one
accessor that already serves the manager read. `Object.freeze` on the shared
block. `trade-tactics.js` gained its first import beyond `rows`, and there is no
cycle: `manager-signals.js` imports only `db`, `manager-identity` and `paths`.

**4. Pointed anywhere else?** One left, `manager-archetypes.js`, routed to the
chat-sync thread — it is not this thread's file. After that, every consumer of
`league_transactions_raw` states its input's age.

**5. How does it unify?** This is the answer to the question rather than another
instance of it. Part 1 established the rule; Part 2 is the rule applied to
every consumer of one table through one accessor, with G5d3 asserting the three
agree. The standing rule that came out of it, now beyond this table: **an "as
of" must come from the data's own stamps for the thing being described, never
from a job-level stamp** — because a job that catches per-item failures and
continues will report success while one item silently stays stale.

---

# Part 3: the priced luck term (RED `56a02f1`, GREEN below)

Parts 1 and 2 were about `league_transactions_raw`. This is the same defect in a
second store, and it is the worst of the three because it moves money.

`luck_self_view` is a **term in the trade price** — `playerValuation` pushes it
as a factor with a cap of 0.05, and the factors multiply into the per-player
multiplier that becomes `their_value`. Its value comes from the `outcome` half of
`manager_archetypes`, which is written only by
`scripts/build-manager-archetypes.mjs`: by hand, off-server, exactly like the
transaction rows. A stale luck read priced into a deal is worse than a stale
card, because nothing on the card says that number moved the money.

**One correction to something I said in Part 2's hand-off, on the record.** I
reported `manager-archetypes.js` as a consumer of `league_transactions_raw`. It
is not: `grep -n league_transactions_raw server/services/manager-archetypes.js`
matches one line, a header comment at `:20`, and there is no `FROM` or `JOIN` of
that table in the file. The chat-sync thread was right and I was wrong; I had
read a comment in a filename grep as a query. So Part 1 already covered every
served consumer of that table, and this part is a different store.

## Not `manager_signals.computed_at`, and this is the whole point

`manager-signals.js` copies the archetype metrics into `manager_signals`, and
those rows carry their own `computed_at`. Using it here would have been the
obvious one-liner and would have been wrong: the signal build can re-run without
the archetype build having re-measured anything, so its stamp advances while the
measurement underneath sits still. That is the same substitution as `sync_log`
in Part 1 — a stamp that looks like a measurement of the thing and is a
measurement of the copy. `archetypesBuilt` reads `MAX(computed_at)` from
`manager_archetypes` itself, for that league-season, restricted to the `draft`
and `outcome` sources the signal layer actually copies. Mutation L1 is that
rule, and it is the mutation worth reading.

## Where it lands

- `counterpartyLayer` computes one frozen block per league (`archetypes`) and
  puts it on every manager entry.
- The `luck` reading handed to `playerValuation` carries `as_of` with it, so the
  stamp travels with the value rather than beside it.
- `add()` takes an optional store stamp and carries it onto **both** the priced
  factor and the **inert** entry. The inert half is not an afterthought: week 2
  of 2026 has one scored week against `min_n` 4, so luck is inert league-wide
  until week 5, and "not enough scored weeks yet" versus "not enough as of a
  build three days ago" are different answers — only the second tells Nick
  whether running the build would change it.
- `asOf` defaults to `null` for the sources with no separate build of their own
  (chat, roster, standings move with the league sync), and that `null` is a
  statement rather than a gap.

## Mutation run, pasted verbatim

```
BASELINE (no mutation): 36 pass, 0 fail
L1  the layer uses manager_signals.computed_at instead of the store's own build stamp
    APPLIED -> killed by: G9g; G9h; G9i
L2  as_of is the OLDEST build in the store instead of the newest
    APPLIED -> killed by: G9g; G9h
L3  the priced factor drops the stamp
    APPLIED -> killed by: G9g
L4  the inert entry drops the stamp, so a not-firing read says nothing about its age
    APPLIED -> killed by: G9h
L5  the luck call stops passing the stamp into add()
    APPLIED -> killed by: G9g; G9h
L6  the store block reports every league's build, not this league's
    APPLIED -> killed by: G9g; G9h
L7  an empty store for this league borrows a stamp instead of saying nothing
    APPLIED -> killed by: G9i
```

Seven injections, seven applied, seven caught.

**Two of my own test bugs, fixed in the tests.** G9g and G9h first read the
per-player valuations off the layer entry; on a layer entry `players` is the
**chat sentiment index**, and the valuations live on `valuationMap`. The
assertions were wrong, not the code. Recorded because it is the same mistake in
a new place: reading a field by name from the wrong one of two objects that both
have it.

The archetype fixture also had every row sharing one `computed_at`, so L2 would
have survived — the third time tonight. Pinned unequal.

## The five questions, for Part 3

**1. Stats or made up?** Definitional, class D. A column maximum over a filtered
set. No threshold added; `min_n: 4` and `cap: 0.05` are untouched and still
`fitted: false` as they were.

**2. How do we know?** Three tests, seven mutations, all applied and caught. The
claim that `manager-archetypes.js` does not read the transaction table was
verified by grep on this tree, which is also how I found my own earlier error.

**3. Structure.** `archetypesBuilt` sits beside `transactionsCollected` in
`manager-signals.js`, same shape, same field names, and
`counterparty-pricing.js` is still the only file that prices. `add()` gained one
optional parameter rather than a second code path.

**4. Pointed anywhere else?** The chat-sync thread has built an as-of block on
the archetype card itself (their hold `6ceb5c7`), with `as_of`, `career_as_of`
and `jev_as_of` per member. **Two accessors now read the same store's stamp,
theirs and mine, and that is a duplication worth closing after the merge** — the
Part 1 lesson (three hand-rolled `MAX()` queries is how three surfaces come to
print three dates) applies to two as much as three. Mine is deliberately the
narrower of the two: league-season scoped, restricted to the `draft` and
`outcome` sources the trade path actually reads, and it has no career or Jev
half. Flagged rather than resolved, because their file is not mine to edit.

**5. How does it unify?** Three parts, two stores, one rule, and the rule is now
general enough to state without naming either: **a served or priced value must
carry the stamp of the process that MEASURED it, never the stamp of a process
that merely copied, scheduled or reported it.** `sync_log` for transactions and
`manager_signals.computed_at` for archetypes are the same mistake, and both were
the convenient one.

---

# Part 4: the date that moved when an allowlist was edited (RED `2af8721`)

Found by the chat-sync thread while searching every branch for a second accessor
on `manager_archetypes`. Their reading of the defect was correct and it is in my
file, so it is fixed here.

`archetypeIndex` (`manager-signals.js`) accumulated its `asOf` **inside** the row
loop, after the `continue` that drops any metric not in `ARCHETYPE_METRICS`:

```js
const name = ARCHETYPE_METRICS[r.source]?.[r.metric];
if (!name || !Number.isFinite(r.value)) continue;
…
if (!asOf || r.computed_at > asOf) asOf = r.computed_at;   // ← after the continue
```

So `archetypes_as_of` — served by the rebuild route and printed by
`scripts/build-manager-signals.mjs` — reported *"the newest stamp among the
metrics this consumer happens to copy"*. Add a metric to `ARCHETYPE_METRICS` and
the reported build date changes without a single row being written. **Which
metrics one consumer copies is not a fact about the age of the store.**

GREEN is one line: `asOf: archetypesBuilt(leagueId, season).as_of`, the accessor
Part 3 added. It was already honest — a SQL `MAX` over the league-season's
`draft` and `outcome` rows with no allowlist — so this is the first payoff of
having built it, rather than new code.

## Mutation run, pasted verbatim

```
BASELINE (no mutation): 27 pass, 0 fail
A1  the build date goes back to being accumulated inside the mapped-metric loop
    APPLIED -> killed by: refresh: the reported archetype build date is the store's, …
A2  the accessor is called without the season, so another season's build leaks in
    APPLIED -> killed by: (same)
A3  the accessor is called without the league, so every league shares one date
    APPLIED -> killed by: (same)
```

**A2 survived the first pass** — no fixture had a second season for league 12, so
dropping the season filter changed nothing. Fixed by adding a **later** build
(07:00) for league 12 in season **2025**: it is the newest row that league has,
and it must not be this season-view's date. "The store was last built at 07:00"
is true and useless when what was built was last year. That is the fifth
fixture-level blind spot of the night and the same kind as the other four
([[unreachable-branch-no-assertion]] in project memory).

## The five questions, for Part 4

**1. Stats or made up?** Definitional. No number introduced; one wrong derivation
replaced by the right one.

**2. How do we know?** One test, three mutations, all applied and caught, plus
the fixture assertion that the two build stamps and the two seasons genuinely
differ — without which the test would pass for the wrong reason.

**3. Structure.** `archetypeIndex` no longer derives a date at all; it calls the
accessor. One store, one stamp, one function.

**4. Pointed anywhere else?** This is the general shape worth looking for
elsewhere: **a summary statistic accumulated inside a loop that `continue`s is a
statistic about what survived the filter, not about the set.** Worth a sweep of
the other `as_of`-like fields, which is a job for the wiring-map thread rather
than a change here.

**5. How does it unify?** Part 3's rule was "carry the stamp of the process that
measured it". Part 4 is its corollary, and the two together are the whole
lesson: **a stamp must describe the store, not the reader.** `sync_log` and
`manager_signals.computed_at` were the wrong *process*; this was the right
process read through one reader's private allowlist.
