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

## Injections

Every injection run, each restored before the next.

| # | Injection | Result |
|---|---|---|
| 1 | the fused two-cause sentence comes back | APPLIED — 17 pass / 1 fail |
| 2 | `else if` → `if`, so a zero-row cell reports `no_variance` too | APPLIED — 17 pass / 1 fail |
| 3 | `.slice(0, 1)`, so only the first cause is reported | APPLIED — 17 pass / 1 fail |

### Is each assertion the thing that catches, or is a neighbour doing the work?

A split is not a split if a clause beside it can satisfy the same mutation. So each
assertion was REMOVED and its own mutation re-run. If the suite stays green, that
assertion was the only catch.

| Mutation | Assertion removed | Result with it gone |
|---|---|---|
| 1, fused sentence restored | the RED `doesNotMatch(/no measurable variance/)` | 18 pass / 0 fail — undetected |
| 2, `else if` → `if` | `heldBecause: no rows at all is one fact` | 17 pass / 0 fail — undetected |
| 3, `.slice(0, 1)` | `heldBecause: two sources can fail in two different ways` | 16 pass / 0 fail — undetected |

Each mutation goes completely unnoticed once its own assertion is gone, so none of
the three is being caught by a neighbour.

Injection 1 is caught by one assertion, not two, and that is correct: the fused
sentence still contains "fewer than 40 training rows", so the row-count `match` and
the `held_because` code both still pass. Only the assertion that the reason must
not blame the other cause fires. A test that had also gone red there would have
been red for the wrong reason.

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
