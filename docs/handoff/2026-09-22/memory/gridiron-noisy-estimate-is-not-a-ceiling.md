---
name: gridiron-noisy-estimate-is-not-a-ceiling
description: A player's own sample mean is a NOISY ESTIMATE of his level, never a ceiling or a signal share — this bias has produced two wrong headline numbers on this project.
metadata:
  type: feedback
---

**The trap.** Anything built from a player's own sample mean — his season
average, a leave-one-out average, a raw between-group variance share — carries
`within_variance / n` of its own noise. Treating it as if it were the player's
true level inflates it. **It has bitten this project twice, in two different
costumes, and both times it produced a headline number that was quoted before
anyone checked it.**

**Instance 1: the raw signal share.** "45.48% of weekly scoring is stable player
skill." Raw between-group share, biased up. ANOVA variance components on the
same data give 38.54%, and matched to R&D's population, 29.30% against their
independently-measured 26%. Recorded in `docs/spec/projection-range.md` §7.

**Instance 2: the weekly ceiling, and it is the instructive one.** A
leave-one-week-out season average was called a "hindsight oracle" and its R2
treated as a ceiling; the model reached 98.9% of it, so player-level features
were declared exhausted. **The oracle was the same bias in a different costume**
— a noisy estimate of a level, not a level. Corrected headroom is ~18x larger.
[[gridiron-weekly-ceiling-2026-09-22]].

**And this is the part to remember.** The spec that caught instance 1 then
contained a paragraph explicitly exempting the ceiling result, on the grounds
that it "rests on a leave-one-out oracle comparison, an empirical benchmark,
unaffected by this correction". **Exactly backwards.** Writing down a
correction is not the same as applying it; the one place it was declared not to
apply is the place it mattered most.

**Three cheap checks, any one of which catches it:**

1. **`SSB/SST` equals the R2 of the in-sample group-mean predictor.** They are
   the same arithmetic. If a "ceiling" is a number a predictor scores on the
   rows that built it, it is not a ceiling.
2. **Compare the claimed ceiling against the estimator that supposedly attains
   it.** A ceiling of 0.4548 beside an "oracle" scoring 0.3223 is the bias,
   visible on one line.
3. **Invert it and check the implied sample size.** Used directly as a
   prediction, a leave-one-out mean scores `R2 = 1 - W*(1 + 1/(m-1))`. Solve for
   the implied weeks and compare with the data. The biased figure implied 5.11
   scored weeks where the data had 8.84.

**Use instead:** ANOVA variance components with the unequal-group correction
`n0 = (N - sum(m_i^2)/N)/(G-1)`, ceiling `= sigma2_b/(sigma2_b + sigma2_w)`, and
report it as a **range** from two independent estimators rather than a point —
within-player variance grows with a player's level, so the homoscedastic
assumption is never exactly right.

Same family as [[gridiron-failure-modes]] and
[[gridiron-suite-figure-rule]]: **a number measured the wrong way looks exactly
like a result.** Sibling in the same week:
[[gridiron-projections-denominator-is-raw]], where two threads inferred opposite
things from one word.
