---
name: evidence-standard-mutation-rows
description: What a mutation table in docs/tdd/ must carry to count as evidence — the eight-part standard agreed 2026-09-20, and the runners that implement it.
metadata:
  type: feedback
---

Agreed with the coordinator and the model-evidence audit on 2026-09-20, after
five of eighteen rows elsewhere could not be reproduced from their
descriptions. A table that does not meet this is an assertion, not a reading.

1. **Per-row `sha256(file)[0:16]` before and after.** A site count ("APPLIED
   (1 site)") is not proof the file changed. A row whose two hashes match made
   no edit; report that, never a suite result.
2. **A no-op control** that cannot match, reported as "no edit, suite not run".
   Without it a broken runner scores ten out of ten. Plus a comment-only
   control that applies and stays green, so the red rows mean something.
3. **Test TITLE and FILE**, not labels. Writing the table from the runner's
   output rather than from memory corrected two rows the first time it was
   done.
4. **Verbatim before and after text**, not a description of the edit — and
   **generated from the runner, not transcribed**, since transcription is
   exactly where reproducibility was lost.
5. **A full-check line with the numbers AND the commit** they were measured on.
6. **Each row names the suite it ran**, and a runner should fail a row whose
   suite contains no test touching the mutated export. Three rows were pointed
   at the wrong suite and read as false survivors.
7. **Restore every file and verify the hash**, don't assume.
8. **Commit the runner**, so the run can be repeated rather than read.

9. **A mutation table proves a test CAN FAIL. It does not say anything was
   broken.** Only the table PLUS an explicit sentence naming what was NOT found
   tells you that. Instance: the fantasy plan thread stating plainly that no
   misaligned comparison existed in either file and that it fixed no bug, which
   stops a seven-mutation table being read as evidence of a live defect.

10. **NOT APPLIED is only evidence when it was DESIGNED to be.** A row
   reporting NOT APPLIED is a control only when the row was written to be one.
   A mutation the author intended to apply whose anchor did not match is a
   HOLE, and relabelling it a control afterwards is undetectable. Fix the
   anchor and re-run the WHOLE sweep. Instance: the UI thread's P3 row,
   2026-09-20.
11. **A skip count that moves without an explanation** is indistinguishable
   from a suite losing coverage. When the number rises, name the newly skipped
   tests. Instance: 41 to 44 on the UI thread's branch, the three waiting on
   another thread's namespace.

12. **A negation row must be killed at the negation's OWN line, and the row
   says which line that was.** A negation row killed at an adjacent positive
   assertion's line measures the positive twice and the negation not at all.
   It is checkable from the runner's output, which is what makes it useful.

**Pair 9 with the dead-branch taxonomy: THREE kinds, not two** (the three-kind
form is the model-evidence-audit thread's).
- **Dead for its fixtures** — a statement about the test data; "leave it" can
  be correct.
- **Dead because an earlier branch swallows it** — a statement about the regex;
  delete it, no fixture can rescue it.
- **Dead because the producer cannot emit it at all** — a statement about the
  contract, and the worst of the three: the assertion describes behaviour the
  code does not have, and would keep passing if the code started having it.

Only the first is ever fine. The third looks most like coverage and is least
like it. See [[unreachable-branch-no-assertion]].

Runners in the repo, all on `claude/project-thread-sytruo-asof-hold`:
`docs/tdd/mutate-league-chat-sync.sh`, `docs/tdd/mutate-parts-1-5.py`,
`docs/tdd/mutate-league-history.py`.

Related: [[mutation-run-catches-duplicated-reads]] (the alternation rule and
the wrong-suite trap), [[archetype-as-of-accessor]].
