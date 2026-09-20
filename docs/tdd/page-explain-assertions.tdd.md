# Two assertions in `test/page-explain.test.js` that could not fail

Model audit swept the suite for a shape: a single-line `assert.match` or
`assert.doesNotMatch` whose regular expression is an alternation. Closed-set
membership is legitimate — "the status is one of these four" is a real claim. The
defect is an alternation standing in for "says something like this", where the
fixture produces one branch and the others are decoration.

Two assertions in this file were named. Both turned out to be the defect, in two
different ways, and both are fixed here. This is not a sweep of the whole file:
five of its seven tests still have no injection aimed at them, and that is stated
rather than rounded up. The two rows below cover the two assertions this pass was
about.

## Verdict 1 — `/not staked|not acting|no real money/i` (was line 138)

**Split.** The mock paragraph this assertion runs against says *"Nothing here is
staked for real money — the desk is watching, not acting."* Of the three branches,
only `not acting` can fire: the sentence says "is staked", not "not staked", and
"for real money", not "no real money". So two thirds of the assertion was wording
nobody wrote, and the line read as "the paragraph says something reassuring"
rather than as a claim about this paragraph.

Replaced with one assertion on the clause the fixture actually contains:

```js
assert.match(result.payload.paragraph, /the desk is watching, not acting/i);
```

**Re-run after the split**, which is the part that matters: a replacement a
neighbouring clause can satisfy is not a split. Row **P1** cuts the model's
paragraph to its first sentence in `nfl-page-explain.js`. Under it the assertion
above goes red and reports the truncated input, while `assert.match(paragraph,
/Pick Watch/)` two lines earlier stays green — so the new line is held by the
clause it names and not by the rest of the sentence.

## Verdict 2 — `doesNotMatch(/I'll place|I placed|stake …|gate …/i)` (was line 178)

**Not a split — the assertion could not fail at all.** It ran against a paragraph
the test itself wrote, which contains none of those phrasings, through a route
that never edits wording: `explainPage()` returns `parsed.paragraph.trim()`
verbatim (`server/services/nfl-page-explain.js:127`). No behaviour of the system
could turn it red; only editing the fixture could. The test is named "never lets
the AI claim to change a pick, stake, or gate", and the guarantee behind that name
is structural, not lexical: the response carries only `paragraph`, `limitations`
and `audit`, and the audit records the call as `wording_only`.

So the mock now *does* claim all three actions — "I'll place the stake now, the
gate is now open, and I changed the pick to the other side" — and what is asserted
is the guarantee that exists:

```js
assert.deepEqual(Object.keys(result.payload).sort(), ['audit', 'limitations', 'paragraph']);
assert.equal(result.payload.audit.authority, 'wording_only');
```

The wording itself is held by the system prompt, not by code. Asserting that the
sentence is stripped would be false; asserting that it survives would enshrine a
weakness as a requirement. The honest claim is the structural one, and row **P2**
— the audit calling itself `advisory` — is what turns it red.

## Mutation table — every injection APPLIED, by hash

Run with the harness, which hashes the file, applies the literal substitution
below, runs the suite, restores the file and proves the restore by hashing again:

    python3 docs/tdd/sweeps/mutation-sweep.py docs/tdd/sweeps/page-explain.json

The exact before and after text of each row is in `docs/tdd/sweeps/EDITS.md`,
generated from the spec file with a staleness gate in the suite.

| # | Injection | File | SHA-256 before → after | Red | The test that must go red |
|---|---|---|---|---|---|
| P1 | the model's paragraph is cut to its first sentence, so the caveat at the end of it never reaches the screen | `nfl-page-explain.js` | `bdb69291` → `9c10636b` | 1 | `page-explain.test.js` — POST /explain/page returns {paragraph, limitations, audit} grounded in the visible_summary it was sent |
| P2 | the call reports itself as advisory rather than wording-only, which is the whole claim the audit makes | `nfl-page-explain-audit.js` | `889065cb` → `b67b2da3` | 2 | `page-explain.test.js` — POST /explain/page never lets the AI claim to change a pick, stake, or gate (and the grounded-paragraph test, which checks the same field) |
| NC-page-explain | NO-OP CONTROL: reword a sentence of the file header, changing no behaviour | `nfl-page-explain.js` | `bdb69291` → `abd30654` | **0** | none — and that is the assertion |

**The harness now runs the project's own test command.** This suite mocks a module
and does not load under a bare `node --test`; the runner passes
`--experimental-test-module-mocks`, the offline guard and a temp database, exactly
as `npm test` does. Every existing sweep was re-run under it and every row's hash
pair and red count is unchanged.

**Coverage.** `test/page-explain.test.js` has seven tests; these two rows turn two
of them red. The other five — the missing-key path, the missing-route rejection,
the tool round-trip, the round cap, and `runTool` never exposing a write — have no
row aimed at them. The Coach sweeps' union is the separate, complete claim: 159 of
159 tests across the twelve `test/coach-*` suites.
