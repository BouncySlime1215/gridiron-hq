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

## 4. Mutation table — every injection APPLIED, by hash

**Coverage, measured not asserted.** This sweep's 27 injections turn red all 29 tests of
`coach-ledger.test.js` (12) and `coach-verify.test.js` (17).
Across all eight Coach sweeps the union of red titles covers **159 of the 159 tests** in
the twelve `test/coach-*` suites, from 155 injections. Nothing in these suites is
turned red by nothing. The full check was green on the tree at `e249cc5`: **3,116 tests,
3,075 pass, 0 fail, 41 skipped, 475.3 s**, build and startup smoke on an isolated
database included, `npm run check` exit 0. Reproduce the coverage with the harness's
`--baseline` mode and the spec file beside it.

Every row was re-measured at head `fdfebf5`, and every row is reproducible:

    python3 docs/tdd/sweeps/mutation-sweep.py docs/tdd/sweeps/ledger.json

The harness hashes the file, applies one literal substitution, runs the named suites,
restores the file and proves the restore by hashing it again. **The literal text of every
row's injection is quoted in `docs/tdd/sweeps/EDITS.md`**, generated from those same spec
files with a staleness gate in the suite, so the quotation cannot describe an injection
nobody ran. The
SHA-256 pair is the point of the row: a diffstat says something changed, a hash pair says
exactly which bytes the suite was run against, so the row can be reproduced without
guessing at the injection. A row whose anchor is not in the source is reported NOT
APPLIED rather than scoring zero failures — that happened once in this sweep (M12's
anchor had the wrong punctuation) and is the failure mode the control below exists for.

**The last row of the table is a NO-OP control.** It rewords a sentence of the file's own
header: the hash moves, so the harness demonstrably applied it, and no test fails, so a
zero in the "Red" column is a real result rather than a silent non-match. Without it, an
injection that quietly failed to apply would look exactly like an injection the suite
survives.

| # | Injection | File | SHA-256 before → after | Red | The test that must go red |
|---|---|---|---|---|---|
| M14 | cell() slides to the nearest row when the index is out of range | `ledger.js` | `7ee4081a` → `ed0e8ad0` | 1 | `coach-ledger.test.js` — a cite that points at nothing resolves to null rather than to something nearby |
| M15 | cell() resolves a column the row does not have | `ledger.js` | `7ee4081a` → `6bd7aafc` | 1 | `coach-ledger.test.js` — a cite that points at nothing resolves to null rather than to something nearby |
| M16 | derive() runs an operation that is not on the list | `ledger.js` | `7ee4081a` → `231e9eab` | 1 | `coach-ledger.test.js` — an operation outside the whitelist is refused, not improvised |
| M17 | derive() divides by zero instead of refusing | `ledger.js` | `7ee4081a` → `83a9e855` | 1 | `coach-ledger.test.js` — dividing by zero is refused rather than returned as Infinity |
| M18 | derive() treats a cite that is not in the ledger as zero | `ledger.js` | `7ee4081a` → `71e11c50` | 1 | `coach-ledger.test.js` — a derivation whose input does not resolve fails loudly instead of skipping it |
| M19 | derive() accepts a cell that is not a number | `ledger.js` | `7ee4081a` → `ce81790e` | 1 | `coach-ledger.test.js` — a derivation over a non-numeric cell fails, rather than producing NaN |
| M20 | percent_of returns the bare ratio instead of a percentage | `ledger.js` | `7ee4081a` → `fe5c5c37` | 2 | `coach-ledger.test.js` — every whitelisted operation computes what it says |
| M21 | trace() stops at the derived value and never unrolls its inputs | `ledger.js` | `7ee4081a` → `8981682c` | 1 | `coach-ledger.test.js` — a derived value can be the input to another, and the chain is readable |
| M22 | handCollected() also lists tables a job refreshes | `ledger.js` | `7ee4081a` → `aa24858f` | 8 | `coach-ledger.test.js` — the ledger reports which cited data is hand-collected, so an answer can show its age |
| M23 | a claim carrying no cite passes verification | `verify.js` | `23844055` → `8204122b` | 1 | `coach-verify.test.js` — a claim with no cites is a violation even when it contains no number |
| M24 | cells pool across claims, so one claim's cite grounds another's number *(survived the first pass; the test in the last column was written for it)* | `verify.js` | `23844055` → `a07bbcd5` | 1 | `coach-verify.test.js` — a cell cited by another claim does not ground this one |
| M25 | every number is checked at two decimal places whatever it was stated to | `verify.js` | `23844055` → `e10e170e` | 1 | `coach-verify.test.js` — a share written as a percentage is grounded against the fraction it came from |
| M26 | hand-collected data no longer has to carry an as-of | `verify.js` | `23844055` → `ad1a7ce5` | 1 | `coach-verify.test.js` — hand-collected data obliges the answer to state its age |
| M56 | a share written as a percentage is no longer grounded against the fraction | `verify.js` | `23844055` → `22c7fe96` | 1 | `coach-verify.test.js` — a share written as a percentage is grounded against the fraction it came from |
| M57 | an answer with neither a claim nor a refusal is accepted | `verify.js` | `23844055` → `634c2da5` | 1 | `coach-verify.test.js` — an answer with no claims is a violation, not a pass by vacuum |
| M98 | every recorded query is called r1, so a cite can point at the wrong one | `ledger.js` | `7ee4081a` → `ea3f918a` | 2 | `coach-ledger.test.js` — ids are handed out in order, so a cite cannot point at the wrong query |
| M99 | a recorded query keeps its shape but not its rows, so no cell is addressable | `ledger.js` | `7ee4081a` → `0b64968d` | 22 | `coach-ledger.test.js` — a recorded query gets an id, and each of its cells is addressable |
| M100 | a derived value records neither its inputs nor its formula, only its answer | `ledger.js` | `7ee4081a` → `8337b48a` | 2 | `coach-ledger.test.js` — a derived value records its operation, its inputs and its formula |
| M101 | the ledger serialises with a Map in it, so what reaches the user is an empty object | `ledger.js` | `7ee4081a` → `5fb5409f` | 1 | `coach-ledger.test.js` — the ledger serialises to JSON with no Map or Set, so it can be shown to the user |
| M102 | a number within one of the cited value counts as grounded *(survived the first pass at ±1; the test in the last column was written for it)* | `verify.js` | `23844055` → `d72585f0` | 1 | `coach-verify.test.js` — a number one away from the cited cell is not grounded — close is not cited |
| M103 | a cite that resolves to nothing is reported without naming the cite | `verify.js` | `23844055` → `5bf75a71` | 1 | `coach-verify.test.js` — a cite that resolves to nothing is a violation naming the cite |
| M104 | a derived value cannot be cited, so a number the ledger worked out grounds nothing | `verify.js` | `23844055` → `ac2b751e` | 1 | `coach-verify.test.js` — a number worked out by the ledger grounds the claim that states it |
| M105 | the sum of a claim's cited cells grounds a number, so arithmetic done in prose passes | `verify.js` | `23844055` → `0093162d` | 1 | `coach-verify.test.js` — arithmetic the model did in its head is not grounded, however right it is |
| M106 | a thousands separator and a sign are dropped, so 1,349 is read as two numbers | `verify.js` | `23844055` → `d9730f84` | 1 | `coach-verify.test.js` — a thousands separator, a leading plus and a minus sign are all read as the number |
| M107 | a refusal is treated as a claim and required to carry cites | `verify.js` | `23844055` → `bedc4a77` | 1 | `coach-verify.test.js` — a refusal is a legitimate answer and needs no cites |
| M108 | the count of numbers examined stays at zero, so an empty check looks like a thorough one | `verify.js` | `23844055` → `86ee217c` | 2 | `coach-verify.test.js` — the check reports how many numbers it examined, so an empty check is visible — also turns red the count assertion in "a claim whose numbers are all cited cells passes" |
| M109 | a fraction is grounded by any percentage at all, because the cell looks like a share | `verify.js` | `23844055` → `f72a1e2c` | 2 | `coach-verify.test.js` — a percentage that is not the cited value is still caught |
| NC-ledger | NO-OP CONTROL: reword a sentence of the file header, changing no behaviour | `ledger.js` | `7ee4081a` → `a318c919` | **0** | none — and that is the assertion |

M56 and M57 carry later numbers because they were added after the numbered pass, when
writing this table showed that two guards in `verify.js` — the percentage form and the
empty-answer check — had no injection against them. Both were injected and both died.

M98 to M109 carry later numbers again, and for a sharper reason: the union check below.

**Every test in both suites is turned red by some row.** A sweep that kills every
injection it happens to have written proves only that those injections were well chosen.
The question worth answering is the other one — which tests would notice nothing if the
code beneath them changed. Taking the union of the red titles across all 27 injections
and subtracting it from the 29 tests these two suites run leaves **nothing**: every test
in `coach-ledger.test.js` and `coach-verify.test.js` is killed by at least one row. The
measurement is reproducible:

```
python3 docs/tdd/sweeps/mutation-sweep.py docs/tdd/sweeps/ledger.json
python3 docs/tdd/sweeps/mutation-sweep.py --baseline \
  'test/coach-ledger.test.js test/coach-verify.test.js'
```

Two rows deserve their bluntness stated. **M99** (a recorded query keeps its shape but
not its rows) turns 22 of the 29 red, because a ledger with no rows breaks everything
downstream of it; it is the only row that kills "a recorded query gets an id, and each
of its cells is addressable", which is the test's own property, but the row is not
evidence about anything else it happens to take with it. **M22** turns 8 red for the same
reason in the other direction — a wrong `handCollected()` adds a MISSING_AS_OF violation
to every answer built on the shared fixture.

**M102, the third survivor.** Loosening the precision comparison from "the same number,
rounded to the precision stated" to "within one at the precision stated" changed real
behaviour and no test noticed: nothing in the suite pinned the boundary, so a claim of 12
targets against a row holding 11 would have shipped with a citation attached — worse than
an uncited number, because the cite makes it look checked. The suite was missing the
test, which is CLAUDE.md's rule for a surviving injection; "a number one away from the
cited cell is not grounded" was written for it, covering the integer, the decimal and the
percentage form, and M102 now kills. **M109** was written in the same pass, for the
neighbouring gap: "a percentage that is not the cited value is still caught" was killed
only by M99 and so was discharged by nothing aimed at it. M109 is the plausible wrong fix
for a percentage false positive — accept any percentage when the cited cell is a fraction
— and it dies on that test and on the new one.

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

**How do we know?** 29 tests, and 27 injections each stated above with the file's SHA-256
before and after it, all now killed, beside a no-op control that moves the hash and kills
nothing. Three of them survived first and produced a tightened test, a rewritten one and
a test that did not exist. Every one of the 29 tests is red under at least one injection,
measured rather than asserted, by the two commands in section 4.
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
