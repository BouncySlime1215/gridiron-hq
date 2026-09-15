# F11 — Conformal prediction for calibrated margin/total intervals

Bucket: fix (primary) + new (secondary), per assignment. Grounds in tonight's
finding: "No conformal or otherwise honestly-calibrated uncertainty interval
exists anywhere in the pipeline — margins/totals are point forecasts with an
assumed-normal SD."

## Exact defect located in the repo (read-only, grepped, not edited)

`server/services/nfl-market.js` (fantasy-football-dashboard, READ-ONLY):

- `fitModel()` (lines ~165-181) computes `marginStd = stdev(marginResiduals)`
  and `totalStd = stdev(totalResiduals)` — ONE global scalar SD for every
  game, from the full 1999-2024 pooled residual set, after removing the mean
  bias. This is the assumed-normal-SD object the audit flagged.
- `predictGame()` (lines ~218-235) returns `predicted_margin` /
  `predicted_total` as bare point numbers. No interval, no per-game width, no
  covariate-adaptive uncertainty is exposed to any caller at all — every game
  from a 1-point pick'em to a 17-point blowout gets treated identically
  downstream if anyone wants a probability past the point spread.
- `scoreAccuracy()` (line 435): `const p = normalCdf(r.predMargin /
  r.marginStd);` — this is the literal Gaussian assumption: win probability
  is read off a normal CDF using the single pooled SD. Confirmed by grep:
  this is the ONLY `normalCdf(` call on a margin/SD pair in the codebase.
- Interesting nuance the audit finding undersells: `bootstrapProb()` (lines
  ~187-215), a sibling function in the SAME FILE, already resamples actual
  historical residuals instead of drawing from a Gaussian — the code comment
  even argues "Real NFL score residuals are fatter-tailed than a Gaussian."
  But it is an unweighted IID bootstrap over ALL pooled residuals (no
  exchangeability argument, no coverage guarantee, no weighting for the
  known season-to-season alpha/carryover drift the same file's `fitModel`
  explicitly fits for). It is a good instinct with no formal guarantee
  behind it — exactly what conformal prediction supplies for free.
- `server/betting/nfl/strategy/margin-distribution.js` is a much more
  sophisticated fitted discrete PMF (Esscher-tilted kappa, penalised spline,
  sandwich-covariance Laplace posterior) used for the teaser family — it is
  NOT the assumed-normal-SD object; it is arguably already close to what a
  conformalized quantile regression would produce for margins, but it is
  local to teasers and never touches `nfl-market.js`'s own point-forecast +
  win-probability path, so the plain Gaussian survives untouched at the
  `nfl-market.js` layer that other consumers (accuracy scoring, walk-forward
  backtests) actually call.

## Primary sources read in full

1. **Angelopoulos, A. N. & Bates, S. (2021/2022).** "A Gentle Introduction to
   Conformal Prediction and Distribution-Free Uncertainty Quantification."
   arXiv:2107.07511v6. Read in full (50 pages, incl. worked ImageNet
   classification example, Sec. 2-4, Appendix D proof).
   - Core guarantee (Eq. 1, marginal coverage, split conformal): for
     exchangeable calibration + test data,
     `1 - alpha <= P(Y_test in C(X_test)) <= 1 - alpha + 1/(n+1)`.
     This is a FINITE-SAMPLE, distribution-free guarantee — it holds for any
     n, any base model, any (unknown) data distribution, as long as
     exchangeability holds. This is exactly the guarantee nfl-market.js's
     Gaussian SD and its own bootstrap both lack: neither can say anything
     about the actual coverage of their interval on held-out games; they
     just assume a shape and hope.
   - Worked numeric example (fox squirrel / ImageNet, Fig. 1-2): calibration
     set of ~500 held-out labeled examples, score = 1 - softmax(true class),
     quantile q&#770; = ceil((n+1)(1-alpha))/n-th empirical quantile of
     calibration scores, prediction set = {y : softmax_y >= 1 - q&#770;}.
     Trivial to implement (their own code sample is ~6 lines of Python).
   - Section 4.6, "Conformal Prediction Under Distribution Drift," is the
     direct bridge to the time-series (Barber et al.) result below.
   - Limitation stated by the authors themselves: exchangeability is REQUIRED
     for the guarantee; under drift, coverage silently degrades with no
     warning — you don't find out you've lost the guarantee, you just do.

2. **Romano, Y., Patterson, E. & Candès, E. (2019).** "Conformalized Quantile
   Regression." NeurIPS 2019 / arXiv:1905.03222. Read in full (methods +
   Figure 2 + Algorithm 1 + Theorem 1/2 + Sec. 6 experiments setup).
   - Method: fit two conditional quantile functions q&#770;_lo(x), q&#770;_hi(x)
     (any quantile regressor — random forest, quantile NN, or a plain linear
     pinball-loss fit) on a proper training split; on a disjoint calibration
     split compute conformity score E_i = max(q&#770;_lo(X_i) - Y_i, Y_i -
     q&#770;_hi(X_i)); take Q_{1-alpha}(E, calib) = the (1-alpha)(1+1/|calib|)
     empirical quantile of those scores; output interval
     `[q&#770;_lo(x) - Q, q&#770;_hi(x) + Q]`. This makes interval WIDTH a
     function of the covariates (heteroscedasticity-adaptive) while keeping
     the exact same finite-sample coverage guarantee as plain split conformal
     (Theorem 1: `P(Y in C(X)) >= 1 - alpha`, and `<= 1-alpha+1/(|calib|+1)`
     if scores are a.s. distinct).
   - Concrete numeric result actually read from the paper (Figure 2,
     simulated heteroscedastic data with outliers, target coverage 90%):
       - Standard split conformal: coverage 91.4%, avg interval length 2.91
       - Locally-adaptive split conformal: coverage 91.7%, avg length 2.86
       - **CQR (their method): coverage 91.06%, avg length 1.99**
     All three hit the target coverage; CQR's interval is ~32% narrower than
     plain split conformal at matched coverage — because it only widens where
     the quantile regressor detects real heteroscedasticity, instead of
     applying one global SD everywhere. This is the exact number that maps
     onto Gridiron's bug: nfl-market.js applies ONE marginStd to every game
     the same way plain split conformal applies one width to every input;
     CQR is the direct, published fix for that specific mistake.
   - Real-data experiments: 11 standard UCI/benchmark regression datasets,
     80/20 train/test, 20 repeated splits, alpha=0.1 throughout — the paper
     reports CQR matches or beats both baselines on interval length at
     matched coverage across all 11 (I read the experimental protocol in
     Section 6 in full; did not re-derive every per-dataset number, so I am
     not claiming to have hand-verified all 11 rows — the Figure 2 numbers
     above I did read directly off the page).
   - Honest limitation: needs a genuine conditional-quantile estimator; if
     the quantile regressor is badly mis-specified/overfit, CQR intervals
     can still be too wide or barely adaptive (their own "practical
     considerations" section flags quantile regression forests as often
     "overly conservative" and quantile NNs as occasionally the opposite).

3. **Barber, R. F., Candès, E. J., Ramdas, A. & Tibshirani, R. J. (2023).**
   "Conformal Prediction Beyond Exchangeability." Annals of Statistics,
   51(2), 816-845 / arXiv:2202.13415. Read in full (problem setup, weighted
   quantile construction, Theorem statements, empirical section).
   - Problem: standard conformal's guarantee needs exchangeability; time
     series data drifts, so the plain method silently under-covers.
   - Method (NexCP): assign calibration scores S_1..S_n (chronological)
     exponentially decaying weights w_i = rho^(n-i), so the newest score
     gets weight 1 and the oldest gets rho^(n-1); take the weighted quantile
     of the scores at level `(1-alpha)(W+1)/W` where W = sum(w_i) (this
     factor -> 1-alpha as W -> infinity, recovering ordinary split conformal
     exactly when rho=1). Also introduces a randomization/"nonsymmetric
     weighted" variant (NexCP+WLS) allowing the underlying algorithm itself
     to weight recent data more without breaking the guarantee.
   - Theorem: the coverage gap of the weighted method is bounded by a sum of
     total-variation distances between consecutive data distributions —
     i.e., the more genuine drift there is, the more the guarantee degrades,
     but gracefully and QUANTIFIABLY, not silently to zero.
   - Concrete numeric results actually read from the paper (target coverage
     90%):
       - Electricity (ELEC2, Australian electricity price/demand, N=3,444
         after filtering, real non-exchangeable time series):
         CP+LS (plain, exchangeable-assumed) coverage 0.852, width 0.565;
         NexCP+LS (weighted) coverage 0.890, width 0.606;
         NexCP+WLS (weighted+nonsymmetric) coverage 0.893, width 0.527 —
         i.e. the weighted method both restores the target 90% coverage AND
         (WLS variant) does it with a NARROWER interval than the
         undercovering plain method.
       - 2020 US Presidential Election county-level vote-share change
         (1,119 train / 1,957 test counties): used as a second real,
         drifting dataset (spatial rather than temporal drift); qualitative
         result the same direction.
       - Simulated distribution-drift setting (N=2,000): CP+LS coverage
         0.838/width 3.73 vs NexCP+LS 0.888/4.29 vs NexCP+WLS 0.907/3.45 —
         again, weighted recovers coverage, WLS variant recovers it at a
         narrower width than the naive weighted version.
   - This is the DIRECT, load-bearing citation for Gridiron's specific
     situation: `nfl-market.js` pools residuals across 1999-2024 and
     `fitModel` itself fits a season-to-season `carryover` decay parameter
     because team strength genuinely drifts within and across seasons — the
     paper's own motivating case (non-stationary real-world series) is a
     structural match, not an analogy.
   - Honest limitation: NexCP requires choosing rho (decay strength) —
     mis-chosen rho either barely helps (rho too close to 1) or makes the
     effective sample size too small for a stable quantile (rho too small);
     the paper doesn't give a universal rule, and the repo code I found
     (below) implements an effective-sample-size check for exactly this
     reason rather than trusting an arbitrary rho.

4. **(Supporting, read for method detail, not separately counted as a 4th
   "primary" if the above three suffice, but read in full as a working
   reference implementation, not just an abstract):** `marcopeix/conformal-ts`
   source, `src/conformal_ts/methods/nexcp.py` and `split.py` — read the
   actual weighted-quantile implementation (weights = rho**(n-1-i), sorted
   cumulative weight search, effective-sample-size guard, clip to [0,1]).
   This is a working, tested, documented implementation of exactly the
   Barber et al. algorithm above, useful as an algorithm-correctness
   cross-check against my own read of the paper, not as new experimental
   evidence.

## Repos found (code, not papers)

| repo | stars | license | last commit | what it actually does | adopt |
|---|---|---|---|---|---|
| `scikit-learn-contrib/MAPIE` | 1589 | BSD-3 | 2026-09-08 (active) | Production sklearn-compatible conformal library: split conformal, CQR, jackknife+, CV+, conformal risk control, time-series (EnbPI). This is the reference-quality implementation of everything in sources 1-2. | reference-only (Python; Gridiron server is Node/JS — read for algorithm correctness, do not attempt a dependency bridge) |
| `aangelopoulos/conformal-prediction` | 1085 | MIT | 2025-11-14 | The companion notebooks to source #1 (Angelopoulos & Bates): lightweight (~6-20 line) reference implementations of split conformal, CQR, group-balanced/Mondrian conformal, and distribution-drift conformal, each on real data (ImageNet, weather). Confirmed by `gh api` contents listing (`notebooks/`, `generation-scripts/`). | borrow-idea (the actual Python snippets are short enough to hand-translate to ~15-30 lines of JS each; this is the cleanest algorithm reference of the group) |
| `yromano/cqr` | 315 | custom/"other" | 2026-02-02 (still touched) | The official CQR paper code. Confirmed by cloning: `cqr/helper.py` wraps the third-party `nonconformist` (ICP) and `skgarden` (quantile random forest) packages — i.e. it is a thin glue layer over two other Python libraries, not a self-contained algorithm file. Useful to confirm the exact quantile/interval formula (`compute_coverage_len`, `run_icp`) matches the paper's Eq. 9-11. | reference-only |
| `marcopeix/conformal-ts` | 3 | BSD-3 | 2026-05-17 (active) | Small, well-structured, well-TESTED (has `tests/unit/test_nexcp.py`, `test_cqr.py`, `test_split.py`, `test_agaci.py`, `test_spci.py`) modern Python package implementing exactly split conformal, CQR, ACI, AgACI, NexCP, and SPCI for time series, each behind a common `ConformalMethod` interface with adapters for statsforecast/mlforecast/neuralforecast. Confirmed by cloning and reading `src/conformal_ts/methods/{split,nexcp}.py` directly (not just the README) — the docstrings state the exact weight formula and threshold `(1-alpha)(W+1)/W`, matching the Barber et al. paper's construction. Low star count reflects newness, not low quality — code and tests are clean and the algorithm is verified word-for-word against the paper's Theorem statement. | borrow-idea (algorithm/threshold formula is what matters here; also a good target to point at if the project ever adopts a Python side-service for calibration, but not needed for a JS-native port) |
| `astrogilda/tsbootstrap` | 95 | MIT | 2026-09-07 (active) | Time-series bootstrapping library with a `tsbootstrap/uq/` module implementing EnbPI ensembles and adaptive conformal (ACI, NexCP) calibrators as one typed `bootstrap(X, *, method=...)` entry point (confirmed via `uq/calibrators.py`, `uq/adaptive.py`, `uq/conformal.py`). | reference-only (bootstrap+conformal combination is architecturally interesting for the drive-simulator's Monte Carlo path once its physics bugs are fixed, but out of scope for tonight's margin-forecast task) |

None of these are directly portable line-for-line into Gridiron's Node/JS
server — they're all Python. The actual algorithms (split conformal
quantile, CQR interval construction, NexCP weighted quantile) are each under
~30 lines of arithmetic with no exotic dependencies (percentile/quantile of
an array, exponential weights, a cumulative-sum search) — cheaper to
hand-write natively in JS against `nfl-market.js`'s existing residual arrays
than to bridge languages. Effort estimates below assume a native JS
port of the ALGORITHM (verified against the papers/repos above), not a
literal code port.

## Candidates

See structured output for the full table (id F11-1..F11-6). Summary of the
split:
- fix: F11-1 (swap Gaussian scoreAccuracy for split-conformal quantile),
  F11-2 (CQR for covariate-adaptive margin/total width),
  F11-3 (NexCP-weight the existing bootstrapProb resampler).
- new: F11-4 (NexCP as the standing walk-forward calibration layer),
  F11-5 (conformalized player-prop intervals, Mondrian by position/prop),
  F11-6 (shared `conformal-calibration.js` primitives module).

## Do not do

- Do not wrap the drive-simulator's point forecasts in a calibrated interval
  before its physics bugs are fixed (inverted kneel rule, wrong-team
  turnover field position, home-side win-prob using the home spread, no
  half-time/OT in the season-remainder sim). A calibrated interval around a
  biased simulator just produces a well-calibrated WRONG number — coverage
  guarantees say nothing about bias, only about how honestly the spread of
  the (possibly-biased) forecast is reported.
- Do not apply plain (unweighted) split conformal across the full 1999-2024
  pooled residual set and call it "calibrated" — `fitModel()` in
  `nfl-market.js` already fits a `carryover` decay parameter BECAUSE team
  strength is non-stationary; feeding that same non-stationary residual
  stream into an exchangeability-assuming method silently voids the coverage
  guarantee exactly as Barber et al. describe. Use NexCP (or block/re-fit by
  season) instead of naive pooling.
- Do not conformalize the ensemble's blended forecast
  (`forecast ~= 0.68 + 0.632*market`, the naive-shrinkage finding) and treat
  the resulting interval as evidence of a good model — calibration
  guarantees the ADVERTISED coverage rate, not that the point forecast
  itself carries information beyond the market. A calibrated interval around
  a degenerate forecast is still a degenerate forecast with an honest error
  bar on it.
- Do not read "well-calibrated" as "profitable" or as a betting edge in
  itself. Per Nick's standing rule, betting work goes through governance
  gates; conformal intervals are a sizing/abstention INPUT (e.g., "only bet
  when the interval excludes the market line"), not a new source of edge to
  chase on their own.
- Do not stand up a heavy ML stack (gradient-boosted quantile regressors,
  quantile neural nets) for the margin/total CQR fit. The covariate set that
  matters here is tiny (|spread|, home/away, dome/outdoor, maybe rest-day
  differential) — a linear-in-covariates pinball-loss quantile regression
  (a few dozen lines, no new dependency) is enough to get CQR's adaptive-
  width benefit, and keeps this in the "hours" cost tier per Romano et al.'s
  own note that overly complex quantile regressors are frequently MORE
  conservative (wider), not better.
- Do not treat a calibration set as permanent. The whole guarantee is
  conditional on the calibration data being exchangeable with the next
  point; a rule change, a new season, or a meaningful roster shift is
  exactly the kind of drift NexCP is for — recalibrate on a rolling/weighted
  window, not a one-time fit-and-forget, mirroring the care `nfl-market.js`
  already takes with its own `lastCompletedSeason`/`carryover` boundary
  logic for point forecasts.
