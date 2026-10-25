---
name: gridiron-evidence-file-form
description: How a docs/tdd evidence file proves its mutations were real: the seven-part standard (SHA per row, named test + test file per row, NO-OP control, APPLIED, full check on the tree, unkilled mutations declared, unkilled tests given a killing row or a reason), two control kinds, control-vs-equivalent column; canonical shape at c986b80/511eed8; parts and clauses from 11:10Z on continue in gridiron-evidence-file-form-2.
metadata:
  type: project
---

- A mutation result is evidence only if the mutation was applied (scheduler 02:02Z 2026-09-20 caught a substitution pattern that never matched: the baseline wearing a mutation's name). Print applied or NO-OP per injection; capture the file SHA-256 before and after.
- One NO-OP CONTROL row: a pattern that does not exist, reporting 'NO-OP — pattern not found'. The control shows the verification can fail; applied rows alone prove nothing (Opportunity 02:06Z).
- Prefer a RED commit over an injection where the test is new; the injection table is for guards that existed before anyone tested them.

**Why:** a silent no-op injection reads as a green sweep, a stronger false claim than no sweep.

**How to apply:** every docs/tdd evidence file from 2026-09-20 on carries these parts; a missing part is fixed in the owner's next commit on its hold, never in an evidence-only commit. See [[gridiron-five-questions-rule]], [[gridiron-failure-modes]].

- APPLIED establishes that an injection landed, never that it landed where the test looks (Trade Brain 02:47Z); pair each injection with the one test it must break; 'APPLIED but killed something else' is unfinished. A fixed-cadence poll cannot bound a periodic process (the 72 s artifact).
- Project-wide (06:57Z, from Google sign-in): SHA-256 before/after per row, the one named test that must go red, a NO-OP control; a full check measured under a tree being edited is void.
- SIXTH PART (07:48Z, Model audit's review of eight files): an unkilled mutation is declared EQUIVALENT with the reason (memo-fit M4: fit ids start at 1) or SURVIVING with the test that would kill it. CANONICAL SHAPE: docs/tdd/uncalled-surface-audit at c986b80 (Google sign-in; wording fixed at 1171d66).
- Unreachable branch rule (07:57Z): a branch made unreachable by a foreign-key cascade is recorded DEFENSIVE, not covered; the test asserts the cascade after reading the league first.
- SEVENTH PART (11:01Z, Model audit's re-run of setup-status-usage-coverage at 52a55cc): a test that no mutation turns red gets a killing row or a stated reason; an unkilled test is the mirror of an unkilled mutation (test 6 was red for nothing until `if (stamp_disagrees)` → `if (true)`).
- Per-row hash rule (11:04Z): a mutation table without a per-row hash is an assertion, not a reading (weekly-scores 6b77382 found two "caught" rows surviving).
- Continues: [[gridiron-evidence-file-form-2]] (the two control kinds, the control-vs-equivalent column, wording, part 5 = numbers + measured commit, NO-OP-matched-elsewhere, the differential matrix, the EIGHTH PART).
