# N10 — Neural probabilistic forecasting (MDN / normalizing flows / DeepAR) as a new output contract for Gridiron

Researcher: N10-mixture-density-neural-forecasting | bucket: new | phase: ResearchNew

## 0. What Gridiron has today (grepped, not assumed)

`server/services/nfl-online-neural.js` (367 lines) is the only neural head in the
betting stack. It is a hand-rolled single-hidden-layer tanh MLP (`HIDDEN = 10`,
`createNetwork`/`forward`/`trainBatch`, lines 50-110) trained by full-batch weekly
SGD with a Huber loss and a 512-example replay buffer (`trainBatch`, `L: 77-110`).
Its output is **one scalar**: `OUTPUT_BOUND * tanh(z)`, a bounded residual added to
the market margin (`forward`, L63-67; `onlineNeuralPrediction`, L175-187). There is
no variance, no quantiles, no distribution of any kind — `predicted_margin` is a
point estimate exactly like the market spread it's trying to beat. The docstring
even names the intended future heads (`total_residual`, `player_props`, etc., all
currently `state: 'scaffolded'`, ONLINE_NEURAL_HEADS L22-31) but every one of them
inherits the same scalar-output architecture once built.

`server/services/player-week-engine.js` (`playerWeekProjection`, L74-83, and
`playerPropEligibility`, L93-118) produces point parameters — `attempts`,
`carries`, `targets` — per player-week. `nfl-props.js`'s own header (L1-14) says
outright: "A prop is a question about a distribution... but a point estimate alone
cannot answer it" — the code simulates *after* the point params are fixed, but the
underlying volume/efficiency model that feeds the simulator is still point-valued,
not a learned negative-binomial/hierarchical distribution. This matches tonight's
FOUND bullet on props directly.

`server/betting/nfl/strategy/teaser-leg-rates.js` (L1-40+) explicitly documents
zero same-game leg pairs in its Wong-teaser candidate family and, per tonight's
findings, assumes independence across legs sharing a game — there is no joint
density anywhere in the repo over (margin, total, player props) for one game.

`server/services/nfl-preseason-blend.js` is a genuine correction worth noting:
as of 2026-09-10 it already implements a proper normal-normal Bayesian posterior
blend (`sigma^2/(sigma^2 + n*tau^2)`) for team strength, replacing an earlier
inverted formula. So the FOUND bullet "team-strength mixes stale priors ... via a
hand-tuned blend, not a principled Bayesian update" is **partially stale**: the
season-level prior/in-season blend is now principled. What is still missing is a
genuinely *sequential* (game-by-game, not single-shot conjugate) probabilistic
model conditioned on the 251,591-row play-by-play table, which nothing in the repo
touches for sequence modeling — that gap is real and is what candidate C6 below
targets, framed honestly as new capability rather than a "fix" for a bug that (in
this file) no longer exists.

## 1. Primary sources read

### S1 — Bishop, C.M. (1994). *Mixture Density Networks*. NCRG/94/004, Aston University.
[https://publications.aston.ac.uk/id/eprint/373/1/NCRG_94_004.pdf](https://publications.aston.ac.uk/id/eprint/373/1/NCRG_94_004.pdf) — **read in full** (14pp PDF fetched and read directly).

Read the actual PDF (not a summary page). Confirmed formulation, verbatim from the
equations:
- Output is a Gaussian mixture `p(t|x) = Σ_i α_i(x) φ_i(t|x)` (eq. 22), with
  `φ_i` a spherical Gaussian of mean `μ_i(x)` and shared-per-component scalar
  variance `σ_i(x)` (eq. 23).
- Network emits `(c+2)×m` raw outputs for `m` components and `c` target dims:
  mixing logits → softmax → `α_i` (eq. 25, guarantees `Σα_i=1`); log-variance
  outputs → `exp(z_i^σ)` → `σ_i` (eq. 26, guarantees positivity, "informative
  prior" trick that also avoids the classic collapsing-variance pathology);
  centers `μ_ik = z_ik^μ` directly (eq. 27).
- Loss is negative log-likelihood, `E^q = -ln{Σ_i α_i φ_i}` (eq. 29), trained here
  with BFGS quasi-Newton (paper's choice) but back-prop-compatible via closed-form
  gradients w.r.t. each output group (eqs. 35, 38, 39) — these three gradient
  expressions are exactly what Gridiron's `trainBatch` would need to swap in for
  its current Huber-on-scalar gradient.
- Sample/evaluation: a synthetic two-variable toy inverse problem (chosen so the
  forward map is one-to-many, i.e. classic least-squares fails to see the
  multimodality) and a real robot inverse-kinematics dataset (multiple joint-angle
  solutions map to one end-effector position — the textbook case where a
  single-Gaussian/point output is provably wrong because the true conditional is
  multimodal). Paper doesn't tabulate a modern accuracy metric (1994, pre-standard
  benchmarks) — the "result" is qualitative-but-rigorous: MDN recovers the correct
  multi-branch conditional density where a least-squares net collapses to the
  (meaningless) average of the branches, shown by direct comparison of the fitted
  density against ground truth.
- Honest limitation acknowledged in the paper itself: spherical (not full)
  covariance per component is a modeling simplification (assumes independence of
  output dims within a component — irrelevant for Gridiron's scalar margin/total
  heads, but matters if Gridiron ever jointly outputs (margin, total) from one MDN
  head, see C2/C5 below); finding the single most-likely mode is a non-convex
  argmax problem, addressed only approximately (eq. 48-49).

### S2 — Salinas, D., Flunkert, V., Gasthaus, J. (2020, orig. 2017). *DeepAR: Probabilistic Forecasting with Autoregressive Recurrent Networks*. International Journal of Forecasting 36(3). arXiv:1704.04110.
[https://arxiv.org/abs/1704.04110](https://arxiv.org/abs/1704.04110) — **read in full** (fetched full HTML body via ar5iv, not just abstract).

- Model: single global LSTM trained across many related series; at each step the
  RNN hidden state parameterizes a likelihood (Gaussian for real-valued, negative
  binomial for count data) rather than a point; multi-step forecasts sampled
  autoregressively (Monte Carlo unroll).
- Datasets/sample, exact from the results table: `parts` (1,046 monthly series,
  8-month horizon, count data), `electricity` (370 series, hourly, 24h horizon),
  `traffic` (963 series, hourly, 24h), `ec-sub` (39,700 weekly series), `ec`
  (534,884 weekly series, both count/demand data).
- Headline result, exact numbers: electricity ND=0.07 vs matrix-factorization
  baseline ND=0.16 (RMSE 1.00 vs 1.15); traffic ND=0.17 vs 0.20 (RMSE 0.42 vs
  0.43); on `parts`/`ec`/`ec-sub` DeepAR's normalized quantile loss is
  0.94/0.85/0.77 of the ISSM (classical structural time-series) baseline —
  i.e., a real, measured, double-digit-percent error reduction against a
  non-neural benchmark, not a self-comparison.
- Stated limitation (their own words): missing-data evaluation needs
  "non-standard adjusted metrics that are hard to compare across studies," so
  they omit it; scheduled-sampling variants (mitigating train/inference mismatch
  in autoregression) "showed no improvement" over plain teacher forcing.
- Relevance to Gridiron: DeepAR's core trick — one shared network learns across
  *many related series* instead of training 32 separate per-team models — maps
  directly onto "32 NFL teams' weekly scoring trajectories" as one panel, which is
  exactly the shape of the play-by-play/team-strength problem and is a genuinely
  different mechanism than nfl-preseason-blend.js's per-season conjugate update.

### S3 — Rasul, K., Sheikh, A-S., Schuster, I., Bergmann, U., Vollgraf, R. (2021, ICLR). *Multivariate Probabilistic Time Series Forecasting via Conditioned Normalizing Flows*. arXiv:2002.06103.
[https://arxiv.org/abs/2002.06103](https://arxiv.org/abs/2002.06103) — **read in full** (fetched full HTML body via ar5iv).

- Model: autoregressive RNN whose hidden state *conditions* a normalizing flow
  (Real-NVP or MAF) instead of a fixed-family likelihood — this is the
  direct answer to "normalizing flows for regression" in the assigned topic: the
  flow gives an arbitrarily-shaped, learned conditional density (not restricted to
  Gaussian mixtures) while staying tractable (exact density via change-of-variables,
  cheap sampling).
- Datasets/sample, exact: Exchange (88 series, daily, 30-step horizon), Solar (137,
  hourly, 24-step), Electricity (370, hourly, 24), Traffic (963, hourly, 24), Taxi
  (1,214, 30-min, 24), Wikipedia (2,000, daily, 30).
- Headline result (CRPS-sum, lower better, exact numbers from their Table 1):
  LSTM-MAF beats GP-Copula and Vec-LSTM baselines on 5/6 datasets, e.g. Traffic
  0.069 (LSTM-MAF) vs 0.078 (GP-Copula) vs 0.087 (Vec-LSTM); Wikipedia 0.067 vs
  0.086 vs 0.133; Taxi 0.161 (LSTM-MAF) vs 0.208 (GP-Copula) — roughly 20-35%
  CRPS-sum reduction over a real multivariate baseline, not a toy comparison.
- Stated limitation (their words): "modeling discrete ordinal data via flows"
  remains "an open problem" — directly relevant, since NFL final scores and many
  props (receptions, TDs) are count/discrete, so a raw continuous flow needs
  dequantization or a hybrid discrete-continuous treatment, not a drop-in.
- Relevance: this is the mechanism for C5 (joint margin+total+correlated-prop
  density), because it is explicitly *multivariate* — unlike a per-target MDN, one
  flow can emit the joint density Gridiron needs to price same-game/teaser
  correlation honestly instead of assuming independence.

### S4 — Herrig, N. (2023, U. St Andrews dissertation). *LSTM Mixture Density Networks for Value-at-Risk Forecasting*. arXiv:2501.01278.
[https://arxiv.org/abs/2501.01278](https://arxiv.org/abs/2501.01278) — **read in full** (fetched full HTML body via ar5iv).

- Model: LSTM + MDN output head (2- and 3-component Gaussian mixtures) predicting
  next-day return distributions for VaR, on FTSE 100 / S&P 500 / EURO STOXX 50
  daily returns, evaluated on a calm period (2017-18) and a turbulent period
  (2021-22).
- Result, exact and honestly reported: the LSTM-MDN "showed better overall results
  for the 2021/2022 (high-volatility) period compared to the benchmark models"
  but the paper's own abstract calls the overall improvement "modest," and 2017-18
  performance was *worse*, blamed on initialization sensitivity.
- Stated limitation (their words, directly quoted): the approach "tend[s] to rely
  on a large amount of training data" and needs "further research" for "stable
  and reliable performance" — this is the single most important caution for
  Gridiron: MDN/flow heads are data-hungry and initialization-sensitive, and
  Gridiron's online-neural head today trains on a few hundred *weekly* NFL
  examples (`promotion_sample: 128` in ONLINE_NEURAL_HEADS, `nfl-online-neural.js`
  L25), several orders of magnitude below every dataset in S2/S3. This is why
  C1/C2 below spec a low-K (2-3 component) mixture and heavy shrinkage-to-market
  prior, not an ambitious flow, as the first move for the actual spread-residual
  head — S4 is direct evidence that jumping straight to a flexible neural
  density model on a small, noisy sports dataset is exactly the failure mode to
  design against.

## 2. Repos

| repo | stars | license | last commit | what it actually is | attach point |
|---|---|---|---|---|---|
| `tonyduan/mixture-density-network` | 154 | MIT | 2023-05-18 | ~150 lines of PyTorch: `GaussianMixture` module (softmax mix weights, `exp` log-var, closed-form NLL), matches Bishop's eqs 25/26/29 exactly. Not cloned (repo already inspected via GitHub API metadata + README; trivial enough to reference/port rather than vendor). | Reference implementation to **port the math from**, not to call — Gridiron's model runtime is hand-rolled JS (`nfl-online-neural.js`), so the value here is the closed-form gradient/loss expressions, ported into `forward()`/`trainBatch()` as new functions, not a dependency. |
| `awslabs/gluonts` | 5,233 | Apache-2.0 | pushed 2026-07-31 (active) | Production DeepAR + normalizing-flow (`DeepAREstimator`, `torch/model/deepar`) implementations, GaussianMixture and flow-based distribution heads built in (`gluonts.torch.distributions`). | Reference-only for Gridiron: Gridiron's stack is Node.js/SQLite with a hand-rolled neural runtime, not Python/PyTorch — porting GluonTS wholesale would mean a second-language runtime alongside `nfl-online-neural.js`, which is a much bigger lift than writing ~80 lines of new JS math. Use it as the **correctness reference** when unit-testing a ported MDN loss (compare Gridiron's JS NLL against GluonTS's Python NLL on identical synthetic inputs), not as a library to depend on. |
| `zhykoties/TimeSeries` | 397 | Apache-2.0 | 2020-04-03 (stale, 5+ yrs) | PyTorch DeepAR reimplementation on the `electricity` dataset (370 series). | Reference-only — same language-boundary issue as gluonts, and it's stale/unmaintained relative to gluonts's own DeepAR. Not recommended to adopt even as a reference over gluonts. |

Given the 6-repo/agent budget and that none of these are Node-compatible runtimes,
I did not clone any of them — Gridiron's actual adoption path is "port the closed-
form math into the existing hand-rolled JS network," not "install a Python
dependency," so cloning full repos would not have produced anything the paper
equations (S1) didn't already give me directly, and GitHub's file-contents API
was sufficient to confirm what each repo is (`gh api repos/<repo>/contents/`
against `tonyduan/mixture-density-network` showed `src/`, `examples/`, no vendored
weights, 57KB total — consistent with "small reference implementation," not a
framework).

## 3. The exact new output contract (this is the deliverable)

Gridiron's current contract (`onlineNeuralPrediction` return shape, L182-186) is:
```
{ residual, predicted_margin, market_margin, production_eligible, metrics, authority }
```
`residual` and `predicted_margin` are single floats. Proposed replacement
contract — additive, not breaking (old scalar fields stay, computed *from* the
new distribution so nothing downstream that reads `.predicted_margin` breaks):

```js
{
  ...existing fields (residual, predicted_margin, market_margin, production_eligible, metrics, authority),
  distribution: {
    family: 'gaussian_mixture',        // or 'normalizing_flow' for C5
    components: [                       // K=2 or 3, per S4's caution
      { weight: 0.62, mean: -0.8, sd: 4.1 },
      { weight: 0.38, mean: 3.9,  sd: 6.7 }
    ],
    quantiles: { p05: -9.2, p25: -3.1, p50: 0.4, p75: 4.8, p95: 11.6 },  // for staking / conformal / prop-line comparison without re-deriving the mixture CDF downstream
    entropy: 2.31,                      // differential entropy of the mixture in points, monotonic proxy for "how confident is this prediction" — lets staking use model-reported uncertainty instead of a fixed bound
    calibration: { method: 'split_conformal', coverage_target: 0.90, interval: [-8.7, 9.9] }  // populated only once C3 (conformal wrapper) runs on top of this head's history
  }
}
```
`predicted_margin` stays defined as `market_margin + Σ weight_i * mean_i` (the
mixture mean), so every existing consumer of the scalar keeps working unchanged;
new consumers (staking guardrail, conformal calibration, teaser-leg pricing) read
`.distribution`. This mirrors exactly Bishop eq. 45 (`⟨t|x⟩ = Σ α_i μ_i`) for
backward compatibility, and eq. 47 for total variance if a single scalar spread
estimate is ever needed.

## 4. Candidates

See structured output. Six candidates: three tagged `new` (genuinely new
capability — MDN head, the output-contract schema itself, and a DeepAR-style
sequence model over the unused 251,591-row play-by-play table) and three tagged
`fix` (conformal calibration wrapper, prop distribution recast, and a
normalizing-flow joint density that gives teaser-leg correlation pricing a real
mechanism instead of an assumed-independence placeholder) — a 50/50 split as
requested, each fix citing its exact FOUND defect.

## 5. Do not do

- Do not port a full Python/PyTorch stack (GluonTS et al.) into this Node.js
  codebase for a single new head — the math (Bishop eqs. 25/26/29 for MDN; the
  flow log-det-Jacobian formula for C5) is small enough to write directly in JS
  next to `forward()`/`trainBatch()` in `nfl-online-neural.js`; a second-language
  ML runtime is a maintenance/deploy liability this project does not need for
  ~80 lines of new math.
- Do not jump straight to a flow/DeepAR-scale model on the spread-residual head:
  S4 is direct evidence that flexible neural density models are initialization-
  sensitive and data-hungry, and Gridiron's real weekly sample (currently far
  below `promotion_sample: 128` games) is orders of magnitude smaller than every
  dataset in S2/S3. Start with K=2-3 Gaussian components (C1), not an
  unconstrained flow, on the actual per-game head.
- Do not let a new distributional head bypass the existing prequential/shadow
  discipline in `nfl-online-neural.js` (freeze-then-score-then-train, L75-76,
  and `production_eligible` gate, L285-291) — every candidate below is an
  additive field/head under the *same* gate, never a new path that skips it.
- Do not claim the team-strength "hand-tuned blend" defect is still live without
  qualification — `nfl-preseason-blend.js` already runs a corrected normal-normal
  Bayesian update as of 2026-09-10; frame any new sequence-model work (C6) as
  extending a now-principled baseline, not fixing a currently-broken one.
- Do not build a joint normalizing flow (C5) that treats NFL final scores as pure
  continuous data without addressing the "discrete ordinal data via flows...open
  problem" limitation S3 itself names — margins and totals are effectively
  integer-valued (key numbers), and a naive continuous flow will mis-price
  exactly the key-number mass (3, 7, 10) that `teaser-leg-rates.js` cares about
  most.
