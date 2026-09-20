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

## The shared accessor, and the field that must not be swapped blind

The chat-sync thread has built a shared accessor on their own branch
(`claude/project-thread-sytruo-asof-hold`, `manager-archetypes.js`):
`archetypesBuilt(leagueId, season, memberId = null)`. Read here from that branch
rather than taken on report.

**This branch does not switch to it yet, deliberately.** The symbol does not
exist on this base, so an import of it would make every test in this branch fail
to load — a red branch pushed against the standing rule that every push is
preceded by a green local check. The defect it addresses is already closed here
by Part 4, using the local `archetypesBuilt` in `manager-signals.js`, so nothing
is broken while the two branches wait for each other. The switch is then a
deletion and a call.

**Two things the person making that switch must know**, both read from their
source:

1. **The field is `priced_as_of`, not `as_of`.** Their `as_of` is the whole
   league-season, *any* source; `priced_as_of` is restricted to
   `PRICED_SOURCES = ['draft', 'outcome']`, which is what this file's local
   accessor computes and what the trade path wants. A straight swap of `as_of`
   would silently widen what the number means — a career or Jev row would move
   the date the trade price is stamped with. That is the Part 1 defect in a new
   costume.
2. **Branch on `stale_version_rows > 0`.** Their query also filters
   `version = MANAGER_ARCHETYPE_VERSION`; the local one does not. That makes `priced_as_of` mean "when the current build
   version last wrote", which is arguably the better question. It has a
   consequence worth naming before the merge: a store containing only
   *older-version* rows returned `rows: 0` and the reason "the build has never
   covered it" — which reads as *no data* when the truth is *stale data from an
   older build*. **Routed, and since fixed on their branch**: the block now also
   carries `stale_version_rows`, and in that state its reason names both
   versions, while `as_of` stays null and `rows` stays 0 so an old row is
   reported and never promoted. The switch here must therefore branch on
   `stale_version_rows > 0` to say "stale build" rather than "never built" —
   otherwise this file reintroduces, one layer up, the exact conflation their
   fix removed.

---

# Part 5: the chat corpus, where absence is the normal case (RED `02a789c`)

The third store, and the one whose absence is not the exception. The corpus is a
private SQLite file on Nick's Mac (`chatDbPath()`), deliberately never in the
deployed image, and its rollup is **step 3 of `scripts/refresh-live-data.mjs`** —
the same off-server loop that collects transactions. So on the deployed app
`openChatDb()` returns null **every time**, every chat read downstream produces
nothing, and "there is no corpus on this machine" and "he never talks" were the
same empty.

`SIGNAL_SOURCES.chat.refreshed` also still read `'every refresh tick'` — the
identical false cadence `tx` carried, in the same registry, reaching the client
the same way: interpolated by `signalRowsFor` into the `why` served on every chat
signal row. Part 1 fixed one of the two and did not look at its neighbour. That
is worth naming: **finding a defect in a registry entry is a reason to read the
other entries, not a reason to move on.** The remaining five were checked this
time; `roster`, `standings` and `outcome` are accurate, and `nick`
("edited in code") and `draft` are accurate.

`chatCorpusState()` reports four states with four sentences, because what a
reader would do about each differs: no path configured; configured but the file
is not here (the deployed app, always); here but the rollup has not written
`manager_chat_profile`; here and rolled up, with the date.

The fourth of those is a real state and not defensive padding: the rollup drops
and recreates `manager_chat_profile` **outside a transaction**, so a crash
between the two leaves the table gone — which the suite already has a test for
elsewhere. That read is caught and reported rather than passed off as an empty
corpus.

## Mutation run, pasted verbatim

```
BASELINE (no mutation): 23 pass, 0 fail
H1  as_of reads the OLDEST rollup stamp instead of the newest
    APPLIED -> killed by: the chat half says whether the corpus is here…; a database with no chat corpus…
H2  an absent corpus is reported as a clean empty with no reason
    APPLIED -> killed by: a database with no chat corpus says so instead of serving an empty chat half
H3  an absent corpus borrows today's date
    APPLIED -> killed by: (same)
H4  the chat source goes back to advertising a refresh tick the server never runs
    APPLIED -> killed by: the chat source does not advertise a refresh the server never runs, either
H5  the block no longer names what rolls the corpus up
    APPLIED -> killed by: the chat half says whether the corpus is here at all…
H6  the route omits the chat block when there is no corpus
    APPLIED -> killed by: a league whose signals were never built still reports its transaction collection
```

Six injections, six applied, six caught.

**H6 survived the first pass — the same fixture gap as C3 and T3 in Parts 1 and
2**, and this is now four times for one shape: the "no rows" assertion used a
league that *has* signals, so hanging the block off `available` changed nothing
asserted. It was fixed the same way both previous times, and I still wrote it
again. The lesson has been promoted out of these run notes into project memory
(`unreachable-branch-no-assertion`) because writing it down per-incident
evidently does not stop it.

## The five questions, for Part 5

**1. Stats or made up?** Definitional. A column maximum, a count, a file-exists
check.

**2. How do we know?** Six tests over the whole pass, six mutations, all applied
and caught. The off-server claim is read from `refresh-live-data.mjs`'s own
header and its step list, not taken on report.

**3. Structure.** Third accessor, same shape and field names as
`transactionsCollected` and `archetypesBuilt`, same file. The route's payload now
carries `transactions`, `chat` and `computed_at` as three separate facts, which
is what they are.

**4. Pointed anywhere else?** `counterparty-pricing.js` and `bluff-detector.js`
read the same corpus. `counterparty-pricing.js` is mine and is next;
`bluff-detector.js` is not allocated to this thread and is routed.

**5. How does it unify?** Three stores, five parts, one sentence: **a served
value must carry the stamp of the process that measured it, and an absence must
say which absence it is.** The second half is what Part 5 adds — the first four
parts were about stamps, and this one is mostly about the four different ways
there can be no stamp at all.

---

# Part 6: the "dead exports" that were not dead

The wiring map flagged eight export-only-tested symbols in
`counterparty-pricing.js`, with the instruction to delete the export and its test
together. **Nine have no production consumer, one of those is genuinely dead, and
none of the other eight should be deleted.** The evidence, because the
instruction and the answer differ:

| export | production consumers | alive inside this file? | verdict |
|---|---|---|---|
| `PERCEPTION_CAP` | none | yes, `perceivedValue` clamp | test seam |
| `PLAYER_VALUATION_CAP` | none | yes, `playerValuation` clamp | test seam |
| `VALUATION_SOURCES` | none (a comment at `trade-engine.js:1907`) | yes, 11 readers | test seam |
| `perceivedValue` | none | yes, `readDeal` calls it twice | test seam |
| `serializeManagerRead` | none (a comment in `client/.../types.ts:64`) | yes, `readDeal:743` | test seam |
| `negotiationProfileErrors` | none | yes, `negotiationProfilesFor` | test seam |
| `negotiationProfilesFor` | none | yes, `counterpartyLayer`, `selfRead` | test seam |
| `NEGOTIATION_PROFILE_SCHEMA` | none, **and no test either** | yes, one reader | **export removed** |
| `valuationMap` | **none at all** | **no** | **wiring finding, see below** |

**Deleting the seven seams plus their tests would have deleted real coverage of
real invariants** — among them G1b, which pins the per-factor cap and the
per-player clamp, and the assertion that `PLAYER_VALUATION_CAP >=
PERCEPTION_CAP`. Those are the exact numbers the model-evidence audit is
currently quoting to describe this layer. Removing their guards on the grounds
that only tests import them would have been a spectacular own goal.

So the fix is the one that makes the finding stop recurring rather than the one
that makes it go away: each of the seven now carries a one-line `TEST SEAM`
annotation naming its internal caller and what the export buys. An audit can then
tell a deliberate seam from an accident, which is the thing it could not do
before.

**`valuationMap` is the real finding, and it is not a dead export.** It has no
caller anywhere in `server/`, `client/` or `scripts/` — `routes/trades.js:415`
names it in a comment and nothing more. It is the whole per-player transparency
surface (`sources_used`, `sources_absent` with a reason each, the per-source
ablation) and it is the harness that produced this layer's only measured
evidence, the AUC study in `docs/tdd/valuation-map.tdd.md` section 6. It is
reachable from tests and from a study run, and from no page Nick can open.
Routed as a wiring finding: deleting it would destroy the ablation that is the
evidence for the layer being a read rather than a price.

## A mistake of mine, in the same shape as the one three hours earlier

My first pass counted five symbols with no production consumer, not nine,
because `grep -rn` counted **comment mentions** as consumers for
`VALUATION_SOURCES`, `valuationMap`, `serializeManagerRead` and
`NEGOTIATION_PROFILE_SCHEMA`. That is exactly the error I made earlier the same
night with `manager-archetypes.js` and `league_transactions_raw`, where a header
comment read as a query. **A name in a comment is not a consumer, and a grep for
a bare identifier cannot tell the difference.** The wiring map's count was closer
than mine. The check that settles it is whether the match is code, which means
reading every hit rather than counting them.

## Is this well built? (the five questions)

**1. Stats or made up?** Neither: a census. Every row of the table above is a
grep whose hits were read individually.

**2. How do we know?** The table is the evidence, and the full suite is green
with the one export removed — which is the only behaviour claim here, since
removing an export nothing imports cannot change behaviour, and the annotations
are comments.

**3. Structure.** The seams stay exported and are now labelled as such.
`NEGOTIATION_PROFILE_SCHEMA` is private, where it belongs.

**4. Pointed anywhere else?** `valuationMap` should point at a page — it is the
surface that can say "these sources fired, these are absent and here is why per
source", which is the transparency question this whole document is about. Not
wired here: which page, and whether the ablation belongs in a served payload at
all, is a design call and not a Trade Brain one.

**5. How does it unify?** With Parts 1-5 more closely than it looks. Every part
so far has been a served value that could not distinguish two states. This one is
a *tool* that distinguishes them beautifully — per-source used, absent, inert,
each with a reason — and is wired to nothing.

---

# Part 7: a refusal nobody read, priced as a refusal that held (RED `51ad809`)

The most expensive instance of the whole pattern, and the deployed app is in it
every time.

Two halves of one fact live in two places. **A manager's declared players** live
in `manager_player_view`, in this database, and survive. **The record of whether
his refusals actually hold** lives in the Mac-only chat corpus, and does not. So
on the deployed app `declarationCredibility()` returns `available: false` while
his declared players are still sitting there, and `untouchableStance`
(`bluff-detector.js:243`) does this:

```js
const c = cred?.credibility ?? (1 - PRIOR_BLUFF_RATE);   // 0.65
```

0.65 clears that function's own 0.45 bar, so the manager lands in `probe`, the
`untouchable_credibility` factor fires, and the player is priced **up** — under a
sentence reading "he has called him untouchable, but his word holds only 65% of
the time". Nothing about his word was read. The number is a prior wearing a
measurement's sentence, and it moves money.

The fix stays in this file — `bluff-detector.js` is another thread's. The layer
now carries `declarations_read` (and its reason) alongside the stance, and
`playerValuation` reports the adjustment **inert with the reason** instead of
pricing it. "He has never reversed a refusal" and "we have never seen his
refusals" are opposite facts, and only the first justifies charging for one.

`declarations_read` is `null`, not `false`, when the league has no trusted chat
identity at all. That is deliberate and not an oversight: with no identity,
`manager_player_view` has no rows for him either, `untouchableStance` returns
`stance: 'none'`, and the branch never fires. The `false` state is specifically
"we have his declarations and not the record behind them", which is the only one
that was mispricing.

## Mutation run, pasted verbatim

```
BASELINE (no mutation): 37 pass, 0 fail
D1  an unavailable record is treated as available again, so the prior prices
    APPLIED -> killed by: G10
D2  the withheld adjustment is dropped silently instead of reported inert
    APPLIED -> killed by: G10
D3  the reason stops naming the absence
    APPLIED -> killed by: G10
D4  the guard fires on a PRESENT corpus too, so a measured refusal stops pricing
    APPLIED -> killed by: G1c (an existing test, not one written for this)
```

Four applied, four caught. **D4 is the one worth noting**: the risk in a guard
like this is not that it fails to fire but that it fires too widely and silently
stops a measured signal from pricing. It is killed by a test that predates this
change, which is better evidence than one written alongside it.

## The five questions, for Part 7

**1. Stats or made up?** The thing removed was made up — a prior presented as a
measurement. Nothing is added: no new constant, no new weight. The change is
strictly a withholding.

**2. How do we know?** One test, four mutations, all applied and caught, one of
them by an older test. The 0.65 figure is read from `bluff-detector.js:38` and
`:243`, not assumed.

**3. Structure.** The availability is computed once per league in
`counterpartyLayer` and carried on the manager profile, so `playerValuation`
decides from data rather than re-deriving it. `bluff-detector.js` is untouched
and its prior remains correct for its own callers — a league whose corpus IS
present and simply has no declarations for him is still "treat his word as good
by default", which is a defensible default *when the record was read*.

**4. Pointed anywhere else?** The same two-halves-in-two-places shape is worth
checking wherever a signal's *value* is in the app database and its *confidence*
is in the corpus. `talk_vs_model` and `chat_sentiment` are the candidates; both
read from the corpus directly, so they go absent together rather than splitting,
which is why they are not in this change.

**5. How does it unify?** This is Parts 1-6's rule at its most expensive, and the
sharpest statement of it: **a default is only honest when the thing it stands in
for was actually looked at.** Every part of this document is one of these — a
build stamp standing in for a collection stamp, an empty result standing in for
an absent store, and here a prior standing in for a measurement that was never
read. The fix has been the same each time: find out which state you are in, say
so, and refuse to price the one you cannot see.

---

## Part 8 — the chat block reported the rollup's age as the data's age

Chat sync read this block side by side with its own `freshness()` in
`league-chat-sync.js` and the coordinator's ruling was that one state gets one
sentence and this block is the machine-readable source. Four defects came out of
that comparison, all of them mine, and all four are the same family as Parts 1-7.

**1. `as_of` was `MAX(computed_at)` — the rollup stamp.** That is when the
aggregate was last computed, not how old the chat is. The rollup runs every
fifteen minutes whether or not a single message arrived, so the number served
was always young and said nothing about whether the chat half of a manager read
is current. A corpus nobody has added to since Tuesday reads as fresh. `as_of` is
now `MAX(last_msg)`, the newest message anyone in the corpus sent, and the rollup
stamp stays beside it as `computed_at`. **Two facts, two fields**, and the test
asserts they are unequal in the fixture so neither can pass on the other's value.

This is the general rule of these eight parts stated once more, in a store where
it had teeth: *a served value must carry the stamp of the process that MEASURED
it, never the stamp of a process that merely copied, scheduled or reported it.*
The rollup is a reporter. `last_msg` is the measurement.

**2. `first_seen` said nothing.** `scripts/chat/extract_league_chat.py` builds
`manager_chat_profile` with `CREATE TABLE AS ... datetime('now') AS computed_at`
for the whole table, so `MIN` and `MAX` of it are **equal by construction**. The
field was the same stamp under a second name. Dropped, and the test asserts it is
gone. This is exactly the T5/L2/A2 shape Part 1 named in another store — a
fixture where every row shares one stamp makes `MIN` and `MAX` indistinguishable
— except that here it is not the fixture, it is the table.

I did not take chat sync's word for this. `extract_league_chat.py:255-282` was
read directly, and it also settled the replacement: the same `CREATE TABLE AS`
carries `MAX(b.ts_utc) AS last_msg` per person, which is the per-row timestamp
that *can* differ and therefore the one `as_of` is now built from.

**3. The not-here branch did not name the path it looked at.** A mistyped
`GRIDIRON_CHAT_DB_PATH` and a machine that genuinely has no corpus produced the
same sentence, and those two have very different fixes. The path is now on the
block and in the sentence, with `path_source` saying whether it came from the
environment or from the in-repo default.

While fixing it, a **dead branch**: the block's first state was "no chat corpus
path is configured on this machine", and `chatDbPath()` cannot return a falsy
value — it is `process.env.GRIDIRON_CHAT_DB_PATH || path.join(PROJECT_ROOT,
'data/derived/league_chat.sqlite')`. No test could ever enter it. It is replaced
by `path_source`, which is the distinction that actually exists. Same lesson as
`unreachable-branch-no-assertion`: a branch nothing can reach is not a state, it
is a comment.

**4. The sentence carried one half of the fix.** "It is not in the deployed
image" points the reader at a deploy. The corpus **cannot be produced here** — it
is extracted from Apple Messages on Nick's Mac — and it **can be uploaded here**,
via `POST /api/league-chat/upload` (`server/routes/league-chat.js:101`, which
`scripts/chat-sync.mjs:351` already posts to). Both halves are in the sentence,
and the test matches the route rather than the word "uploaded", because the first
version of that assertion was loose enough to pass with the route removed.

### Mutation run, pasted verbatim

```
H1  as_of goes back to the rollup stamp                              APPLIED  caught
H2  as_of reads MIN(last_msg) instead of the newest in the corpus    APPLIED  caught
H3  computed_at reports the oldest rollup stamp                      APPLIED  caught (3 tests)
H4  the absent-corpus sentence drops the path                        APPLIED  caught
H5  the absent-corpus sentence drops the upload half                 APPLIED  caught
H6  path_source always says default                                  APPLIED  caught (2 tests)
H7  first_seen returns as the same stamp under another name          APPLIED  caught
H8  the present branch hardcodes path_source                         APPLIED  caught
```

Three of the eight — H4, H5 and H8 — survived their first pass, and all three
were the same test defect: I asserted on the FIELD and claimed a guarantee about
the SENTENCE, and the loose `/upload/i` still matched after the route name was
deleted because the neighbouring clause says "uploaded". **An assertion that
passes when the thing it names is removed is not an assertion about that thing.**
The three are now pinned on the reason string itself.

### Is this well built? (the five questions)

**1. Stats or made up?** Neither: these are stamps, and the whole point is that
each one is read from the process that produced it. Nothing here is fitted.

**2. How do we know?** Eight mutations, eight caught, pasted above, plus the
direct read of `extract_league_chat.py:255-282` that confirmed both the `MIN`
claim and the `last_msg` replacement rather than taking another thread's word
for either.

**3. Structure.** One accessor, four states, and no state that cannot happen.
`freshness()` in chat sync's `league-chat-sync.js` will call this block rather
than deriving its own, which is what makes one state one sentence.

**4. Pointed anywhere else?** Yes: every surface that shows a chat-sourced
number — the manager signals page, the counterparty layer's per-player reads,
the negotiation profiles — is reading data whose age is now available and was
not. The block is served on `GET /api/trades/:leagueId/managers/signals`.

**5. How does it unify?** With Parts 1-7 it is one rule in eight stores, and
Part 8 adds the sharpest case of it: the rollup is a scheduler, and a scheduler's
clock is not the data's clock.

---

## Part 9 — the other half of the unread refusal, found by another thread

Part 7 stopped pricing a refusal whose credibility record could not be read: with
the chat corpus off the machine, `declarationCredibility()` answers
`available: false`, `declarations_read` is `false`, and the untouchable
adjustment is reported inert instead of firing on the prior.

**It closed one of three doors.** Chat sync found the others. Everything
`untouchableStance` needs to *find* a declaration lives in `manager_player_view`,
which is in the app database and survives; only the record of whether his word
HOLDS lives in the corpus. So whenever that record is missing for a manager, the
stance falls back to `1 - PRIOR_BLUFF_RATE = 0.65`, which clears the 0.45 bar,
lands him in `probe`, and prices the player up under the sentence *"he has called
him untouchable, but his word holds only 65% of the time"* — a statement about a
word nobody read.

Three ways it goes missing, and Part 7 caught one:

| | `credibility` (league) | `stance.credibility` (his) | Part 7 | now |
|---|---|---|---|---|
| corpus not on this machine | `{available: false}` | null | inert | inert |
| no confirmed chat identity in the league | **null** | null | **priced** | inert |
| mixed league: his roster unconfirmed, others fine | available | **null** | **priced** | inert |

**The fix is where the guard reads from.** It keyed on
`managerProfile.declarations_read === false`, a league-level flag, and
`credibility == null` made that flag neither true nor false, so the `=== false`
test slid past it. It now keys on `stance.credibility == null` — **the record
itself, for this manager** — which is null in all three rows and is the only form
that can see the mixed league at all. `declarations_reason` still supplies WHICH
absence, in three distinct sentences, because one is a machine, one is a name
Nick never confirmed, and one is a record that holds nothing about him.

### Mutation table

Baseline `4293dfcae703` for `server/services/counterparty-pricing.js`.

| Mutation | Verification | Result | Fails | Named test red? |
|---|---|---|---|---|
| the guard goes back to the league-level flag | APPLIED `4293dfcae703` → `d8638191aaec` | RED | 1 | yes (G10d) |
| an unread record prices on the prior instead of going inert | APPLIED `4293dfcae703` → `b3df2ef08bbb` | RED | 4 | yes (G10b) |
| the two absences share one sentence | APPLIED `4293dfcae703` → `2ba2620baa10` | RED | 2 | yes (G10c) |
| the no-identity case is reported as read | APPLIED `4293dfcae703` → `52b4d8643911` | RED | 1 | yes (G10b) |
| a measured record is also inert, so nothing ever prices | APPLIED `4293dfcae703` → `a66364e65257` | RED | 5 | yes (G1c) |
| **CONTROL** — pattern not in the file | **NO-OP — pattern not found** | — | — | — |

5/5 caught by the test that names them; the control reported NO-OP. Source
restored clean after every row.

**The first row survived its first pass, and the survivor was the finding.**
Reverting the guard to the league-level flag still passed, because the other half
of the fix — making `declarationsRead` false when `credibility` is null — was
independently catching the no-identity league. The two changes each fixed the
case the tests covered, so mutating one left the other doing the job. The case
that separates them is the **mixed league**, and no test had one: every fixture
had all rosters confirmed or none. Rather than declare the mutant equivalent, G10d
builds the mixed league — league 21's roster 4 has no identity row while 1, 2 and
3 do — and asserts both halves: the unconfirmed manager does not price, **and the
confirmed manager in the same league still does**, so the guard is per-manager and
not a switch that turned the source off for everyone.

That second assertion is the one worth keeping. A guard that makes everything
inert passes every "must not price" test ever written.

### Is this well built? (the five questions)

**1. Stats or made up?** `1 - PRIOR_BLUFF_RATE = 0.65` is hand-set and always
was; what changes is that it is no longer allowed to *look* measured. Nothing is
fitted here.

**2. How do we know?** Five mutations, five caught, above, plus the direct read of
`bluff-detector.js:229-259` that established the fallback is reachable in all
three rows rather than assuming it from the call site.

**3. Structure.** One condition, reading the record instead of a flag about the
record. The league-level flag stays, but only to choose the sentence.

**4. Pointed anywhere else?** Yes: the same three-way absence applies to every
chat-sourced source in `VALUATION_SOURCES`, not only this one. `talk_vs_model`,
`chat_sentiment` and `profile_roster_read` all read a corpus that may be absent.
They degrade correctly today because their evidence is the `manager_player_view`
rows themselves, which either exist or do not — but that is a property of where
their evidence lives, not a guard, and it is worth stating so nobody moves one of
them onto a prior later.

**5. How does it unify?** It is the as-of rule with a different noun: **a value
must carry the stamp of the process that measured it** becomes **a price must
carry the record that justified it**, and an absent record is an absence that has
to say which absence it is. Chat sync found this because they read Part 7's fix
and asked what else could make the record missing — which is the useful form of
review, and better than the line number they quoted.
