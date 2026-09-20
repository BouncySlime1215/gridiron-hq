# A held position names the cause that actually held

Branch `claude/project-thread-5f9c3y-alternation-hold`, off `origin/main` 791b131.
RED `6a9bb93`, GREEN in the commit carrying this file.

## What was wrong

`fitInverseVarianceWeights` holds a position at the hand-set split when it cannot
be fitted. It decided that with one collapsed boolean and explained it with one
fused sentence, both at `server/services/consensus-weights.js:334-337` on main:

```js
const usable = cells.every(c => c.n >= MIN_POSITION_ROWS && c.variance > 0);
if (!usable) {
  weights[pos] = { ...handShare, fitted: false, n: Math.min(...cells.map(c => c.n)),
    reason: `fewer than ${MIN_POSITION_ROWS} training rows or no measurable variance — held at hand-set weights` };
```

Two conditions ANDed into one flag, two causes ORed into one message. The code
could not say which held, so it said both, every time, whichever one it was.

There is a third state inside the same flag. `measureSourceErrors` returns
`variance: null` for a source and position with no rows at all, and `null > 0` is
false, so a zero-row cell reported a missing variance as well — inventing a second
finding out of the absence of the first.

`n` is `Math.min(...cells.map(c => c.n))` and is still reported, so a position held
for flat variance would print a row count that had nothing to do with the decision.

## How it was found

Sweeping single-line assertions whose regex carries an alternation.
`test/consensus-weights.test.js:238` read:

```js
assert.match(w.reason, /fewer than \d+ training rows|no measurable variance/);
```

which looks like a closed-set membership check over two outcomes and is not one.
Both branches match the same single string, so the first always fires and the
second is dead regex. Splitting that assertion would have changed nothing, because
there was only ever one outcome to assert. The test was weak because the code was
fused; the test was the symptom.

The same test also had no guard: `thin` is a filter, and an empty one would have
satisfied every assertion in the loop without reading a weight.

## RED

`6a9bb93`. Under the `[2021]` fixture the panel is 20 QB, 45 RB, 85 WR, 20 TE, so
QB and TE are held on row count with a measured, positive variance.

```
not ok 8 - an unfitted position names the cause that actually held, and not the other one
  error: 'QB: held on 20 rows, so the reason must not also blame a variance it never failed to measure'
# tests 13 / pass 12 / fail 1
```

The two assertions before it are the guard — `held.length`, and `w.n` under the bar
— so the failing assertion is known to have read a real, non-degenerate world.

## GREEN

`HELD_BECAUSE` is a frozen closed set `['no_rows', 'too_few_rows', 'no_variance']`
and `heldBecause(cells)` returns the causes that held, in that order, empty when the
position is fittable. `causeText` says each one in words and names the sources and
the number behind it. The object now carries `held_because`, so a caller asserts a
code instead of parsing prose.

`heldBecause` is exported rather than inlined because the live fixture reaches
exactly one of the three branches. A branch no test reaches is a branch nobody has
seen run, and this one decides what a reader is told about a position the model
declined to fit. Four unit tests give it its own cells, one branch each, plus one
where two sources fail two different ways at once — the case the fused sentence
could not have distinguished, because it printed both every time.

`test/consensus-weights.test.js` file: 18 tests, 18 pass, 0 fail.

## Mutations

Every row below was run by `/tmp` harness on the tree at `656b11b`, one mutation at a time,
each restored before the next. `before` and `after` are the first 16 hex of the SHA-256 of
`server/services/consensus-weights.js` (pristine `a76bfca38f4dd0d0`); a row whose hash does not
move did not land and is reported NO-OP rather than counted as a pass.

| # | what was changed | before → after | landed | pass / fail | first test that went red |
|---|---|---|---|---|---|
| M1 | the fused two-cause sentence comes back | `a76bfca38f4dd0d0` → `0f06872007608c61` | APPLIED | 17 / 1 | an unfitted position names the cause that actually held, and not the other one |
| M2 | absence of rows also reported as a missing variance | `a76bfca38f4dd0d0` → `45f4faeb30b69192` | APPLIED | 17 / 1 | heldBecause: no rows at all is one fact, not a missing variance as well |
| M3 | only the first cause is reported | `a76bfca38f4dd0d0` → `608dc5c42c33077c` | APPLIED | 17 / 1 | heldBecause: two sources can fail in two different ways at once, and both are reported |
| M4 | held_because is dropped from the object | `a76bfca38f4dd0d0` → `21828c4591181c56` | APPLIED | 17 / 1 | a position with too few training rows is held at the hand-set weights rather than fitted on nothing |
| M5 | a fittable position is reported as held | `a76bfca38f4dd0d0` → `e9bccfe5d1b8f91b` | APPLIED | 12 / 6 | weights move toward the lower-variance source, and stay inside the caps |
| M6 | too few rows is misreported as no rows | `a76bfca38f4dd0d0` → `7404f7b3e284db56` | APPLIED | 14 / 4 | a position with too few training rows is held at the hand-set weights rather than fitted on nothing |
| M7 | the flat-variance test is inverted | `a76bfca38f4dd0d0` → `e3cb42496d512743` | APPLIED | 10 / 8 | weights move toward the lower-variance source, and stay inside the caps |
| C1 *NO-OP CONTROL* | a comment word changed, nothing executable | `a76bfca38f4dd0d0` → `4ab75929bae5f944` | APPLIED | 18 / 0 | — none, and that is the point — |
| C2 *KILL-CONTROL* | heldBecause always returns empty | `a76bfca38f4dd0d0` → `4f47d62dcd17e1b1` | APPLIED | 12 / 6 | a position with too few training rows is held at the hand-set weights rather than fitted on nothing |

Every row landed: each `after` hash differs from the pristine `a76bfca38f4dd0d0`, so no row is a
description of an edit that never happened.

**C1 is the NO-OP CONTROL** and it is the row that makes the other eight mean anything. It changes
a word inside a comment: the file's hash moves, so the harness demonstrably edited the file, and
the suite stays at 18 / 0. A harness that reported a failure here would be reporting noise, and
every red below it would be worthless.

**C2 is the KILL-CONTROL**, a different thing and named separately: `heldBecause` returns `[]`
always, which must break a great deal, and does — 12 / 6. It proves the tests can fail at all.

### Every new test is reddened by something

The seventh part of the standard: a test no mutation turns red gets a killing row or a reason.
None here needs a reason, because each has a mutation that kills it.

| test | killed by |
|---|---|
| an unfitted position names the cause that actually held, and not the other one | M1, M6, M7 |
| a position with too few training rows is held at the hand-set weights rather than fitted on nothing | M4, M6, M7 |
| heldBecause: a fittable position holds nothing back | M5, M7 |
| heldBecause: no rows at all is one fact, not a missing variance as well | M2, M5, M7 |
| heldBecause: too few rows is named on its own | M6, M7 |
| heldBecause: rows that are all identical leave no variance to weight on | M5 |
| heldBecause: two sources can fail in two different ways at once, and both are reported | M3, M6, M7 |

### Exact text, per row

A description of an edit is not the edit. Each row's `old` and `new` are quoted verbatim below,
in the order of the table.

**M1** — the fused two-cause sentence comes back

```diff
- held_because: held, reason: `${held.map(c => causeText(c, cells)).join('; ')} — held at hand-set weights` };
+ held_because: held, reason: `fewer than ${MIN_POSITION_ROWS} training rows or no measurable variance — held at hand-set weights` };
```

**M2** — absence of rows also reported as a missing variance

```diff
-     if (!c.n) causes.add('no_rows');
-     else if (c.n < MIN_POSITION_ROWS) causes.add('too_few_rows');
-     else if (!(c.variance > 0)) causes.add('no_variance');
+     if (!c.n) causes.add('no_rows');
+     if (c.n < MIN_POSITION_ROWS) causes.add('too_few_rows');
+     if (!(c.variance > 0)) causes.add('no_variance');
```

**M3** — only the first cause is reported

```diff
-   return HELD_BECAUSE.filter(k => causes.has(k));
+   return HELD_BECAUSE.filter(k => causes.has(k)).slice(0, 1);
```

**M4** — held_because is dropped from the object

```diff
-         held_because: held, reason:
+         reason:
```

**M5** — a fittable position is reported as held

```diff
-   const causes = new Set();
+   const causes = new Set(['too_few_rows']);
```

**M6** — too few rows is misreported as no rows

```diff
-     if (!c.n) causes.add('no_rows');
-     else if (c.n < MIN_POSITION_ROWS)
+     if (c.n < MIN_POSITION_ROWS) causes.add('no_rows');
+     else if (c.n < MIN_POSITION_ROWS)
```

**M7** — the flat-variance test is inverted

```diff
-     else if (!(c.variance > 0)) causes.add('no_variance');
+     else if (c.variance > 0) causes.add('no_variance');
```

**C1** — NO-OP CONTROL: a comment word changed, nothing executable

```diff
- /** One cause, said in words, naming the sources it held for and the number behind it. */
+ /** One cause, put into words, naming the sources it held for and the number behind it. */
```

**C2** — KILL-CONTROL: heldBecause always returns empty

```diff
-   return HELD_BECAUSE.filter(k => causes.has(k));
+   return [];
```

### Is each assertion the thing that catches, or is a neighbour doing the work?

A split is not a split if a clause beside it can satisfy the same mutation. So for the three
mutations that motivated the split, the assertion meant to catch each was REMOVED and the mutation
re-run. If the suite stays green, that assertion was the only catch.

| mutation | assertion removed | result with it gone |
|---|---|---|
| M1 | the RED `doesNotMatch(/no measurable variance/)` | 18 pass / 0 fail — undetected |
| M2 | `heldBecause: no rows at all is one fact` | 17 pass / 0 fail — undetected |
| M3 | `heldBecause: two sources can fail in two different ways` | 16 pass / 0 fail — undetected |

Each mutation goes completely unnoticed once its own assertion is gone, so none is being caught by
a neighbour.

M1 is caught by one assertion and not two, and that is correct: the fused sentence still contains
"fewer than 40 training rows", so the row-count `match` and the `held_because` code both still
pass. A test that had also gone red there would have been red for the wrong reason.

## Acceptance test: six mutations written by someone else

The mutations above are mine, which is the weakness of any mutation table — a
fix proved only against mutations its author invented is proved against its
author's imagination. These six were specified by the fantasy plan thread,
which reached the same diagnosis independently through an alternation sweep on
`test/consensus-weights.test.js:238` rather than by reading the consumer. It
also noticed something I had not: the old test's regex matched on the first
alternative every time, because the fused message contains both phrases, so
the test was a symptom of the defect rather than a guard against it.

**All four of their original mutations survive on `main` at zero fail**, on
`consensus-weights.js` at base hash `d1f5eabd828e` (main `791b131`): W1 `2f299a59c65e`,
W2 `e709991898c3`, W3 `e85f72a040e6`, W4 `c36ce7b8931b`, each applied alone.
So the old gate was not weakly pinned, it was unpinned: either half of the
condition could be deleted, or either cause reported exclusively, in silence.

Their W1 and W2 were expressed against the `usable` line, which this change
deletes, so they are re-expressed against the helper rather than
pattern-matched onto it. W5 and W6 exist only because this change created the
states they attack.

Base for every row below: `server/services/consensus-weights.js` at
`a76bfca38f4d`, this branch's head. Each row applied **alone** from that clean
base and restored before the next, because two at once can mask each other.
The file was hashed before and after every row: a pattern that silently
matched nothing reports as a pass, which is how a table records a row as
caught when nothing was mutated.

| row | mutation | after | pass / fail | tests that caught it |
|---|---|---|---|---|
| W1 | drop the row-count arm — only zero variance can hold a position | `0cc6d80c84b2` | 14 / **4** | 7, 10, 12, 13 |
| W2 | drop the variance arm — only a thin panel can hold a position | `5d380bc6f484` | 16 / **2** | 11, 12 |
| W3 | report only the row-count cause, never the variance one | `9a5414bf20ec` | 16 / **2** | 11, 12 |
| W4 | report only the variance cause, never the row-count one | `78e680b0521d` | 14 / **4** | 7, 10, 12, 13 |
| W5 | delete the zero-rows cause from `HELD_BECAUSE` | `d3f185dacc2e` | 17 / **1** | 9 |
| W6 | return only the first cause when several fired | `608dc5c42c33` | 17 / **1** | 12 |

Every row APPLIED — six distinct after-hashes, none equal to the base. Six of
six red. Test titles, not ordinals:

- 7 — a position with too few training rows is held at the hand-set weights rather than fitted on nothing
- 9 — heldBecause: no rows at all is one fact, not a missing variance as well
- 10 — heldBecause: too few rows is named on its own
- 11 — heldBecause: rows that are all identical leave no variance to weight on
- 12 — heldBecause: two sources can fail in two different ways at once, and both are reported
- 13 — an unfitted position names the cause that actually held, and not the other one

**NO-OP CONTROL**, `e5d4c7a1d228`: a comment appended to the `heldBecause`
signature line. Applied, 18 / 0. The harness reports a miss when a real edit
changes no behaviour, so a green row means the edit landed and nothing broke,
not that nothing was edited.

**KILL CONTROL**, `4f47d62dcd17`: `heldBecause` returns `[]`, so no position
can ever be held. Applied, 12 / **6** — tests 7, 9, 10, 11, 12, 13. These
tests can fail.

W2 and W3 redden the same two tests by different routes: W2 makes a flat panel
fit at all, W3 keeps it held and mislabels the cause. Same guard, two ways
past it, both closed.

**Why the distinction is load-bearing rather than pedantic**, in the fantasy
plan thread's words, which are better than mine: too few rows is a coverage
problem that more seasons fix, while no measurable variance means a source's
errors are identical across the panel, which in this file almost certainly
means a broken measurement — and the header already records that two of the
three sources have no obtainable history. Same action, entirely different
cause, and one of them is a bug. The reason nobody noticed is that holding at
the hand-set weights is the **correct action in both cases**, so the output
was right and only the reason was wrong.

**Credit where the account is theirs and where it is mine.** The two-condition
diagnosis was reached independently on both sides. The third state is mine and
they say it completes the diagnosis: with no rows at all, `variance` is `null`,
`null > 0` is false, and both causes report through one branch for a reason
that is neither of them. That is why three states wore one sentence.

## Numbers, and the commit they were measured on

`test/consensus-weights.test.js` alone: **18 tests, 18 pass, 0 fail**, on `656b11b`.

Full `npm run check` on `656b11b`: **2,960 tests, 2,919 pass, 0 fail, 41 skipped**, exit 0.
874 JavaScript files (`git ls-tree -r --name-only 656b11b -- server scripts test | grep -cE
'\.(js|mjs)$'`), build 3.15s, `start:smoke` passed on an isolated database (32 teams).

## The five questions

**Is it well built?** The decision is three named conditions instead of one
collapsed boolean, and the set is frozen and checked. The classifier is a pure
function over cells, so every branch is reachable in a test.

**Is it based on stats or made up?** `MIN_POSITION_ROWS = 40` and the variance test
are unchanged — this commit changes what the code can SAY about its own decision,
not the decision. No weight, share, cap or shrinkage number moves.

**How do we know?** RED at `6a9bb93` failing on a named position with its row count
in the message; three injections, each applied and each caught; the file green at
18/18 and the full suite below.

**Should this data point anywhere else?** Yes, and it is the open question rather
than a claim: `held_because` is the first machine-readable statement in this module
of why a position is unfitted. Anything that presents fitted consensus weights to a
reader currently has only prose to go on. Routing that to a surface is a separate
change and is not made here.

**How does it unify?** `RESPONSE_PROBLEMS` in `trade-proposals.js` is the same
pattern, arrived at the same way and with the same lesson written above it: "One
generic 'malformed response' for all six is what made the live bug invisible."
`HELD_BECAUSE` is that shape for this module.
