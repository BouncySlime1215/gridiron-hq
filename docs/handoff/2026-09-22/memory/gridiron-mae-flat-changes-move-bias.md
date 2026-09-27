---
name: gridiron-mae-flat-changes-move-bias
description: MAE-optimal choices in Gridiron systematically push the predicted level BELOW the mean; five instances, two of them already documented in weekly-ensemble.js, and the summing consumers pay for it.
metadata:
  type: project
---

Escalated by the auditor 2026-09-22 as a standing finding after the fourth
independent instance. **Not a unit; a property of optimising MAE on this data.** Broadened 12:15Z:
it is not only "MAE flat, bias moves" — the general form is **MAE-optimal choices
push the level low**, in two shapes: (a) MAE flat while bias moves, (b) MAE
IMPROVES while bias worsens.

**HONESTY NOTE: the repo already knew.** Two of the five instances are documented
in `weekly-ensemble.js` and were found by R&D, not by the auditor. What this entry
adds is the **generality** (it recurs in units that have nothing to do with the
ensemble) and the **mechanism** ([[gridiron-mae-optima-are-medians]]).

Instances:
- **#13 / #14 injury-multiplier arms:** at each arm's MAE optimum the arm ships
  **~17-18% low in the mean** (base 1.0217/0.870 = 1.1744, candidate
  1.2056/1.020 = 1.1820). The baselines themselves are mean-unbiased
  (mean(actual)/mean(pred) 1.0217 and 1.0225).
- **Partial pooling:** MAE flat (+0.0007 [−0.0097,+0.0111]) while mean signed
  error went **−0.4954 → −0.5462**.
- **Early-week blend:** MAE moved 0.02 while signed error worsened
  **−0.50 → −0.71** as arms got more flexible.

- **`weekly-ensemble.js:42-54`, convex vs LAD (shape b).** Leave-one-season-out
  2021-2025: an unconstrained least-absolute-deviation fit with an intercept beats
  the convex grid **5 of 5 folds by 0.078 MAE** (4.344 vs 4.422) — more than the
  ensemble's whole 0.048 edge over `season_to_date` — but biases predictions by
  **−1.02 to −1.56** pts/player-week against **−0.16 to −0.62** for convex.
  Convexity is what keeps the level near-unbiased. Priced, not free.
- **`weekly-ensemble.js:69-77`, the promoted weights (shape a, and the cost).**
  Mean signed error **−0.26 / −0.17 / −0.31 / −0.58 / −0.32** for 2021-2025,
  **negative in every season**. Rankings unaffected, so start/sit is fine — but
  **anything that SUMS these inherits −1.5 to −5 points of level**: a nine-starter
  lineup total, playoff points, a trade delta. The file says it is "not corrected
  here, because correcting it changes live numbers and has to be graded."
  **That deferral is still open and now has five instances behind it.**
- **#15 as the CONVERSE (control):** a mean-preserving candidate left both MAE and
  the level alone. The pattern tracks the level shift, not flexibility as such.

**Why:** the MAE optimum is a median-type quantity on a right-skewed target
([[gridiron-mae-optima-are-medians]]), so minimising MAE pulls the level below
the mean. A sub-1 optimal multiplier is skew, not bias — but *acting* on it
creates bias.

**How to apply:**
- **Report mean signed error beside MAE on anything proposed for shipping.**
- A "free MAE gain" from a flat rescale is not free: anything needing unbiased
  levels (trade valuation, projections a user reads) pays for it.
- Which to optimise is a product/data decision, owned by the coordinator under
  the standing routing — not the auditor's call and not a threat-level-10 item
  for Nick.
- When an information share is quoted, check the arms are **bias-matched** at
  their respective optima (#13 gap 0.65%, #14 1.74%). That check is what makes
  an information share trustworthy.

See [[gridiron-preda-level-confound]].
