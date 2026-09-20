# TDD evidence: the retrieval ledger and the grounding check (2026-09-20)

**Item:** Nick, 2026-09-20 04:30Z — "Make sure coach is valid and doesn't hallucinate …
train coach to pull all the data from the entire data base and run calculations quickly
to sense check things."
**Slice:** 2 of the Coach rebuild — the record of every row Coach looked at and every
number it worked out, and the deterministic check that refuses an answer containing a
number that is in neither.
**Files:** `server/services/coach/ledger.js`, `server/services/coach/verify.js`; tests
`test/coach-ledger.test.js`, `test/coach-verify.test.js`.
**Commits:** RED `5d55b6f`, GREEN `3bd6325`, mutation-driven tests `45391da` and
`56ced08`, this file after them.
**LLM spend:** $0. Neither module calls Anthropic and neither test does.
**Environment:** cloud container, fresh clone of `origin/main` at `791b131`, `npm ci`
run (exit 0) before any suite number below. No production database and no live read.

## 1. Audit: why a sentence in a prompt is not enough

Slice 1 established that the assistant mounted on every page today has no check on its
own output: `explainPage` (`server/services/nfl-page-explain.js:88-133`) parses
`{paragraph, limitations}` and returns whatever came back, and the only thing standing
between a reader and an invented number is the instruction at :56 — "Never invent a
number, team name, game, or fact that is not present in … an actual tool result."

That instruction is correct and unenforced. The app already has one place that does
enforce an equivalent claim: `/trades/:leagueId/sense-check`
(`server/routes/trades.js:705-887`) runs a season simulation against Claude's verdict and
retries once when the two disagree. The shape is right; the cost is a second model call
and a judgement. This slice takes the shape and removes both: the check is arithmetic
over a data structure, so it is free, instant, and the same every time.

The second half is the one Nick asked for directly — "run calculations quickly to sense
check things". A language model doing arithmetic in prose is the cleanest way to ship a
wrong number that looks right: the inputs are real, the output is invented, and nothing
downstream can tell the difference. So Coach does not do arithmetic. It either asks SQL
for the aggregate or it calls one of eight recorded operations, and the result becomes a
cell with its own id, inputs and formula. A computed number is then exactly as traceable
as a retrieved one.

## 2. What was built

**`ledger.js`** — one ledger per turn. `record(result)` files a query result as `r1`,
`r2`, …; `derive({op, inputs, label})` works out one number from cells already present
and files it as `d1`, `d2`, …. `cell(cite)` resolves the one string that ties an answer
to its evidence:

```
r1#0.target_share   query 1, row 0, column target_share
d2                  the second derived value
```

A cite that does not resolve returns `null`. It never resolves to something nearby,
because a cite that quietly slides one row over is worse than no cite at all — that is
what M14 injects and what a test now forbids.

`LEDGER_OPS` is the whole of Coach's arithmetic: `sum`, `difference`, `product`,
`quotient`, `mean`, `min`, `max`, `percent_of`. Anything absent is a question for SQL,
which can express it exactly and has the whole table to do it over. Division by zero is
refused with a message that says so, rather than returning `Infinity` and letting the
finite check catch it downstream with a vaguer complaint.

`percent_of` is `(a * 100) / b`, not `a / b * 100`. This was changed during the slice
because the test and the implementation disagreed in the last decimal place on 100/3;
the implementation was wrong, not the test — one rounding step is closer than two.

`trace(cite)` unrolls a derived value all the way down to rows, so the chain behind a
number can be printed. `handCollected(cites)` returns the cited tables whose catalog
`collection` is `by_hand` — the Finding 7 population, as data.

**`verify.js`** — `verifyAnswer({answer, ledger, question})`. A digit in a claim is
grounded when a cell **that claim** cites holds it: exactly, at the precision the claim
states it to (`0.28351` written as `0.28`), or as its percentage form (`0.284` written as
`28.4%`). A cell cited by a *different* claim does not count. That rule is the difference
between a citation and a decoration: letting cites pool would make one honest cite
launder a whole paragraph.

Five violations block: `EMPTY_ANSWER`, `UNCITED_CLAIM`, `BAD_CITE`, `UNGROUNDED_NUMBER`,
`MISSING_AS_OF`. Two things warn and are stated here because they are the honest limit of
the check: a quantity spelled out in words ("three of the last four"), and a proper noun
that appears in no cited row. Closing the word-number gap by rejecting "one" would reject
"one of the reasons", which is not a claim about football.

`MISSING_AS_OF` is the Finding 7 rule made mechanical: if any cited table is collected by
hand, the answer must carry a non-empty `as_of`. Data that is only as fresh as the last
time someone ran a script must not read as current.

## 3. RED and GREEN

RED `5d55b6f`: both suites written against modules that do not exist; 0 pass, 2 files
erroring on import.
GREEN `3bd6325`: **28 pass, 0 fail** (12 ledger, 16 verify), and still 28 after the
mutation runs below: both survivors were closed by tightening and rewriting tests that
already existed rather than by adding new ones.

## 4. Mutation table — every injection APPLIED, with its diffstat

Each mutation was applied to the working tree with `perl -0pi`, both suites run, the
diffstat recorded, and the file restored and verified clean before the next one.

| # | Injection | File | Applied | Tests failing |
|---|---|---|---|---|
| M14 | `cell()` slides to the nearest row when the index is out of range | ledger.js | 1 ins, 1 del | 1 |
| M15 | `cell()` resolves a column the row does not have | ledger.js | 1 ins, 1 del | 1 |
| M16 | `derive()` runs an operation that is not on the list, as a sum | ledger.js | 2 ins, 2 del | 1 |
| M17 | `derive()` divides by zero instead of refusing | ledger.js | 1 ins, 1 del | 1 |
| M18 | `derive()` treats a cite that is not in the ledger as zero | ledger.js | 1 ins, 1 del | 1 |
| M19 | `derive()` accepts a cell that is not a number | ledger.js | 1 ins, 1 del | 1 |
| M20 | `percent_of` returns the bare ratio instead of a percentage | ledger.js | 1 ins, 1 del | 2 |
| M21 | `trace()` stops at the derived value and never unrolls its inputs | ledger.js | 1 ins, 1 del | 1 |
| M22 | `handCollected()` also lists tables a job refreshes | ledger.js | 1 ins, 1 del | 6 |
| M23 | a claim carrying no cite passes verification | verify.js | 1 ins, 1 del | 1 |
| M24 | cells pool across claims | verify.js | 2 ins, 2 del | **0 → 1** |
| M25 | every number is checked at two decimal places whatever it was stated to | verify.js | 1 ins, 1 del | 1 |
| M26 | hand-collected data no longer has to carry an as-of | verify.js | 1 ins, 1 del | 1 |
| M56 | a share written as a percentage is no longer grounded against the fraction | verify.js | 1 ins, 1 del | 1 |
| M57 | an answer with neither a claim nor a refusal is accepted | verify.js | 1 ins, 1 del | 1 |

M56 and M57 carry later numbers because they were added after the numbered pass, when
writing this table showed that two guards in `verify.js` — the percentage form and the
empty-answer check — had no injection against them. Both were injected and both died.

**M17, the first survivor.** Removing the divide-by-zero guard changed nothing: a
`quotient` by zero produced `Infinity`, which the finite check below caught anyway, so
the suite still failed in the same place for a different reason. The guard is still worth
keeping — its message tells the model to say the ratio is undefined rather than to try
again — so the test was tightened to assert the message names the division, and M17 now
kills. Commit `45391da`.

**M24, the second survivor, and the more serious one.** Pooling the cited cells across
claims changed real behaviour and no test noticed. There *was* a test named for exactly
this property — "a cell cited by another claim does not ground this one" — and it did not
test it: both of its claims cited the same cell, so pooling changed nothing about the
outcome. The test was wrong, which is CLAUDE.md's own rule for a surviving injection. It
was rewritten so the first claim cites the cell holding 18.4 and the second states 18.4
while citing something else; M24 now kills. Commit `56ced08`.

## 5. The five questions

**Is this well built?** The ledger is a plain data structure with no I/O, and the
verifier is a pure function over it, so both are cheap to test exhaustively and there is
no path where a number reaches a reader without passing through them. The design decision
worth defending is that Coach does no arithmetic at all: eight recorded operations or
SQL, nothing else. That is more restrictive than it needs to be for simple sums, and it
is what makes "every number is traceable" a property rather than a hope. The known limit
is stated in the module header and again above: digits block, words warn.

**Is it based on stats, or made up?** This slice produces no statistic. It carries other
people's numbers and checks them. The one arithmetic choice with a defensible answer —
`(a*100)/b` over `a/b*100` — was settled by a disagreement between the test and the
implementation on 100/3, and the implementation was changed because two rounding steps
are worse than one.

**How do we know?** 28 tests, and 15 injections each stated above with its diffstat, all
now killed. Two of them survived first and produced a tightened test and a rewritten one.
The claims about the assistant Coach replaces (`nfl-page-explain.js:56,88-133`) and about
the sibling that got it right (`trades.js:705-887`) are line-cited and were read in this
container.

**Should this data be pointed anywhere else on the platform?** Two things should.
(a) `handCollected()` is the mechanical form of Finding 7 — it already answers "does this
answer stand on data a person last refreshed by hand" for any set of cites. Whatever
surfaces the as-of field elsewhere should read the catalog's `collection` mode rather than
keep a second list. (b) The verifier is not Coach-specific. `nfl-page-explain.js` returns
a paragraph with no check at all, and the same function would work on it unchanged if
that route were made to cite. That is a proposal for the thread that owns it, not a change
made here.

**How does it unify?** It makes one rule for the whole platform's AI output: a number
appears on screen because it was retrieved or because it was derived from something
retrieved, and the chain is printable in both cases. Before this, `sense-check` had a
strong version of that rule for one endpoint, `page-explain` had a prompt sentence, and
nothing else had anything.

## 6. What this slice does not do

It does not retrieve anything and it does not answer anything — the tool layer is slice 3
and the loop that uses both is slice 4. It does not check prose for truth, only numbers
for provenance: a claim that says "he is the best receiver on the team" with a valid cite
passes, because the check is about traceability, not about judgement. And a proper noun
that appears in no cited row is a warning rather than a violation, which is a real gap: a
confidently wrong player name would ship. Closing it needs a name index over the cited
rows and is worth doing after the answering loop exists to exercise it.
