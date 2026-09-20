# The draft gate's worst verdict had never been tested

Branch `claude/project-thread-5f9c3y-alternation-hold`, off `origin/main` 791b131.
Retroactive RED by mutation, recorded below; GREEN in the commit carrying this file.

## What was wrong

`test/draft-abstention-audit.test.js:357` on main:

```js
} else if (a.seasons_inverted.length) {
  assert.match(a.verdict, /ANTI-SELECTIVE|NO SEPARATION/);
} else {
```

Two faults, one inside the other.

**The alternation cannot happen.** The source picks the verdict with a nested
ternary: `passes ? GATE SEPARATES : inverted.length ? ANTI-SELECTIVE : NO SEPARATION`.
The test's arm condition IS the source's condition for ANTI-SELECTIVE, so
NO SEPARATION is unreachable inside it. Naming it as an alternative only widened
what would pass.

**The arm never runs at all.** Measured, by printing the audit's own result under
the fixture:

```
[probe] passes=false inverted=[] separating=[2023] verdict=NO SEPARATION — coverage-side thinness does not identify pic
```

`seasons_inverted` is empty, so the test takes its third branch every time. The
assertion has never executed. Tightening it in place would have changed nothing,
which is the reason this became a source change rather than a test edit.

The cost is not cosmetic. The neighbouring NO-SEPARATION arm pins `/Do not ship/`;
this one did not. So the refusal was pinned on the null result and unpinned on the
verdict that says the gate is actively backwards — the picks it flagged as thin
landed CLOSER than the ones it kept.

## Retroactive RED

Three mutations, each run against **main's test file** with the new source in place.
Every one passes unnoticed:

| # | Mutation | Against main's test |
|---|---|---|
| 1 | `if (invertedCount)` → `if (false && invertedCount)`: an inverted season falls through to the null verdict | APPLIED — 18 pass / 0 fail |
| 2 | the anti-selective verdict stops saying "Do not ship" | APPLIED — 18 pass / 0 fail |
| 3 | `if (passes)` → `if (passes && !invertedCount)`: an inverted season overrides a pass | APPLIED — 18 pass / 0 fail |

Three changes to what the audit tells a reader about a gate that is backwards, and
the suite was silent on all three.

## GREEN

The nested ternary becomes `verdictFor({ passes, invertedCount })`, exported, so all
three verdicts can be read on their own inputs rather than only through whichever
one a fixture happens to produce. Four tests, one per verdict plus the precedence
between them, each assertion carrying one fact and its own message.

The same three mutations against the new tests:

| # | Mutation | Against the new tests |
|---|---|---|
| 1 | inverted season falls through | APPLIED — 21 pass / 1 fail |
| 2 | "Do not ship" dropped | APPLIED — 21 pass / 1 fail |
| 3 | inverted overrides a pass | APPLIED — 21 pass / 1 fail |

`test/draft-abstention-audit.test.js` file: 22 tests, 22 pass, 0 fail.

No verdict wording changed, and no threshold moved: `separating.length >= 2` is the
bar it was, and the three sentences are the three sentences. What changed is that
two of them can now be reached by a test.

A `VERDICTS` constant was written and then removed. Nothing keys off it — the
verdict is a sentence and every caller reads it as one — and an unused parallel
enum is a dead export waiting to be found by the next sweep.

## The five questions

**Is it well built?** The selector is a pure function of the two facts that decide
it, and the arm that used to be unreachable now has three tests that do not depend
on a fixture producing a rare outcome.

**Is it based on stats or made up?** Neither the bar nor any verdict text moves.
The audit's own statistics — the cluster two-sample separation, the >= 2 of 3 rule
— are untouched. This is about which of its conclusions a test can see.

**How do we know?** Three mutations silent against main's tests and caught by the
new ones, plus the probe output showing the arm was never entered.

**Should this data point anywhere else?** The open question, not a claim: nothing
presently surfaces this audit's verdict to a reader at all. It says "Do not ship"
to a file. Whether a gate verdict belongs on a draft surface is a product decision
and is not made here.

**How does it unify?** Same shape and same session as
`docs/tdd/consensus-weights-held-because.tdd.md`: a decision that was inline and
unreachable becomes a named function whose every branch a test can ask for
directly. Both started as a hedged regex alternation and both turned out to be the
code's fault rather than the test's.
