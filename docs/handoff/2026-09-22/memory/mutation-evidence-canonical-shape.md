---
name: mutation-evidence-canonical-shape
description: What a mutation-evidence table in docs/tdd must contain — the two controls, per-row exact edit text, named tests per suite — and the free-text rows that cannot meet it.
metadata:
  type: project
---

The shape every Gridiron HQ mutation table must meet, settled 2026-09-20 across threads.
Grade a table against this; see [[mutation-table-third-reading]] for how to reproduce one.

**Per row:** the mutation, state APPLIED or NO-OP, sha256 (first 12) before and after, the
fail count, and the tests it turned red BY TITLE. When the rows span more than one suite,
name the test FILE beside each title and write out the run that reproduces the counts —
otherwise a row whose reds fall in two files reads as though a named test were missing.

**The two controls.**
- **NO-OP CONTROL** — must break nothing: a real edit that moves the hash and fails no
  test, or a pattern not in the file that reports NO-OP. Every table is graded for this.
- **KILL-CONTROL** — must break something, proving the suite can fail at all. Needed only
  where the table's own rows do not already prove it; a table where every mutation row
  lands and turns a named test red needs no ceremonial kill row.
- **A zero-fail row is not automatically a control.** An unkilled mutation declared
  equivalent is also zero-fail and means the opposite thing about the suite. Say which.

**The full-check line states the numbers AND the commit they were measured on.** The
worked example: availability-basis-vocabulary read 2,961/2,920 at 775e339 and 2,962/2,921
at e53ff1a — the same file, two correct numbers, neither naming its commit. A table keyed
by commit is the shape that fixes it (see that file at c10f925).

**Eighth part: every row quotes its exact before and after text, not a description.** A
hash only proves something if the text that produced it is on the page.

**Why:** the predictable casualty is a FREE-TEXT mutation — a reworded comment, a replaced
error sentence. Any wording is a valid application, so its hash is not derivable from the
row's description and cannot be recovered.

**How to apply:** re-measure that row with quotable text and carry its real hash, or drop
the hash for it. Never print text that does not reproduce the recorded hash. Withdraw the
old figure in the file and say why. To recover a code-shaped row's text after the fact:
write the candidate edit from the description, apply it to the recorded base, and require
the recorded after-hash back to the character. Six of six recovered that way on
availability-basis-vocabulary; only the free-text control did not.

**Alternation rule (adopted 2026-09-20 12:2xZ).** Each branch of a regex alternation in an
assertion is its own assertion with its own message. Closed-set membership is legitimate;
an alternation standing in for "says something like this" where the fixture produces one
branch is the defect. **The sharper tell is a DEAD BRANCH** — run each branch alone against
the fixture and flag any that matches nothing; that finds the defect with no judgement
about what counts as a closed set. (Found one in the wild: the producer wrote
`injury-report`, the assertion matched `injury report`.)

After splitting, **re-run the mutation that motivated it**: a replacement a neighbouring
clause can satisfy is not a split. Each split carries a re-run row.

**`old` and `new` are both measurements, not one measurement and a prediction.** Learned
the hard way: of five rows, the three whose `old` column was reasoned rather than run, one
was wrong (the mutation the alternation *did* catch). The row you do not measure is the row
that is wrong.
