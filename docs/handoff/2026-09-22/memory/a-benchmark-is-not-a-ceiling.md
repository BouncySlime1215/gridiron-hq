---
name: a-benchmark-is-not-a-ceiling
description: An arm handed one perfect input is a benchmark, not a ceiling — a predictor with information it lacks can beat it; and test contamination rather than assuming it.
metadata:
  type: feedback
  modified: 2026-09-22T08:41:49.532Z
---

An arm that is handed one true input (week W's actual snap count) while every
other input stays causal is a **benchmark**, not a ceiling. A predictor carrying
information the benchmark does not have — e.g. a graded injury report saying a
player is inactive on Sunday — can score **below** it. Calling it an "oracle
ceiling" asserts an upper bound the design does not establish, and the audit was
right to reject the word.

**Why:** "ceiling" licenses a recovery-fraction sentence ("we capture 14% of
what is achievable") that the construction cannot support. Only an arm given
*every* relevant input is a ceiling; an arm given *one* of them is a benchmark.

**How to apply:**
1. Name the arm for the input it is handed — "perfect-snaps", not "oracle".
2. Say in the same document what could beat it, and why.
3. When an audit says a benchmark's per-player rate might be in-sample and
   therefore biased low, **measure it, do not comply**. Deliberately contaminate
   the rate (let week W into it) and score the paired difference. On snaps
   (2026-09-22) the shipped arm was 1.0729 and the contaminated variant 0.9724,
   **+0.1006 [+0.0950, +0.1062]** — clearly positive, so the shipped arm was
   never the in-sample one. If it had been, that difference would be zero.
4. Then state the residual bias direction: a causal rate is *noisy*, so the
   benchmark **understates** the value of the perfect input, which biases a
   recovery fraction **up**. Say the fractions are mildly optimistic.

See [[gridiron-noisy-estimate-is-not-a-ceiling]] for the sibling trap — a
player's own leave-one-out mean treated as a ceiling — and
[[a-recovery-fraction-needs-both-denominators]].
