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

| # | mutation | state | sha256 before -> after | fail | a test that fails |
|---|---|---|---|---|---|
| C1 | back to the durability prior (the borrow this removes) | APPLIED | `9c639848757d` -> `8ce1a890d48e` | 1 | the uncovered value reads the OUTPUT-side constant |
| C2 | a local `0.92` literal instead of the producer's constant | APPLIED | `9c639848757d` -> `24295760c9a2` | 1 | the uncovered value reads the OUTPUT-side constant |
| C3 | the uncovered arm serves `default_durability` | APPLIED | `9c639848757d` -> `23670b6fc18e` | 3 | a player with no row at all is unfitted_position |
| C4 | the no-number branch never fires | APPLIED | `9c639848757d` -> `16e0129a14da` | 1 | a row with a basis but no number keeps the number and loses the label |
| C5 | a substituted default keeps the row's declared label | APPLIED | `9c639848757d` -> `6e78f335fd79` | 1 | a row with a basis but no number keeps the number and loses the label |
| C6 | only `null` counts as missing, so `NaN` is a probability | APPLIED | `9c639848757d` -> `a4f40c9d3b2a` | 1 | a row with a basis but no number keeps the number and loses the label |
| CONTROL | a comment reworded, no code path touched | APPLIED | `9c639848757d` -> `405289686ab0` | 0 | none, and none should |

**One row in this sweep first came back NO-OP, and that is the argument for the column.** `C4`
was written against `row.active_probability ?? UNCOVERED_ACTIVE_PROBABILITY`, and the fix had
already deleted that expression, so the pattern matched nothing and the file's hash did not
move. Without the hash recorded it would have read as a mutation the tests caught. Re-aimed at
the branch that replaced it, it fails.

## Numbers

11 tests, 11 passed, 0 failed in the targeted file.
Full local check `npm run check` on the exact pushed tree: exit 0 — 2,979 tests, 2,938 passed,
0 failed, 41 skipped; typecheck, lint and build clean.

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

**How do we know?** Six mutations and an inert control, each with the file's hash before and
after. One came back NO-OP first and is recorded as such rather than counted. The import-name
test exists because no assertion on the value can distinguish the two constants.

**Should this data be pointed anywhere else on the platform?** It already is: `trade-engine.js`
and `roster-risk.js` are named consumers of the same export, and each had its own copy of 0.92
before it existed. The open value question lands on all three at once now.

**How does it unify?** It removes the last copy of a number that existed in six places, and it
does it by reading the producer's name rather than matching its digits — so the one thing that
could still drift silently, which name is read, is the thing the new test pins.
