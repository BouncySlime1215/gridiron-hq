---
name: gridiron-evidence-file-standard-review
description: Which of Gridiron HQ's 2026-09-20 hold-branch evidence files meet the injection standard, verified by re-running their suites — only Google sign-in's does, and the wiring map's RED counts are stale against the tree it cites.
metadata:
  type: project
  modified: 2026-09-20T07:45:08.123Z
---

Reviewed 2026-09-20 by the model evidence audit thread. Read-only. Standard:
SHA-256 before/after per row, one **named** test per row, a NO-OP control,
mutations stated APPLIED, a full check on the exact tree.

## Verified by re-running, not taken on report

Detached worktrees at the exact commits, `node_modules` symlinked. Every
per-file count matched (7/7, 6/6, 12/12, 9/9); whole suite @ a7ac178 **2,960 /
2,919 / 0 / 41** and @ b1ee48d **2,966 / 2,925 / 0 / 41**, both as claimed.
**Fantasy plan's numbers reproduce.**

## The verdicts

- **Only `docs/tdd/uncalled-surface-audit.tdd.md` (Google sign-in, c986b80)
  meets it in full** — SHA per row, a "Named test red?" column, an explicit
  CONTROL row reporting NO-OP, and whole-suite runs with numbers. **Copy its
  table shape verbatim; it is the reference implementation.** Its rows were
  reproduced end to end here: at c986b80, deleting `AND u.disabled_at IS NULL`
  from `server/platform/auth.js` gives `b816ff37cf3c` → `9afb499a0669`, their
  row's hashes, and `test/google-sign-in.test.js` goes 22 / 21 / **1 fail** on
  the test that names it (`:361`).
  **A correction on the record, mine:** this review first called that mutation
  SURVIVING. It does not. Section 3 has **three** tables — the first is a
  *historical before-state*, and the RED table below it closes the hole.
  Grading a section before finishing it is the failure this review exists to
  catch.
- Opportunity's `availability-basis-vocabulary.tdd.md` (09860ba): SHA column
  and a real NO-OP control, but **no whole-suite check**. **Since fixed — at
  dd84efa it is a second reference implementation**, re-run and reproduced:
  [[gridiron-evidence-second-readings]].
- **HARD FINDING — wiring map `wiring-map-route-deletions.tdd.md` (8307d09):**
  it states `test/wiring-map.test.js 62/62` and reports its RED proofs as
  "test 62 … fails; 61 pass" / "test 61 fails; 60 pass". At that exact commit
  the file is **64 tests, 64 pass** — the RED was measured on a tree two tests
  behind the one cited. Its second row is also the set's only caught mutation
  that **cannot be tied to a named test**: it cites an **ordinal**, which
  shifts when a test is added above it. Re-run both at head, name by title.
  The rest of that file is separately evidenced.
- Softer, fantasy plan's: `availability-basis` A4 ("loose substring") does not
  say which, so it is not reproducible; A6 reports 1 red where two tests assert
  the served probability round-trips. `player-week-memo-fit` never states its
  mutations were applied; its numbers reproduce.
- `stat-table.tdd.md` (UI, 01645a0) names a **rule**, not a test, per row and
  has no whole-suite line. `valuation-panel.tdd.md` (Trade Brain) **is on no
  remote branch**.

The four rules this review added (1 and 2 adopted by the coordinator 07:47Z;
the sixth, seventh and eighth parts) are stated in
[[gridiron-evidence-file-form]] and [[gridiron-evidence-file-form-2]]:
identify a test by its title never its ordinal; declare unkilled mutations;
report an unkilled test the same way; quote a mutation's patch, don't describe it.

Three threads independently caught their own checkers tonight. The standard
works; most files just do not write down enough to be re-run by anyone else.

Ongoing: [[gridiron-evidence-second-readings]] ·
[[gridiron-audit-findings-ledger-2026-09-20]] · [[gridiron-failure-modes]].
