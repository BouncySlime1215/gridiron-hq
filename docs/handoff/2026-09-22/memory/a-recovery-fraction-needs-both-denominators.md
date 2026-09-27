---
name: a-recovery-fraction-needs-both-denominators
description: When two harnesses agree on the benchmark but disagree on the baseline, the same absolute gain reads as two different percentages — report both, never pick one.
metadata:
  type: feedback
  modified: 2026-09-22T08:41:57.217Z
---

A recovery fraction is `gain ÷ (baseline − benchmark)`. Two harnesses can agree
closely on the benchmark and still disagree on the baseline, and the baseline is
half the denominator.

Worked case, snap-share forecastability 2026-09-22: R&D's naive baseline is
**1.5674** and its perfect-snaps figure **1.0717** (gap 0.4957). This thread's
harness got naive 1.4898 / 1.6338 and perfect 1.0729 / 1.1341 (gaps 0.4172 /
0.4997). The **constants reproduce**; the baselines do not. So the identical
gain of +0.0588 reads **14.1%** on one denominator and **11.9%** on the other.

**Why:** quoting one figure makes a contested number look settled, and the
flattering denominator is always available. It also manufactures false precision
— an earlier draft claimed two season halves "agree to four tenths of a
percentage point", which was an artefact of holding the denominator fixed, not a
replication result.

**How to apply:**
1. Report the fraction against **both** denominators in a table, with the
   absolute gain in its own column so the numerator is visibly shared.
2. State the honest size as a **range** ("roughly an eighth to a seventh"), and
   say that what replicates is the direction and rough magnitude, not digits.
3. A contradiction of another thread's finding can be **real in direction and
   not comparable in size** at the same time. Say both.

Related: [[a-band-ratio-is-not-an-effect-size]],
[[a-benchmark-is-not-a-ceiling]].
