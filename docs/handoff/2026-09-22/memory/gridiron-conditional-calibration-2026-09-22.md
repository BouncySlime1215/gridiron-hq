---
name: gridiron-conditional-calibration-2026-09-22
description: The standing promotion gate tests only pooled coverage, which cannot see a 20-point per-quintile calibration error; the width model here is WITHDRAWN in favour of docs/spec/projection-range.md.
metadata:
  type: project
---

Measured 2026-09-22, walk-forward on nflverse pbp; width models fitted on
REG 2022-2023 and scored once on REG 2024-2025 (5,394 held-out player-weeks).

An 80% interval with one global width scores **83.1% pooled coverage**, which
reads fine. Sliced by projection size the same intervals score
**0.923 / 0.871 / 0.853 / 0.780 / 0.728** across quintiles — 19.5 points of
spread. Residual SD nearly doubles across the range (4.57 at mean projection
4.17, to 8.44 at 14.35), so a width that does not scale with the projection
is wrong at both ends by construction, and it is the high-projection players
managers actually start whose range is too narrow.

**WITHDRAWN, do not implement:** the two-parameter Gaussian width below.
[[gridiron-projection-range-spec]] (committed at `docs/spec/projection-range.md`,
Nick's decision 2026-09-22 04:24Z) already solves this with conditional
empirical quantiles by position x projection bin, actual 80.74% over 23,137
player-weeks, holding per bin 78.90-82.23. Their band is deliberately
ASYMMETRIC because the outcome is floored at zero with a long right tail; a
symmetric `mean +/- k*sd` band — exactly what the formula below produces — is
the version they already tried and it over-covers at 84.76% (88.33% TE).
Recorded here only so nobody re-derives it and "simplifies" their band with it.

Two parameters recover most of it: `E|residual| = 2.2436 + 0.3132 * proj`,
`sd = sqrt(pi/2) * that`. Per-quintile coverage becomes
0.845 / 0.823 / 0.818 / 0.804 / 0.837 (spread 4.1 points) and the mean 80%
interval is **6.4% narrower** (15.87 vs 16.96). Better calibrated and
narrower at once.

**Why:** pooled PIT L1 error is 0.287 (global width) vs 0.275 (linear width)
— nearly identical, for a five-fold difference in per-quintile spread.
Over-dispersion at the bottom and under-dispersion at the top cancel inside a
pooled histogram.

**What is still outstanding, and it is one thing.** The range spec measures
per-bin coverage once, at fit time. The STANDING promotion gate does not.

**How to apply:** `weekly-learning.js#coverageCheck` (line 202) gates on
pooled coverage in [0.78, 0.82], and `projections.js:838-844` records sigma
being selected on `10*|coverage-0.80| + calibration error`, also pooled. Both
are blind to this. Any interval work here reports coverage AND PIT per
prediction quintile, and a candidate that widens the per-quintile spread
fails even when its pooled number improves.

**Not yet established:** whether the SERVED intervals have the defect. They
come from `playerWeekDistribution`, so widths do vary per player and may
already be fine — nobody has measured it, and the 0.775-0.783 pooled figure
at `weekly-learning.js:182` says nothing either way. Measuring that is change
#2 in `CALIBRATION-SPEC.md`.

The right skew found in passing (PIT bin 10 runs 0.14-0.16 against 0.10
expected under a Gaussian) is not an open problem — it is the thing the
empirical quantiles in [[gridiron-projection-range-spec]] already handle.

Two weekly-ceiling measurements now exist on different samples and neither is
canonical yet: this one (pbp REG 2022-2025, 10,755 player-weeks, shrunk
season-to-date R2 0.201) and [[gridiron-weekly-ceiling-2026-09-22]] (2018-2025,
WR/TE/RB, 24,801 player-weeks, model R2 0.3186 vs oracle 0.3223). They agree in
direction — headroom is small — but are not comparable. Name the sample when
quoting either.

Files: `CALIBRATION-SPEC.md`, `interval.mjs`, `interval-width.json`.
Dead end from the same run: [[gridiron-offense-entropy-dead-end]].
Baselines it builds on: [[gridiron-baseline-ceiling-2026-09-22]].
