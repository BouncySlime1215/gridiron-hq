# F10 — Copula-based dependence modeling for correlated legs (teasers, SGP)

Bucket: fix (this agent). 50% grounded in tonight's FOUND defect, 50% genuinely new capability.

## 0. What the repo actually does today (read-only grep, 2026-09-12)

Before proposing anything, I read the actual code the FOUND bullet points at, because the
literal claim ("legs sharing a game" for teasers) turned out to be **factually false** for
one half of it, and there is already a real Gaussian copula in production for the other half.
Getting this right changes what "fix" means here.

### `server/betting/nfl/strategy/teaser-leg-rates.js`
- The "cross-both" 6-point teaser family is built so that **a game's two sides can never both
  be candidate legs** (`familyPairCorrelation` reports `same_game_pairs: 0`, and the module's
  own header proves this structurally: a -7..-8.5 favourite's counterpart is a +7..+8.5 dog,
  never a member of the family). So teaser legs, by construction, never share a game. The
  literal wording of the assigned defect ("despite legs sharing a game") does not describe this
  file's actual object.
- What IS real and unaddressed: `ticketProbabilities()` and `ticketOutcomes()` (also in
  `teaser-staking.js`) multiply per-leg win/push/loss probabilities **assuming independence
  across different games in the same week** — no copula, no dependence model, just a product.
- The module's own audit (`familyPairCorrelation`, lines ~518-580) already measured this: raw
  same-week rho = -0.044, but a week-block bootstrap and a composition-corrected marginal show
  this is a **week-size weighting artifact**, not real dependence (permutation test p=0.116;
  corrected rho ≈ -0.0015, CI [-0.095, +00.008] includes zero). The file explicitly declines to
  "correct" for it on exactly these grounds, and states the correction, if done wrong, is a
  "factor of four" EV error waiting to happen (their words, from a documented prior mistake).
- `teaser-staking.js`'s `portfolioKelly`/`weekendPayoffDistribution` **already tried a Gaussian
  copula + Monte Carlo** for combining simultaneous tickets and **abandoned it**: the header
  records that sampling noise moved the answer by a third between seeds, and the copula "silently
  shrank the measured -0.044 binary correlation to about -0.025 on the way through the tetrachoric
  map." They replaced it with an exact second-order Bahadur expansion (matches every marginal and
  pairwise correlation exactly, zeros higher joint cumulants) computed by enumeration over ≤3^8
  outcome patterns — not simulation. This is a load-bearing prior finding for this research: a
  naive small-sample Gaussian-copula-by-Monte-Carlo attempt already burned effort here and was
  correctly reverted.

### `server/services/nfl-prop-correlation.js` — a Gaussian copula ALREADY EXISTS for props
- `fitPropCorrelations()` fits Pearson correlation on **residuals** (value minus that player's
  own mean) between quoted prop stats (`passing_yards, rushing_yards, receiving_yards,
  receptions, anytime_td`) for same-team and opposing-team player pairs in the same game, from
  `player_week_usage` joined to `players`, stored in `prop_correlation_estimates`
  (MIN_PAIRS=150).
- `samePlayerCorrelation()` fits the same thing within one player across two stats (e.g. a
  receiver's receptions vs receiving yards).
- `sgpAnalysis()` builds an n×n correlation matrix from these, conditions it to
  positive-definite (`conditioned()`, ridge search), Cholesky-decomposes it, and draws
  **correlated latent normals** — `cholesky`/`correlatedNormals`/`probit`/`normalCdf` all live
  in `server/services/stats-util.js` and are shared with `teaser-staking.js`'s abandoned
  attempt. This is a textbook Gaussian copula (exactly the construction in Haugh's notes,
  Section 2.1, "Simulating the Gaussian Copula") already wired into the SGP pricing path, with
  its own forward-CLV promotion gate (`sgpQuoteEvidence`: ≥50 paired candidate/close quotes,
  positive mean CLV, "0u until...").
- **What is genuinely missing here**: (a) the correlation table only ever knows about
  player-prop-to-player-prop pairs — there is no entry for a team-level leg (spread/total)
  correlated with a player prop, so a "spread + QB passing yards" same-game combination has
  *zero* dependence model despite unambiguously sharing a game; (b) the copula family is
  Gaussian only — `stats-util.js` has no t-copula, no Archimedean family, so every pair is
  forced through a single symmetric, zero-tail-dependence assumption regardless of what the
  data looks like; (c) the fitted correlation is one static number per (stat, position,
  relation) key forever — never conditioned on game script/spread/total.

### Data available for a real fix
- `nfl_play_by_play` (schema: `server/db/schema/nfl-a-to-m.js:306`, populated by
  `server/services/nfl-espn-pbp.js` and `server/services/nfl-pbp.js`) — this is the
  251,591-row table FOUND references; it is indexed by `(season, week)` and currently used only
  for hand-built features, never for joint/co-occurrence dependence estimation.
- `game_lines` (used by `teaser-leg-rates.js`) has team-level spread/margin per game per team.

## 1. Primary sources (4, all read in full)

1. **Haugh, M. (2016), "An Introduction to Copulas."** IEOR E4602 Quantitative Risk Management
   lecture notes, Columbia University.
   https://www.columbia.edu/~mh2078/QRM/Copulas.pdf — read in full (theory sections, pp. 1-10).
   Sample: states and proves Sklar's theorem (`F(x1,...,xd) = C(F1(x1),...,Fd(xd))`), the
   Fréchet-Hoeffding bounds, defines the comonotonic/countermonotonic/independence copulas,
   the Gaussian copula (`C_P^Gauss(u) = Φ_P(Φ^-1(u1),...,Φ^-1(ud))`, simulated via Cholesky —
   exactly what `stats-util.js` implements), the Student-t copula, and the Gumbel/Clayton
   Archimedean families. Key result: a bivariate normal and a "meta-Gumbel" distribution with
   the **same linear correlation (ρ=0.70)** produce visibly different scatter — the Gumbel
   pair shows much heavier co-movement in the upper-right tail (Figure 1) — which is the
   precise, provable sense in which "one correlation number" (what Gridiron computes today in
   both `nfl-prop-correlation.js` and `familyPairCorrelation`) underdetermines the joint
   distribution. Also documents named fallacies of Pearson correlation relevant to any
   "correlation bonus" reasoning: marginals + correlation do not determine the joint; not
   every ρ in [-1,1] is achievable for given marginals; and correlation does not maximize
   joint tail risk the way people assume.

2. **Aas, K., Czado, C., Frigessi, A., Bakken, H. (2009), "Pair-copula constructions of
   multiple dependence."** Insurance: Mathematics and Economics 44(2), 182-198 (working-paper
   PDF read: https://epub.ub.uni-muenchen.de/1855/1/paper_487.pdf, SFB 386 Paper 487) — read in
   full (37 pages: theory pp.1-9, application pp.20-26, conclusion). This is the foundational
   vine-copula paper (D-vines and canonical/C-vines), building an n-dimensional density as a
   cascade of bivariate ("pair") copulas, each pair free to be a *different* family
   (eq. 8-9). Sample/result: applied a 4-variable D-vine of Student-t pair-copulas to
   international stock/bond return data (S, M, T, B). The D-vine's AIC = -665.08 vs
   -632.18 for a single 4-D Student-t copula fit the standard way; a likelihood-ratio test
   (χ²=21.45, df=5) rejects the single-copula model at p=0.0007. Most concretely: the
   **tail-dependence coefficient** implied for one margin (S,M) is 0.029 under the pair-copula
   decomposition vs 0.001 under the single 4-D t-copula — **29× higher**. A single global
   correlation/copula assumption, fit the way Gridiron currently fits one, can silently erase
   almost all of the actual tail co-movement in the data. Honest limitation stated by the
   authors themselves: goodness-of-fit testing for pair-copula models "is still an unsolved
   problem," and with empirical (rank-transformed) margins the test's critical values are
   affected "in a complicated, non-trivial way" — i.e. even the authors flag that formal
   testing of a fitted vine is not fully solved.

3. **van der Wurp, H., Groll, A., Kneib, T., Marra, G., Radice, R. (2019), "Generalised
   Joint Regression for Count Data with a Focus on Modelling Football Matches."**
   arXiv:1908.00823 — read in full (intro/methodology pp.1-3, results pp.15-17, conclusion).
   Sample/result: bivariate-copula joint regression (implemented in the R package GJRM,
   tries Frank/FGM/Gaussian/Joe/Clayton/Plackett/AMH/Gumbel families, rotations included) on
   the goals scored by both teams in every match of five FIFA World Cups (2002-2018), with
   the copula parameter itself allowed to be a function of covariates. Result, stated
   honestly by the authors: the best-fitting copulas show only **weak dependence** between
   the two teams' goal counts (Kendall's τ ≈ 0.07-0.10 for the top-ranked families), and
   copula models "improve the values for the chosen measures by a small margin or not at
   all" versus a plain independence/Skellam baseline — consistent with prior literature
   (Groll et al. 2018) that found "no additional dependence modelling was needed" once
   predictors are well specified. A backtested betting strategy (constant stake and Kelly,
   copula model vs bookmaker odds on World Cup 2018) shows positive but small-sample,
   high-variance fictional returns (~50-60 units of profit on 100 staked over 64 matches),
   which the authors themselves caution against over-reading given sample size and one
   extreme-odds outcome (South Korea over Germany, avg. odds 19.52) driving much of the
   swing. This is the honest counterweight to source #2: copula modeling is not automatically
   free EV — it can also measure that the true dependence is small, and a betting backtest on
   64 games proves little either way.

4. **Wizard of Odds, "Same-Game Parlays: The Mathematics of Correlation."**
   https://wizardofodds.com/article/same-game-parlays-the-mathematics-of-correlation/ — read
   in full via fetch (practitioner explainer, not peer-reviewed, dated 2025/2026). Sample:
   walks the exact three-step Gaussian-copula SGP construction Gridiron's
   `nfl-prop-correlation.js` already implements (inverse-normal transform of each leg's
   marginal probability → multivariate-normal draw with a correlation matrix → integrate for
   joint win probability), and gives a worked numeric example: three legs at 58.3%, 52.4%,
   52.4% give an independent joint of 0.583×0.524×0.524 = 16.0%, vs ≈21.2% under a plausible
   positive correlation structure — a 33% relative increase, which is why a book would price
   that combination near +350 rather than the independence-implied +600. Directly validates,
   with real-world sportsbook-facing numbers, the shape of the `independent_probability` /
   `correlated_probability` / `correlation_multiplier` fields `sgpAnalysis()` already returns.
   Stated limitation: correlation matrices are context-dependent (favorite/dog, home/away,
   total) and for novel combinations with no historical data, accuracy "diminishes" —
   sportsbooks use a "hybrid approach" blending copula output with empirical frequency, which
   is effectively what `nfl-prop-correlation.js`'s `MIN_PAIRS=150` gate is already doing
   (falling back to correlation=0 below threshold).

## 2. Libraries checked (assigned: pyvinecopulib, copulas)

- **vinecopulib/pyvinecopulib** — https://github.com/vinecopulib/pyvinecopulib — MIT license,
  126 stars, **actively maintained** (latest commit 2026-09-10, a real 1.0.0-stable feature
  PR adding a PyTorch subclassing surface; commit history shows ongoing engineering
  discipline, not a dead academic package). Python interface to the `vinecopulib` C++/Eigen
  core, which reimplements the core of R's `VineCopula`/`rvinecopulib`. Confirmed working
  example (docs, `03_vine_copulas_fit_sample.html`, fetched): `u = pv.to_pseudo_obs(x)`,
  `controls = pv.FitControlsVinecop(family_set=[pv.gaussian])`,
  `cop = pv.Vinecop.from_data(u, controls=controls)`, then `cop.simulate(n_sim, seeds=...)`.
  Structure selection (which pairs go in which tree) is automatic. This is the direct
  Python analog of the Aas et al. D-vine method above, and the natural tool for the "new
  capability" candidates below (it has no sports-betting example out of the box, but the API
  maps 1:1 onto "fit a vine on my own leg data, simulate joint outcomes").
- **sdv-dev/Copulas** — https://github.com/sdv-dev/Copulas — 652 stars, license reported by
  GitHub as `NOASSERTION` (repo does not declare a clean SPDX id — check the actual LICENSE
  file before any real adoption), last push 2026-09-07. Broader but shallower: bivariate and
  multivariate Gaussian copulas plus a large marginal-distribution zoo, aimed at synthetic
  data generation (it's the copula engine inside the Synthetic Data Vault project), not vine
  decomposition — less relevant to Gridiron's actual gap (multi-family pairwise dependence)
  than pyvinecopulib.
- **No sports-betting/SGP example exists in either library's own docs or issues.** A GitHub
  code search for "copula" + "parlay" turns up only hobby projects
  (`Rithvik09/NBA-Player-Props-Analyzer` — 0 stars, no license; `shryesth/nba-betting-engine`
  — 1 star; `imnotaCTO/chachingAI` — 0 stars; `JesunAhmadUshno/BigFish` — 0 stars), every one
  of them independently re-deriving the same Gaussian-copula SGP construction
  `nfl-prop-correlation.js` already has in production. This is useful negative evidence: it
  confirms Gaussian-copula SGP pricing is a well-known, convergently-discovered pattern
  (matching source #4's description of what real books do), and that Gridiron is already at
  parity with the hobbyist state of the art on this specific piece — the actual uplift
  available is moving past Gaussian (vine/tail-dependent families), not "discovering
  copulas" from scratch.

## 3. How correlation would be estimated from Gridiron's own play-by-play co-occurrence data

Concretely, using `nfl_play_by_play` (schema at `server/db/schema/nfl-a-to-m.js:306`,
indexed `idx_pbp_season_week`):

1. Group rows by `(season, week, game_id)` and by a finer unit than the current weekly
   box-score residual (`fitPropCorrelations` in `nfl-prop-correlation.js` currently uses
   `player_week_usage`, one row per player per week) — e.g. by drive, or by quarter, to get
   many more joint observations per game than one.
2. For each pair of markets that can appear together in one SGP/teaser-adjacent ticket
   (team-A rush yards this drive vs team-B pass yards next drive; QB pass yards vs team
   total; a team's early-game pace vs a receiver's target share), compute the same kind of
   residual Gridiron already computes (value minus that player's/team's own mean) but at
   the finer grain, and accumulate the sufficient statistics (`sx, sy, sxx, syy, sxy`) exactly
   as `fitPropCorrelations`'s `add()` helper does — reuse the pattern, not a new library.
3. Transform to pseudo-observations (`pv.to_pseudo_obs`) and fit a vine
   (`pv.Vinecop.from_data(u, controls=pv.FitControlsVinecop(family_set=[pv.gaussian, pv.student, pv.clayton, pv.gumbel]))`)
   letting the library pick, per pair, whichever family actually fits — instead of Gridiron's
   current single global Gaussian assumption — and letting it pick the tree structure instead
   of assuming a flat n×n correlation matrix is the right shape for the dependence.
4. Store one row per fitted pair-copula (family + parameter + Kendall's τ + n) in a new table
   shaped like the existing `prop_correlation_estimates`, so `propPairCorrelation()`'s callers
   don't have to change, only its data source.
5. Gate promotion exactly the way `sgpQuoteEvidence()` already gates the existing Gaussian
   model: no staking authority until ≥50 paired candidate/close quotes priced with the new
   correlation source show positive mean CLV, and only relative to the existing Gaussian
   model, not to raw independence (the existing model already clears that lower bar).

## 4. Candidates

See structured output. 3 "fix" candidates target the exact code paths audited in §0; 3 "new"
candidates are capability Gridiron has zero of today (vine copulas, play-level co-occurrence
fitting, context-conditional dependence).

## 5. Do not do

- Do not add a "correlation bonus" to `ticketProbabilities`/`familyPairCorrelation` in
  `teaser-leg-rates.js` using the raw -0.044 same-week rho. The module's own bootstrap
  already showed this is a week-size composition artifact (CI includes zero;
  composition-corrected rho ≈ -0.0015). Doing so anyway repeats the exact "factor of four" EV
  mistake the file's own header documents having made and retracted once already.
- Do not describe teaser legs as "sharing a game" — the code proves the opposite
  (`same_game_pairs: 0`, structurally guaranteed by the candidate-line construction). A
  "same-game teaser copula" is not a real object; don't build one. The real gaps are (a)
  cross-game correlation within a week for teasers (already measured, ≈0 after correction)
  and (b) team-leg-to-player-prop same-game correlation (genuinely unmodeled).
- Do not touch `fantasy-football-dashboard` — it is read-only for this research, a live
  server is capturing Week 1 games, and none of these candidates require write access to
  validate the idea; every exit test above can be run offline on a copy or in a sidecar.
- Do not adopt any of the 0-1-star hobby "copula parlay" GitHub repos found during this
  search as a dependency or reference implementation — unmaintained, and none exceed what
  `nfl-prop-correlation.js` already does in production.
- Do not treat a fitted play-by-play copula (or any copula) as tradeable without the same
  forward-CLV promotion gate `sgpQuoteEvidence()` already enforces (≥50 paired candidate/close
  quotes, positive mean CLV) — a better-fitting joint distribution in-sample is not evidence
  of profitability against real prices, and both primary sources #2 and #3 above show
  copula-vs-independence AIC/likelihood improvements that are real but say nothing directly
  about betting profitability.
