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

---

# Part 3: three values that exist and cannot be accounted for

RED `892b8e7`, then GREEN. Same branch, on top of Part 2's `ff26c15`. Files:
`server/services/manager-archetypes.js`, `server/services/bluff-detector.js`,
`server/services/league-chat-sync.js`, test `test/wiring-absent-states.test.js`.

Three wiring-map findings in this thread's files. They are one finding in three
places: **a value that exists and nothing accounts for.**

## Finding 1 — `capital_hhi`, and "never scheduled"

`manager-archetypes.js:314` computes a Herfindahl concentration of draft capital
across skill positions, `buildManagerArchetypes` writes it into
`manager_archetypes` like any other metric, and `managerProfile` serves it
inside the manager card's `this_season.metrics`.

**It is not dead, and that is the finding.** `metricRepeatability()` (`:696`)
and `splitHalfReliability()` read *every* `source='draft'` metric generically,
and both are called only from `scripts/build-manager-archetypes.mjs:62`. So
`capital_hhi` appears in the run sheet's repeatability table and **nowhere a
person makes a decision**: not in `manager-signals.js`'s `ARCHETYPE_METRICS`,
not in `jevStateFor`'s summary, not in the client. A repo-wide grep returns one
match, its own definition.

Not removed. A metric should be dropped on evidence — a repeatability run
saying it does not hold year over year — not on nobody having wired it yet, and
the repeatability report needs candidates to test. What was missing was the
statement, so it is now `RUN_SHEET_ONLY_METRICS` and `RUN_SHEET_ONLY_REASON`,
with the reason including the thing that would have to change first: it is not
centred on its league-season, so it is not comparable across leagues and must
not be served until it is. The test fails if an entry has no reason, so the
next metric cannot quietly join it.

**"Two tables never scheduled" is answered, not fixed.** `WHY_UNSCHEDULED`
states it: the build replays every league-season, and the Jev pass calls a paid
gateway per manager, for inputs that change once a year on draft day. A timer
would spend on every tick to refresh a table whose inputs do not move. What was
actually wrong was that no served surface said how old the result was — which
is Part 1 of this file. The as-of block is the honest version of a timer: the
card tells you when to run it.

## Finding 2 — a silent empty that means the opposite thing

`bluff-detector.js`'s `declarationCredibility()` returned
`{ byManager: new Map(), events: [], available: false }` when `openChatDb()`
finds nothing.

On the deployed box it **always** finds nothing, and permanently:
`data/derived/league_chat.sqlite` is extracted from `~/Library/Messages/chat.db`
by `scripts/chat/extract_league_chat.py`, which needs a Mac and Full Disk
Access. Fly cannot produce it. So the empty result is not "no data yet", it is
"this machine cannot see the conversation" — and downstream, in
`counterparty-pricing.js:144`, an empty credibility map reads as *he has never
called a player untouchable*, which is the opposite conclusion and moves a
price.

`available: false` carried none of that: a boolean cannot say which of two
opposite things it means. There is now a `reason` naming the path and saying
the corpus is not producible here. Mutations C4, C5 and C6 are the three ways
that reason can rot: dropped, path-less, or no longer saying Mac-only.

## Finding 3 — the field that would have explained the state

`corpusStats()` assembled `path` and nothing read it, while `freshness()`'s
`absent` branch said only *"Every ladder is priced on our numbers only"* — no
path, no reason the file cannot be there.

Those are the same gap. `status()` now carries `path` at the **top level**, not
only inside `corpus`, because the case that needs it is the one where `corpus`
is `null`: with no file there is nothing else to say, and "we looked here" is
the whole answer. The absent note names the path and says the corpus comes off
the Mac. Before this, absent was the state that said least.

"Not on this machine" is the intended register, confirmed with the coordinator:
this is a normal permanent state on Fly, not a fault, and it must not read like
a broken sync — or someone goes looking for a server job that does not and
should not exist.

## RED, pasted verbatim

```
not ok 1 - every draft metric the build writes is either named by a consumer or declared run-sheet only
  error: 'the file has to state which of its metrics no served surface reads'
not ok 2 - the run-sheet-only list cannot rot: every entry says why, and none is secretly read
  error: 'archetypes.RUN_SHEET_ONLY_METRICS is not iterable'
not ok 3 - the archetype tables say why nothing schedules them, not just that nothing does
  error: '"never scheduled" is a finding until the reason is written down, then it is a decision'
not ok 4 - with no chat corpus the credibility read says it cannot see one, not that nobody spoke
  error: 'an empty result with no reason reads as "he has never called anyone untouchable"'
not ok 5 - the corpus status names where it looked, even when there is nothing there
not ok 6 - the absent note says the corpus is Mac-only, so nobody goes looking for a server job
```

## Mutation run

Baseline **6 pass, 0 fail**. Eight injections, eight applied, eight caught.

```
C1 the run-sheet-only declaration is emptied              APPLIED -> killed (2 tests)
C2 a metric is declared unread with no reason beside it   APPLIED -> killed
C3 the unscheduled reason stops naming the gateway        APPLIED -> killed
C4 the credibility read goes back to a silent empty       APPLIED -> killed
C5 the reason stops naming the path it looked at          APPLIED -> killed
C6 the reason stops saying the corpus is Mac-only         APPLIED -> killed
C7 status drops the path again                            APPLIED -> killed
C8 the absent note stops naming Apple Messages            APPLIED -> killed
```

C2 is the one worth naming: it adds a **real, served** metric
(`homer_top_team_share`) to the run-sheet-only list without a reason. A list
that can be padded with things that *are* read is worse than no list, and the
reason requirement is what stops it.

## The five questions

**Is this well built?** Nothing computed was thrown away and nothing new was
computed. Two declarations and two sentences, each one a thing a reader would
otherwise have to re-derive by grep, and each one pinned by a test that fails
when it rots.

**Is this based on stats, or made up?** No numbers change. `capital_hhi` is
still written and still tested for repeatability; the chat reads return exactly
what they returned, with a reason attached.

**How do we know?** Every claim is a citation: the generic read is
`manager-archetypes.js:698`, its only caller `build-manager-archetypes.mjs:62`,
the single grep match for `capital_hhi`, the extractor's Mac requirement in
`league-chat-sync.js`'s own header, and the downstream consumer at
`counterparty-pricing.js:144`. Six tests failed before and pass after; eight
mutations caught.

**Should this data point anywhere else?** `capital_hhi` should point at
`ARCHETYPE_METRICS` once it is centred on its league-season — that is the
condition, and it is written into the reason so the next person does not have
to guess. Uncentred, it would say an 8-team league's managers are all more
concentrated than a 12-team league's, which is about the league.

**How does it unify?** The same contract as the rest of this branch: a value
either says where it came from and when, or says plainly that it cannot. An
absent chat corpus, an unbuilt league-season and an unread metric now answer in
the same register — `reason` strings that name the thing and the path — instead
of three different silences.

## Known limits, Part 3

- **`RUN_SHEET_ONLY_METRICS` is a declaration, not a derivation.** Nothing
  proves the list is complete: a metric added tomorrow and read by nobody
  passes every test here. Deriving it would mean importing
  `manager-signals.js`'s `ARCHETYPE_METRICS` (not exported, not my file) and
  scanning the client, which is a bigger change than the finding warrants.
- **The client does not render any of the new reasons yet.** They are in the
  payloads; showing them is the UI thread's.
- **`counterparty-pricing.js:144` still treats an unavailable credibility map
  the same as an empty one.** The reason now exists for it to read; making it
  read it is Trade Brain's file.
- **No live measurement.** All fixtures, on a box with no corpus, which is the
  deployed shape but not the deployed box.

---

# Part 4: stale is not absent

RED `9e76ec8`, then GREEN. Same branch, on top of Part 3's `98a9deb`.
`server/services/manager-archetypes.js`, `test/archetype-as-of.test.js`.

Found by Trade Brain reading `ff26c15` — not by a test here, and not by me.

## The defect

`builtStamps` filters `version = MANAGER_ARCHETYPE_VERSION`. That filter is
right: a price should stand on the current build, not on whatever a superseded
one left behind. But it meant a league-season holding **only** rows from an
earlier version returned `rows: 0`, `as_of: null`, and the reason *"the build
has never covered it"*.

Stale data rendered identically to no data — the exact conflation this whole
pass exists to remove, reintroduced by the fix for it. And the two states lead
to opposite actions: *re-run the build*, versus *find out why this league has
no draft picks on file*.

## The fix

A third read, `version <> MANAGER_ARCHETYPE_VERSION` on the same key, giving a
count, a stamp and the distinct versions present. The block carries
`stale_version_rows`, and the reason branches:

```
no row for league 36 season 2026 at version manager-archetypes-v1, but 1 row
from manager-archetypes-v0 (last written 2026-08-02T04:10:00.000Z) — this is
stale, not missing; re-run the build
```

**Both versions are named.** "Which build wrote what is here" and "which build
is being asked for" are the two facts needed to decide whether re-running fixes
it; one without the other leaves a reader guessing how far behind the store is.
Mutation D3 is that rule.

`as_of` stays `null` and `rows` stays `0`. The old rows are reported, never
promoted: an `as_of` from a superseded build is a date for a number the current
build would not produce.

The coordinator's suggestion was a count **or** a distinct reason. Both are
here, because they answer different readers: the count is what a payload
consumer branches on, the sentence is what a person reads.

## Mutation run

Baseline **20 pass, 0 fail**. Nineteen injections, nineteen applied, nineteen
caught. Four new:

```
D1 the stale count is dropped, so old rows read as none again        APPLIED -> killed
D2 a stale league-season goes back to saying the build never covered it  APPLIED -> killed
D3 the stale reason names no version                                 APPLIED -> killed
D4 the stale query counts every version including the current one    APPLIED -> killed
```

A2, A5 and A10 needed retargeting again — the block's signature grew a
parameter and the reason became a branch. Each reported `NO-OP` first, which is
the only reason that was visible; a runner that silently skipped a
non-matching pattern would have reported nineteen clean injections while
running sixteen.

## The five questions

**Is this well built?** One extra indexed read on the same key, and a branch in
the sentence already being built. No new state, no new table.

**Is this based on stats, or made up?** Row counts and versions the table
already stores.

**How do we know?** Four tests, one per state: stale, never-built, current, and
the card carrying the count. Four mutations, each caught.

**Should this data point anywhere else?** Every other store in this app with a
`version` column has the same latent shape — a read filtered to the current
version reports an old one as nothing. `manager_archetypes` is the one in my
files; naming the pattern is what I can do about the rest.

**How does it unify?** It closes the loop on the branch's own contract. Absent,
stale, present-but-unpriceable and never-built are now four distinct answers in
one vocabulary, where before the first two shared a sentence.

## Known limits, Part 4

- **`GROUP_CONCAT(DISTINCT version)` has no defined order**, so with two or
  more superseded versions present the reason lists them in whatever order
  SQLite returns. Never seen in practice — there has only ever been one
  version — and not worth an ORDER BY subquery until there is.
- **A partially-migrated league-season is not called out.** Some current rows
  and some old ones reports `rows > 0` with the stale count beside it and no
  reason, because the current build did cover it. Whether that deserves its own
  sentence is a question for the first time it happens.

---

# Part 5: one clock for the chat data

RED `8782471`, then GREEN. Same branch, on top of Part 4's `f2f321b`. Files:
`server/services/league-chat-sync.js`, `scripts/chat/extract_league_chat.py`,
tests `test/chat-age.test.js` and `scripts/chat/test_extract_league_chat.py`.

Two rulings from the coordinator after the wording comparison in Part 3:
normalise chat's stamps at the producer, and settle which of three candidate
dates *is* the age of the chat data.

## The defect nobody had seen

`corpusStats()` read:

```js
out.newest_message = db.prepare('SELECT MAX(sent_at) AS m FROM messages').get()?.m ?? null;
```

**`messages` has no `sent_at` column.** It is `ts_utc`
(`extract_league_chat.py:84`). So the prepare threw on every corpus that has
ever existed, a bare `catch {}` swallowed it, and `newest_message` has always
been `null` — with a comment explaining the null as "an older corpus without
the column", which made the permanent failure look like a handled edge case.

That is the shape CLAUDE.md names: *no bare `catch {}` that swallows a fault*.
It also made the second ruling unanswerable, because the value the ruling names
as the age was the one value the code could never produce.

Fixed with the real column, and the catch now records
`newest_message_error` naming `ts_utc` rather than reporting silence. Mutations
E1 and E2.

## Ruling one: ISO 8601 UTC at the producer

Four producers on the chat side wrote SQLite's `YYYY-MM-DD HH:MM:SS`:

| Where | Was | Now |
|---|---|---|
| `apple_ts()` → `messages.ts_utc` | `strftime('%Y-%m-%d %H:%M:%S')` | `'%Y-%m-%dT%H:%M:%SZ'` |
| `extract_runs.ran_at` | the same, inline | `now_iso()` |
| `manager_chat_profile.computed_at` | `datetime('now')` | `strftime('%Y-%m-%dT%H:%M:%SZ','now')` |
| `manager_player_sentiment.computed_at` | `datetime('now')` | the same |

Everything else on the manager card — the transactions collector
(`collect-league-transactions.mjs:31`), the archetype build, the pull record —
is `new Date().toISOString()`. Two fields called `as_of` side by side that
cannot be compared is worse than one missing field.

**The hazard that makes this more than a format change.** The extractor is
incremental: it resumes from `MAX(msg_id)` and never re-reads a row it has. So
changing the writer alone would leave an existing corpus holding both formats —
and the two do not sort against each other, because `T` is `0x54` and a space is
`0x20`. Every ISO row would beat every legacy row in `MAX(ts_utc)` whatever its
date, so the "newest message" would be the newest *new-format* message.

Hence `normalise_stamps()`, run **before the watermark is read**, not after:
`MAX(msg_id)` is unaffected either way, but every later reader of `MAX(ts_utc)`
is wrong for as long as the two formats coexist. It is idempotent (guarded on
the missing `T` and a length of 19), covers all four columns, and tolerates the
two rollup tables not existing yet on a first pull. Mutations E8, E9, E10.

`league_hour()` now accepts both formats. `datetime.fromisoformat` only accepts
a trailing `Z` from **Python 3.11**, and the Mac that runs this script may be
older than the box these tests run on — so the test patches
`fromisoformat` to the pre-3.11 behaviour and asserts both formats still give
the same hour. Mutation E11. (Without that patch the test passes on this box
whatever the code does, which is how E11 survived its first run.)

## Ruling two: the age is the newest message

Three candidates, and the surfaces had picked different ones:

- the newest message in the corpus — **the age**;
- the rollup's `computed_at` — provenance;
- the last local pull's `finished_at` — provenance.

`freshness()` now computes staleness from the newest message and carries
`as_of` plus a `provenance` string. The consequence the ruling called out:
**an uploaded corpus is no longer `unknown`.** It has messages, so it has an
age; what it lacks is a local pull, which is provenance —
`"uploaded, not pulled here"`. Mutations E5 and E6.

`unknown` now means one thing only: messages exist and none of them can be
dated. That is the state the `sent_at` defect would have produced if it had
ever been visible.

## The client enum is unchanged

`LeagueChatPull.tsx` types `state` as a closed union and colours off it, so the
four upstream states are mapped onto it rather than widening it, and the
mapping is `STATE_MAPPING` rather than folklore living in the branches:

| Upstream state | Client state |
|---|---|
| no path configured | `absent` |
| file not on this machine | `absent` |
| present but no messages | `absent` |
| present but undatable | `unknown` |
| present and dated | `fresh` / `aging` / `stale`, by the age of the newest message |

Mutation E7.

## Mutation run, both languages

Baseline **JS 8 pass / 0 fail, Python 28 pass / 0 fail.** Eleven injections,
eleven applied, eleven caught.

```
E1  the newest-message query names sent_at again              killed (4 failing)
E2  the throw goes back into a bare catch with no reason      killed (1)
E3  stamps are served raw, so a legacy corpus reports non-ISO killed (2)
E4  the rollup stamp is dropped                               killed (2)
E5  an uploaded corpus goes back to being called unknown      killed (2)
E6  the age is taken from the rollup stamp                    killed (1)
E7  the state mapping is removed                              killed (1)
E8  message timestamps go back to SQLite format               killed (1)
E9  the normalise pass is skipped                             killed (1)
E10 normalise stops guarding, so a second run corrupts        killed (2)
E11 league_hour only accepts the legacy format again          killed (1)
```

**Three survived the first pass, and each was a different kind of hole.**

- **E2** — no fixture had a corpus whose timestamp column is genuinely
  unreadable, only one with no messages. Added: a `messages` table with rows
  and no `ts_utc`.
- **E9** — `normalise_stamps()` being *correct* is not the same as it being
  *called*. Every test hit it directly; none ran the extract path. Added an
  end-to-end run against a corpus seeded with a legacy row.
- **E11** — the compatibility claim could not fail on this box, because Python
  3.11 accepts the `Z`. Added the patched-`fromisoformat` test above.

The pattern across Parts 1–5 is now consistent enough to name: **a surviving
mutation is a question about which of three things is missing** — the code is
duplicated (A1), the fixture cannot tell two states apart (B2, B3, E2), or the
call site is untested while the function is (E9, and E11 as its environmental
cousin).

## The five questions

**Is this well built?** It deletes an always-broken query, replaces four ad-hoc
stamps with one format, and adds one idempotent migration that runs where it
cannot be skipped. The client contract is unchanged.

**Is this based on stats, or made up?** Timestamps the corpus already holds. The
one judgement — which of three dates is "the age" — was ruled on, and the other
two are still served, labelled as provenance rather than dropped.

**How do we know?** The missing column is `extract_league_chat.py:84` against
`league-chat-sync.js`'s old query. The sort hazard is the byte values of `T` and
space. The 3.11 boundary is tested by patching, not asserted. Seven tests failed
before, thirty-six pass after across two languages, eleven mutations caught.

**Should this data point anywhere else?** `isoStamp` is exported and is the
right thing for any other reader of a SQLite-stamped column. Nothing else in my
files has one; the first candidate elsewhere is whatever Trade Brain's final
`chatCorpusState` reads, which is the same rollup column and will now be ISO at
the source.

**How does it unify?** Every stamp on a manager card — transactions,
archetypes, Jev, chat — is now one format, and "how old is this" has one
answer per store instead of three for the chat one.

## Two existing tests asserted the rule this replaces

The full check came back **2 failing** on the first run, both in
`test/league-chat-sync.test.js`, and both were asserting the OLD contract:

```
not ok 884 - freshness degrades with age, and only a recent pull reads as up to date
  'unknown' !== 'fresh'
not ok 885 - a corpus that arrived by upload is marked as never pulled here, not as fresh
  The input did not match /Never pulled/i. Input: 'Chat data of unknown age'
```

Their fixture was `{ messages: 250 }` with a pull stamp and no
`newest_message`, because under the old rule the **pull stamp was the age**.
Test 885 asserted in its own title that an uploaded corpus is `unknown`, which
is precisely what the ruling overturns.

Rewritten to the new rule rather than the code bent back to pass them, and said
so in a comment above them with the date. CLAUDE.md's rule is *fix the
implementation, not the test, unless the test is wrong* — here the
specification changed by an explicit decision, which is the "unless". The
replacements are stronger than what they replace: one of them now asserts the
case that motivated the ruling, that pulling a week-old conversation five
minutes ago does not make the conversation recent. A third was added for the
only `unknown` left, messages with no readable date.

## Known limits, Part 5

- **`freshness()` is not yet wired to Trade Brain's `chatCorpusState`**, as
  instructed: their final block shape is not landed. The four-state split is
  mapped and declared here, but `freshness` still derives its own absence
  branch. That wiring is the next step and is one call.
- **`normalise_stamps` fixes a corpus only when the extractor next runs**, which
  is on the Mac. A corpus uploaded to Fly before the next pull keeps its legacy
  stamps — which is exactly why `isoStamp` normalises on the way out too. Both
  layers are load-bearing; neither alone is enough.
- **The length-19 guard means a stamp with fractional seconds is left alone.**
  No producer writes one today. If one appears, it is skipped silently rather
  than corrupted, which is the safer failure but is still a silence.
- **No live measurement.** Fixtures only; the real corpus is on the Mac and this
  box cannot have one.

---

## Part 6 — freshness() reads the corpus block, and the rollup lag stops hiding inside the age

**The five questions.**

- **Well built?** It is the consumer half of a contract that had already landed
  on another thread's branch. The contract was read out of the source, not out
  of the commit message describing it.
- **Stats or made up?** Every date in the badge comes out of the argument. The
  suite runs with no corpus file on disk and `GRIDIRON_CHAT_DB_PATH` pointed at
  a path that is never created, so a `freshness()` that resolved anything for
  itself has nothing to find.
- **How do we know?** Nine tests failing before, ten passing after, plus one
  that drives the real producer over a real file; ten mutations injected, ten
  caught, every injection printing `APPLIED` with its site count.
- **Pointed anywhere else?** The same block feeds the chat half of the manager
  card and the Trade Brain's counterparty read.
- **How does it unify?** One query per fact, one clock for the chat data, one
  sentence per state — and the state that had no sentence now has one.

### The hash was wrong, and the block was read instead

The brief named `ef3164e` as the commit carrying the landed block. That commit
is "cut sixteen dead route handlers from trades.js, services untouched".
`git log --all -S"path_source" -- server/services/manager-signals.js` gives the
real one: **`34250dc`**, on `origin/claude/project-thread-3xqh5l-accessor-hold`.
The shape was then taken from the source of `chatCorpusState()` rather than from
the description of it, which is what turned up the next two findings.

### What the block's `as_of` actually is

`chatCorpusState().as_of` is `MAX(last_msg)` over `manager_chat_profile`. That
table is rebuilt by `rollup()` in `scripts/chat/extract_league_chat.py`, and two
things follow that the field name does not say:

1. `rollup()` runs **only under `--rollup`** (`extract_league_chat.py:369`). It
   is not part of an extract.
2. Its `base` CTE keeps only rows with `m.name IS NOT NULL` and non-empty text
   after stripping the object-replacement character.

So `as_of` is *the newest message the rollup has seen*, which lags the corpus by
however long since the rollup last ran. Serving it as the age — the obvious
reading of "wire freshness() to the block" — would have made a three-day-old
rollup over a corpus someone texted in an hour ago read as a dead league. That
is the same two-states-one-sentence defect Parts 1–5 exist to remove, arriving
by a new route.

The resolution keeps both facts and conflates neither. The age stays the newest
message (the 07:15Z ruling, unchanged). The block's `as_of` becomes what the age
is measured *against*, and the gap is its own field:

```
rollup: 'current' | 'behind' | 'unknown' | 'missing'
```

`missing` is the state that was collapsing wrongly. `rows: 0` on the block means
no manager profiles — which is not "no chat data": the messages are there and
dated, and the fix is one flag on a script, not a trip to the Mac for a fresh
pull. It had been reported as `absent`.

### Three states that the consumer must not re-word

`chatCorpusState()` already writes the sentence for each absence, and the
sentences are not interchangeable:

| Block state | Why a generic sentence is wrong |
|---|---|
| no file, `path_source: 'GRIDIRON_CHAT_DB_PATH'` | a typo in an env var; the fix is the variable |
| no file, `path_source: 'default'` | a machine with genuinely no corpus; the fix is a pull and an upload |
| file present, `rows: 0` | the rollup has not run; the fix is `--rollup` |

So the block's `reason` is carried word for word and `path_source` is named. The
test that pins this passes a block whose `path` is `/typo/league_chat.sqlite`
while the environment points somewhere else entirely, and asserts both that the
typo path appears and that the environment path does not.

`no_path_configured` came out of `STATE_MAPPING`. `chatDbPath()` always returns
a string, so it was a row claiming to map a state nothing could reach — the same
category of dead branch `34250dc` removed on its own side.

### One name for the rollup stamp

`corpusStats()` called it `rolled_up_at`; the block calls it `computed_at`. Two
names for one field is the thing this branch keeps deleting, so `corpusStats()`
now emits the block's shape outright — `as_of`, `computed_at`, `rows`, `path`,
`path_source`, `collected_by`, `reason` — and `freshness()` takes that shape from
either producer. When `chatCorpusState()` lands on this branch's base, one of the
two producers is deleted and nothing downstream changes.

### Mutations

Ten injected, ten caught. Each run printed `APPLIED` with the number of matching
sites before the suite ran; a run that printed `PATTERN MISSED` would have been a
mutation that never executed, which is the failure mode Part 3 was bitten by.

| # | Injection | Caught by |
|---|---|---|
| M1 | age taken from `as_of` before `newest_message` | rollup-behind, ISO, producer end-to-end |
| M2 | lag comparison reversed | rollup-behind, rollup-levels, end-to-end |
| M3 | `state.path` dropped for `chatDbPath()` | the decoy-path test |
| M4 | the block's `reason` not carried | the typo-path test |
| M5 | `path_source` never read | the typo-path test |
| M6 | "is there data" keyed on `rows` instead of messages | absent, undatable, empty-corpus |
| M7 | `MIN(last_msg)` for `MAX` | producer end-to-end |
| M8 | `collected_by` dropped at the producer | producer end-to-end |
| M9 | `rollup: 'missing'` unreachable | rollup-levels, not-rolled-up |
| M10 | block stamps served without `isoStamp` | the legacy-stamp test |

M7 and M8 are the pair worth keeping. Every other test here hands `freshness()`
a literal, which is the right way to test a pure consumer and the wrong way to
leave it: nothing was running the query that fills the block in, and both
injections would have passed a suite of nine. The fixture that closes them puts
**two** profile rows with different `last_msg` values on disk, so `MIN` and `MAX`
cannot agree by accident on a one-row table.

### One test was rewritten rather than satisfied

The first draft of the rollup-behind test asserted `/rollup/i` against the note.
The implementation's sentence is *"The profiles were last built over messages up
to 2026-09-17T07:46:26Z, so anything said since then is in the corpus but not yet
in the counterparty read"* — which says the thing in plainer English than the
word "rollup" does, and failed. That is a test asserting its own vocabulary, the
same defect `34250dc` reported three of. It now asserts the cutoff stamp: the
fact a reader needs in order to act, rather than a word.
