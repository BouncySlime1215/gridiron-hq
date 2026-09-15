# GF08 — Conformal Prediction Code Survey (for Gridiron's uncalibrated margin/total intervals)

Bucket: fix. Target defect (verified tonight): "No conformal or otherwise honestly-calibrated
uncertainty interval exists anywhere in the pipeline — margins/totals are point forecasts with an
assumed-normal SD." Concretely, the actual code (read tonight, not assumed) is
`server/services/nfl-ensemble.js:203-251`, function `predictiveDistribution()`. It does NOT even
assume normal SD — it does something arguably worse: it pools historical `(actual_margin -
market_line)` residuals from an all-history cohort loosely conditioned on `|spread_i - spread| <=
2.5` and `|total_i - total| <= 6` (falling back to the full unconditioned history if fewer than 120
games match), takes empirical quantiles of that residual pool, and widens them by an ad hoc
`inflation = 1 + min(0.25, disagreement/30)` multiplier tied to ensemble disagreement. There is no
held-out calibration split enforced beyond "games before the target week" (cutoff-safety, not
exchangeability), no coverage backtest wired into the pipeline, and the code's own metadata is
honest about this: `calibration_state: 'research_distribution_only'`, `production_eligible: false`.
This is the exact attachment point for real conformal calibration.

Four repos cloned and read (not just README-skimmed) under
`/private/tmp/claude-501/-Users-nick-matta-Claude-Artifacts/e22ddbdc-9d23-482e-a1cc-7bc1f39b77c6/scratchpad/research2/github/`.

---

## 1. scikit-learn-contrib/MAPIE

- URL: https://github.com/scikit-learn-contrib/MAPIE
- License: BSD-3-Clause
- Stars: 1,589
- Last commit: 2026-09-08 (today's date is 2026-09-12 — actively maintained, commits within the week)
- What the code actually does (verified): `mapie/regression/quantile_regression.py` (2,343 lines)
  implements `_QuantileConformalizer`, a full CQR pipeline: fits lower/upper (and optionally
  central) quantile estimators per fold, then `conformalize()` (line 744) computes conformity
  scores via `QuantileRegressionScore.get_conformity_scores()` on a calibration split, and
  `predict_interval()` (line 1193) applies the calibrated width. It supports scikit-learn
  quantile-capable regressors (`GradientBoostingRegressor`, `HistGradientBoostingRegressor`,
  `LGBMRegressor`, `QuantileRegressor`) and cross-validation aggregation strategies (`mean`,
  `median`, `pinball_weighted_mean` — the last one, `_pinball_weighted_mean()` at line 796, weights
  each CV fold's quantile prediction by the inverse of its calibration-set pinball loss, which is a
  genuinely useful trick not present in the simpler libraries below). Separately,
  `mapie/regression/time_series_regression.py` (512 lines) implements EnbPI/block-bootstrap-style
  prediction intervals for sequential, non-exchangeable data — MAPIE is the only one of the four
  that ships both CQR and a non-exchangeable time-series method behind one consistent
  `fit`/`conformalize`/`predict` API. `mapie/metrics/regression.py` provides real coverage/width
  scoring functions to grade any candidate interval.
- Adopt: **call** (not port). It's a pip-installable, scikit-learn-compatible package, and
  Gridiron's `research/` directory already carries scikit-learn 1.7.2 + lightgbm 4.7.0 as an
  *isolated* dependency (`research/requirements.txt`: "Isolated research environment... No
  app-runtime dependency") in `research/.venv`. Adding `mapie` there touches nothing live.
- Gridiron attachment point: use it as an **independent second implementation** to validate
  whatever hand-rolled JS conformal code gets written for `nfl-ensemble.js` — a cheap check against
  a 7th silent numeric bug, given the drive simulator already has six (per tonight's findings).
  Concretely: export the same feature set `predictiveDistribution()` already computes
  (`margin`, `homeSpread`, `marketTotal`, `disagreement`) as a CSV from history, fit MAPIE's
  `SplitConformalRegressor`/`ConformalizedQuantileRegressor` in a `research/*.py` script, and diff
  its coverage/width against the JS port before flipping `production_eligible: true`.

## 2. henrikbostrom/crepes

- URL: https://github.com/henrikbostrom/crepes
- License: BSD-3-Clause
- Stars: 582
- Last commit: 2026-07-08 (active)
- What the code actually does (verified): `src/crepes/base.py` (4,870 lines) — `ConformalRegressor`
  class (line 556). `fit(residuals, sigmas=None, bins=None)` (line 569) stores
  `self.alphas = np.sort(abs_residuals)[::-1]` — just the sorted absolute calibration residuals,
  optionally normalized by a per-sample difficulty estimate `sigmas`, optionally split into
  Mondrian bins (`self.binned_alphas`) keyed by an arbitrary categorical label. `predict_int()`
  (line 828, core math at line ~900) computes
  `alpha_index = int((1-confidence)*(len(self.alphas)+1)) - 1` and returns
  `[y_hat - self.alphas[alpha_index], y_hat + self.alphas[alpha_index]]` — the textbook split-
  conformal interval, with the Mondrian branch doing the identical calculation per-bin so that
  interval width can vary by a chosen category (e.g. a spread bucket) while keeping the coverage
  guarantee within each bin. This is deliberately the simplest correct implementation of the
  method — no neural nets, no CV aggregation, ~350 lines total for `ConformalRegressor`.
- Adopt: **port**. The core algorithm (sort abs residuals, index formula, add/subtract) is small
  enough (~30-40 lines) to reimplement directly in JS with no new runtime dependency, and the
  Mondrian-bin mechanism maps almost one-to-one onto what `predictiveDistribution()` is already
  informally trying to do with its `|spread_i - spread| <= 2.5` cohort filter.
- Gridiron attachment point: `server/services/nfl-ensemble.js`, replacing the residual-quantile +
  `inflation` block inside `predictiveDistribution()` (lines ~216-222) with a real split-conformal
  regressor: bin games by `|homeSpread|` bucket (reusing the existing conditioning logic as the
  Mondrian key instead of a soft ±2.5 filter with an all-history fallback), fit on a genuinely
  held-out calibration slice (not "everything before this week," which is cutoff-safe but not the
  same as a proper calibration/training split), and use the `alpha_index` formula for the interval
  half-width per bin instead of the ad hoc `disagreement/30` inflation multiplier.

## 3. yromano/cqr

- URL: https://github.com/yromano/cqr
- License: MIT (repo also vendors Henrik Linusson's `nonconformist` package, also MIT)
- Stars: 315
- Last commit: 2026-02-02 (this is the original Romano/Patterson/Candès NeurIPS 2019 CQR paper's
  reference implementation; the repo is still receiving small maintenance pushes, but the
  algorithm itself has been frozen since publication)
- What the code actually does (verified): `nonconformist/nc.py`, `QuantileRegErrFunc` class
  (line 207). `apply(prediction, y)` (line 219) computes the CQR nonconformity score exactly as
  the paper defines it: `err = max(y_lower - y, y - y_upper)` — i.e., how far outside the predicted
  quantile band the true value falls (negative when inside the band). `apply_inverse(nc,
  significance)` (line 227) sorts those scores, takes
  `index = min(max(ceil((1-significance)*(n+1)) - 1, 0), n-1)`, and returns that order statistic as
  a symmetric expansion applied to *both* the low and high quantile predictions. This is the
  asymmetric-input, symmetric-output CQR construction from the paper (there's also
  `QuantileRegAsymmetricErrFunc` a few lines below for split low/high adjustments). `cqr/helper.py`
  wraps this around several regressors including a quantile-forest adapter and a quantile neural
  net (`AllQNet_RegressorAdapter`), none of which are needed for the core guarantee.
- Adopt: **port** (the score/inverse formula, not the surrounding neural-net/forest scaffolding).
  It's ~15 lines of array math with a well-known finite-sample coverage proof behind it.
- Gridiron attachment point: use this exact score formula on top of the two boundary quantile
  models Gridiron's own `research/tree_lab.py` ("Package C... quantile regression alike," per its
  header comment) is already positioned to produce (LightGBM/XGBoost support quantile loss
  natively). Fit q10/q90 (or whatever alpha the 80%-interval target implies) LightGBM quantile
  models on the same feature set `predictiveDistribution()` uses, calibrate the CQR score on a
  held-out slice, and export the resulting scalar (or per-Mondrian-bin scalars) as a small JSON
  file the Node service loads — no change to the live server's process, just a static coefficients
  artifact computed offline in `research/`.

## 4. aangelopoulos/conformal-time-series

- URL: https://github.com/aangelopoulos/conformal-time-series
- License: MIT
- Stars: 144
- Last commit: 2023-11-30 (unmaintained since the paper's release, but this is the canonical
  reference implementation for "Conformal PID Control for Time Series" / builds on "Adaptive
  Conformal Inference" (Gibbs & Candès 2021), both widely cited for the non-exchangeable case)
- What the code actually does (verified): `core/methods.py` (248 lines).
  `aci_clipped()` (line 35) and `aci()` maintain a running miscoverage target `alphat` (starting at
  the nominal `alpha`) that is updated online after every observation:
  `grad = -alpha if covered else 1-alpha; alphat = alphat - lr*grad` — i.e. a stochastic-gradient
  / PID-style correction that widens the interval (lowers the effective `1-alphat` quantile it asks
  for) after a miss and narrows it after a hit, tracking coverage even when the underlying score
  distribution is drifting (non-exchangeable). `trailing_window()` (line 16) is the simpler
  baseline it's compared against: just a plain sliding-window empirical quantile of the last
  `weight_length` scores, no adaptation. Both operate on a precomputed `scores` array (the
  conformity scores from *any* upstream model — CQR's or a plain residual), so they compose
  directly with candidates #2/#3 above rather than competing with them.
- Adopt: **port** (core ACI update loop only — the repo's baselines/experiment harness pull in
  `statsmodels`/`tqdm` that aren't needed for the ~20-line update rule itself).
  Time-series-specific conformal work exists precisely because exchangeability — the one
  assumption every method above relies on — is exactly what a season of NFL games violates: team
  strength drifts (this is also, separately, why tonight's findings flag
  `nfl-team-strength.js`'s blend as a non-principled state-space substitute). `trailing_window`
  and `aci` are the standard fix for that: they let the calibration window track drift instead of
  drawing from all-history-conditioned-on-similar-spread the way `predictiveDistribution()`'s
  cohort logic currently does.
- Gridiron attachment point: run this once per week, after that week's games settle. Feed the
  realized CQR (or split-conformal) scores from candidates #2/#3 into a small persisted state
  object (current `alphat`), update it with the `aci` rule, and use the resulting `alphat` — not
  the fixed nominal alpha — to pick next week's calibrated quantile. This turns the interval into
  something that self-corrects if the current season is running systematically different from the
  historical residual pool, instead of silently drawing from stale history the way the current
  `inflation` hack does with no feedback loop at all.

---

## Do-not-do

- Do not adopt EnbPI (`hamrel-cxu/EnbPI`, 134 stars, MIT, last commit 2023-11-25) directly — also
  read tonight (`PI_class_EnbPI.py`, `compute_PIs_Ensemble_online` at line 118). The algorithmic
  idea (bootstrap-ensemble LOO residuals + sliding-window empirical quantile) is sound and is
  effectively subsumed by `aangelopoulos/conformal-time-series`'s cleaner, purpose-built ACI code;
  but the repo itself is rough research-script code (hardcoded `keras.callbacks`/`Sequential`
  branches inside the fit loop, commented-out `# print(time.time()-start)` profiling lines,
  `__pycache__` checked into a past commit) not meant for reuse as a library. Treat it as
  reference-only for the underlying idea, not a port/call target.
- Do not swap in a conformal wrapper without first re-solving what "exchangeable calibration set"
  means for this data — cutoff-safety (games before the target week) is necessary but not
  sufficient; a genuinely held-out calibration slice separate from whatever data fit the point
  forecast is required, or the coverage guarantee is fiction dressed as rigor.
- Do not report `production_eligible: true` on any of this without an actual backtested coverage
  number — the point of conformal prediction is the guarantee is checkable, so it should be
  checked before being trusted.
