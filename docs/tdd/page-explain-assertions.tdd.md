# `test/page-explain.test.js` — two assertions that could not fail, and the sweep that followed

Model audit swept the suite for a shape: a single-line `assert.match` or
`assert.doesNotMatch` whose regular expression is an alternation. Closed-set
membership is legitimate — "the status is one of these four" is a real claim. The
defect is an alternation standing in for "says something like this", where the
fixture produces one branch and the others are decoration.

Two assertions were named. Both turned out to be the defect, in two different
ways, and both are fixed here. The first pass covered only those two and said so;
the other five tests are now swept as well, and the union below is complete.

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

**An assertion that could not fail at any behaviour of the system is not a weak
test, it is not a test, and replacing it with a structural guarantee is the right
repair rather than strengthening the regex.**

It ran against a paragraph the test itself wrote, which contains none of those
phrasings, through a route that never edits wording: `explainPage()` returns
`parsed.paragraph.trim()` verbatim (`server/services/nfl-page-explain.js:125`).
No behaviour of the system could turn it red; only editing the fixture could.
A stronger regular expression would still have been a claim about the fixture.
The test is named "never lets the AI claim to change a pick, stake, or gate", and
the guarantee behind that name is structural, not lexical: the response carries
only `paragraph`, `limitations` and `audit`, and the audit records the call as
`wording_only`.

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

## Verdict 3 — the missing-key test is held by two guards, and neither alone

Found by the sweep, not by reading. Row **P3** deletes the route's own
`if (!getApiKey())` and **nothing goes red**. The reason is a second guard:
`callClaude()` throws its own `status: 400` error whose message also contains
"Anthropic API key" (`server/services/claude.js:209-213`), and the suite's error
handler renders it as the same 400 the test asserts. Row **P11** deletes that one
instead, leaving the route's, and **nothing goes red** either.

So the test does not pin a guard. It pins the endpoint's contract — a keyless
request is answered, not crashed — and that contract genuinely survives the loss
of either guard alone. Row **P12** removes both in one injection and the test goes
red, which is what a red for this test has to mean. This is the reason the harness
grew a two-file row form; the single-file rows stay in the spec because the
measurement is the finding.

Worth saying plainly, because the flattering reading is available: the redundancy
is real defence in depth, not a gap. P3's zero is an applied edit that correctly
kills nothing, and the hash pair `682e95a7 → 74c0441f` proves it was applied.

**Why the harness has a two-file row at all, and not just for this route.** A
property held in two places is invisible to any single-point mutation. Each
injection is individually survivable, so a sweep that only ever edits one file at
a time reports the test as unswept, and the reader concludes it is weak. It is not
weak — it is redundant, which is the opposite — and nothing about a one-file sweep
can tell those two apart. The only way to separate them is to remove every guard
at once and watch the test go red. So any test whose subject is defended in depth
will read as a hole under a one-file harness, and the fix is an instrument rather
than an exception: the two-file form belongs in the harness for the general case,
and this route is simply where the general case first showed up.

## The other four tests

No verdicts — the rows land where the comments in the test already say the claim
is. Two are worth naming:

- **P5** replaces the tool result with the model's own arguments echoed back.
  This is the injection the test's own comment anticipates ("the tool actually ran
  against the real (seeded) database rather than the loop just echoing the model's
  input back"), and it goes red on `typeof toolResultPayload.available`.
- **P10** renames a declared tool to `set_stake` and wires it to a live branch —
  the exact thing `page-explain-tools.js`'s header promises cannot exist. It turns
  red both halves of the write-safety test at once: the declared-set `deepEqual`,
  and `runTool('set_stake', …)` returning data instead of `Unknown tool`.

## Mutation table — every injection APPLIED, by hash

Run with the harness, which hashes each file, applies the literal substitution
below, runs the suite, restores the file and proves the restore by hashing again:

    python3 docs/tdd/sweeps/mutation-sweep.py docs/tdd/sweeps/page-explain.json

The exact before and after text of each row is in `docs/tdd/sweeps/EDITS.md`,
generated from the spec file with a staleness gate in the suite.

| # | Injection | File | SHA-256 before → after | Red | The test that must go red |
|---|---|---|---|---|---|
| P1 | the model's paragraph is cut to its first sentence, so the caveat at the end of it never reaches the screen | `nfl-page-explain.js` | `bdb69291` → `9c10636b` | 1 | returns {paragraph, limitations, audit} grounded in the visible_summary it was sent |
| P2 | the call reports itself as advisory rather than wording-only, which is the whole claim the audit makes | `nfl-page-explain-audit.js` | `889065cb` → `b67b2da3` | 2 | never lets the AI claim to change a pick, stake, or gate (and the grounded-paragraph test, which reads the same field) |
| P3 | the route's missing-key guard is removed, leaving `callClaude()`'s | `routes/betting-hub.js` | `682e95a7` → `74c0441f` | **0** | none — see verdict 3; this zero is the measurement |
| P4 | a request with no route is accepted and explained anyway | `routes/betting-hub.js` | `682e95a7` → `c8bc8ced` | 1 | rejects a request with no route |
| P5 | the loop echoes the model's own tool arguments back as the tool result instead of running the lookup | `nfl-page-explain.js` | `bdb69291` → `397c000b` | 1 | runs the tool once, re-calls with the result, and returns a grounded final answer |
| P6 | the audit records which tool ran but not what it was asked | `nfl-page-explain.js` | `bdb69291` → `5a5391b9` | 1 | runs the tool once, re-calls with the result, and returns a grounded final answer |
| P7 | the round cap that bounds cost is raised from four to five | `nfl-page-explain.js` | `bdb69291` → `9b44d968` | 1 | enforces the tool-call round cap and surfaces an honest limitation when it is hit |
| P8 | an answer that ran out of rounds is presented as complete, the cut-short note withheld in exactly the case that produces it | `nfl-page-explain.js` | `bdb69291` → `826c1b44` | 1 | enforces the tool-call round cap and surfaces an honest limitation when it is hit |
| P9 | the declared-name whitelist is removed and an unknown name falls through to the switch default | `page-explain-tools.js` | `7086f1bf` → `957d1757` | 1 | runTool never exposes a write/mutating action, even for an unknown or bet-shaped tool name |
| P10 | a stake-shaped name is declared to the model and wired to a live branch | `page-explain-tools.js` | `7086f1bf` → `e2ba1d30` | 1 | runTool never exposes a write/mutating action, even for an unknown or bet-shaped tool name |
| P11 | `callClaude()`'s missing-key guard is removed, leaving the route's | `services/claude.js` | `ba1dac79` → `ea5c131d` | **0** | none — see verdict 3; this zero is the measurement |
| P12 | both missing-key guards are removed at once | both of the above | `682e95a7+ba1dac79` → `74c0441f+ea5c131d` | 1 | handles a missing API key gracefully instead of crashing |
| NC-page-explain | NO-OP CONTROL (applied, kills nothing): reword a sentence of the file header | `nfl-page-explain.js` | `bdb69291` → `abd30654` | **0** | none — and that is the assertion |
| NC-tools | NO-OP CONTROL (applied, kills nothing): reword a sentence of the file header | `page-explain-tools.js` | `7086f1bf` → `2cdba6a1` | **0** | none — and that is the assertion |
| NC-absent-page-explain | NO-OP CONTROL (anchor absent, nothing applied): `const MAX_TOOL_ROUNDS = 3;`, which the file does not contain | `nfl-page-explain.js` | `bdb69291` → *unchanged* | *n/a* | reported `NOT APPLIED (anchor x0)` |

**The two kinds of zero are not the same measurement**, and the table keeps them
apart. NC-page-explain and NC-tools are applied edits that correctly kill nothing:
the hash moves, the suite runs, the failure column is 0. NC-absent-page-explain is
a plausible anchor the file does not contain: the harness refuses it, the hash
does not move and the failure column is empty rather than 0. Reading the second as
if it were the first is how a sweep quietly measures nothing, which is what the
anchor check exists to prevent — and it has caught real drift before (M7, M10 and
M13 all came back `NOT APPLIED` when `catalog.js` moved under them).

**Two rows edit files this thread does not own.** P3, P4 and P12 touch
`server/routes/betting-hub.js`, and P11 and P12 touch `server/services/claude.js`.
Both are allocated elsewhere, and neither is modified by this branch: the harness
restores every file it writes and proves the restore by re-hashing, `git status`
was clean after each run, and no commit here contains either file. The alternative
was to leave two of the seven tests unswept behind a procedural reason, which is
the kind of reason this standard exists to refuse.

**The harness runs the project's own test command.** This suite mocks a module and
does not load under a bare `node --test`; the runner passes
`--experimental-test-module-mocks`, the offline guard and a temp database, exactly
as `npm test` does.

## Coverage, measured not asserted

Baseline, with nothing injected: seven tests in `test/page-explain.test.js`, zero
failures.

    python3 docs/tdd/sweeps/mutation-sweep.py --baseline "test/page-explain.test.js"

Union of the rows above: **7 of 7**, no test carrying a stated reason. Every test
in the file is turned red by at least one injection, and the one that took a
two-file row to get there is verdict 3.

The Coach sweeps' union is the separate claim: 161 of 161 tests across the twelve
`test/coach-*` suites.
