---
name: gridiron-recurring-evidence-defects
description: Five statistical defect patterns the Gridiron audit caught repeatedly on 2026-09-22 — check every measurement against this list before accepting a headline figure.
metadata:
  type: feedback
---

Each of these was caught more than once in a single morning, on different
submissions by different threads. Check a measurement against all five before
accepting its headline.

**1. AN IN-SAMPLE ORACLE IS NOT A CEILING.** A per-player constant estimated on
the rows it scores has artificially low error, so a "% of ceiling recovered" built
on it is biased DOWN and a "% of ceiling reached" is biased UP. Hit twice: the
weekly ceiling (0.4548 → 0.3854 once corrected; see
[[gridiron-weekly-ceiling-989-withdrawn]]) and the snap-share forecastability
"14.1% of the oracle ceiling". **Fix: estimate the constant on one split, score on
another.** Second half of the same defect: such an object is a ceiling only within
its own predictor class. A per-player constant cannot predict an absence, so any
predictor with absence information beats it — call it "best per-player constant",
never "ceiling".

**Why:** a ceiling quoted as a bound gets used to close whole categories of work.

**2. A POOLED CORRELATION IS NOT THE WITHIN-GROUP ONE (Simpson's).** Snap share
vs opportunity: pooled partial 0.0427, but WR 0.3513 / TE 0.2599 / RB 0.2648 —
between-position variance inflates the pooled `r(opp_w, opp_w-1)` to 0.75 and
swamps the signal. A pooled fit or pooled gate returns "adds nothing" and is
WRONG. **But note the limit: the artefact lives in an UNCONDITIONAL correlation.
A feature-lift on held-out MAE measured against a baseline that already conditions
on position is NOT automatically exposed** — `projections.js` is per-position
throughout. Do not extend the paradox to measurements that already condition.

**3. A MINIMUM AT THE BOUNDARY OF THE GRID IS NOT AN OPTIMUM.** k=26 beat k=34
with an interval excluding zero and the curve was monotone from it upward — but 26
was the smallest value tested. A trend running into the edge of a search space
says the grid is mis-centred. **Unadoptable regardless of the interval.** Extend
the grid and find an interior minimum, and work out in advance what a continued
boundary result would mean.

**4. TWO CHECKS THAT COMPENSATE MANUFACTURE CONFIDENCE.** Twice in mirror image:
a weekly-ceiling consistency check closed because two substitutions cancelled; and
the saturation cap, where a wrong prior-season term and a wrong within-season term
ran in opposite directions so a wrong answer looked nearly right. **A check that
closes is not evidence unless each input was verified separately.**

**5. A PERCENTAGE IS A FRACTION OF A DENOMINATOR NOBODY STATED.** Recovery
percentages and shares disagreed repeatedly because the baselines or populations
differed, not the results: naive 1.4898 vs 1.5674 turns the same 0.0588 gain into
14.10% or 11.86%; TE target share 0.086-0.117 (per-player) vs 0.2115-0.2449
(position group) are different quantities. **Require the population and baseline
definition in the same sentence as any percentage, before comparing two of them.**

**How to apply:** run this list before accepting a headline, and say which of the
five you checked. Related standing rules: submissions need claim / file:line on a
reachable tree / evidence with command, metric, n and split / incumbent behaviour
— missing evidence or incumbent is an auto-redirect. Multiplicity: pre-register
which arm counts before reporting several. Rig limits in
[[gridiron-offline-rig-evidence-line]]. See
[[gridiron-auditor-thread-standing-2026-09-22]].

**#6 — an MAE-optimal quantity derived from a mean/variance decomposition.**
Every MAE optimum is a MEDIAN-type statistic; deriving one from a mean, a variance
decomposition or an RMSE ratio is a category error. Full entry, with the three
errors it retires and the flat-multiplier corollary:
[[gridiron-mae-optima-are-medians]].
