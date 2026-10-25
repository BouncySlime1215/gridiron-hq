---
name: state-which-side-of-an-estimator-change-a-figure-ran-on
description: When an estimator changes mid-project, figures from before and after are not comparable; every number must carry which side it ran on, and a pre/post pair is not a candidate-vs-incumbent delta.
metadata:
  type: feedback
---

Standing requirement from the auditor, 2026-09-22, after `positionalPriors()`
changed its accumulation gate from `target_share > 0` to `target_share != null`
(shipped `25de210e`, defaulted off in `a2fd9daa`).

**Why:** figures produced before and after such a change are not on the same
estimator. A number from one side differs from a number on the other by the
estimator *as well as* by whatever was being tested, so **a pre/post comparison
is not a candidate-versus-incumbent delta and must never be reported as one.**

**How to apply:** every figure a unit carries in states its side in the same
sentence as the number, usually as a column in a table. Run every arm of a grade
on one side so no comparison inside the unit crosses the boundary, and name any
quantity that unavoidably comes from the other side rather than letting it be
discovered later. The live example worth remembering: `k` for `target_share` is
a **pre-change** quantity still in use on a **post-change** estimator, because
it was fitted at `shrinkage-fit.js:329-330` and never refitted — which is the
support mismatch in [[shrink-weight-is-an-accidental-availability-weighting]]
seen from the estimator side rather than a second problem.
