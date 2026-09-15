# N16 — Modern (2023–2026) NFL/analytics aging-curve work vs. Gridiron's dynasty-age-curve.js

## Baseline: what Gridiron has today

`server/services/dynasty-age-curve.js` (143 lines, fantasy-football-dashboard, read-only):
- A single position→age lookup table (`AGE_CURVE_ANCHORS`) for RB/WR/TE only (QB = 1.0, no curve).
- Anchors are **not fit to any data Gridiron holds** — they are hand-transcribed from 4for4's 2025
  "Production Curves" blog post's *prose* ("peaks 26, holds through 28, falls off 29-31"), then
  **linearly interpolated** between the literal numbers the study states and **linearly extrapolated**
  past the last anchor, floored at 0.25. The file's own header comment is explicit about this: "anything
  between the literal anchors is a linear reading of the study's prose, not a further-fitted number."
- Output is a single point multiplier. No confidence interval, no cliff/bust probability, no
  distinction between "gradual per-game decline" and "sudden loss of role/injury-ending-career,"
  no player-level covariates (draft capital, workload share, injury history) — every 29-year-old RB
  gets the same 0.90 regardless of who they are.
- `player_season_stats` (server/db/schema/core-and-fantasy.js:290) is keyed to internal `players.id`
  and looks scoped to players who have actually been rostered in Nick's leagues — i.e. Gridiron does
  **not** currently hold a multi-decade, full-NFL-population season-by-fantasy-points table locally.
  `nflverse_player_positions` (server/db/schema/mlb-model-misc.js:292 base + birth_date column read
  at runtime by dynasty-age-curve.js) gives birth dates but not career performance history.
  `player_accolades` (core-and-fantasy.js) does carry `draft_round`, `draft_pick`, `draft_year` —
  usable survival-model covariates already sitting in the DB.
- **This means every "fit a real curve" candidate below has a data-acquisition cost on top of a
  modeling cost**: Gridiron needs a historical, full-population player-season fantasy-points/usage
  table (an nflverse import) before any regression/survival model can be estimated locally.

## Primary sources (read in full)

### 1. Baseball Prospectus — "The Delta Method, Revisited: Rethinking Aging Curves"
https://www.baseballprospectus.com/news/article/59972/the-delta-method-revisited/ — read_in_full=true
- **Model**: replaces the classic delta method (pair consecutive same-player seasons, average the
  change by age, chain the averages) with a **GAM using thin-plate regression splines on age**,
  controlling for each player's career-average performance, fit across all player-seasons directly
  (no season-pairing, no data loss).
- **Data**: MLB position players, 1977–2016 train / 2017–2019 held-out test, ages 21–41, OPS vs
  league average.
- **Result**: delta method MAE 0.089 on the 2017-19 holdout; "corrected" delta (survivor-bias patch)
  0.085; the GAM 0.084 — best overall and in most age subgroups. Leave-career-out CV (5,000
  resamples): GAM 0.089 vs. delta method 0.096.
- **Stated limitation**: only 3 holdout seasons → "very noisy," large SEs; author calls the GAM "a
  floor, not a ceiling"; no claim it's ready for individual-player projection (future work); metric
  is OPS only.
- **Why it's the right "beyond delta method" citation**: the delta method's named failure modes —
  discarding ~20% of player-seasons (all final seasons, all single-season careers — exactly the
  seasons that carry the survivorship/cliff information), and "new-arrivals bias" pulling the
  apparent peak earlier — are the same failure modes baked into Gridiron's file, just one level
  cruder (Gridiron doesn't even do the delta method's season-pairing; it interpolates a single
  external study's summary sentences).

### 2. Schuckers, Lopez & Macdonald (2023), "Estimation of Player Aging Curves Using Regression and
   Imputation" (Annals of Operations Research; preprint at arXiv:2110.14017) — read_in_full=true
   (ar5iv full text)
- **Model**: fits a naive age-curve model to *observed* player-seasons only, then **imputes the
  missing/unobserved player-seasons from a truncated normal distribution** (upper bound = 75th
  percentile of observed performance at that age) to correct the exact bias the delta method and
  Gridiron's curve both have — that only good players are observed at old ages — then re-fits on
  observed+imputed data, and iterates once more.
- **Data**: NHL, 2,276 forwards born ≥ Jan 1 1970, seasons 1988-89 to 2019-20 (32 seasons), ages
  18–40, standardized points/game. ~63% of players observed at peak ages 23-24 but <9% observed at
  age 18 or 36+ — i.e. the tails are exactly where the naive curve is least trustworthy.
- **Result**: spline models with fixed player effects, fit on observed+imputed data, get the lowest
  average RMSE at every age and the closest Shape-Based-Distance to the (simulation-known) true
  curve, vs. quadratic and delta-plus baselines that curve upward unrealistically at old ages from
  survivorship alone.
- **Stated limitation**: the 75th-percentile imputation ceiling is explicitly called "arbitrary";
  point estimates only (no uncertainty quantification — the authors flag Bayesian/multiple-imputation
  as the natural next step); simulation calibrated to NHL, generalizability to other sports untested
  by the authors.
- Sport is NHL, not NFL — cited for the **imputation/survivorship-correction method**, which is
  sport-agnostic, not for any NHL number.

### 3. Yu & Hu (2026), "The Load Management Paradox: Correcting the Healthy-Worker Survivor Effect
   in NBA Injury Modeling" (arXiv:2603.26935) — read_in_full=true
- **Model**: a Marginal Structural Piecewise-Exponential Model (MS-PEM) — inverse-probability-of-
  treatment weighting combined with a piecewise-exponential survival model — to correct for the
  **healthy-worker survivor effect**: conditioning on "did this player play" induces collider bias
  from unobserved latent fitness, so naive survival models find that heavy recent workload
  *lowers* injury risk (players resting/being managed off the injury path never enter the risk set
  the same way).
- **Data**: NBA, 3 seasons, 771 players, 78,594 player-game observations, 2,439 injury events.
- **Result**: the paradox is not a small artifact — the authors show the selection mechanism is
  "mathematically sufficient to entirely reverse the sign of the true association," and their
  IPW correction reverses the naive (protective) sign back to the true (harmful) direction; the
  correction magnitude is sensitive to regularization (1-2% shift under conservative
  cross-validated penalization vs. 63-78% under light penalization), but the corrected sign is
  robust across multiple propensity specifications.
- **Stated limitation**: observational data only, no experiment; relies on the no-unmeasured-
  confounding assumption standard to MSMs; the authors frame this as a caution about causal
  inference in workload models generally, not a finished off-the-shelf tool.
- **Why it matters for dynasty aging specifically**: it is the 2023-2026 formal statement of exactly
  the bias that makes "workload keeps rising for veterans who are still playing" look like *evidence*
  that veterans hold value — when it's actually the survivors-only sample talking. Any Gridiron
  aging-curve fit that uses "still-active players' usage trend by age" as a feature will reproduce
  this same collider bias unless it's IPW/imputation-corrected the way this paper and Schuckers et
  al. above both do.

### 4. Jason Harstad (Footballguys), "We're Probably Thinking about Age the Wrong Way" (Mortality
   Tables) — read_in_full=true (fully accessible, not paywalled)
- **Model**: reframes fantasy aging as a **mortality-table / hazard problem**, not a smooth decline
  curve: for each age, estimate P(catastrophic "death" this season) rather than "average % of peak."
  Defines "fantasy-relevant season" (last year with >20 Estimated Value over Baseline), "death"
  (zero EVoB or ≥75% YoY decline), "decline" (25-75% drop), "survivor" (neither).
- **Data**: top 50 retired RBs and top 50 retired WRs, 30 years of NFL history — the actual
  population Gridiron's dynasty league drafts from.
- **Result**: among survivors (players who don't bust), production is "almost completely flat" by
  age — contradicting the smooth gradual-decline shape 4for4's curve (and thus Gridiron's file)
  assumes. Of the 100 players examined, 50% of final fantasy-relevant seasons ended in an outright
  decline-year rather than a slow fade; only 17% showed two consecutive declining seasons before
  falling off (i.e. the cliff, when it comes, mostly comes with one season of warning or less).
  Death-rate rises sharply with age for both positions, but RBs show a bit more pre-cliff decline
  than WRs, who are closer to pure "flat until the cliff."
- **Stated limitation**: retrospective, hand-defined thresholds (75%/25% cutoffs are the author's
  choice, not fit); N=100 total across two positions; no formal hazard regression (Kaplan-Meier/Cox)
  — it's a rate table, not a fitted survival model. That gap is exactly what candidate #3 below closes.
- **Why it's the strongest single source for this task**: it is fantasy-football-specific (unlike
  #2/#3), directly falsifies the *shape* Gridiron currently hard-codes ("gradual decline" is wrong;
  "flat-then-cliff" is closer to the data), and gives an actual quantitative target (50% single-year
  collapse rate, 17% two-year-warning rate) a Gridiron cliff-probability model should be checked
  against.

## Supporting repo (reference-only, not a port)

**johnrandazzo/surv_nflrb** — https://github.com/johnrandazzo/surv_nflrb
- License: none (no LICENSE file) — code must not be reused verbatim; ideas only.
- Stars: 7. Last pushed: 2018-10-14 (stale, 90 commits, single-author student project).
- What it does: scrapes Pro-Football-Reference career stats + player physical measurements
  (BeautifulSoup), builds a **Kaplan-Meier survival curve** and a **Cox Proportional Hazards** model
  of NFL RB career length on 1,014 retired RBs. Significant covariates in the final Cox model: BMI,
  yards/carry, and draft age. Fits the aggregate survival function to a generalized gamma
  distribution (μ=4.3805, σ=0.7168, Q=1.694).
- Adopt as: **borrow-idea** — the KM/Cox PH framing and the covariate list (BMI/efficiency/draft
  age) are exactly right for what Gridiron should build in candidate #3, but Gridiron already has
  better covariates available locally (draft_round/draft_pick from `player_accolades`, real usage
  share from `player_week_usage`) than this repo's scraped BMI, and the repo's data pipeline
  (undocumented scrape, no license, no tests) shouldn't be imported wholesale — re-implement the
  method against Gridiron's own DB.

## Candidates

See structured output. Summary of the 6 candidates:
1. **[new]** Fit an actual position-specific curve-with-uncertainty on Gridiron's own player
   population (once imported) via GAM+imputation (sources #1, #2), replacing the prose-anchor table.
2. **[new]** Add a Harstad-style cliff/hazard probability field alongside the smooth multiplier —
   the flat-then-cliff shape, not gradual decline (source #4).
3. **[new]** Build a real Kaplan-Meier/Cox-PH career-survival function using covariates already in
   Gridiron's DB (draft capital, usage share) — a genuinely new "years of dynasty shelf-life" number
   (repo + source #4 for validation targets).
4. **[fix]** Apply survivorship/healthy-worker correction (IPW or truncated-imputation) wherever the
   new curve or hazard model uses "still-active players' trend" as a feature — this is the same
   defect class as tonight's verified finding "No conformal or otherwise honestly-calibrated
   uncertainty interval exists anywhere in the pipeline — margins/totals are point forecasts with an
   assumed-normal SD," extended to the age-curve surface, which is exactly as point-estimate-only and
   uncertainty-free as the betting margins it names (sources #2, #3).
5. **[new]** One-time nflverse historical player-season import — the prerequisite data-engineering
   step every modeling candidate above depends on; called out as its own candidate because it's real,
   nontrivial cost that a "just fit a GAM" estimate would otherwise hide.
6. **[new]** Position×draft-capital interaction in the curve (rookie-contract WR/TE breakout timing
   differs from Day-3 picks) — a covariate dynasty managers already price in ADP that no version of
   the current or 4for4-anchor curve captures at all.

## Do-not-do
- Don't ship a "fitted" curve using only external blog data (4for4, PFF) relabeled as if it were
  Gridiron's own model — the entire point of this upgrade is fitting to real, checkable data or
  being explicit that it isn't.
- Don't build the full causal-inference machinery (MSM + IPW as in source #3) as a first cut in a
  Node.js service with no historical panel data yet — that's a multi-week academic project; start
  with the much cheaper truncated-imputation correction from source #2 and only reach for IPW if the
  simpler correction visibly fails a backtest.
- Don't collapse "gradual per-game decline" and "sudden cliff/injury-ending-career" into one number
  again — source #4 shows they are different phenomena with different shapes; a single multiplier
  launders both into one misleading average.
- Don't port johnrandazzo/surv_nflrb's code (unlicensed, stale, worse covariates than what Gridiron
  already has) — re-derive the KM/Cox approach against Gridiron's own tables.
- Don't fit any of this per-position on fewer than ~30-50 retired players once the historical import
  lands — Harstad's own N=50/position is already at the low end the author works with; going lower
  than that on Gridiron's own subset (e.g. splitting further by draft round) will overfit.
- Don't present the new cliff-probability or survival-curve number without also keeping the raw
  FantasyCalc market value and the existing multiplier visible side-by-side, exactly as
  `dynastyAgeAdjustment()` already does today — that transparency pattern is the one thing in the
  current file worth keeping as-is.
