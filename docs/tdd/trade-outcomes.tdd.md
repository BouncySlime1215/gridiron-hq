# The trade outcome ledger

**No real row exists until the ESPN cookie is set and the collector runs; every
row here is a fixture.**

That sentence is the first thing in this file because it is the thing most
easily lost. `league_transactions_raw` has no migration — it is created by hand
in `scripts/collect-league-transactions.mjs:21-27`, which needs an ESPN cookie —
and that script has never run on this machine. So the ledger has a schema, four
writers, a reader and twenty-five tests, and it has zero observed rows. Nothing
below invents one, and `settleObservedOutcomes` returns
`state: 'raw_table_absent'` rather than an empty result, so the difference
between *the collector has never run* and *this league has no trades* survives
all the way to the caller.

Phase 0 item 4. Branch `claude/project-thread-3xqh5l-outcome-ledger`, cut from
`origin/main` `654ff93`.

**Landing record (work-queue F-05, 2026-09-22):** see
`docs/tdd/2026-09-22-trade-outcomes-landing.tdd.md`. Two things below stopped
being true there. The slate tests in §5 used shapes no producer emits, so the
real route would have recorded every sent idea as `considered_only`. That was
fixed at RED `88ed3722` / GREEN `031e4931`. And on Node 25 the sweep in §7
scored every row SURVIVED until its reporter was pinned (`b11b74c7`).

## The five questions

- **Is it well built?** It stores what was already being computed and thrown
  away. `counterparty-pricing.js:815-844` and `manager-signals.js:190-197` each
  re-derive accept/decline from the raw rows on every page load, and neither is
  joined to anything this app proposed. Both are untouched here and still green;
  this is the same reading pointed at a store, so an outcome gains a stamp and a
  join key.
- **Is it based on stats, or made up?** The observed rows are ESPN's own
  transaction records. The predictions are the acceptance model's, recorded as
  the model states them — a band with a basis, `fitted: false` — and §3 is about
  the one place the brief would have had me record a precision the model
  refuses to claim.
- **How do we know?** RED before GREEN — `92f31b7d` "test: RED — the trade
  outcome ledger, before it exists", then `e363b35c` "feat: GREEN — the trade
  outcome ledger, 17 of 17" — plus the contract asserted against the table's own
  CHECK constraints rather than against the writer. Both re-measured on this
  branch's rebase onto `ea69d9f3`; §7 carries what RED actually printed. The absence path is tested first,
  because it is the only path this machine can actually take today.
- **Should this data point anywhere else?** Yes, and deliberately not yet.
  Nothing reads the ledger: no page, no route, no model. It is a recorder, and a
  recorder with one week of rows answers nothing. The consumer worth building is
  the calibration read — `model_p_accept` against `status`, grouped by
  `model_basis` — and it is a follow-on named in §6, not a claim made here. I am
  not reporting a consumer this branch does not have.
- **How does it unify?** One rule, the same one this thread has been applying
  all night: **a value carries the stamp and the shape of the process that
  MEASURED it.** Its corollaries do the work here. *An absence must say which
  absence it is* — `raw_table_absent` vs no trades. *A number that was never
  measured must not arrive looking like a measurement* — §4, where a min_n
  sentence claimed a sample that was never taken. And the new one this piece
  adds: **a store of decisions must record the decisions NOT taken, or it is a
  store of the filter and not of the decider.**

## 1. What was missing, exactly

| | |
|---|---|
| Stored trade outcome | none. No table, on any branch. |
| Accept/decline today | recomputed at read time, twice, in two files, per page load |
| Joined to an app proposal | never |
| `trade_proposal_cache` (060) | `cache_key, league_id, payload, created_at` — a cache, not a ledger |

So neither question a P(accept) model has to answer could be asked: *when it said
70%, was he*, and *what did it consider and not send*.

## 2. Two corrections to the brief, both verified before a line was written

Both would have shipped a settle function that writes zero rows forever, and
both were found by reading the producer rather than the brief.

**The transaction type is `TRADE_PROPOSAL`, not `TRADE_PROPOSE`.** Read at
`counterparty-pricing.js:825` and `manager-signals.js:190`. Answers are
`TRADE_ACCEPT` / `TRADE_DECLINE`, both gated on `execution_type = 'EXECUTE'`,
linked to their proposal by `related_tx_id`. `TRADE_VETO` also exists and is not
an answer.

**Idempotency cannot key on `espn_tx_id` alone.** `league_transactions_raw`'s
primary key is `(league_id, season, tx_id)`, so a `tx_id` is not unique. Keyed on
the id alone, the first id shared between two leagues merges two different deals
— and the merge looks like successful de-duplication, which is why it would not
have been noticed. The unique index is on all three columns, and PARTIAL, because
`app_proposed` and `considered_only` rows legitimately have no ESPN id and a
plain UNIQUE would cap them at one row per table.

Also: the migrations are in `server/migrations/`, and `main` tops out at two
`062`s, so `067` was free as briefed.

## 3. The model states a band. The ledger must not record a point.

The brief specifies `model_p_accept REAL`. But `acceptanceBand`
(`trade-acceptance.js:277`) returns `{ band: {low, mid, high}, basis, ... }`,
sets `fitted: false` on every path, and its own served sentence says the number
is **"not a calibrated probability"**. `trade-engine.js:1921` attaches it to each
deal as `d.acceptance`.

A bare midpoint would therefore put in the ledger a precision the model
explicitly refuses to claim — and worse, a year later nobody could tell a wide
declared starting point from a narrow anchored one. Those are different evidence,
and pooling them into one curve is how a model ends up graded against its own
guesses.

The midpoint stays, because a calibration needs a point to score. It now travels
with what the model actually said:

| column | what it carries |
|---|---|
| `model_p_accept` | the midpoint, the point prediction to score |
| `model_p_accept_low` / `_high` | the width the evidence bought |
| `model_basis` | `no_information`, `heuristic_unanchored`, `heuristic_anchored` — the three the module emits, and no others |

Enforced in SQL: low and high are both present or both absent; `low <= mid <=
high`; a midpoint requires a basis. The writer takes the band object the engine
already attaches, and refuses a bare midpoint with a sentence saying why.

`067` was amended rather than superseded by a `068`. It has never been applied
outside a test database; the never-rename rule is about APPLIED migrations.

## 4. The half the audit did not find

Another thread flagged `trade-tactics.js` as silently broken: two
`catch { tx = []; }` blocks around the `league_transactions_raw` reads, falling
through to `blank()` and returning `decisions_n: 0` with a null reason. A claim
that we looked at this person and he has never decided anything, manufactured out
of a missing table.

Fixing `blank()` was not enough, and **my own test is what found that.** Thirty
lines later the min_n branch unconditionally overwrote the field:

```
entry.decisions_reason = `rests on ${lat.length} of the ${MIN_D} decided offers needed `
  + 'before a response time means anything'
```

On a machine with no collector run that sentence re-manufactures the identical
false claim, one loop after the guard removed it. Both min_n sentences are now
gated on the store having actually been read.

**The general form, and the reason this is in an evidence file rather than a
commit message: a guard at the read is not enough when a later line writes a
sentence that presumes the read happened.** A min_n sentence is only honest about
a sample that was taken.

The two tests for this had to DROP the table to reach it. The thirty-two that
were already there all ran with it present, so none of them could have caught any
of this — which is the more useful statement than "coverage was thirty-two". The
second test renames a column and asserts the fault **throws** rather than
arriving as an empty history: that is the half a `tableExists` guard alone does
not buy, and the reason removing a bare catch is not the same thing as guarding.

## 5. The gates, and where each is tested

All in `test/trade-outcomes.test.js` unless named otherwise.

| | gate | how it is shown |
|---|---|---|
| G1 | settle turns raw rows into observed rows, idempotently | a second run writes 0 and `deepEqual`s the rows it already wrote |
| G2 | an answer attaches to the proposal it answers; silence is not a decline | an unanswered offer stays `proposed` with `resolved_at` null; an orphan answer is skipped with its reason |
| G3 | an app proposal records the model's number AT THAT MOMENT | the band and basis are asserted off the stored row; a bare midpoint, a missing basis, and a midpoint outside its own band are each refused |
| G4 | what was considered and not sent is recorded with its reason | the verifier's words where it gave them, an honest sentence where it did not, and the low prediction kept because the low number IS the datum |
| G5 | synthetic never pools with real | separate table; `label` CHECK; the real table has no `sim_run_id` (asserted from `PRAGMA table_info`, not from the migration text); no JOIN between them |
| G6 | absence is a state | `raw_table_absent` with a reason naming the table and the script — tested FIRST, because it is the only path this machine can take |
| G7 | nothing is invented | a proposal with no readable counterparty is skipped with its reason, not written with a guess |
| — | a cache hit records nothing | `source: 'cache'` returns `no_decision_made`; the row count does not move |
| — | the same idea may be proposed in one slate and dropped in another | both rows exist; the unique index includes `source` for exactly this |
| — | the absence reaches the surface in `trade-tactics.js` | `test/trade-tactics.test.js` G5b, two tests, table dropped and column renamed |

## 6. What is NOT here

- **No consumer.** Nothing reads the ledger. The calibration read —
  `model_p_accept` against `status`, grouped by `model_basis`, with the
  `considered_only` rows as the control group — is the next piece and is not
  claimed as done.
- **No real row.** See the first line of this file.
- **No change to the read-time passes.** `counterparty-pricing.js` and
  `manager-signals.js` are untouched. The ledger is additive.
- **`counterparty-pricing.js`'s own bare catch** (`:817`) is a near miss rather
  than a silent failure: it reports itself unavailable, but the reason text names
  the wrong cause. Left for its own commit rather than folded in here, so that
  the fix and its test are not buried in a feature diff.
- **`countered` and `expired` statuses** are in the CHECK set and nothing writes
  them yet. ESPN's vocabulary as collected has no counter row, so a writer for it
  would be a writer against a shape nobody has seen.

## 7. The second pass: 34 mutations, and the eight tests that were not there

RED before GREEN proves the tests were written first. It does not prove that any
one of them discriminates, and this unit's RED is weaker than it looks. Measured
again at `92f31b7d` on this branch's current head, rather than quoted from when it was
written:

```
$ node --test test/trade-outcomes.test.js       # at RED 92f31b7d
not ok 1 - test/trade-outcomes.test.js
  error: 'test failed'
  code:  'ERR_TEST_FAILURE'
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '.../server/services/trade-outcomes.js' imported from
  '.../test/trade-outcomes.test.js'
# tests 1 | pass 0 | fail 1

$ node --test test/trade-outcomes.test.js       # at GREEN e363b35c
# tests 17 | pass 17 | fail 0
```

The module does not exist at RED, so the file never loads and node reports one
file-level failure rather than a count of the tests inside it. (An earlier
version of this section said "all fifteen tests failed on the same cause"; the
cause was right, the shape was not — nothing inside the file ran at all.) A file
full of tests asserting nothing would have produced exactly the same RED, which
is why the sweep below exists and why that RED is not offered as evidence on its
own.

So the second pass is a mutation sweep, committed and re-runnable:

```
node docs/tdd/sweeps/trade-outcomes.mutations.mjs
```

Each row breaks ONE contract in the producer — a CHECK, an index, a guard, a gate
— runs the suites that claim to hold it, reverts, and verifies the revert. It
prints `git write-tree` either side and refuses its own result if the tree moved.

**First run: 19 killed, 8 SURVIVED.** A survivor is the finding. All eight were
test defects rather than production defects, in three shapes:

| shape | rows | what it was |
|---|---|---|
| passed for the wrong reason | M7 | the status-vocabulary test inserted a row that was also missing its `espn_tx_id`, so a DIFFERENT CHECK refused it. Strip the status CHECK entirely and the test still passed. `/CHECK\|constraint/` cannot tell one constraint from another, so the discrimination has to come from the row: valid in every respect except the rule under test. |
| mutual-masking pair | M6+M19, M4+M31 | the rule is held in both the table and the service. Remove either alone and the other still refuses the row; an assertion that accepts either refusal passes. Neither layer was pinned. A single-layer mutation **cannot** find this — only the paired row can. |
| no test at all | M1, M3, M9, M23, M29 | two CHECKs nobody exercised, a unique index masked by the writer's own SELECT, a `counterpartyOf` that could return a guessed team id, and `vetoClimate`'s absence branch — written in the same commit as the bug class it exists to kill, with nothing behind it. |

**The fixes.** Eight tests added or repaired: the vocabulary row made otherwise
valid; direct-SQL tests for the four unexercised CHECKs and for the unique index,
written through `run` rather than a writer because a CHECK exists for the writer
that has not been written yet; the two service refusals pinned to their own error
messages (`/^trade-outcomes: …/`) so the service layer is measured independently of
the table; a slate test for the unreadable counterparty; and the `vetoClimate`
absence test.

**The one production defect, found by writing that last test.** `read_state` was
set on the absent path and on the empty path and NOT on the populated one, so a
consumer checking `read_state === 'present'` got `undefined` on the one path where
the data is really there. A field that goes missing only when everything is fine is
worse than no field. Fixed at the populated return.

**Second run: 33 rows, 32 killed, 0 survivors, control clean.**

**Third run: 34 rows, 32 killed, 0 survivors, both controls behaving.** The
extra row is a second control, and it exists because the first one only covers
half of what can go wrong with a harness:

```
rows 34 | killed 32 | survived 0 | bad 0 | control SURVIVED | not-applied control BAD_ROW
```

`CONTROL` is an edit that changes nothing; it must come back SURVIVED, or the
harness is lying about every other row. `NOTAPPLIED` is the opposite case: a
`find` string that cannot occur in the file, which the harness must report as
BAD_ROW and refuse to score. Until this pass, nothing in the spec was ever
designed to trip that detector, so the detector itself had never been observed
to fire — and a harness that silently scores mutations it never made makes every
verdict in the run worthless, survivors and kills alike.

So it was shown firing. `NOTAPPLIED`'s `find` was made matchable with a
parsing-valid no-op replace (`const RAW_TABLE = ` for itself), which makes the
row apply cleanly and the detector wrong to fire:

```
MUTANT EXIT 1
NOTAPPLIED SURVIVED  fail=0 @ -
NOTAPPLIED was expected to come back BAD_ROW and came back SURVIVED.
The not-applied detector did not fire, so no verdict in this run can be trusted.
```

The first attempt at that liveness check proved nothing and is recorded here
rather than dropped: it made `find` matchable but left the replacement as
`unreachable`, which breaks parsing, so the row came back BAD_ROW for the wrong
reason — the same trap the M1 mutation hit earlier. A no-op replacement is what
makes the run a test of the detector rather than of the parser.

Two corrections this pass forces on what is written above. §5's claim that the
contract is asserted against the table's own CHECKs was true for three of seven;
it is true for all of them now. And the gate table's "how it is shown" column
described what each test intends, which is not the same as what it discriminates —
the sweep is the only part of this file that measures the difference.

## 8. The check

`npm run check` — typecheck, lint, the whole suite, build, `start:smoke`.

- **Numbers and the tree they were measured on:** in the PR body's "Merge gate"
  section, for the head that merges. This line used to point at "the commit
  message of the final commit on this branch". That stopped being true once the
  branch took merges from main. A tree that
  moves inside the window voids the run whatever the numbers say, and an install
  anywhere in the container voids it with nothing failing visibly.
- **Isolation:** NOT isolated. In place in the container's working tree against
  its single `node_modules`, nothing else running. The hash pair stands in for
  isolation; it says nothing moved, not that nothing could have.
- **`npm ci` has not been run in this container.** A fresh clone fails the
  offline-guard tests with `ERR_MODULE_NOT_FOUND` until it is, which looks
  exactly like a regression and is not one.
- **CI runs and reports on this pull request.** An earlier version of this line
  said Actions minutes were spent until 2026-10-01 and the only workflow was
  disabled deliberately. That was written before 2026-09-22 14:52Z and is false:
  Actions was re-enabled, the repository is public so runs are free, and
  workflow `357164314` is active. The local run is one half of the gate, not the
  whole of it.
- One caveat on the usual shortcut: `docs/` is invisible to every stage of the
  check **except** `docs/CLAUDE-NEXT-STEPS.md`, which
  `test/nfl-execution-integrity.test.js:258` reads byte for byte. This file is
  not that path.
