---
name: gridiron-mae-optima-are-medians
description: Recurring defect #6 in full — every MAE-optimal quantity is a median-type statistic, so deriving one from a mean, variance decomposition or RMSE ratio is a category error; retires three Gridiron errors at once.
metadata:
  type: feedback
---

Ruled by the auditor 2026-09-22 after two R&D units hit the same thing
independently on different problems. Recurring defect #6; the list is
[[gridiron-recurring-evidence-defects]].

**The principle.** Minimising `Σ|aᵢ − m·pᵢ|` over m equals `Σ pᵢ·|aᵢ/pᵢ − m|`,
whose minimiser is the pᵢ-weighted MEDIAN of the ratios aᵢ/pᵢ. So any
MAE-optimal quantity is median-type. Deriving one from a mean, a variance
decomposition or an RMSE ratio is a category error, and it is silent: the wrong
answer comes out the right order of magnitude.

**Why:** an MAE optimum is a quantile, a variance decomposition is about second
moments, and the two only coincide under a shape assumption that fantasy
residuals do not satisfy (measured MAD/RMSE 0.734-0.749 against the Gaussian
0.79788; residuals are leptokurtic).

**How to apply:** before deriving any MAE floor, optimum or multiplier, ask
whether the route passes through a mean or a variance. If it does, measure the
median-type quantity directly instead — it is almost always a one-pass
computation on data already held.

Three errors it retires at once:
- **Plan 05's `p < m* < 1` — REFUTED** (the auditor's own pre-registered
  prediction). m* is the prediction-weighted median of actual/prediction over
  ALL rows including zeros. Zeros sit at the bottom of the weighted mass, so m*
  lands near the 37th percentile of the played ratios: BELOW P(played), not
  above. Measured 0.740 vs 0.7895 (none, n=4,086) and 0.480 vs 0.6570
  (Questionable, n=207). The identity predicted 0.742/0.478/0.000 with no free
  parameters.
- **`MAE floor = oracle MAE × (RMSE floor / oracle RMSE)` — WITHDRAWN.** Assumed
  MAD/RMSE invariance that the same document's own two predictors contradicted.
- **A mean-centred MAE floor understates headroom.** The MAE-optimal per-player
  centre is the MEDIAN week, not the mean: in-sample 3.9979 on the median vs
  4.2122 on the mean.

**Corollary that caught a live error:** an MAE-optimal flat multiplier can sit
below 1 purely from right skew — on played rows the optimum was 0.915 while
mean(actual)/mean(pred) was 1.0464, same rows, opposite sides of 1 — and it
flips by baseline (1.085 on the #14 carries baseline). **The multiplier's side of
1 carries no information about availability.** Nobody may cite it as such.

See also [[gridiron-offline-rig-evidence-line]].
