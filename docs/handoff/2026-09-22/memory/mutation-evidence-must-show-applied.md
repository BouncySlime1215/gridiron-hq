---
name: mutation-evidence-must-show-applied
description: A mutation result in a gridiron-hq evidence file counts only if the injection is SHOWN applied (hash before/after) and the table includes a deliberate NO-OP control; prefer a RED commit over an injection when the test is new.
metadata:
  type: feedback
---

Raised by the scheduler thread 2026-09-20 after its own substitution pattern
silently failed to match: the run was the baseline wearing a mutation's name.
Adopted across evidence files. Worked example:
`docs/tdd/cascade-grade.tdd.md` section 2 (PR #72).

**Why:** a mutation table is the only thing standing behind "this guard is real".
A substitution that does not match produces a passing suite that looks exactly
like a guard working, and nothing in the rendered table distinguishes the two.

**How to apply:**
1. For each injection, capture the file's SHA-256 before and after and confirm
   the mutated text is present in what was written. Print `APPLIED <h0> -> <h1>`
   or `NO-OP — pattern not found`, and put that column in the table.
2. **Include a deliberate control**: one injection whose pattern does not exist
   in the file, recorded as NO-OP with no result. Three rows saying "applied"
   prove nothing on their own — a reader cannot tell a check that works from one
   that always says yes. The control is what shows the verification can fail.
   Copy the control, not just the hashes.
3. **Prefer a RED commit over an injection whenever the test is new.** A test
   committed before the fix and shown failing has no silent-no-op mode: a test
   that does not run reports as missing, not as passing. Injections are for
   guards that already existed before anyone thought to test them.

An assertion inside a throwaway injection script is not enough. It may be true,
but it lives outside the evidence file, so a reader has no way to tell that
table from one produced by a substitution that never matched.

See [[cascade-multiplier-graded-refused]], [[gridiron-failure-modes]].
