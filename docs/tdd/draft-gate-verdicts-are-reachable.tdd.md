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

The nested ternary becomes `verdictFor({ passes, invertedCount })`, exported, so all three verdicts
can be read on their own inputs rather than only through whichever one a fixture happens to
produce. Four tests, one per verdict plus the precedence between them, each assertion carrying one
fact and its own message.

No verdict wording changed, and no threshold moved: `separating.length >= 2` is the bar it was, and
the three sentences are the three sentences. What changed is that two of them can now be reached by
a test.

A `VERDICTS` constant was written and then removed. Nothing keys off it — the verdict is a sentence
and every caller reads it as one — and an unused parallel enum is a dead export waiting to be found
by the next sweep.

## Mutations

Every row below was run on the tree at `656b11b`, one mutation at a time, each restored before
the next. `before` and `after` are the first 16 hex of the SHA-256 of
`server/services/draft-abstention-audit.js` (pristine `dfd5a24a7a5fc574`); a row whose hash does
not move did not land and is reported NO-OP rather than counted as a pass.

| # | what was changed | before → after | landed | pass / fail | tests that went red |
|---|---|---|---|---|---|
| M1 | an inverted season falls through to the null verdict | `dfd5a24a7a5fc574` → `c39305c249d0b979` | APPLIED | 21 / 1 | verdictFor: an inverted season is anti-selective, and says do not ship |
| M2 | the anti-selective verdict stops saying do not ship | `dfd5a24a7a5fc574` → `a7ee284e7cdd35f1` | APPLIED | 21 / 1 | verdictFor: an inverted season is anti-selective, and says do not ship |
| M3 | an inverted season overrides a pass | `dfd5a24a7a5fc574` → `2b9944850a21f073` | APPLIED | 21 / 1 | verdictFor: passing wins over an inverted season, so the two cannot both be claimed |
| M4 | the passing verdict claims a licence to re-rank | `dfd5a24a7a5fc574` → `bd26eba7f1f0c4ee` | APPLIED | 21 / 1 | verdictFor: two separating seasons is the only way to pass |
| M5 | the null verdict stops saying do not ship | `dfd5a24a7a5fc574` → `44d3c4c3c1ae11f0` | APPLIED | 20 / 2 | the verdict is a function of the bar, not of the author's hopes<br>verdictFor: no inverted season and no pass is the null result |
| M6 | the null verdict drops the sample-size reason | `dfd5a24a7a5fc574` → `76ff9418021e8c0e` | APPLIED | 21 / 1 | verdictFor: no inverted season and no pass is the null result |
| C1 *NO-OP CONTROL* | a comment word changed, nothing executable | `dfd5a24a7a5fc574` → `203cfa41fd2cc6cc` | APPLIED | 22 / 0 | — none, and that is the point — |
| C2 *KILL-CONTROL* | every verdict becomes the same sentence | `dfd5a24a7a5fc574` → `b257539e80dd0268` | APPLIED | 18 / 4 | the verdict is a function of the bar, not of the author's hopes<br>verdictFor: two separating seasons is the only way to pass<br>verdictFor: an inverted season is anti-selective, and says do not ship<br>verdictFor: no inverted season and no pass is the null result |

Every row landed: each `after` hash differs from the pristine `dfd5a24a7a5fc574`.

**C1 is the NO-OP CONTROL.** A word inside a comment changes, the file's hash moves, and the suite
stays at 22 / 0. It proves the harness really edits the file and that a clean run means something.

**C2 is the KILL-CONTROL**, named separately because it is a different claim: every verdict becomes
one placeholder sentence, which must break a lot, and does — 18 / 4.

### Every new test is reddened by something

| test | killed by |
|---|---|
| verdictFor: two separating seasons is the only way to pass | M4, C2 |
| verdictFor: an inverted season is anti-selective, and says do not ship | M1, M2, C2 |
| verdictFor: no inverted season and no pass is the null result | M5, M6, C2 |
| verdictFor: passing wins over an inverted season, so the two cannot both be claimed | M3 |
| the verdict is a function of the bar, not of the author's hopes *(pre-existing)* | M5, C2 |

The pre-existing test is included deliberately. It is the one whose ANTI-SELECTIVE arm never runs,
and M5 and C2 show what it DOES cover: the null-result arm it actually takes. Its middle arm still
depends on a fixture that produces an inverted season, which none does; the four `verdictFor` tests
are what now cover that verdict, and the arm is left in place with a comment saying so rather than
deleted, because the day a fixture does invert, it should assert.

### Exact text, per row

A description of an edit is not the edit. Each row's `old` and `new`, verbatim, in table order.

**M1** — an inverted season falls through to the null verdict

```diff
-   if (invertedCount) {
+   if (false && invertedCount) {
```

**M2** — the anti-selective verdict stops saying do not ship

```diff
- the same inversion the betting side found (top-3 confidence picks at 45.1%, z = -2.42). Do not ship.'
+ the same inversion the betting side found (top-3 confidence picks at 45.1%, z = -2.42).'
```

**M3** — an inverted season overrides a pass

```diff
-   if (passes) {
+   if (passes && !invertedCount) {
```

**M4** — the passing verdict claims a licence to re-rank

```diff
- 'A hypothesis for a forward test and a presentational change, not a licence to re-rank.'
+ 'A hypothesis for a forward test and a presentational change, and a licence to re-rank.'
```

**M5** — the null verdict stops saying do not ship

```diff
- + 'expectation. The gate measures nothing real at this sample size. Do not ship.'
+ + 'expectation. The gate measures nothing real at this sample size.'
```

**M6** — the null verdict drops the sample-size reason

```diff
- The gate measures nothing real at this sample size.
+ The gate measures nothing real here.
```

**C1** — NO-OP CONTROL: a comment word changed, nothing executable

```diff
-  * The three verdicts, as a closed set, keyed by the two facts that decide between
+  * The three verdicts, as a fixed set, keyed by the two facts that decide between
```

**C2** — KILL-CONTROL: every verdict becomes the same sentence

```diff
- export function verdictFor({ passes, invertedCount }) {
+ export function verdictFor({ passes, invertedCount }) {
+   if (true) return 'GATE SEPARATES — placeholder';
```
## Numbers, and the commit they were measured on

`test/draft-abstention-audit.test.js` alone: **22 tests, 22 pass, 0 fail**, on `656b11b`.

Full `npm run check` on `656b11b`: **2,960 tests, 2,919 pass, 0 fail, 41 skipped**, exit 0.
874 JavaScript files (`git ls-tree -r --name-only 656b11b -- server scripts test | grep -cE
'\.(js|mjs)$'`), build 3.15s, `start:smoke` passed on an isolated database (32 teams).

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
