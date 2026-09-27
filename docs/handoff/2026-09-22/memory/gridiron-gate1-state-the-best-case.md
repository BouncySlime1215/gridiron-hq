---
name: gridiron-gate1-state-the-best-case
description: Standing gate-1 rule from 2026-09-22 — every pre-registration must state the maximum achievable effect and show it exceeds the test's resolution; two Explorer units failed it.
metadata:
  type: feedback
---

**Auditor rule, effective 2026-09-22, binding on every pre-registration:** state
the **maximum achievable effect** and show it **exceeds the test's resolution**.
A pre-registration that cannot pass its own best case is not a test.

**Two live failures, both mine, both caught only afterwards:**
- **Partial pooling** (`POOLING-PREREG-2026-09-22.md`): whole fit-season k range
  0.0103 against a test CI half-width 0.0104. **Ratio 0.99.** A perfect result
  was indistinguishable from zero before the run.
- **Early-week vs weighted-evidence** (`EARLYWEEK-PREREG-2026-09-22.md`): an
  ORACLE fitted on the eval season's own answers beats the control by 0.0030
  against a CI half-width of 0.0039. **Ratio 0.77.**

**Also now mandatory in every pre-registration:** the `total = level +
information` decomposition regardless of the primary outcome
([[gridiron-preda-level-confound]]), and a pre-registered **tie-break rule** for
the hyper-parameter grid (pooling had k=4 and k=8 tied; "prefer more shrinkage"
was chosen after seeing the tie, which is too late).

**The companion identifiability check that DID work:** register, and run first,
a check that the conditioning the design rests on is possible at all. Early-week
registered "worst-pair IQR overlap of the conditioning variable, threshold
0.25"; it measured **0.015**, and the unit was reported **UNIDENTIFIABLE ON THIS
DATA** rather than as a null. Two independent routes to the same verdict.

**Related standing rule:** a direction or mechanism claim cites the **applying
line** in the code, never a table in a write-up — that error cost two wrong
classifications in one hour.
