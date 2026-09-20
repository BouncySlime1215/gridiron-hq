# TDD evidence: the manager card says when its archetype evidence was built

**Branch** `claude/project-thread-sytruo-asof-hold`, off `claude/project-thread-sytruo-lst`
(PR #47's head). RED `4523064`, then GREEN. Files:
`server/services/manager-archetypes.js`, `test/archetype-as-of.test.js`.

This is the same fix Trade Brain shipped on the signals payload
(`docs/tdd/transactions-as-of.tdd.md`, `21b449a`), applied to the other half of
the same manager card.

## One correction to the brief before the defect

The work came to me as "`manager-archetypes.js` reads `league_transactions_raw`".
It does not. `grep -rn league_transactions_raw server/services/manager-archetypes.js`
returns one line, `:20`, and it is prose in the file header explaining why
transaction-derived metrics are **deliberately absent**:

> WHAT IS DELIBERATELY NOT HERE. Lineup-set timing, waiver reaction latency,
> counter-offer behaviour and proposal response time. ESPN serves roughly three
> days of transactions, so that history is not retrievable; forward capture into
> `league_transactions_raw` started 2026-09-17.

So the transactions table is already covered by `21b449a` and has no second
consumer here. The same defect is real in this file, with different inputs, and
that is what this change fixes.

## The defect

`archetypesFor(leagueId, season)` is served at `server/routes/trades.js:501-502`
as the `archetype` block on every manager card. Each card carried `owner`,
`member_id`, `career`, `this_season` and `jev` — **and no date of any kind.**

Traced on this tree, not taken on report:

- `manager_archetypes` and `manager_archetype_jev` are written by
  `buildManagerArchetypes()` (`:517`) and `storeJevAnswers()` (`:1024`).
- Both are called from exactly one place: `scripts/build-manager-archetypes.mjs`
  (`:60`, `:180`). `grep -rn "buildManagerArchetypes\|storeJevAnswers"` over
  `server/` matches only the definitions. No route, no scheduler job, no refresh
  tick calls either.
- `manager_archetypes` **has** a `computed_at` column (`:84`) and
  `managerProfile()` (`:800`) never selected it.

So a card reading "auto-draft rate 0.25, 16 picks" is an assertion about
evidence that was last produced whenever a person last ran a script, and the
payload said nothing about when.

## Three provenances, not one date

The one thing worth more than the stamp itself is that a single date would have
been wrong for two thirds of the card:

| Half of the card | Table and key | Written by |
|---|---|---|
| `this_season` | `manager_archetypes` (member, league, season) | `buildManagerArchetypes` |
| `career` | the same table, keyed **(member, 0, 0)** | the same build, but only for members it found draft picks for |
| `jev` | `manager_archetype_jev`, own `evaluated_at` column | `storeJevAnswers`, a **separate pass** after a gateway call |

`CAREER_LEAGUE = 0` / `CAREER_SEASON = 0` (`:68-69`) means the career roll-up on
a card is not keyed by the league-season the card is in. A build that covers
2026 for league 31 and a build that produced that member's career rows can be
different runs, so `career_as_of` is read separately. And the Jev answers are
written by a different pass entirely, so dating them by the archetype build
would report a stamp that pass never wrote.

**`jev_as_of` is per member, not league-wide.** A league-wide `MAX(evaluated_at)`
would hand a manager with no stored answers the date of somebody else's.
Mutation A8 is that rule.

## Why the table's own stamps and not `sync_log`

The rule carried over from `21b449a`, and it bites here for its own reason:
`buildManagerArchetypes` takes its league-seasons from
`SELECT DISTINCT league_id, season FROM league_draft_picks` (`:526`). A league
with no draft picks on file is not in that list and is skipped **silently** —
the job succeeds, `sync_log` moves, and this league-season's rows stay exactly
as old as they were. `MAX(computed_at)` for this league-season is the only value
that means "the build reached this league-season".

**There is no `table_missing` reason.** Unlike `league_transactions_raw`, this
module runs `CREATE TABLE IF NOT EXISTS` on both tables at import (`:78`,
`:86`), so the table cannot be absent anywhere this function can be called.
Writing that branch would have been a reason that can never fire.

**MAX and not MIN.** Every row of one build shares a single `now` (`:550`), so on
a clean database MIN and MAX are equal — but the build `DELETE`s only its own
version, so rows survive from earlier runs of that version. The card is
answering when the evidence was last refreshed.

## RED is a real commit

`4523064`, seven failing tests, output pasted verbatim:

```
not ok 1 - every served manager card says when its archetype evidence was built
  error: 'roster 1 served an archetype with no build stamp'
  expected: true
not ok 2 - the block names what writes the table, and says the server does not
  error: "Cannot read properties of undefined (reading 'built_by')"
not ok 3 - the career roll-up is stamped apart from this season, because it is a different key
  error: "Cannot read properties of undefined (reading 'career_as_of')"
not ok 4 - a league-season the build never covered says so, and borrows no stamp
  error: "Cannot read properties of undefined (reading 'as_of')"
not ok 5 - the Jev answers carry their own evaluation date, not the archetype build stamp
  error: "Cannot read properties of undefined (reading 'jev_answers')"
not ok 6 - a manager with no Jev answers reports none, not the other manager's date
  error: "Cannot read properties of undefined (reading 'jev_answers')"
not ok 7 - a full league-season is clean: no gap reported when both halves are there
  error: 'archetypesBuilt is not a function'
```

## Mutation run, pasted verbatim

```
BASELINE (no mutation): 9 pass, 0 fail
A1  as_of reads the OLDEST build stamp instead of the newest
    APPLIED -> killed by: every served manager card says when its archetype evidence was built; the career roll-up is stamped apart from this season, because it is a different key; the direct read answers with the same stamps the card does
A2  the built block is omitted from the card entirely
    APPLIED -> killed by: every served manager card says when its archetype evidence was built; the block names what writes the table, and says the server does not; the career roll-up is stamped apart from this season, because it is a different key; a league-season the build never covered says so, and borrows no stamp; the Jev answers carry their own evaluation date, not the archetype build stamp; a manager with no Jev answers reports none, not the other manager's date; the direct read answers with the same stamps the card does
A3  the career half is dated by this league-season's build
    APPLIED -> killed by: the career roll-up is stamped apart from this season, because it is a different key; a league-season the build never covered says so, and borrows no stamp; the direct read answers with the same stamps the card does
A4  an uncovered league-season borrows the career stamp rather than saying nothing
    APPLIED -> killed by: a league-season the build never covered says so, and borrows no stamp
A5  the empty league-season reports no reason
    APPLIED -> killed by: a league-season the build never covered says so, and borrows no stamp
A6  the row count is every league-season's rows, not this one's
    APPLIED -> killed by: every served manager card says when its archetype evidence was built; a league-season the build never covered says so, and borrows no stamp; a full league-season is clean: no gap reported when both halves are there
A7  the Jev answers are dated by the archetype build instead of evaluated_at
    APPLIED -> killed by: the Jev answers carry their own evaluation date, not the archetype build stamp; a manager with no Jev answers reports none, not the other manager's date; the direct read answers with the same stamps the card does
A8  the Jev stamp is league-wide, so a manager with no answers gets someone else's date
    APPLIED -> killed by: a manager with no Jev answers reports none, not the other manager's date
A9  the block no longer names what writes the tables
    APPLIED -> killed by: the block names what writes the table, and says the server does not
A10 archetypesFor gets its own copy of the stamp query again, so the two entry points can drift
    APPLIED -> killed by: every served manager card says when its archetype evidence was built; the career roll-up is stamped apart from this season, because it is a different key; the direct read answers with the same stamps the card does
```

Ten injections, ten applied, ten caught. Every injection prints APPLIED or
NO-OP, so a pattern that silently failed to match cannot be read as a pass.

## What the mutation run found that the tests did not

**A1 survived the first pass**, and it is the one that mattered. Injecting `MIN`
for `MAX` changed nothing any test could see, because `archetypesBuilt` and
`archetypesFor` each held their **own copy** of the same two queries: a string
replace hit the first, every stamp assertion ran through the second, and the
answer stayed right. Two things were wrong, and both are fixed:

1. The duplication itself. `builtStamps()` is now the one place those two reads
   are written — the same rule `builtBlock()` already applied to the shape, one
   level up. A10 is the regression test for the dedupe.
2. **`archetypesBuilt`'s own `as_of` was asserted by nothing.** Every check went
   through the card. Two tests were added: one asserting the direct read's three
   stamps and `deepEqual` against the card's block, and one asserting that
   calling it without a member leaves the Jev fields **off** rather than
   answering `null`, which would read as "no answers stored".

A second fixture defect, found while the first test was still red: the test
first asserted a **per-member** row count (2 and 1). The block is league-season
scoped, so the right number is 3 for both cards. That was the test being wrong,
not the code — fixed in the test, with league 32's `rows: 0` left as the
discriminator that a count borrowed from every league would fail.

## The five questions

**Is this well built?** It is the smallest shape that does not lie: three reads,
one frozen object, no new table, no new dependency, and the two entry points
share one query and one formatter so they cannot answer differently. Ten
mutations, ten caught.

**Is this based on stats, or made up?** Neither — it reports stamps the tables
already wrote (`manager_archetypes.computed_at`,
`manager_archetype_jev.evaluated_at`). Nothing here is estimated, and where a
value is unknown the field is `null` with a reason rather than a plausible date.

**How do we know?** The writer trace is `grep` over `server/`, cited above with
line numbers; the three-provenance claim is the table keys at `:68-69` and the
DDL at `:78`/`:86`; the silent-skip claim is `:526`. Seven tests failed before
the fix and nine pass after, and every rule is shown failing under an injection.

**Should this data point anywhere else on the platform?** Two places, neither
taken here:
- `managerProfile(memberId)` (`:800`) is the same store read career-wide, and
  `scripts/build-manager-archetypes.mjs` consumes it. It has no stamp either.
  Its callers are scripts, not served surfaces, so it is not the same urgency.
- `counterparty-pricing.js:452-457` turns the `outcome` half of this store into
  `luck_self_view`, **a term in the trade price**. A price carrying a stale luck
  read is a worse failure than a stale card, and that layer still says nothing
  about age. That belongs to Trade Brain's files, not mine, and is raised rather
  than reached into.

**How does it unify?** By being the same block, in the same words, as
`transactionsCollected` on the signals payload: `as_of`, a row count, the writer
named, `null` with a reason instead of a borrowed stamp, and the table's own
stamps per league rather than a job-level one. A manager card now carries the
age of both halves of its evidence — the transactions under the signals and the
build under the archetypes — in one vocabulary. The third half, the ESPN league
history those archetypes are keyed to, got its scheduled writer in PR #47, so
`league_season_teams` is no longer the hand-run input it was when this card was
first drawn.

## Known limits

- **Nothing here makes the build run.** The card will now say how old its
  evidence is; it does not make it fresher. `buildManagerArchetypes` is still
  invoked only from a script a person runs, and putting it on the scheduler is
  a separate change with its own cost (it replays every league-season and calls
  a gateway for the Jev pass).
- **The client does not render the block yet.** It is in the payload; making it
  visible on the manager card is the UI thread's file, not this one.
- **`career_as_of` is league-agnostic by construction.** It is `MAX` over all
  career rows, not that member's own. A build that wrote career rows for some
  members and not others would report the newest. The fix for that is a
  per-member career stamp, which the current key supports but no test demands
  yet; it is named here rather than guessed at.
- **No live-database measurement.** Every number above is from the fixture in
  `test/archetype-as-of.test.js`. The app was not deployed or touched (GitHub
  freeze, 2026-09-20).

---

# Part 2: one accessor, not two — the priced stamp

RED `c8fba79`, then GREEN. Same branch, on top of the Part 1 GREEN `6ceb5c7`.

## One correction to this brief too

The work came as "Trade Brain's `archetypesBuilt` in `counterparty-pricing.js`
duplicates yours". There is no `archetypesBuilt` in that file. Searching the
identifier across **every** remote branch returns exactly one file —
`server/services/manager-archetypes.js` on this branch — so the duplication as
described did not exist.

A real one does, in a different file, and it is worth more than the one
reported.

## The second accessor, and the defect in it

`manager-signals.js:271`, `archetypeIndex(leagueId, season)`, already derives an
`asOf` from `manager_archetypes` for the same league-season and serves it at
`:425` as `archetypes_as_of`. Its loop:

```js
for (const r of rows(`SELECT member_id, metric, value, n, source, computed_at FROM manager_archetypes
                      WHERE league_id = ? AND season = ? AND source IN ('draft', 'outcome')`, leagueId, season)) {
  const name = ARCHETYPE_METRICS[r.source]?.[r.metric];
  if (!name || !Number.isFinite(r.value)) continue;
  …
  if (!asOf || r.computed_at > asOf) asOf = r.computed_at;
}
```

The `asOf` update is **inside** the loop, **after** the `continue`. So the date
served is "the newest stamp among the metrics this module happens to map", not
"when the build reached this league-season". Two consequences, neither
obvious from the call site:

- Editing `ARCHETYPE_METRICS` — adding a metric, renaming one, dropping one —
  silently changes the date the API reports for data that did not change.
- A build that wrote only unmapped metrics for a league-season reports the
  **previous** build's date, or `null`, for a league-season that was in fact
  just rebuilt.

## The decision, and where it deliberately does not match

`archetypesBuilt` now also returns `priced_as_of` / `priced_rows`: the same
league-season, restricted to `PRICED_SOURCES = ['draft', 'outcome']` and **no
metric allowlist**. `manager-signals.js` can switch to it without a second
query over the same table.

**A strict `deepEqual` against `archetypeIndex`'s value cannot hold, and should
not.** On a league-season whose newest priced row is an unmapped metric, the
two differ — and that is precisely the case where the old one was wrong. The
tests assert agreement on an ordinary fixture (league 31) and a deliberate
divergence on the fixture built to expose it (league 33), rather than pinning
the bug in place. This was put to the coordinator before it was built.

`career` stays out of the priced set: those rows are keyed (member, 0, 0) and
travel across leagues, so including them would date a league-season by evidence
from another one. Mutation B1 is that rule.

## RED, pasted verbatim

```
not ok 10 - the priced stamp is the draft and outcome rows only, not every source
  expected: '2026-09-17T04:10:00.000Z'
not ok 11 - on an ordinary league-season the two readings agree
  expected: '2026-09-18T04:10:00.000Z'
not ok 12 - the priced stamp does not depend on a consumer's metric allowlist
  expected: 2
not ok 13 - a league-season with no priced rows says so rather than borrowing the unrestricted stamp
  expected: ~
not ok 14 - the card carries the priced stamp too, so one payload answers both questions
  expected: '2026-09-17T04:10:00.000Z'
```

## Mutation run, fifteen injections

Baseline **16 pass, 0 fail**. A1–A10 from Part 1 re-run unchanged (two needed
retargeting after the signature grew a parameter — both were reported `NO-OP`
first, which is why every injection prints its state). Five new:

```
B1  the priced stamp includes career rows, so another league dates this one
    APPLIED -> killed
B2  an empty priced set borrows the unrestricted stamp
    APPLIED -> killed
B3  the priced stamp drops the outcome source
    APPLIED -> killed
B4  the priced read is not scoped to this league-season
    APPLIED -> killed
B5  a league-season with rows but nothing priceable reports no reason
    APPLIED -> killed
```

Fifteen applied, fifteen caught.

## What the mutation run found, again

**B2 and B3 both survived the first pass, and both were fixture holes.**

- **B3** — dropping `'outcome'` from `PRICED_SOURCES` changed nothing, because
  no fixture had an outcome-source row at all. The whole second half of the
  constant was unexercised.
- **B2** — making an empty priced set fall back to the unrestricted stamp
  changed nothing, because the only "no priced rows" fixture (league 32) had no
  rows of *any* source, so the fallback was `null` either way. "Never built" was
  standing in for "built, nothing priceable", which are different answers.

Two fixtures were added rather than one, because the two rules cannot share
one: league 33 needs its newest priced row to be the **unmapped draft** metric
(the allowlist test), and B3 needs its newest priced row to be the **outcome**
row. League 34 carries the second; league 35 is rows-with-nothing-priceable,
and its own `reason` clause got mutation B5.

Same lesson as A1 in Part 1, from the other direction: A1 survived because the
*code* was duplicated; B2 and B3 survived because the *fixture* could not tell
two states apart. A mutation that survives is a question about which, and it is
worth answering before adding an assertion.

## The five questions

**Is this well built?** It removes a query rather than adding one: the consumer
switching to it drops its own scan of the same table. One constant, one added
clause in one already-shared helper, and the block's shape is unchanged for
existing readers.

**Is this based on stats, or made up?** Stamps the table wrote. Nothing
estimated. The one judgement is which sources count as priceable, and that is
declared in `PRICED_SOURCES` with its reasoning, not buried in a query.

**How do we know?** `archetypeIndex`'s defect is the four lines quoted above,
at `manager-signals.js:271-283`. The claim that no other `archetypesBuilt`
exists is a search of every remote branch. Five tests failed before, sixteen
pass after, fifteen mutations all caught.

**Should this data point anywhere else?** The switch itself is
`manager-signals.js`, which is not my file — the accessor is built so that
change is a deletion plus a call. Beyond it, `counterparty-pricing.js:452-457`
still prices `luck_self_view` off the `outcome` half of this store with no age
at all, and `priced_as_of` is exactly the value that read needs. Also Trade
Brain's file; raised, not reached into.

**How does it unify?** Three readers of one store's freshness become one
function with one vocabulary: `as_of`, `career_as_of`, `priced_as_of`,
`jev_as_of`, each with its own row count, `null` with a reason instead of a
borrowed stamp, and the table's own stamps rather than a job-level one — the
same contract `transactionsCollected` uses for the transactions on the same
manager card.

## Known limits, Part 2

- **Nothing switches yet.** `manager-signals.js:271` still has its own loop;
  this only makes the switch a deletion. Until it happens the served
  `archetypes_as_of` keeps the allowlist behaviour.
- **`priced_rows` counts rows, not managers.** A league-season where one
  manager has every priced metric and eleven have none reports a healthy count.
  The per-member breakdown the card would need for that is not here.
- **`PRICED_SOURCES` is a second place the source vocabulary is written**, the
  first being the `source TEXT NOT NULL -- draft | outcome | career` comment on
  the DDL. A fourth source added to the build would need a decision here, and
  nothing forces that decision to be made.
