# GN10 — Aging-curve / survival-analysis code for dynasty-age-curve.js

Task: clone and read real player-aging-curve / survival-analysis repos, verify by reading
code (not READMEs), and specify a concrete replacement design for
`server/services/dynasty-age-curve.js` (READ-ONLY reference; never edited) with genuine
uncertainty bands.

## Current state of dynasty-age-curve.js (read, not modified)

`/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/server/services/dynasty-age-curve.js`

- `AGE_CURVE_ANCHORS` is a hand-typed table of (age, multiplier) points per position (RB/WR/TE),
  taken from the prose of one outside study (4for4 2025 "Production Curves"), with everything
  between the literal cited anchors filled in by **linear interpolation** and everything past
  the last anchor by **linear extrapolation floored at 0.25** (`ageDecayMultiplier`, lines 68-80).
- `dynastyAgeAdjustment()` returns exactly one number (`adjusted_value = raw_value * multiplier`).
  There is no standard error, no confidence interval, no sample size, no per-player variation —
  every RB of age 29 gets the identical 0.90 multiplier whether he has 200 career touches or 2,000.
- QB gets multiplier 1.0 everywhere ("no published curve") — not "no curve fit," just "we didn't
  bother," because the current method requires a hand-curated literature anchor, not a fit.
- This is a **point estimate with no uncertainty representation of any kind** — the exact
  "no honestly-calibrated uncertainty interval exists anywhere in the pipeline" defect from
  tonight's findings, applied to the one place in Gridiron that is explicitly a value adjustment
  (dynasty trade values), not just a projection.

## Repos cloned and read

All cloned under
`/private/tmp/claude-501/-Users-nick-matta-Claude-Artifacts/e22ddbdc-9d23-482e-a1cc-7bc1f39b77c6/scratchpad/research2/github/`.
No `node_modules`/`venv` present in any (all pure source, tiny repos). None declare a license
(GitHub API `license: null` on all three) — under default copyright this means **no redistribution
rights**: ideas/methods/API shapes may be reimplemented from scratch (that's what's proposed below),
but code must not be copied in.

### 1. kellytodhunter/KBO-Player-Analysis
- License: none declared. Stars: 1. Last commit: 2026-07-22. Size: 6.4 MB (mostly CSV data + one xlsx).
- What it actually does (verified by reading `code/03_regression_mean.py`, `code/04_age_curves.py`,
  `code/06_validation.py`): a full Marcel-style KBO hitter/pitcher projection pipeline —
  (1) empirical-Bayes regression-to-the-mean (`r_reg = (k + m·r_lg)/(n + m)`, m tuned per-stat by
  method-of-moments, not a literature guess — see `04b_tune_regression.py`/`data/tuned_m_values.csv`);
  (2) a **delta method** aging curve (`04_age_curves.py:98-139`): for every consecutive-season pair,
  `delta = stat_next - stat_current`, grouped by age-at-season-N, weighted by the harmonic mean of
  playing time in the two years (so part-time seasons count less), giving both a mean delta **and
  a standard error per age bin** (`se_{col} = d.std()/sqrt(n)`, line 134) — this is the genuine
  uncertainty band the current Gridiron file has none of; ages with thin samples (`min_n=5` floor,
  line 119) get `NaN` rather than a fabricated number;
  (3) the deltas are cumulatively summed and anchored at age 27 to build a full aging-adjustment
  curve (`cumulative_adjustment`, lines 178-197);
  (4) `06_validation.py` genuinely backtests 2021-2024 out-of-sample against two naive baselines
  (prior-year-only, league-average) with MAE/RMSE/Pearson r — the delta-method aging step measurably
  improves projection accuracy vs. the no-aging-adjustment baseline in their own backtest table
  (`data/hitter_validation_metrics.csv`).
- Adopt: **borrow-idea + adoption-path for a from-scratch port**. The delta method itself is
  simple (~60 lines of vectorized pandas/JS) and directly transplantable to NFL/fantasy data
  Gridiron already has; what's valuable to copy is the *design*, not the code (no license to copy
  code verbatim anyway): compute deltas from real consecutive-season fantasy-points pairs per
  player, group by age, weight by playing time, and — critically — **carry the standard error
  through as a first-class output**, not just the mean.
- Gridiron attachment point: `server/services/dynasty-age-curve.js` currently has no ingestion of
  season-pair data at all — it starts from a literature table. Gridiron already has
  `nflverse_player_positions` (joined by `gsis_id`, used today only for birth dates) and a season-level
  fantasy scoring table (referenced throughout `server/services/` for weekly/season fantasy points).
  A new `research/aging_curve_delta_method.py` script (parallel to the existing `research/*.py` labs)
  would join those two, compute delta-method curves + SE per position/stat, and write a JSON table
  that `dynasty-age-curve.js` loads in place of `AGE_CURVE_ANCHORS`.

### 2. kennethho193/nfl-aging-curve
- License: none declared. Stars: 0. Last commit: 2026-03-20. Size: 1.6 MB (sqlite db + 2 notebooks
  + a Streamlit app + a scraper).
- What it actually does (verified by extracting and reading `notebooks/02_modeling.ipynb`'s code
  cells directly, since the README oversells "end-to-end analysis"): fits one
  `statsmodels.formula.api.mixedlm("rushing_yards ~ age_c + age_c2", groups=player_id)` —
  a random-intercept mixed-effects model, fixed effects centered/quadratic age, one random
  intercept per player (so within-player trajectories share a population curve but each player
  keeps his own baseline level — this directly addresses **survivorship bias**: a bad rookie season
  doesn't get treated as a "aging" data point the same way a great veteran's does, because the
  player's own intercept absorbs his baseline quality). It derives peak age analytically from the
  quadratic's vertex (`-b1/(2*b2)`), and — the part directly relevant to the uncertainty-band ask —
  builds an approximate 95% CI on the **population-level fitted curve** by propagating the fixed-effect
  covariance matrix through the quadratic (`se = sqrt(Var(Intercept) + age_c²·Var(age_c) + age_c⁴·Var(age_c²))`,
  cell 4) rather than eyeballing a band. This is a textbook delta-method CI on a nonlinear function of
  fitted parameters, done correctly with `result.cov_params()`. Data is RB rushing yards only
  (`db/nfl_aging.db`, `season_stats` table), not fantasy points, and the CI shown is for the population
  mean curve, not a per-player predictive interval — it does not capture between-player variance
  (the random-intercept variance itself is never turned into a band).
- Adopt: **borrow-idea** (mixed-effects quadratic + delta-method CI on the fitted curve). Genuinely
  reusable technique, thin implementation (4 notebook cells, no tests, no packaging) — worth
  reimplementing directly against Gridiron's own schema rather than adapting this code, since the
  repo hardcodes column names (`rushing_yards`, `nfl_aging.db`) irrelevant to Gridiron and has no
  license permitting reuse anyway.
- Gridiron attachment point: same `research/aging_curve_*.py` location. `statsmodels` is not
  currently in `research/requirements.txt` or the `research/.venv` site-packages (checked:
  only `scipy`/`sklearn` present) — would need `pip install statsmodels` into that venv (no paid
  API, a local pip install of an open-source package). Output: per-position fixed-effect curve +
  95% CI band (upper/lower per age) exported as JSON, **plus** the random-intercept variance
  component reported separately so callers can see "population curve uncertainty" vs.
  "player-to-player spread at any given age" as two distinct numbers instead of collapsing them.

### 3. sashaostr/sklearn-lifelines
- License: none declared. Stars: 29 (highest of the three, but repo itself is tiny — 152 KB,
  effectively one 75-line file). Last commit: 2019-01-27 (stale — 7+ years old; the underlying
  `lifelines` library it wraps has moved on substantially since, so this wrapper's exact API calls
  are likely broken against a current `lifelines` install and should not be pip-installed/imported —
  reference only, never executed).
- What it actually does (verified by reading `sklearn_lifelines/estimators_wrappers.py` in full,
  the entire content of the package): two ~35-line sklearn-`BaseEstimator`-shaped wrappers around
  `lifelines.CoxPHFitter` and `lifelines.AalenAdditiveFitter` so they can drop into an sklearn
  `Pipeline`/`GridSearchCV`. `fit()` merges the duration/event columns into X and delegates to the
  real lifelines fitter; `predict()` calls `predict_expectation()` (point estimate of expected
  survival time) — it does **not** expose `predict_survival_function`, confidence intervals, or the
  `alpha` parameter it accepts in `__init__` anywhere beyond passing it through to the underlying
  fitter's constructor. So despite the fancy framing, this repo does not itself demonstrate uncertainty
  bands — it demonstrates the **plumbing** (constructor signature, `duration_col`/`event_col`/`alpha`
  contract) for calling `lifelines`' real survival models, which do carry proper confidence intervals
  on `predict_survival_function` / `.confidence_interval_` natively (that capability lives in
  `lifelines` itself, not in this wrapper).
- Adopt: **reference-only** for the constructor/API shape; **avoid** running the wrapper code as-is
  (stale, unverified against current `lifelines`). The actual adoption target is `lifelines` proper
  (`CoxPHFitter`/`AalenAdditiveFitter`, MIT-licensed, actively maintained, already known to this
  Gridiron codebase's context as an acceptable dependency family — "lifelines-based examples count"
  per this task's own instruction) — not this thin, dead wrapper.
- Gridiron attachment point: a **survival framing of dynasty decline** distinct from both curves
  above. Instead of "expected multiplier at age N," model time-to-event = seasons until a player's
  fantasy PPG permanently drops below some threshold (e.g. 70% of career-peak PPG), event = that
  drop observed in the data, censored = still above threshold as of the most recent season (this
  is real right-censoring — most active players haven't declined yet, and treating them as "never
  declining" the way a naive average would is exactly the survivorship bias the delta method and
  lifelines both exist to correct). `CoxPHFitter` with covariates (position, draft capital, prior
  injury games, target/touch share) fit on Gridiron's own multi-season fantasy history would produce
  a **player-specific** predicted survival curve — `predict_survival_function()` returns the full
  curve, and `lifelines` computes proper (non-parametric, Kaplan-Meier-anchored) confidence bands on
  it — giving a genuinely player-conditioned uncertainty band instead of one curve applied uniformly
  to every player at a given position/age, which is what both the current code and the two curve-based
  repos above still do.

## Where the three repos disagree / what each is missing

- KBO repo: real per-age-bin SE, but purely population-level (no per-player covariates) and MLB/KBO
  hitting stats, not NFL fantasy production.
- nfl-aging-curve repo: correct delta-method CI on the *fitted population curve*, but only rushing
  yards, and it never turns the random-intercept variance into a usable per-player band — the CI
  shown answers "how sure are we about the average trajectory," not "how sure are we about *this*
  player's."
  sklearn-lifelines: the only one of the three whose underlying method (`lifelines`) natively supports
  a genuinely player-specific band, but the repo itself doesn't demonstrate that — it demonstrates
  plumbing.

None of the three, alone, is a complete answer — the recommended design below combines the delta
method's empirical per-age SE, the mixed-effects population CI, and a `lifelines` Cox survival
model for player-conditioned bands.
