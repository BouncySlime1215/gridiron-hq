# GN06 — Mixture Density Networks / Normalizing Flows for a probabilistic margin-forecast head

Bucket: **new**. Task: read 3-4 real MDN/normalizing-flow regression repos (full predictive
distributions, not point estimates) and specify the exact new output contract for a
probabilistic margin-forecast head for Gridiron's NFL model.

## The defect this replaces (verified tonight, in the read-only repo)

`fantasy-football-dashboard/server/services/nfl-ensemble.js:207-252`, function
`predictiveDistribution(hist, {margin, total, homeSpread, marketTotal, disagreement})`:

- It is **not a model**. It filters `hist` (completed games) to a "similar spread/total"
  cohort, takes each historical game's `margin_residual = (home_score-away_score) -
  (-home_spread)`, subtracts the cohort's residual median, multiplies by a hand-tuned
  `inflation = 1 + min(0.25, max(0,disagreement)/30)` factor, and adds the point forecast
  `margin`. That resampled-and-shifted set of ~100-500 historical residuals *is* the
  "predictive distribution" — quantiles are just `quantile()` calls over that list.
- It explicitly self-labels: `calibration_state: 'research_distribution_only',
  production_eligible: false`. The author already knows this is not a real distribution.
- No closed-form pdf/cdf exists anywhere — every consumer (cover probability, win
  probability, quantiles) is a `filter().length / length` count over ~100-500 discrete
  resampled points. That means no genuine tail behavior, no smooth density for a
  calibration test (PIT/CRPS) to score against, and quantiles jump in fixed-size steps
  determined by cohort size, not by any theory of the margin's shape.
- The function signature `(context) -> {margin, total}` per game (per file comment
  "Every model is a function of (context) -> { margin, total }") is exactly the
  <sample-features> -> <point-forecast> shape a real distributional head would extend to
  <sample-features> -> <full conditional distribution over margin>.

This is the exact attachment point for everything below.

## Repos read (cloned/fetched into `github/` alongside other agents' repos)

### 1. `stanfordmlgroup/ngboost` — Natural Gradient Boosting for Probabilistic Prediction
- License: Apache-2.0. Stars: 1,888. Last commit: 2026-09-01 (`#416`, actively maintained).
- Verified by reading (not README): `ngboost/ngboost.py` implements gradient-boosted trees
  where each boosting round fits one `DecisionTreeRegressor` **per distribution parameter**
  (`fit_base`), using the **natural gradient** (`scores.py: Score._natural_gradient` —
  solves `metric @ x = grad` per sample, i.e. divides the ordinary gradient by the
  distribution's Fisher information) rather than the raw gradient. `line_search` then picks
  a step size that actually decreases the total score before committing.
  `ngboost/distns/normal.py` shows the payoff: `Normal` wraps `scipy.stats.norm(loc, scale)`
  and via `__getattr__` transparently exposes `.pdf`, `.cdf`, `.ppf`, `.mean`, `.rvs` —
  a genuine closed-form conditional distribution per row, with both `LogScore` (MLE) and
  `CRPScore` (proper, robust-to-misspecification CRPS) implementations already written out
  (`NormalCRPScore.score`/`d_score`/`metric` in the same file). `api.py`'s `NGBRegressor`
  is the sklearn-style wrapper (`.fit(X,y)`, `.pred_dist(X)` returning the fitted
  distribution object, `.predict(X)` returning the point mean).
- **Adopt: port.** This is Python/sklearn, Gridiron is Node — "port" here means running
  NGBoost as an offline/nightly batch job over exported features, not embedding the
  library at request time.
- Attachment: replace the *contents* of `predictiveDistribution()` — keep its signature,
  but instead of resampling historical residuals, look up a per-game `(loc, scale)` pair
  from an NGBoost `Normal` fit (trained offline on the same `hist` rows already being
  filtered), and derive `margin_quantiles`, `margin_interval_80/50`,
  `home_win_probability` (`1 - norm.cdf(-margin/scale-ish)` — concretely
  `1 - normalCdf(0, loc, scale)`), and `home_cover_probability`
  (`1 - normalCdf(-homeSpread, loc, scale)`) analytically instead of by counting resampled
  points. `CRPScore` in particular is worth citing because it's the same proper scoring
  rule already implicit in the Nick's-model doc's "measured skill" framing (Brier for
  props) — CRPS is its continuous-margin analogue.

### 2. `tonyduan/mixture-density-network` — minimal PyTorch MDN
- License: MIT. Stars: 154. Last commit: 2023-05-17 (unmaintained but stable — it is a
  ~130-line reference implementation of Bishop 1994, not a moving target).
- Verified by reading the entire repo (it's two files, `src/blocks.py` 85 lines and
  `examples/ex_1d.py` 58 lines — read in full, not skimmed):
  - `MixtureDensityNetwork.forward(x)` runs two independent small MLPs from the context
    `x`: one outputs `log_pi` (mixture weights via log-softmax over `n_components`), the
    other outputs `mu` and `sigma` per component (`sigma = exp(raw + eps)` for the
    `DIAGONAL` noise type — guarantees positivity without a separate softplus).
  - `.loss(x, y)` is exact Gaussian-mixture negative log-likelihood via
    `torch.logsumexp(log_pi + normal_loglik, dim=-1)` — numerically stable, no
    approximation.
  - `.sample(x)` draws a component index per row from the categorical `log_pi` via
    inverse-CDF (`torch.searchsorted` on `cumsum(exp(log_pi))`), then a Gaussian draw from
    that component's `(mu, sigma)` — this is exact ancestral sampling, not an
    approximation.
  - The example (`ex_1d.py`) fits `x -> y` where `y` is genuinely multimodal given `x`
    (`x = 7*sin(5*y) + 0.5*y + noise`, so a single `x` can map to several plausible `y`),
    which is the precise scenario a plain Normal-mean regressor cannot represent and a
    single-Gaussian NGBoost head also cannot represent (NGBoost's `Normal` is unimodal by
    construction) — margins in games where two live storylines are plausible (garbage-time
    blowout vs. backup-QB-keeps-it-close) are a real candidate for genuine multimodality.
- **Adopt: port.** The forward pass (two 3-layer MLPs, softmax, exp) is ~40 lines and has
  zero dependencies beyond matrix multiply + softmax + exp — trivial to re-implement
  natively in JS for inference. Training stays offline in Python (this exact file, almost
  unmodified) producing a weights JSON; the *inference-time* consumer in
  `nfl-ensemble.js` never needs PyTorch.
- Attachment: same as above — swap into `predictiveDistribution()`. Quantiles of a
  Gaussian-mixture CDF have no closed form, so require bisection on the (monotonic) mixture
  CDF `sum_k pi_k * Phi((x-mu_k)/sigma_k)` — a ~15-line JS root-find, still far cheaper and
  more principled than resampling.

### 3. `probabilists/zuko` — normalizing flows in PyTorch (actively maintained)
- License: MIT. Stars: 466. Last commit: 2026-03-10 (`v1.6.0` — actively maintained,
  successor project to `bayesiains/nflows`).
- Verified by reading `zuko/lazy.py`, `zuko/flows/spline.py`, and the README's own usage
  example (cross-checked against the actual class signatures, not taken on faith):
  - The core abstraction is `LazyDistribution.forward(c) -> torch.distributions.Distribution`
    (`zuko/lazy.py:29-47`) — i.e. **a context vector in, a full distribution object out**,
    exposing that distribution's real `.log_prob(x)`, `.sample((n,))`, `.rsample(...)`. This
    is the cleanest literal instantiation of "(context) -> full conditional distribution"
    that exists among the repos read.
  - `zuko.flows.NSF` (`zuko/flows/spline.py:20-60`, Neural Spline Flow, Durkan et al. 2019)
    is a `MAF` (masked autoregressive flow) whose per-dimension transform is a
    `MonotonicRQSTransform` (monotonic rational-quadratic spline) — read the actual
    `__init__`, it just calls `super().__init__(..., univariate=partial(MonotonicRQSTransform,
    slope=slope), shapes=[(bins,), (bins,), (bins-1,)], ...)`, confirming the transform is
    genuinely learned per-context (spline knot positions/heights/derivatives are outputs of
    a small conditioner network on the context), not a fixed parametric family. For a
    1-D margin (`features=1`) this yields an arbitrarily-shaped, exactly-invertible,
    exact-density conditional distribution — skew, fat tails, bimodality all representable
    without picking a component count in advance.
  - Confirmed usage contract straight from the README and cross-checked against the class:
    `flow = zuko.flows.NSF(3, 5, transforms=3, hidden_features=[128]*3)`;
    `loss = -flow(c).log_prob(x)`; `flow(c_star).sample((64,))`.
- **Adopt: call**, not port — the monotonic rational-quadratic spline transform
  (`zuko/transforms.py`) is nontrivial numerics (forward+inverse spline evaluation with
  correct log-det-Jacobian) and not worth hand-porting to JS. Run it as a small always-local
  (localhost-only, no external network, no paid API) Python sidecar process that Gridiron's
  Node service calls over HTTP for `{pdf, cdf via numerical integration of pdf, sample}`
  given a context vector; NFL game volume (≤16/week) makes per-request Python inference
  latency irrelevant.
- Caveat found by reading, not assumed: flows are typically data-hungry, and Gridiron's own
  diagnostic notes put total playable history at low thousands of games — NSF is the
  highest-capacity, highest-overfitting-risk option of the three and should be the last one
  turned on, gated on an actual held-out log-likelihood beating the MDN and NGBoost heads.

### 4. `bayesiains/nflows` — normalizing flows in PyTorch (predecessor to zuko)
- License: MIT. Stars: 1,019. Last commit: 2024-12-27 (maintenance has effectively moved to
  `zuko`, per `zuko`'s own README acknowledgment — confirmed by comparing commit cadence).
- Verified by reading `nflows/distributions/mixture.py` in full: `MADEMoG` is a **conditional
  Mixture-of-Gaussians density estimator** — a single `MixtureOfGaussiansMADE` network maps
  `context -> (log_pi, mu, sigma)` for `num_mixture_components` components, exposing
  `_log_prob(inputs, context)` and `_sample(num_samples, context)`. This is architecturally
  the same idea as `tonyduan/mixture-density-network` (context-conditioned Gaussian mixture)
  but wrapped inside `nflows`'s heavier `Distribution`/`Transform` class hierarchy, and it
  is the older, less-maintained project.
- **Adopt: reference-only.** Confirms the MoG-via-MADE pattern is a well-established,
  independently-reinvented idea (both `tonyduan`'s from-scratch version and `nflows`'s
  MADE-conditioned version arrive at the same math), which raises confidence in candidate
  #2 above, but there is no reason to pull in `nflows` itself when `tonyduan`'s version is
  10x smaller and easier to port, and `zuko` is the actively-maintained flow library if a
  full flow (not just a MoG) is wanted later.

## The exact new output contract (all three heads implement this identically)

Replace `predictiveDistribution()`'s return value with an object that is a strict superset
of today's fields (so no downstream consumer breaks) plus the pieces today's empirical
resample cannot provide — a real pdf/cdf and a provenance/calibration record:

```js
{
  method: 'ngboost-normal' | 'mdn-3component' | 'nsf-flow-v1',   // which head produced this
  distribution: {
    family: 'normal' | 'gaussian-mixture' | 'spline-flow',
    params: { /* e.g. {loc, scale} | {pi:[], mu:[], sigma:[]} | {knots: [...]} */ }
  },

  // unchanged shape from today, but values now come from the closed-form pdf/cdf,
  // not from counting resampled points:
  margin_quantiles: { p10, p25, p50, p75, p90 },
  margin_interval_80: [lo, hi],
  margin_interval_50: [lo, hi],
  home_win_probability: number,     // 1 - cdf(0)
  home_cover_probability: number,   // 1 - cdf(-homeSpread)
  away_cover_probability: number,   // cdf(-homeSpread)
  push_probability: number,         // for integer spreads only; 0 for flow/continuous heads
  uncertainty_width_80: number,     // hi80 - lo80, unchanged definition

  // new — not derivable from the old resample-based version at all:
  pdf: (x: number) => number,       // exact density, enables PIT/CRPS scoring
  cdf: (x: number) => number,       // exact CDF, replaces every filter().length/length call
  sample: (n: number) => number[],  // exact ancestral/inverse-CDF sampling, replaces bootstrap

  training_metadata: {
    n_train: number,
    fit_date: string,
    held_out_log_likelihood: number,   // or held_out_crps for the NGBoost/CRPS variant
    held_out_period: string
  },
  calibration_state: 'model_fit_uncalibrated' | 'model_fit_pit_checked' | 'research_distribution_only',
  production_eligible: boolean
}
```

`sample_size`/`conditional_cohort` (today's cohort-selection diagnostics) drop out entirely
once there is a real model — they were only meaningful because the "distribution" was
literally the resampled cohort.

## Do-not-do

- Do not swap in a flow (`zuko`/`nflows`) as the *first* production head. Start with
  NGBoost-Normal (cheapest, most robust, closed-form, few knobs) or the ported MDN
  (captures multimodality, still tiny), and only add the flow sidecar if a held-out
  log-likelihood/CRPS comparison actually shows it beating both — flows are the
  highest-overfitting-risk option on a few-thousand-game dataset, confirmed by reading the
  method, not assumed.
- Do not embed PyTorch/Python inference in the hot request path unconditionally. NGBoost and
  the ported MDN should run training offline and serve a tiny precomputed lookup or a ~40-line
  ported JS forward pass at request time; only the flow needs a live local sidecar, and only
  because its transform is genuinely too complex to re-derive in JS by hand.
- Do not conflate this with the ensemble's blend-collapse defect (`0.68 + 0.632·market`) —
  that is a *point-forecast combination* problem; this candidate replaces the *distribution
  around* whatever point forecast survives that separate fix.
