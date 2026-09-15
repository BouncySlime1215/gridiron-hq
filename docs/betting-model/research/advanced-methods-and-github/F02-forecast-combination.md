# F02 — Real forecast combination to replace nfl-ensemble.js's naive shrinkage

## The defect, exactly where it lives

`server/services/nfl-ensemble.js` builds 31 independent-premise models (Massey, Colley,
Pythagenport, margin-Elo, EPA variants, market anchor, etc. — `MODELS` array, lines
318-... , 31 `id:` entries). Two blend modes exist (`ensembleLine`, lines 1220-1330):

- `raw` — weighted average of every model's own margin, weight = `exp(-0.7 * held_out_rmse)`
  normalized over the pool (`rawWeight`, lines 1160-1170; `blend()`, lines 1273-1283).
- `market_residual` — **the production path**. Every one of `nfl-forecast-identity.js`
  (line 41), `nfl-unified-engine.js` (line 40), `nfl-auto-picks.js` (line 83), and
  `nfl-cover-calibration.js` (line 276) hardcodes `blendMode: 'market_residual'`.

The `market_residual` math (nfl-ensemble.js:1291-1299):

```
residualMargin = marketMargin + Σ_m [ residual_weight_m * residual_slope_m * (model_margin_m − marketMargin) ] / Σ residual_weight_m
```

Each `residual_slope_m` is a **no-intercept OLS regression of the market's eventual error
on that one model's own deviation from the market** (lines 1112-1143):

```js
const slope = denominator > 0
  ? fitSignal.reduce((s, x, i) => s + x * fitActual[i], 0) / denominator : 0;
```

fit on one chronological half, graded on the other (the "M05" fix, comment lines 1097-1111).
So the final number is `market + (weighted average of 31 separate single-covariate
regressions against the market)`. That collapses, empirically, to `forecast ≈ 0.68 +
0.632·market` — a scalar shrinkage toward the close, not a real multivariate combination —
because (a) the 31 "signals" are mostly correlated transformations of the same handful of
underlying ratings ideas (Massey/Colley/point-diff/turnover-regressed are all margin-based;
EPA-net/EPA-neutral/success-rate/explosive/drive-eff are all play-efficiency based — call it
~3 independent factors), and (b) no step ever fits the models **jointly** — every slope is
estimated one-model-at-a-time against the market, never against each other, so the "ensemble"
never has the chance to learn that two models are redundant.

The inclusion gate for a component (lines 1185-1188) is a single paired t-stat on one
chronological split:
```js
m.residual_diagnostic_passed = m.residual_n >= 250
  && m.residual_rmse_gain >= 0.03 && m.residual_paired_t <= -1.645;
```
That is a Diebold-Mariano-*shaped* statistic (paired squared-error difference, t-ratio) but:
unconditional (no information-set conditioning), single-split (not the OOF-1,
week-clustered standard `nfl-cover-calibration.js` uses elsewhere per the code's own
comment, lines 1179-1184), and never benchmarked against the one alternative the literature
says is hardest to beat — **equal weights**. `weighting: 'equal'` already exists in the code
(line 1167, `if (weighting === 'equal') return 1;`) and is never used in production
(`nfl-forecast-identity.js:44` only allows `['exponential', 'inverse_mse', 'equal']` but the
default and every caller pass `'exponential'`). Nobody has ever run the equal-weight
ensemble against the exponential/market-residual one and tested whether the difference is
real.

## Primary sources read in full

1. **Yao, Y., Vehtari, A., Simpson, D., Gelman, A. (2018). "Using Stacking to Average
   Bayesian Predictive Distributions (with Discussion)." Bayesian Analysis 13(3).**
   https://arxiv.org/abs/1704.02030 — read pages 1-22 of the PDF.
   Key result: stacking solves
   `max_w (1/n) Σ_i log Σ_k w_k p(y_i | y_{-i}, M_k)` s.t. `w_k ≥ 0, Σw_k = 1` (Eq 2.2),
   using Pareto-smoothed-importance-sampling LOO (PSIS-LOO) to get the leave-one-out
   predictive density `p(y_i|y_{-i},M_k)` without refitting n times (Eq 2.4). This is
   provably the M-open-consistent generalization of Bayes model averaging (BMA collapses
   to the single closest-KL model as n→∞; stacking instead finds the best point *in the
   simplex of predictive distributions*, Thm./§2.2). Simulation: n from 3 to 300,
   correlation between candidate predictors from −0.3 to 0.9, 100 repeats × 100 test
   points; stacking-of-predictive-distributions and their cheap "Pseudo-BMA+" (Bayesian
   bootstrap-regularized AIC-type weights, Eq 2.6) beat BMA, plain model selection, and
   full mixture models in every condition tested (Fig. 6, §3.2-3.4), and are robust to
   high correlation among candidates (directly relevant: our 31 models are highly
   correlated). Named honest limitation: stacking is unstable for very small n
   (n < ~5× effective parameters, §3.2, Fig. 5) — LOO variance dominates below that.

2. **Claeskens, G., Magnus, J.R., Vasnev, A.L., Wang, W. (2016). "The forecast combination
   puzzle: A simple theoretical explanation." International Journal of Forecasting 32(3),
   754-762.** https://www.janmagnus.nl/papers/JRM113a.pdf — read in full (8 pp).
   Key result: when weights are *estimated* rather than fixed, the combined forecast is
   *biased* even if every input forecast is unbiased (Eq. 3: `E[y_c] = μ + cov(w, y1−y2)`),
   because the estimated weight is correlated with the very forecast errors it's built
   from. Proposition 3.1 gives the exact MSE decomposition (mean + variance + a bias term
   `δ` from third/fourth co-moments of `(y,w)` jointly). Numerical illustration: an AR(2)
   forecast-combination Monte Carlo, T=30 observations, **1,000,000 replications**
   (following Smith & Wallis 2009's design) — variance of the combination is 3-4% larger
   with the estimated weight than with the fixed 1/2 weight when φ1=φ2 (Table 1), and up
   to ~15% larger when the two forecast variances differ substantially (Table 2).
   Practical takeaway stated explicitly (§5): ignore estimated covariances between
   forecast errors and base weights on inverse-MSE at most — full covariance-aware
   "optimal" weighting (Bates-Granger's original two-forecast regression form, or ours)
   routinely makes things worse once you pay for estimating the extra terms.

3. **Giacomini, R., White, H. (2006). "Tests of Conditional Predictive Ability."
   Econometrica 74(6), 1545-1578.** (working-paper text at fmwww.bc.edu/EC-P/wp572.pdf,
   April 2003 version) — read in full (11 pp of theory).
   Key result: reframes forecast comparison as a test of *conditional* (not unconditional)
   equal predictive ability of a **forecasting method** (model + estimation procedure +
   window), H0: `E[ΔL_{m,t+τ} | F_t] = 0` (Eq. 3), which is testable via the Wald statistic
   `T^h_{n,m} = n · Z̄'_{m,n} Ω̂_n^{-1} Z̄_{m,n} →d χ²_q` (Eq. 4, Theorem 1), where
   `Z_{m,t+1} = h_t · ΔL_{m,t+1}` for a chosen test-function/instrument vector `h_t`
   (e.g. `h_t=1` recovers an unconditional Diebold-Mariano-style test as a special case;
   richer `h_t` — lagged disagreement, market vig regime, week-of-season — lets the test
   detect predictability that a plain DM test on the full sample average would miss).
   Explicitly designed for heterogeneous/non-stationary data (no stationarity assumption),
   finite estimation windows (so estimation uncertainty never vanishes asymptotically —
   directly the situation of a rolling in-season NFL fit), and both nested and non-nested
   model comparisons in one framework. Their own empirical illustration: 146 monthly
   macro series, 1-/6-/12-month-ahead forecasts, comparing sequential selection vs.
   Stock-Watson diffusion indices vs. Bayesian shrinkage — the "sophisticated" sequential
   selection method is *routinely beaten* by a naive AR/random-walk benchmark once judged
   this way.

4. **Diebold, F.X., Mariano, R.S. (1995). "Comparing Predictive Accuracy." Journal of
   Business & Economic Statistics 13(3), 253-263.** — read in full (4 pp of core theory +
   test-statistic derivations).
   Key result: `S1 = d̄ / sqrt(2π f̂_d(0)/T) →d N(0,1)` under H0 of equal expected loss
   (§1.1), valid for *any* loss function (not just quadratic), non-Gaussian, non-zero-mean,
   serially- and contemporaneously-correlated forecast errors — the point being that the
   naive `F`-test on the ratio of squared-error variances (§2.1) requires four assumptions
   that essentially never hold for real forecasts (independence of forecast errors chief
   among them), which is exactly why nfl-ensemble.js's own paired-t stat (lines 1125-1129)
   needs the Harvey-Leybourne-Newbold small-sample correction to be trustworthy at
   realistic NFL sample sizes (~270 games/season × a few seasons out-of-fold).
   Cross-checked implementation: `johntwk/Diebold-Mariano-Test` (below) — its 40 lines of
   real logic are the DM stat plus exactly the Harvey et al. (1997) correction factor
   `sqrt((T+1-2h+h(h-1)/T)/T)`, confirming the formula is this simple to port.

5. (Secondary, not independently fetched, cited via Claeskens et al.'s direct quotations)
   **Smith, J., Wallis, K.F. (2009). "A Simple Explanation of the Forecast Combination
   Puzzle." Oxford Bulletin of Economics and Statistics 71(3), 331-355.** Their three
   conclusions, quoted verbatim in Claeskens et al. §5: (1) a simple average is expected to
   be more accurate (MSFE) than a combination based on estimated weights; (2) if estimated
   weights must be used, ignore forecast-error covariances entirely — inverse-MSE weights
   alone beat the full Bates-Granger regression generalization; (3) with many competing
   forecasts, gains from unequal weighting are typically not statistically significant.

## Repos checked

- **johntwk/Diebold-Mariano-Test** (github.com/johntwk/Diebold-Mariano-Test) — MIT,
  1 star-worthy small script, 127 stars, last commit 2017-12-07 (stale but the math
  doesn't age). `dm_test.py` (164 lines, ~40 real): builds the loss-differential series
  under MSE/MAD/MAPE/power loss, computes the HAC-style variance
  `V_d = (γ0 + 2·Σγ_{1..h-1})/T` via sample autocovariance, then
  `DM = V_d^{-1/2}·d̄ · harvey_adj`. Confirms the DM statistic is ~40 lines — cheap to
  **port** directly into JS rather than adding a Python/R runtime dependency to a Node
  service. Attachment point: replace the ad hoc paired-t at nfl-ensemble.js:1125-1129 with
  this exact statistic (extended to the Giacomini-White conditional form by swapping the
  scalar `ΔL` for `h_t·ΔL_t` and using a proper HAC `Ω̂` instead of the current
  unconditional variance).
- **ceweiss/ForecastComb** (github.com/ceweiss/ForecastComb) — GPL (>=2), 28 stars, last
  commit 2018-08-04 (stale, but it's a reference catalog, not a running service). R
  package implementing the full textbook menu of forecast-combination weight schemes as
  separate files: `comb_SA.R` (simple average, `w=1/N`), `comb_BG.R` (Bates-Granger
  inverse-MSE, no covariance term — exactly what Smith & Wallis recommend as the ceiling
  of complexity worth paying for), `comb_CLS.R` (constrained least squares — the simplex-
  constrained regression that is the non-Bayesian analogue of Yao et al.'s stacking-of-
  means), plus `comb_OLS`, `comb_WA`, `comb_EIG1-4` (Hsiao-Wan eigenvector weighting),
  `comb_NG`, `comb_InvW`, `comb_MED`, `comb_LAD`, `comb_TA`, `comb_CSR`. Adopt as
  **borrow-idea / reference-only** (R, GPL, not called from Node) — it is the concrete
  evidence that "equal average" and "inverse-MSE, no covariance" are first-class named
  methods in the literature, not a fallback to be embarrassed about; Gridiron's own
  `weighting: 'equal'` option (nfl-ensemble.js:1167) already *is* `comb_SA`, and
  `weighting: 'inverse_mse'` (line 1168) already *is* a variant of `comb_BG`. Both exist
  in code and are never selected in production or benchmarked against what is selected.

## Do not do

- Do not add a Stan/R/Python dependency to the Node service to get "real" Bayesian
  stacking — the DM/GW test and CLS/stacking-of-means optimization are both small enough
  (a constrained least-squares QP in ≤31 dimensions, a HAC variance estimator) to
  implement natively in JS. Reference the papers' formulas, port johntwk's ~40 lines, do
  not shell out to R.
- Do not add more models to the ensemble to chase the "20+ components" framing. The
  finding is the opposite: 31 models collapse to ~3 independent factors, so the priority
  is a correlation/PCA-based *reduction* step before any weight optimization, not more
  inputs. Adding models without addressing collinearity will make stacking's simplex QP
  more degenerate, not less.
- Do not let the new stacking or CPA-gate weights bypass the existing walk-forward cutoff
  discipline (`beforeSeason`/`beforeWeek` in `fitEnsemble`) or the week-boundary split
  fix (C07, nfl-ensemble.js comment lines 1148-1152). A leave-one-*game*-out LOO for
  stacking must still respect "no two games from the same week straddle the fit/score
  boundary" — same bug class as the one already found and fixed once.
- Do not treat a single significant DM/GW test as production promotion. Multiple models
  are being tested against the market (31 of them) — this needs the same multiplicity
  correction (Holm/PBO) flagged elsewhere for the 21-model historical search; a per-model
  GW test at α=0.05 across 31 models will falsely promote ~1.5 components by chance alone
  with no correction.
- Do not compute stacking weights once per season and freeze them; Claeskens' bias term
  (`cov(w, y1-y2)`) gets worse, not better, the more stale the estimation window is
  relative to the current season's regime (injuries, rule changes, roster turnover).
