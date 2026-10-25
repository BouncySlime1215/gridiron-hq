---
name: mae-optimal-is-a-median-statistic
description: Recurring defect #6 on this project — any MAE-optimal quantity is a median-type statistic, so deriving one from a mean or a variance decomposition is a category error.
metadata:
  type: feedback
  modified: 2026-09-22T11:33:07.800Z
---

**Any MAE-optimal quantity is a median-type statistic.** Deriving one from a
mean, an RMSE, or a variance decomposition is a category error, not an
approximation. Logged 2026-09-22 as the project's **sixth** instance of this
defect; it converges with the Explorer's Unit A finding.

**Two instances from the weekly-ceiling work, both mine:**
1. Scaling an RMSE floor by a MAD-to-RMSE ratio to get an MAE floor. It assumes
   the error distribution keeps its shape down to the floor. Worth **0.37 of the
   answer** — a Gaussian shape flipped the headroom's sign, +0.3141 → −0.055.
2. Defining the floor as `E|y − μᵢ|`, the deviation from a player's *mean*. The
   MAE-optimal constant is his **median**: in-sample 3.9979 against 4.2122 on
   the mean. So the mean-based floor is too high and the headroom it implies is
   a lower bound.

**Why:** the mean minimises squared error and the median minimises absolute
error. A variance decomposition is a statement about the first; an MAE claim is
a statement about the second. Nothing carries between them without a
distributional assumption, and that assumption is usually load-bearing.

**How to apply:**
1. When a target metric is MAE, measure MAE directly on the rows. Do not derive
   it from σ², RMSE, or R².
2. If a scaling step is unavoidable, name the assumption **wherever the derived
   number appears**, not once in a methods note. `√(m/(m−1))` rescaling assumes
   MAD scales as SD — smaller than the ratio assumption, not zero.
3. Prefer an assumption-free **bracket** (a biased-low and a biased-high
   estimator) and cite the bracket; a point estimate inside it is an estimate.
4. A bootstrap CI on one estimator is **not** the uncertainty when the estimator
   choice is itself in question. On the ceiling the CI was 8.6× narrower than
   the bracket. Quote them together.

See [[ceiling-headroom-mae-derivation]] for the worked case,
[[a-benchmark-is-not-a-ceiling]] and
[[gridiron-noisy-estimate-is-not-a-ceiling]].
