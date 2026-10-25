---
name: a-duplicated-guard-hides-a-missing-test
description: Where one rule is enforced in two layers, a single-layer mutation cannot find a missing test — each half is masked by the other and the assertion passes either way; only a PAIRED mutation row exposes it.
metadata:
  type: feedback
  modified: 2026-09-22T04:58:08.632Z
---

**A rule held in two places, with no test that fails when either one goes, is a
rule with no test at all — and a one-edit-at-a-time mutation sweep is blind to
it.** Measured on Gridiron HQ, 2026-09-22, sweeping `test/trade-outcomes.test.js`
(33 rows, docs/tdd/sweeps/trade-outcomes.mutations.mjs).

Two rules were enforced both as a SQLite CHECK on `trade_outcomes` and as a throw
in `server/services/trade-outcomes.js#predictionOf`:

- a recorded midpoint must carry a `model_basis`
- an `app_proposed` row must carry a `model_p_accept`

Removing the CHECK alone: all tests green, because the service still threw.
Removing the throw alone: all tests green, because the table still refused the
row. Each half SURVIVED, and a reader of that sweep would conclude two contracts
were untested when in fact four were. Removing both at once killed immediately.

**Why the assertion could not tell them apart.** The test asserted
`/model_basis/` on the thrown message. SQLite's constraint failure quotes the
constraint text, which contains the column name too, so the same regex matched
whichever layer fired. The fix is to pin each layer to words only it can produce:
the service's refusals now assert `/^trade-outcomes: model_basis is required/`,
a namespace no database error can emit.

**How to apply.**
- Before writing a mutation list, ask of each rule: is it enforced anywhere else?
  Every duplicated rule needs a PAIRED row removing both halves, in addition to
  the two single rows. The single rows are still worth having — a survivor there
  is the signal that a pair exists.
- When a guard and a schema constraint say the same thing, the test for the guard
  must assert something the schema cannot produce, and vice versa.
- Test a database constraint through raw SQL, never through today's writer. A
  CHECK exists for the writer that has not been written yet, and a test routed
  through the current writer cannot see it. Four CHECKs on this table had no test
  for exactly that reason.
- A `/CHECK|constraint/` assertion measures "something refused this row", not
  "this rule refused this row". Make the row valid in every respect except the
  single rule under test, or it is measuring a neighbour — one test here passed
  with its target CHECK deleted, because the row was also missing a column a
  different CHECK required.

**Related.** [[assertion-must-name-the-thing-it-guards]] is the single-layer
version of the same failure. [[a-grep-finds-a-pattern-not-a-shape]] is the
search-side twin. [[a-guard-undone-by-a-later-line]] is the other direction: one
guard, undone downstream instead of duplicated.
