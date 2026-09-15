# F09 — Hierarchical Bayesian / NB / zero-inflated player-prop distributions

Researcher: F09-hierarchical-prop-distributions (bucket: fix)
Date: 2026-09-12

## What Gridiron actually does today (verified by reading the code, not assuming FOUND is exactly right)

FOUND's summary line — "Player props are point-estimate projections, not distributions — no
negative-binomial/hierarchical/calibrated model" — is directionally correct but imprecise about
*which* layer is the point estimate. Read in full:

- `server/services/nfl-props.js:1-15` — the module header explicitly says props are "simulated
  rather than reported as a single number," because "a prop is a question about a distribution."
  So there IS Monte Carlo simulation of a distribution.
- `server/services/player-week-engine.js:34-51` — team-level pass attempts / rush carries ARE
  drawn from a **negative binomial** (`randNegBinomial`), with dispersion fit by **method-of-
  moments** from `player_week_usage` (132 team-seasons for attempts, 150 for carries):
  `TEAM_PASS_ATTEMPT_DISPERSION = 47`, `TEAM_RUSH_CARRY_DISPERSION = 31` — both **fixed point
  constants**, not posterior distributions over dispersion.
- `server/services/projections.js:478-480` — per-player NB dispersion is likewise a **plug-in
  point estimate**: `dispersion = Math.min(30, Math.max(1.2, oppVar > oppMean ? oppMean**2/(oppVar-oppMean) : 12))`
  — classic method-of-moments NB dispersion, no uncertainty carried forward.
  Every player-level rate feeding the simulation (target share, catch rate, YPC, TD rate) goes
  through `shrinkSafe(observed, prior, n, k)` (`projections.js:426-471`), where `k` itself is a
  **fitted point estimate** from `shrinkage-fit.js`'s one-way random-effects ANOVA
  (`k* = sigma^2_within / sigma^2_between`, method-of-moments, no posterior on `k`).
- `server/services/td-regression.js:255-286` — the touchdown-regression view does not even use
  Poisson/NB properly; it approximates a standard error as `se = sqrt(max(0.5, expected))` and
  calls it "the Poisson standard error," then buckets confidence into
  strong/moderate/weak by `|gap/se| >= 2 / 1.2`. This is a Wald-normal heuristic dressed as
  Poisson, not a fitted count model.
- `server/services/nfl-prop-player-heads.js` and `nfl-prop-player-weekly-heads.js` — the
  "player engine" TD-prop research heads are ridge-**logistic** regressions of a single scalar
  (the anytime/multi-TD win probability), stacked on the shipped Platt/isotonic/beta calibrators
  in `nfl-prop-calibration.js`. Output is `applyAugmented() -> clamp(sigmoid(...))`, i.e. **one
  probability number per player-market**, never a count distribution. This module's own
  docstring records it was declined 0/3 and 0/3 on walk-forward Brier, and diagnosed the failure
  as a **grain problem** (season-level constant features), not a distribution-shape problem —
  meaning nobody has yet tried fixing it with a real hierarchical count model.
- No stored posterior / posterior-predictive artifact exists anywhere: `server/migrations/`
  has no table for prop calibration draws or quantiles (only `018_saved_prop_tickets.js`, which
  is the user's own bet slip, not a model artifact). Every prop percentile is recomputed by
  live Monte Carlo (`samplePlayerWeekEvents`, `sampleTeamWeekEvents`) from POINT parameters at
  request time.
- No probabilistic-programming toolchain exists at all: `research/.venv` has scipy/sklearn/
  pandas/seaborn but **no pymc, no cmdstanpy/pystan, no numpyro, no arviz** (checked directly).
  Every "Bayesian" step in Gridiron today is hand-rolled empirical-Bayes shrinkage in JS with
  point-estimate hyperparameters — real hierarchical Bayes (joint MCMC posterior over
  hyperparameters AND per-player effects, propagating both levels of uncertainty into the
  predictive interval) does not exist anywhere in the codebase.

**Net assessment:** Gridiron already has the right *shape* of model (volume x efficiency,
simulated, NB-distributed opportunity counts, empirical-Bayes shrinkage) — it is not starting
from zero. What it lacks is exactly what "hierarchical Bayesian" adds on top of empirical Bayes:
(1) a posterior *distribution* over the pooling/dispersion hyperparameters instead of a single
method-of-moments number, so a rookie or single-game-sample player's predictive interval widens
correctly instead of silently trusting a fixed `k`/`dispersion`; (2) a genuine count-distribution
model for touchdowns/receptions in place of the ridge-logistic scalar-probability heads and the
sqrt(expected) Wald heuristic; and (3) any zero-inflation component, which nothing in the
pipeline has (a healthy starter who gets benched at half or a committee back who vultures zero
touches is not "a low-rate NB draw," it's a structural zero).

## Primary sources (4 read in full)

1. **Baio, G. & Blangiardo, M. (2010). "Bayesian hierarchical model for the prediction of
   football results." Journal of Applied Statistics 37(2), 253-264.**
   Fetched and read the full 13-page PDF (all sections, all tables, WinBUGS code appendix).
   - Model: `y_gj | theta_gj ~ Poisson(theta_gj)`, `log(theta_g1) = home + att_h(g) + def_a(g)`,
     `log(theta_g2) = att_a(g) + def_h(g)`; team effects exchangeable,
     `att_t ~ N(mu_att, tau_att)`, `def_t ~ N(mu_def, tau_def)`, sum-to-zero identifiability,
     flat/Gamma(0.1,0.1) hyperpriors. Fit in WinBUGS via MCMC.
   - Data: Italian Serie A 1991-92 (T=18 teams, G=306 games) and 2007-08 (20 teams, G=360).
   - Result: home-effect posterior mean 0.2124 [0.1056, 0.3213] (1991-92) and 0.3578
     [0.2748, 0.4413] (2007-08). Basic model **overshrinks** extreme teams (top scorers
     Inter/Roma predicted 69/67 points vs actual 85/82) — the paper's own headline finding.
   - Fix: a 3-component mixture (bottom/mid/top-table groups) on `att`/`def` using
     non-central-t(4) instead of Normal, each group's location itself given a
     Dirichlet-mixture membership — reduces overshrinkage (mixture-model points 76 vs 69 for
     Inter). This mixture idea is the direct analogue of what Gridiron would need for
     "blue-chip volume hog" vs "committee back" player sub-populations rather than one global
     position prior.
   - Honest limitation stated by the authors: validation is **in-sample posterior-predictive
     checking against the same season's data**, not a genuine held-out season — "for the sake
     of simplicity, predictions are obtained in one batch... using the observed results to
     estimate the parameters." No out-of-sample test in this paper. (The player-level extension
     below fixes that.)

2. **Whitaker, G.A., Silva, R., Edwards, D. & Kosmidis, I. (2020). "A Bayesian approach for
   determining player abilities in football." arXiv:1710.00001 (published J. R. Stat. Soc. C).**
   Fetched and read the full paper (22 pages incl. appendix pointers).
   - Extends Baio & Blangiardo to the **player level**: for event type e, player i on team j
     in game k, `X_i,k^e ~ Poisson(eta_i,k^e * tau_i,k)` where
     `eta_i,k^e = exp{ Delta_i^e + tau_i,k*(lambda1*sum(teammates' Delta) - lambda2*sum(opponents' Delta)) + home*gamma^e }`,
     `tau_i,k` = fraction of the match the player was on the pitch, Gaussian prior on player
     ability `Delta_i^e ~ N(-2, 2^2)`. Fit by **variational inference** (mean-field, ELBO
     maximized via autograd+ADAM) rather than full MCMC, explicitly for scalability — 2182
     parameters over 544 players.
   - Data: touch-by-touch English Premier League, 2013/14 (train, 380 games, 544 players) and
     2014/15 (held-out test), ~1.2M events total, ~1600 events/game, 39 raw event types grouped
     into Goal/GoalStop/Shots/ChainEvents/etc.
   - **Genuine out-of-sample validation** (the thing Baio & Blangiardo lacked): predicting
     over/under 2.5 goals in each 2014/15 match using only pre-match info (a human-verified
     predicted starting XI, 86% accurate). AUC by prediction block, baseline (team-only) vs
     +player-abilities: block1 0.47->0.54, block2 0.60->0.65, block3 0.53->0.58,
     block4 0.55->0.68, block5 0.61->0.62 — player-ability model wins every block. Real-money
     backtest against the over/under betting market for the full 2014/15 season: flat £100/bet
     staking returned **+£4486.73** with player abilities vs **-£378.54** for the baseline team-
     only model.
   - Honest limitations stated: AUCs are modest (0.47-0.68, several barely above chance);
     "unable to disclose the full details of the betting strategy" (can't audit staking); a
     single held-out season; predicted starting lineups came from human experts, not the model
     (real deployment would need a lineup-uncertainty layer); event-type groupings and the
     independence-between-grouped-events assumption are acknowledged simplifications; player
     ability is treated as constant across a season (no in-season random walk) even though the
     paper's own results (Fig. 11) show ability visibly drifting block to block (e.g. Kane's
     goal-ability rising sharply once he got playing time) — the authors flag a random-walk
     extension as future work, unimplemented here.
   - Direct relevance to Gridiron: this is literally "replace `shrinkage-fit.js`'s static
     per-season `k` with a jointly-fit hierarchical Poisson/NB model over players, with a proper
     posterior, validated the way Gridiron already validates everything else (walk-forward,
     held-out season, a real market backtest)" — done, published, with code structure (PyStan)
     directly transferable.

3. **Jensen, S.T., McShane, B. & Wyner, A.J. (2009). "Hierarchical Bayesian Modeling of Hitting
   Performance in Baseball." arXiv:0902.1360 (Annals of Applied Statistics).**
   Fetched and read the full paper (12+ pages incl. results tables).
   - Model: `Y_ij ~ Binomial(M_ij, theta_ij)` (home runs out of at-bats), 
     `logit(theta_ij) = alpha_k + beta_b + f_k(Age_ij)` with `alpha_k` a **two-component mixture**
     (elite vs non-elite home-run hitter) per position `k`, `f_k` a cubic B-spline age curve per
     position, and a **hidden Markov model** on each player-year's elite/non-elite latent state
     (transition probs partially pooled by position, later extended to player-specific
     transitions with a Dirichlet hyperprior — genuine partial pooling of a *dynamic* per-player
     parameter, which is the "and weeks" half of the "players and weeks" ask in this brief).
   - Data: Lahman database, MLB 1990-2005 fit set (10,280 player-years, 9 positions, 46
     ballparks), held out and validated on **2006** (559 players).
   - Internal result: full model RMSE 5.30 with 85.5% 80%-interval coverage vs RMSE 6.87 /
     64.4% coverage stripping position+mixture, vs RMSE 8.24 for a same-as-last-year strawman.
     Player-specific-transition extension: RMSE 5.45, coverage 87.1% — **not actually better**
     despite more parameters; authors report this honestly as "not enough additional
     information in personal history... to noticeably improve predictions," a direct
     illustration of the "more hierarchy isn't free" risk this research brief should flag.
   - **External benchmark**, the standard this brief asked for: on the 118 top HR hitters with
     PECOTA and MARCEL predictions available, RMSE 7.33 (this model) vs 7.11 (PECOTA) vs 7.82
     (MARCEL) — **the hierarchical model is not the outright RMSE winner overall** (PECOTA
     beats it), but wins on MAE (4.40 vs 4.68/4.41) and "% closest" (41% vs 28%/31%), and wins
     decisively on young players (age<=26: RMSE 2.62 vs 4.62 PECOTA vs 4.15 MARCEL, 62% closest).
     Reported honestly, including the failure mode: worst errors are all in the DH position,
     which the authors attribute to DH not fitting the position-prior assumption well.
   - Direct relevance: (a) demonstrates the exact "elite/non-elite" mixture-of-sub-populations
     structure a real receiving-TD or target-hog model would want (some WRs are structurally
     high-volume, not just a shrunk average WR); (b) is the single cleanest "here is exactly how
     to grade a hierarchical count/rate model against real external competitor benchmarks,
     and here is what an honest, mixed result actually looks like" template available.

4. **PyMC Example Gallery — "Hierarchical Partial Pooling" (Efron & Morris 1975 baseball
   batting-average case study).**
   Fetched and read in full via WebFetch.
   - Model: `phi ~ Uniform(0,1)` (population mean), `kappa_log ~ Exponential(1.5)`,
     `theta_i ~ Beta(phi*kappa, (1-phi)*kappa)`, `hits_i ~ Binomial(at_bats_i, theta_i)`.
   - Data: the canonical n=18-player, small-sample (as few as 4 at-bats) Efron-Morris dataset,
     plus a synthetic 19th player (4 at-bats, 0 hits) added specifically to demonstrate
     shrinkage.
   - Result: population mean posterior ~0.26 [0.22, 0.31]; the 0-for-4 player's partially-pooled
     estimate lands near **0.20**, not 0 — the textbook demonstration of why partial pooling
     specifically helps the exact case Gridiron currently handles worst: a low-snap-count
     player (backup, injury replacement, Week 1 rookie) whose empirical rate is a single small
     count. This is the direct evidence for why `shrinkage-fit.js`'s method-of-moments point `k`
     is not the finish line: a *posterior* over `theta_i` (not a shrunk point estimate) is what
     lets Gridiron report a real credible interval on, e.g., a rookie WR's Week 1 target share
     instead of one shrunk number with no attached uncertainty.

### Secondary/supporting sources consulted (not read in full — cited for context only)
- PyMC "Hierarchical model for Rugby prediction" case study (Six Nations 2014-2017, 60 matches):
  same Baio&Blangiardo-style attack/defense Poisson GLM in modern PyMC syntax, useful as an
  implementation template but not independently validated against a market, so not counted as
  a primary source.
- srome.github.io "Bayesian Hierarchical Modeling Applied to Fantasy Football Projections"
  (PyMC3, 2013-2015 NFL fantasy scoring): a practitioner case study with a *negative* headline
  result worth citing as a do-not-do warning — full-model MAE 6.08 vs a naive 7-game-average
  baseline's MAE 5.99, i.e. the hierarchical model **did not beat the trivial baseline** on
  point accuracy; the only real win was in the calibration of predictive SD (low-SD subset
  showed better MAE), reinforcing that this class of model earns its keep on *uncertainty
  quality*, not on point-forecast accuracy, and should be gated on interval calibration/CLV,
  not on RMSE alone.
- PyMC Discourse thread "Fantasy Football Hierarchical Model Questions": a live practitioner
  debugging session showing the most common way these models go wrong in practice — a
  hierarchy that adds parameters with no actual variance to explain (deterministic point
  projections fed in as "data"), and diagnostic tells (ESS<100, two parameters moving in
  lockstep) to watch for. Useful as a pre-mortem checklist, not a validated result.

## Do not do
- Do not replace the entire `player-week-engine.js`/`projections.js` empirical-Bayes machinery
  wholesale. It already does the right *shape* of thing (volume x efficiency, NB-distributed
  opportunity, shrunk rates) and is walk-forward tested; a hierarchical Bayes upgrade should
  slot in at the two specific point-estimate seams (dispersion, shrinkage k) and at the TD-prop
  head, not rip out the simulator.
- Do not fit a hierarchical model and skip the walk-forward + market-CLV gate that
  `model-governance.js` already enforces for every other prop head in this codebase — Jensen et
  al.'s own result (a hierarchical model that LOST to PECOTA on RMSE) is the proof that
  "more Bayesian" does not imply "better," and the srome fantasy-football case is the proof it
  can straightforwardly lose to a 7-game rolling average on point accuracy.
- Do not add player-specific dynamic parameters (per-player HMM transition probabilities, a
  random walk per player) as a first move — Jensen et al. tried exactly this
  (player-specific transitions) and it did not improve predictions despite added complexity.
  Start with position-level (or role-level) partial pooling only; earn dynamics with evidence.
- Do not fit in JS. There is no MCMC/VI library in this codebase or in `research/.venv`
  (checked: no pymc/pystan/cmdstanpy/numpyro/arviz). Do not hand-roll a Gibbs sampler in
  Node — use the existing Python research environment (add pymc or numpyro) as an offline batch
  job that exports fitted posteriors/quantiles for the JS server to read, mirroring how
  `scripts/fit-team-volume-dispersion.mjs` already separates "fit offline" from "consume online."
- Do not report a hierarchical model's win using in-sample fit quality (Baio & Blangiardo's own
  original paper's weakness) — always validate on a season/week the fit never saw, the way
  Whitaker et al. and Jensen et al. both did.
