---
name: gridiron-projection-range-spec
description: Nick decided 2026-09-22 to keep the point projection AND add a calibrated range; the measured method and the start/sit win-rate curve that replaces a guessed threshold.
metadata:
  type: project
---

**Nick's decision, 2026-09-22 04:24Z ("do both for finding"): keep the point
projection and ADD a range alongside it, not replace one with the other.**
Spec committed at `docs/spec/projection-range.md`.

Method, forced by measurement not taste: conditional **empirical quantiles** by
position x projection bin, fitted causally from prior weeks only. A fixed band
is wrong (spread scales 2.56x, bottom projection decile RMSE 3.525 to top
9.015). A symmetric `mean +/- k*sd` band is wrong (outcome floored at zero with
a long right tail; in the bottom four deciles the empirical 10th percentile of
the actual outcome IS 0.0). Calibration achieved: **stated 80%, actual 80.74%**
over 23,137 player-weeks, holding by position (80.45/80.95/81.04), projection
bin (78.90-82.23) and season (79.90-81.56).

**The band is deliberately ASYMMETRIC and must stay so** — measured tails are
below 5.37% / above 14.18% (WR), 3.80% / 15.25% (TE), 7.75% / 11.21% (RB). A
first version assuming symmetric tails over-covered at 84.76% (88.33% for TE).
Anyone "fixing" it to be symmetric breaks the calibration.

**The start/sit win-rate curve** — how often the higher projection actually
outscores the lower, measured on 43,200 same-week pairs: margin 0.0-0.5 -> 48.4%,
1.0-1.5 -> 54.0%, 1.5-2.5 -> 59.0%, 2.5-4.0 -> 65.3%, 4.0-6.0 -> 72.8%,
6.0-9.0 -> 81.4%, 9.0+ -> 90.3%. Same-week residuals are essentially independent
(r=+0.0068), so a comparison carries sqrt(2) the noise of one projection.
Against `lineup-brain.js:328-329`: `TIE_THRESHOLD = 1.5` is WELL CHOSEN;
`CLEAR_THRESHOLD = 4.0` is optimistic, buying only 72.8% where an 80% call needs
about 6.0 points. Define the labels by win probability, not points, so they can
be re-derived when the model changes.

`lineup-brain.js:252-258` flags its own noise threshold as "not fitted — it is a
judgement". **It is CONFIRMED**: measured MAE for a startable projection
(yhat >= 8.0) is 6.085, against its stated five to six points.

**Caveat for the implementer:** these widths come from a research baseline
without the repo's `opp_adj_def_epa` ([[gridiron-phase-a-baseline-caveat]]). The
method is unaffected but the WIDTHS must be re-measured against the production
model before being shown to a user. See [[gridiron-weekly-ceiling-2026-09-22]].
