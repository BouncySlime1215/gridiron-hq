# F08 — Bayesian state-space / dynamic linear models for NFL team strength

Researcher: F08-bayesian-state-space-ratings (bucket: fix). Topic: Glickman & Stern
(1998), Koopman & Lit (2015/2019) dynamic bivariate Poisson/Skellam, as a
replacement for the hand-tuned preseason/in-season blend in
`server/services/nfl-team-strength.js` / `server/services/nfl-preseason-blend.js`.

## 0. What's actually in the repo today (read, not guessed)

`nfl-team-strength.js` (480 lines) is NOT the blend itself — it is a team-level
aggregate of *offseason/preseason* player features (`proj_off_points`,
`vacated_opportunity_share`, `returning_points_share`, `qb1_change`,
`qb1_qbr_delta`, `qb1_proj_ppg_delta`), gated behind `model-governance.js`,
walk-forward tested in `teamStrengthWalkForward()` against the champion GBM.
Its own honest result: **not tested as "in-season blend" at all** — it never
touches in-season results, by design (it is preseason-only, no look-ahead).

The actual hand-tuned prior/in-season blend Nick's finding describes lives in
**`server/services/nfl-preseason-blend.js`** (410 lines, dated 2026-09-09/10,
already once corrected by a Codex audit — see its own header for the M01 bug:
an earlier version had the normal-normal posterior weight backwards). The
mechanism, read in full:

- `dampenMargin(margin)`: log-compress raw score margins (Elo-style MOV
  dampening).
- `calibratePreseasonBlend({asOfSeason})`: estimates two scalars from real
  history — `per_game_variance` (pooled within-team-season variance of
  dampened margins) and `prior_variance` (variance of *this season's* average
  dampened margin minus *last season's*, i.e. real year-over-year prediction
  error). Cutoff-safe (`asOfSeason`) so a later season can't leak into an
  earlier forecast.
- `blendedTeamRating(season, team, week)`: **one static normal-normal
  posterior** — `weightOnPrior = per_game_variance / (per_game_variance + n *
  prior_variance)`, `blended = w*prior + (1-w)*inSeasonMean`, `posteriorSE =
  sqrt(1 / (1/priorVar + n/perGameVar))`. `inSeasonMean` is the team's own
  raw average dampened margin over its games so far this season — **not
  opponent-adjusted**. `teamChurnMultiplier` widens `prior_variance` for a
  team with above-average offseason roster churn.
- Walk-forward tested via `teamStrengthWalkForward({challengerFeatures:
  preseasonBlendGbmFeatures()})` (the exact harness `nfl-team-strength.js`
  built) — **honest recorded result, already in the file**: "pooled
  2023-2025, challenger MAE 9.86 vs champion MAE 9.84 ... 90% CI [-0.017,
  0.056], includes zero, 0 of 3 seasons individually significant." Not wired
  into production. `blendedTeamRating` itself is documented as unused
  infrastructure — nothing in the repo consumes its `posterior_se`.

This is exactly Nick's finding: a real, single-shot Bayesian *shrinkage*
calculation (correctly implemented, now that M01 is fixed), but not a
*state-space* model — no recursive week-to-week filtering, no separate
week-to-week vs season-to-season evolution variance, and critically **no
paired-comparison structure**: a team's in-season mean margin ignores who it
played. `nfelo.js` (312 lines) is the closest thing to Elo in the repo, but
it is a **read-only consumer of greerreNFL's external CSVs** — Gridiron has
no in-house state-space/Elo engine of its own.

Schema: `game_lines(season, week, team, opponent, home, spread, total,
team_score, opp_score, closing_spread, closing_total, neutral_site, div_game,
rest_days, gameday, ...)` — one row per team-game (both sides present), 32
teams, PK `(season, week, team)`. This is where any new state-space fit would
read from, and `teamStrengthGbmFeatures()` / `preseasonBlendGbmFeatures()`
show the exact `{names, row}` contract a new challenger feature must expose
to reach `nfl-gbm.js` and be graded by `teamStrengthWalkForward`.

## 1. Primary sources (4, all read in full)

### S1 — Glickman, M.E. & Stern, H.S. (1998), "A State-Space Model for
National Football League Scores," *JASA* 93(441), 25-35.
https://www.glicko.net/research/nfl.pdf — **read in full (all 10 pages)**.

- **Model**: paired-comparison normal linear state-space. Observation:
  `y_ii' = θ_i - θ_i' + α_i + ε`, `ε ~ N(0, τ²)` where `θ` is team ability and
  `α_i` is team `i`'s *own* home-field-advantage parameter (not shared across
  teams). State evolution has **two separate variance components**:
  week-to-week (`θ_{k,j+1} | θ_{k,j} ~ N(β_w·G·θ_{k,j}, (φω_w)^-1 I)`) and
  season-to-season (`θ_{k+1,1} | θ_{k,g_k} ~ N(β_s·G·θ_{k,g_k}, (φω_s)^-1
  I)`), where `G` centers/shrinks toward the mean team strength each time —
  `β_w`, `β_s` < 1 means shrinkage toward the mean, > 1 means expansion.
- **Data**: NFL regular seasons 1988-1993 (p=28 teams, 16-18 games/team/
  season), fit through week 10 of 1993, held out weeks 11-18 (n=110 games).
- **Estimation**: full Bayesian, Gibbs sampling (7 parallel chains, 18,000
  iterations, PSR-diagnosed convergence, 7,000 posterior draws kept). Not
  closed-form — this is the expensive end of the spectrum.
- **Honest out-of-sample result** (n=110, weeks 11-18 of 1993): **MSE 165.0
  vs the Las Vegas point spread's 170.5**; **MAE 10.50 vs 10.84**; correctly
  picked **64/110 winners (58.2%) vs the Vegas line's 63 (57.3%)**. Their own
  words: "the difference is not large enough to generalize" — a positive but
  small, honestly-reported edge on a 110-game sample, not a proven win.
- **Fitted magnitudes** (posterior means, week 10 of 1993): between-week SD
  `σ_w ≈ 0.88`, between-season SD `σ_s ≈ 2.35` — season-to-season variation is
  ~2.7x week-to-week, i.e. team strength genuinely moves far more across
  offseasons than within a season (the qualitative justification for
  Gridiron's own two-scale intuition in `nfl-preseason-blend.js`, but
  Glickman-Stern actually estimate and use *two* evolution variances in a
  recursive filter, not one static blend fit at forecast time). Team-specific
  HFA ranged **1.6 to 7.7 points** across 28 teams (Cowboys/Browns weakest,
  Oilers strongest) — evidence that a single league-wide HFA constant, which
  is what most of the rest of the codebase implicitly assumes, throws away
  real signal.
- **Section 5 (posterior-predictive model checking)**: their own diagnostic
  method — simulate replicate data from the fitted model, compare a
  discrepancy statistic (e.g. spread of per-team residual variance) computed
  on real vs simulated data, report the tail probability. This is a genuinely
  different validation technique than anything in `backtest-significance.js`
  or `audit-registry.js` (which test effect sizes/CLV, not model fit).

### S2 — Koopman, S.J. & Lit, R. (2019 / Tinbergen discussion paper TI
2017-062/III), "Forecasting football match results in national league
competitions using score-driven time series models" (published, *Int. J.
Forecasting* 2019). https://papers.tinbergen.nl/17062.pdf — **read in full**
(title through conclusion, pp. 1-26 of 26).

- **Model families compared, all with a dynamic (time-varying) extension**:
  (a) bivariate Poisson (attack/defense intensities `λ1=exp(δ+α_i-β_j)`,
  `λ2=exp(α_j-β_i)`, shared covariance `λ3` — a draw-inflating "common shock"
  term), (b) Skellam (goal-difference only), (c) ordered probit (win/draw/
  loss only, one strength per team, no attack/defense split). **Dynamic
  extension method is score-driven (GAS)**: the time-varying strength vector
  `f_t` is updated each round by `f_{t+1} = ω + A·s_t + B·f_t`, where `s_t` is
  the **scaled score of the predictive log-likelihood** — i.e., the update is
  driven by how wrong the model's last prediction was, computed in closed
  form from the observed data, with NO Kalman filter and NO simulation
  needed. They separately implement the "true" parameter-driven alternative —
  a genuine non-Gaussian state-space model (`f̃_{t+1} = ω + Bf̃_t + Aη_t`) fit
  by simulated maximum likelihood — as their benchmark.
- **Data**: 6 European leagues (EPL, Bundesliga, La Liga, Ligue 1, Serie A,
  Eredivisie), 17 seasons 1999/2000-2015/16, in-sample 1999-2009 (10 seasons)
  for initial fit, out-of-sample 2009-2016 (7 seasons) for the forecasting
  study — **~15,000 probabilistic toto (win/draw/loss) forecasts total**,
  re-estimating after every round (expanding window).
- **Loss function**: Rank Probability Score (RPS), Diebold-Mariano test for
  equal predictive accuracy.
- **Honest result**: the **dynamic bivariate Poisson, score-driven, with f1
  initialized from a static fit on the first in-sample season**, is the best
  forecasting strategy in **all 6 leagues** (Eredivisie only exception where
  a random-walk-updating variant wins). Dynamic beats static and beats the
  Dixon-Coles-style exponential-downweighting alternative "significantly, in
  almost all cases." Bivariate Poisson beats Skellam beats ordered probit —
  "the subsequent merging of data... leads to a decrease of forecasting
  performance." **Directly load-bearing finding for Gridiron**: the
  score-driven model **beats the full parameter-driven state-space model on
  forecast precision, and does it in under 10 seconds of estimation time vs
  ~1 hour** for the state-space/simulation approach, per model, per
  competition. This is the single most actionable number in this research —
  see candidate F1/N1 below.

### S3 — Ley, C., Van de Wiele, T. & Van Eetvelde, H. (2018), "Ranking soccer
teams on basis of their current strength: a comparison of maximum likelihood
approaches," arXiv:1705.09575. https://arxiv.org/pdf/1705.09575 — **read in
full**.

- **Model**: 10 models across 4 families (Thurstone-Mosteller, Bradley-Terry,
  Bradley-Terry-Davidson [handles draws], Independent Poisson, Bivariate
  Poisson [Karlis-Ntzoufras `λ_C` covariance]), each fit by **weighted
  maximum likelihood**, no filtering/state-space machinery at all — weight on
  match `m` played `x_m` days ago is a smooth exponential decay `w_time,m =
  (1/2)^(x_m / HalfPeriod)`, i.e. "how much does the past matter" reduces to
  one tunable half-life, chosen by predictive performance rather than
  assumed. This is the cheapest possible alternative to a real dynamic model
  and is exactly the "weighting likelihood method" Koopman & Lit (S2) test
  and find loses to their dynamic bivariate Poisson.
- **Data**: EPL 2008-2017 (domestic) and international national-team matches
  2008-2017 (with an added match-importance weight: 1 for a friendly, up to 4
  for a World Cup match).
- **Result**: Bivariate and Independent Poisson are the best-forecasting
  models by RPS; Thurstone-Mosteller/Bradley-Terry (outcome-only, no score
  information) are worse. A companion reproduction
  (`itamarsaacks/world-cup-forecasting`, below) that reruns this exact
  pipeline on a newer data vintage independently confirms the ordering and
  finds an **optimal half-life ≈ 3 years**, RPS ≈ 0.174 vs the paper's 0.165
  (difference attributed to data vintage/coverage, not a model failure).

### S4 — Glickman, M.E. & Stern, H.S. (2016), "Estimating team strength in
the NFL" (book chapter). https://www.glicko.net/research/nfl-chapter.pdf —
**read in full through the paired-comparison ridge derivation (§1-2,
pp.1-8)**; this is the practitioner-facing distillation of S1's machinery.

- Derives the **closed-form regularized paired-comparison estimator** that a
  full state-space fit reduces to at any single time slice: design matrix
  `X` (n games × J teams, row = +1 home / -1 away), least-squares normal
  equations `X'Xθ = X'y` are rank-deficient (columns sum to zero), so either
  (a) impose a linear identifiability constraint (`θ_J=0` or `Σθ_j=0`), or
  (b) **ridge-regularize**: `θ̂ = (X'X + λI)^-1 (X'y + λγ)`, shrinking each
  team's rating toward a prior center `γ_j` at strength `λ`, chosen by
  K-fold cross-validation. This is a **single matrix solve** — no MCMC, no
  Kalman recursion — and it is *already* the paired-comparison structure
  Gridiron's current blend lacks (see the opponent-blindness gap in §0
  above). It generalizes immediately to a *weekly-refit* version (recompute
  `θ̂` each week on games-to-date, `γ` = last week's `θ̂` or the preseason
  prior) which is the cheap, days-not-weeks fix (F2 below) versus the full
  S1-style Kalman filter (F1, more expensive, genuinely state-space).

### Also read, not counted toward the "4+": abstracts/intros of Koopman & Lit
(2015), *JRSSA* 178(1), 167-186 (the original EPL-only bivariate Poisson
paper S2 extends) — paywalled, only the abstract/SSRN summary was available:
reports a **significant positive betting return over bookmaker odds on the
2010/11-2011/12 EPL seasons** using the same dynamic bivariate Poisson class.
Cited as corroborating evidence, `read_in_full: false`.

## 2. Working code found (4 repos cloned, read, not executed)

| repo | stars | license | last push | what it actually is |
|---|---|---|---|---|
| `mikemiller442/Bivariate_Poisson_Soccer` | 2 | none declared (all-rights-reserved by default) | 2020-01-07 | **Real, runnable Stan models** (`bivariate_poisson_no_cov.stan`, `bivariate_poisson_model.stan`, `bivariate_poisson_int_cov.stan`) implementing exactly the Maher/Karlis-Ntzoufras bivariate Poisson S1-S3 describe: `alpha`/`delta`/`rho` (attack/defense/covariance) as `normal(0, sigma)` random effects, `inv_gamma(1,1)` priors on the variances, `poisson(lambda1+lambda3)`/`poisson(lambda2+lambda3)` likelihood — read in full above. A 5-fold-CV R script (`data_cleaning_btw_models.R`) fits it with RStan on 10 EPL seasons and compares to Bradley-Terry/Davidson MLE fits by binary and log loss. **No license file** — treat as reference/read-only, not directly redistributable; re-derive the Stan code from the (short, standard) model spec rather than copying the file verbatim if anything ships. |
| `renenunezg/momentumnfl` | 0 | MIT | 2026-09-10 (actively maintained, same week as this research) | **NFL-specific, Bayesian, production-shaped** — closed-form `solve_ridge()` in `backend/model/joint_scoring.py`: exactly S4's ridge estimator (`precision = diag(1/prior_sd²)` or a full prior covariance; `θ̂ = (X'WX+precision)^-1(X'Wy+precision·prior_mean)`), but generalized to a **joint weighted GLS system across all 32 teams at once** with exponential recency weighting (`rating_half_life_weeks=6.0`, i.e. S3's half-life idea applied within-season) and refit from scratch every week rather than filtered forward — an engineering middle ground between S3 (weighted MLE) and S1 (true recursive filter). Also implements a **preseason prior blending win-total market with mean-reverted priors** (`backend/model/preseason.py`), and is walk-forward-calibrated against the closing line with a published, versioned recommendation ledger (`backend/recommendations.py`, `backend/grading.py`) — structurally the closest external analogue to Gridiron's own `beat-the-close.js` / `model-governance.js` gating discipline. Confirms this class of model is buildable and operable in a live betting pipeline, not just an academic toy. |
| `Torvaney/mezzala` | 40 | Apache-2.0 | 2021-10-19 | A clean, composable **static** Dixon-Coles Python library (`mezzala/models.py::DixonColes`, `mezzala/weights.py::ExponentialWeight`) — team-strength "blocks" (`BaseRate`, `HomeAdvantage`, `TeamStrength`) assembled into a Poisson regression, with the same exponential-decay weighting as S3. No dynamic/state-space extension. Useful as a clean reference architecture for how to decompose attack/defense/HFA into composable "blocks" in application code, but does not itself demonstrate anything beyond S3's simpler alternative — which S2 found loses to the real dynamic model. |
| `itamarsaacks/world-cup-forecasting` | 0 | MIT | 2026-09-08 | A from-scratch, honest **reproduction** of S3 (declares itself as such), independently recovering S3's model ordering and finding an optimal half-life of ~3 years; useful primarily as an independent confirmation that S3's numbers replicate on a different data vintage, and as a second, from-scratch reference implementation of weighted-MLE bivariate Poisson in Python (single notebook, not a library). |

`node_modules`/`venv` check: none present in any of the four clones (all are
either flat scripts or small pure-Python/R packages).

## 3. What this means for `nfl-team-strength.js` / `nfl-preseason-blend.js`

Two separate, distinct problems, confirmed by reading the code (not implied
by the finding text alone):

1. **No paired-comparison structure** — `blendedTeamRating`'s `inSeasonMean`
   is a team's raw average margin, blind to opponent strength. This is fixed
   by S4's ridge-regression estimator alone, cheaply, without touching the
   prior/posterior blending math (which is already correct post-M01).
2. **No recursive state, no two-scale evolution variance** — the blend is
   computed fresh at forecast time from `calibratePreseasonBlend`'s two
   *global* scalars (`per_game_variance`, `prior_variance`), not filtered
   forward week-by-week the way S1's Kalman recursion (or S2's much cheaper
   score-driven update) would. This is the more expensive, genuinely
   "state-space" fix.

S2's own head-to-head result (score-driven beats full state-space on
precision AND costs ~360x less compute) is the strongest single piece of
evidence for *which* of these two to build first if only one gets built:
implement the score-driven (GAS) recursion, not a literal Gibbs-sampled
Kalman filter, and validate it exactly the way `nfl-team-strength.js` already
validates its own challengers — through `teamStrengthWalkForward`.
