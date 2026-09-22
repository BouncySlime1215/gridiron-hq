# The number for an uncovered player, read from one place

2026-09-20. `server/services/player-week-engine.js`, `test/availability-basis.test.js`.
Merges Opportunity's `availability-basis.js` head and closes the borrow this thread opened.

## What this replaces

`activeProbabilityFor` needed a probability to serve for a player with no availability row —
`weeklyAvailability` covers QB, RB, WR and TE, so every kicker and defence lands there by
construction. The five call sites it replaced each wrote `?? 0.92`. There was no export for
that quantity, so it borrowed `DEFAULT_DURABILITY_PRIOR` under a docstring saying the borrow
was wrong in kind and the right name belonged beside the prior.

It does now. `availability-basis.js` exports `DEFAULT_ACTIVE_PROBABILITY = 0.92` as its own
literal, with this file named as a consumer, and this reads it.

## Why two constants with the same digits is the correct answer

`DEFAULT_DURABILITY_PRIOR` is an **input**: `contingency.js` substitutes it as the prior and
then runs the published report-status curve over it, so a `default_durability` row's served
probability is nowhere near 0.92 for a Questionable player. `DEFAULT_ACTIVE_PROBABILITY` is the
**output**: the probability served for a player who has no row and never went through the
curve. Deriving one from the other would look like tidying and would move a served probability
the next time the prior is revised for a reason to do with the curve. The producer pins them as
independent literals; this file reads the output-side one.

**The value is still open, and the name does not settle it.** Whether a kicker should be priced
at 0.92, at 1, or refused a number at all moves the odds, and it is on the list for Nick. What
changed is that there is now one place to change when it is answered, instead of six.

## A test that no assertion on the value can replace

Both constants are `0.92`. Every existing assertion passes whichever one this module imports,
so the wrong import is invisible to the suite — and it is not cosmetic, because it decides
whether a later revision of the prior silently moves this served number.

The only thing that can catch it is which name is in the import, so that is what is asserted:
the import line must contain `DEFAULT_ACTIVE_PROBABILITY` and must not contain
`DEFAULT_DURABILITY_PRIOR`. The same test asserts the two are equal today, because that
equality is precisely why the names have to be checked rather than the numbers.

## Which arm, and why not the one I first used

The first version of this fix served `unrecognised` for a present row with no number. The
producer's vocabulary now separates the two cases, and it is right to: `unrecognised` is a row
that arrived **without the basis field** — version skew, which decays to zero once every producer
is on the current shape — while this is a row that arrived **with** a basis and no number, a live
fault in a current payload. A consumer counting either has to be able to count them apart, and one
word for both would have made a permanent fault look like a migration artefact that was on its way
out. So this serves `unvouched`, and a test asserts it is not `unrecognised`.

## A defect the sweep found, and it is the memo key's shape again

`C4` — changing `row.active_probability ?? UNCOVERED_ACTIVE_PROBABILITY` to `?? 1` — failed
nothing. No fixture had a row present with no number in it, so the fallback was untested.

`weeklyAvailability` always sets `active_probability`, so that branch is unreachable from the
live producer and defensive against a hand-built map. But it decides what a reader is told, and
what it told them was wrong: it served the substituted default **under the row's own declared
basis**, so a row claiming `pooled` with no number printed "this came from the pooled fit" over
a number that came from a constant. That is this accessor's own defect arriving from the other
side, and the same shape as the memo key serving a correct fit id over the previous fit's
numbers.

Fixed rather than pinned. The number is still served — a throw here takes down the odds — and
what is withheld is the claim about where it came from: basis `unrecognised`, and a source
sentence naming the value the row claimed. Five broken shapes are covered (`null`, `undefined`,
the key absent, `NaN`, a string), because `?? ` and `== null` both accept `NaN` and a string as
probabilities and `C6` proves the difference.

## Mutations

Canonical shape: one row at a time from the same clean base, the file's SHA-256 (first 12
characters) before and after, and
`node --test --test-concurrency=1 --experimental-test-module-mocks test/availability-basis.test.js`.

Base file: `9c639848757d`. Restored to `9c639848757d` after the last row, checked.

| # | mutation | before -> after (quoted by the runner) | state | sha256 | fail | a test that fails |
|---|---|---|---|---|---|---|
| C1 | back to the durability prior: the borrow this removed | `  AVAILABILITY_BASIS, DEFAULT_ACTIVE_PROBABILITY, isAvailabilityBasis` -> `  AVAILABILITY_BASIS, DEFAULT_DURABILITY_PRIOR as DEFAULT_ACTIVE_PROBABILITY, isAvailabilityBasis` | APPLIED | `f9da8591e948` -> `4a3638d7abd4` | 1 | the uncovered value reads the OUTPUT-side constant |
| C2 | a local `0.92` literal instead of the producer's constant | `const UNCOVERED_ACTIVE_PROBABILITY = DEFAULT_ACTIVE_PROBABILITY;` -> `const UNCOVERED_ACTIVE_PROBABILITY = 0.92;` | APPLIED | `f9da8591e948` -> `10542db5fc61` | 1 | the uncovered value reads the OUTPUT-side constant |
| C3 | the no-row arm serves `default_durability` | `availability_basis: 'unfitted_position',` -> `availability_basis: 'default_durability',` | APPLIED | `f9da8591e948` -> `1f3210142524` | 3 | a player with no row at all is unfitted_position, not default_durability |
| C4 | the no-number branch never fires | `const missing = row.active_probability == null \|\| !Number.isFinite(row.active_probability);` -> `const missing = false;` | APPLIED | `f9da8591e948` -> `ac4d9f234a96` | 1 | a row with a basis but no number keeps the number and loses the label |
| C5 | a substituted default keeps the row's declared label | `availability_basis: 'unvouched',` -> `availability_basis: basis,` | APPLIED | `f9da8591e948` -> `1e69c2d42248` | 1 | a row with a basis but no number keeps the number and loses the label |
| C6 | only `null` counts as missing, so `NaN` is a probability | `row.active_probability == null \|\| !Number.isFinite(row.active_probability)` -> `row.active_probability == null` | APPLIED | `f9da8591e948` -> `be0062f3c7e6` | 1 | a row with a basis but no number keeps the number and loses the label |
| C7 | the label reverts to `unrecognised` | `availability_basis: 'unvouched',` -> `availability_basis: 'unrecognised',` | APPLIED | `f9da8591e948` -> `3a8b3086a935` | 1 | a row with a basis but no number keeps the number and loses the label |
| CONTROL | a comment reworded, no code path touched | `Two quantities, same digits, two exports with two docstrings` -> `Two quantities with the same digits, two exports and two docstrings` | APPLIED | `f9da8591e948` -> `ad2bf389259f` | 0 | none, and none should |

Every before/after above is printed by the runner from the strings it actually applied, not
transcribed. A row whose pattern matches nothing, or matches in more than one place, is reported
NO-OP and not applied — matching the wrong place is the same failure as matching nothing, and it is
worse, because an unrelated test may then fail and read as a kill.

**C2 survived the first run of this table, and the gap it found is a real one.** C1 was rewritten
to alias the prior under the right name, which left the import line correct; C2 then replaced the
constant with a bare `0.92` and the import-name test still passed, because it checked which name
was *imported* and not whether it was *used*. Closed by asserting the assignment reads the
imported name and that no `0.92` literal appears in this file's code at all — prose may discuss the
number, code has to import it. Three comment lines mention 0.92 and are excluded deliberately.

**Two rows in this sweep came back NO-OP before they came back APPLIED, and that is the argument
for the state column.** `C4` was written against `row.active_probability ?? UNCOVERED_ACTIVE_PROBABILITY`,
which the fix had already deleted, so it matched nothing. `C5` was written against
`availability_basis: 'unrecognised'`, which the arm swap had just replaced. Neither moved the
file's hash, and without the hash recorded both would have read as mutations the tests caught.
Re-aimed, both fail.

## Numbers

11 tests, 11 passed, 0 failed in the targeted file.
Full local check `npm run check`, measured on the tree whose parent is `74657ef` (the merge of the
producer's `f68059d`): exit 0 — 2,980 tests, 2,939 passed, 0 failed, 41 skipped; typecheck, lint
and build clean; `start:smoke` passed on an isolated database. The earlier commit on this branch
measured 2,979 / 2,938 / 0 / 41 on the tree whose parent was `0b26f20`.

Run on the whole suite, not just the two targeted files, because an earlier edit on this branch
replaced text between two anchors and deleted `memoKBasis` in the gap: both targeted suites
passed and 54 tests in other files failed. A targeted suite is not evidence for a structural
edit.

## The five questions

**Is this well built?** The value has one definition, in the producer's file, with the
input/output distinction written down beside it. This file reads it and states what it does
when a row arrives without a number.

**Is this based on stats, or is it made up?** The constant is **made up and says so** — nothing
can be fitted for a position the availability model does not cover, and both docstrings state
that a default says it is one rather than claiming to be a good guess. What is measured is the
`role`, `pooled` and `durability_prior` bases, which this accessor reports rather than
substitutes. The 0.92 is the value five call sites already used; adopting it changed no served
number.

**How do we know?** Seven mutations and an inert control, each with the file's hash before and
after and its exact before/after text quoted by the runner. Two came back NO-OP first and are
recorded as such rather than counted, and one survived and found a real gap (the right import,
unused). The import-name test exists because no assertion on the value can distinguish two
constants that carry the same digits.

**Should this data be pointed anywhere else on the platform?** It already is: `trade-engine.js`
and `roster-risk.js` are named consumers of the same export, and each had its own copy of 0.92
before it existed. The open value question lands on all three at once now.

**How does it unify?** It removes the last copy of a number that existed in six places, and it
does it by reading the producer's name rather than matching its digits — so the one thing that
could still drift silently, which name is read, is the thing the new test pins.
