# Online learning and drift for a weekly-refit, small-data NFL model

Builds on the earlier research: F08 (state-space ratings), F11 (conformal), F07 (anytime-valid inference), F04 (CLV), F18 (registry), GF02 (nfelo). The only repo change I read was read-only: `server/modeling/registry.js` already has `promote()`/`rollback()` with `REQUIRED_GATES = ['schema','leakage','data_quality','baseline_improvement','tests']`.

## 1. What the evidence says about how fast NFL team strength moves

- **Lopez, Matthews & Baumer (arXiv:1701.05976, published in Annals of Applied Statistics 2018)** fit a Bayesian state-space model to 10 NFL seasons of betting-market log-odds (Table 4, NFL):
  - γ_week = 0.978 (sd 0.005) and γ_season = 0.69 (sd 0.042).
  - σ_week = 0.147, σ_season = 0.331, σ_game = 0.233.
  - The 95% interval for γ_season is (0.61, 0.77).
  - They note Glickman & Stern (1998) got similar values, 0.99 and 0.82, with wider intervals.
  - A team-specific home advantage beat a constant one on DIC (−153.2, SE 24.3).
  - Code: https://github.com/bigfour/competitiveness.
  - Meaning: strength decays about 2% per week toward the mean within a season (a half-life of about 31 weeks), and about 31% regresses away between seasons.
- **FiveThirtyEight's NFL Elo** reverts 1/3 toward the mean each offseason (`REVERT = 1/3.0`, K = 20, HFA = 65; https://github.com/fivethirtyeight/nfl-elo-game/blob/master/forecast.py, MIT). That matches γ_season ≈ 0.69.
- **Glickman & Stern (1998)**, per F08: season-to-season SD is about 2.35 points vs week-to-week about 0.88. Across offseasons strength moves roughly 2.7 times as much as within a season.
- **Sample time-decay (soccer)**:
  - Dixon & Coles (1997) chose ξ = 0.0065 per half-week by predictive likelihood, a half-life of about 1 year. I only saw this via a secondary source (https://opisthokonta.net/?p=1013) and did not re-read the original.
  - The Ley et al. (2018) reproduction found a half-life of about 3 years (F08).
  - F08 reports `renenunezg/momentumnfl` uses `rating_half_life_weeks = 6.0` within season. That comes from F08; I did not re-verify it.
- **Pesaran & Timmermann (J. Econometrics 137:134–161, 2007)**:
  - After breaks, it can still be optimal to use pre-break data, because of the bias-variance trade-off.
  - They propose cross-validated window choice, or averaging forecasts across window lengths (https://ideas.repec.org/a/eee/econom/v137y2007i1p134-161.html).
  - This supports averaging over several half-lives instead of betting on one.

## 2. Refit cadence

- **Warm start vs fresh refit.** Ash & Adams (NeurIPS 2020, https://arxiv.org/abs/1910.08475): warm-started neural nets generalize worse than fresh ones even at similar training loss. That result is about neural nets. It argues against warm-starting any iterative learner here.
- **Cost.** The candidate models (ridge, hierarchical linear, Kalman) solve in closed form in milliseconds on about 7k game rows. Warm start saves nothing.
- **Two speeds are the principled split:**
  - Team state updates recursively after every game (a Kalman or score-driven filter). This is exact Bayesian updating, not a warm start. F08 cites Koopman & Lit (2019): the score-driven dynamic model beat the full state-space model and exponential downweighting, and ran in under 10 seconds vs about 1 hour.
  - Feature coefficients refit from scratch weekly on time-weighted history.
  - Hyperparameters (half-life, ridge λ, σ_week, σ_season, γ) are tuned only in the offseason, by walk-forward predictive likelihood, and frozen in season. Retuning weekly adds hidden trials (see F06 on multiplicity).
- **Effective sample size of decay weights** (my derivation from Kish's formula, not from a source): a half-life of h seasons gives ESS ≈ 2h/ln2 ≈ 2.9h seasons.
  - h = 1 season: about 780 games.
  - h = 3 seasons: about 2,300 games.
  - At about 270 games per season, a half-life under 1 season starves a model with more than about 20 coefficients. Coefficients should use multi-season half-lives. Only team state should move fast.

## 3. Drift detection is weak at this sample size

**ADWIN** (Bifet & Gavaldà, SIAM SDM 2007, https://www.cs.upc.edu/~gavalda/papers/adwin06.pdf):
- Rigorous cut: ε_cut = sqrt((1/2m)·ln(4/δ′)), with δ′ = δ/n and m = 1/(1/n0 + 1/n1).
- Tighter version (normal approximation plus Bernstein term): sqrt((2/m)σ²·ln(2/δ′)) + (2/3m)·ln(2/δ′).
- My calculation, assuming one season split in half (n0 = n1 = 136), δ = 0.05, residuals rescaled over an 80-point range, σ = 13.5:
  - Hoeffding version: detects a mean shift of about 22 points.
  - Tighter version: about 14 points.
- ADWIN can only catch gross breaks: pipeline bugs, sign flips, stale data.

**Loss differential vs the close** (my calculation, assumptions stated):
- d_t = e_model² − e_close². If model-minus-market has SD about 2 points, SD(d_t) ≈ 2·2·13.5 ≈ 54.
- Detecting a 5 squared-point degradation (about 0.18 RMSE) at 80% power needs roughly (2.8·54/5)² ≈ 900 games, about 3.4 seasons.
- The current gap (14.8 vs 13.55 RMSE, d ≈ 35) would show in about 20 games.
- **Implication:** in-season detectors can flag catastrophes, not subtle decay. Subtle decay is an offseason, multi-season question.

**CUSUM and Page-Hinkley:**
- Page (Biometrika 41:100–115, 1954) is the basis for both.
- river's `PageHinkley` "implements the CUSUM control chart" (defaults: min_instances = 30, delta = 0.005, threshold = 50, alpha = 0.9999; https://riverml.xyz/latest/api/drift/PageHinkley/). river is BSD-3 and has no JS port.
- Run them on weekly aggregates (about 14 games per week), not per game.
- Set thresholds by replaying detectors over historical walk-forward residuals to reach a chosen false-alarm rate (for example, at most one false alarm per 3 seasons). I did not re-verify textbook ARL tables, so thresholds should come from this replay instead.

**Model vs market over time.** Giacomini & Rossi (J. Applied Econometrics 25(4):595–620, 2010, https://onlinelibrary.wiley.com/doi/10.1002/jae.1177) give a Fluctuation test on rolling relative loss. It is the right offseason test for "did relative performance break."

**Continuous peeking.** Checking results every week needs anytime-valid confidence sequences (Howard et al. 2021 and Waudby-Smith & Ramdas 2024, per F07). A fixed-sample p-value is not valid when you look weekly.

## 4. Calibration monitoring and adaptive recalibration

- **ACI** (Gibbs & Candès, NeurIPS 2021, arXiv:2106.00170):
  - Update: α_{t+1} = α_t + γ(α − err_t).
  - Proposition 4.1 bound, with no distributional assumptions: |(1/T)Σerr_t − α| ≤ (max{α_1, 1−α_1} + γ)/(Tγ).
  - They used γ = 0.005.
  - For about 270 games per season, a larger γ (for example 0.01–0.02, my suggestion) keeps the bound meaningful within one season (T·γ ≈ 3–5).
  - It is about 10 lines of JS.
- **Davis et al. (J. Biomed. Inform. 112:103611, 2020, https://pubmed.ncbi.nlm.nih.gov/33157313/)**: online-SGD dynamic calibration curves plus adaptive sliding-window drift detection to decide when and on what data to update. This is the only clinical calibration-drift system I found. I read the abstract only; the numeric results were not accessible.

## 5. Adaptive ensemble weights

Fixed Share (Herbster & Warmuth, Machine Learning 32:151–178, 1998) tracks the best expert when the best one changes over time. It is the drift-aware replacement for static blend weights, but only for a small set of experts (market, filter, feature model).

---

## (A) Key findings

1. NFL strength dynamics are estimated, not guessed: γ_week ≈ 0.98 and γ_season ≈ 0.69 (Lopez et al. 2018; Glickman & Stern 1998). FiveThirtyEight's 1/3 reversion agrees. Priors for filter hyperparameters exist.
2. Recursive filtering for team state plus regularized refit for coefficients beats ad hoc decay (Koopman & Lit 2019, via F08).
3. Warm-starting has no benefit for closed-form models and hurts neural-net generalization (Ash & Adams 2020).
4. With about 270 games per season, drift detectors only catch gross breaks (ADWIN math above). Detecting subtle degradation takes multiple seasons.
5. ACI gives assumption-free long-run coverage under shift (Gibbs & Candès 2021). Window averaging is a robust alternative to picking a half-life (Pesaran & Timmermann 2007).
6. CLV has far lower variance than win/loss, reaching significance in about 50 bets per Buchdahl (F04, practitioner source). That makes CLV the only fast live feedback signal.

## (B) Recommended loop for Gridiron

**1. Offseason (once a year, preregistered per F06):**
- Tune σ_week, σ_season, γ_season, the per-team home-advantage prior, ridge λ, and the coefficient half-life grid {1, 2, 4, ∞ seasons}, by walk-forward log-likelihood on margin.
- Serve the average of the half-life fits (Pesaran & Timmermann) rather than the single argmax.
- Run the Giacomini-Rossi fluctuation test on multi-season model-vs-close loss.
- Freeze all hyperparameters with a hash.

**2. After each game (any time):**
- Kalman update of team state (Glickman & Stern form, closed-form JS).
- Log the prior and posterior state as of that game's final-score ingestion time.

**3. Weekly retrain (Tuesday cutoff after MNF, fixed time):**
- Training set: games whose final scores were ingested before the cutoff. Every feature is taken as of that game's kickoff (bitemporal, F05).
- Refit coefficients from scratch with ridge and exponential sample weights, in numpy or pure JS normal equations (both available now, nothing to install).
- The model is residual-to-market: target = margin − closing spread. Coefficients shrink toward 0, so the no-evidence default forecast is the market. This replaces binary gates with shrinkage.
- Register it as a candidate in `server/modeling/registry.js`. Keep schema, leakage, data_quality and tests as hard gates. Replace the binary `baseline_improvement` gate with a continuous score (below).

**4. Serving (during the week):**
- Later injury and line updates change inputs only, never coefficients.
- Every decision-tape row stores model_version, hyperparameter hash, feature-snapshot hash and as_of.

**5. Continuous bet gate:**
- Fit a one-coefficient discount-factor dynamic regression (West & Harrison, *Bayesian Forecasting and Dynamic Models*, 2nd ed. 1997, ch. 6; discount δ ≈ 0.98–0.99 per game, to be tuned offseason): (close − bet-time line) ~ β·(model − bet-time line).
- Record a shadow row for every game, bet or not, to maximize sample size.
- Stake = fractional Kelly × clip(lower confidence-sequence bound of β̂, 0, 1).
- Given the known −2.28 CLV history, this starts at zero stake and must earn its way up.

**6. Weekly monitor job (after grading):**
- Anytime-valid confidence sequence on mean shadow CLV and on d_t vs the close.
- CUSUM or Page-Hinkley on weekly mean standardized residual and weekly mean CLV, with thresholds from historical replay.
- ACI on 80% margin intervals.
- Pooled reliability bins for cover probability.
- Feature missingness and freshness checks.

**7. Rollback rules:**
- **Automatic on hard faults:** NaNs, stale data, a PIT violation, |model − market| distribution blowout, or an ADWIN/CUSUM alarm on residual mean. Action: stake = 0, serving pointer → previous champion via `rollback()`, forecast falls back to the market.
- **Performance-based:** only when the confidence sequence on d_t vs the previous champion excludes zero (worse). Never on a bad week alone.
- **Re-enable:** only by explicit owner action or a clean replay.

## (C) Adoptable code

- `bigfour/competitiveness` (GitHub; license not checked): the Lopez et al. state-space specification, Gibbs sampling code and posterior draws. Borrow the model form and the NFL priors for γ and σ. Do not port the MCMC.
- `fivethirtyeight/nfl-elo-game` (MIT): reversion and margin-of-victory constants as a baseline sanity benchmark.
- `online-ml/river` (BSD-3, about 6.1k stars): read the `drift/adwin`, `page_hinkley` and `kswin` implementations. Each is tens of lines to port to JS. It is Python-only and should not be installed.
- ACI: the update is in the paper; hand-write it. F11 lists `marcopeix/conformal-ts` (BSD-3) with ACI, AgACI and NexCP as a tested reference.
- In-repo: `server/modeling/registry.js` (`promote`/`rollback`/`atomicPromote`) and F07's confidence-sequence fix. Reuse these rather than building new infrastructure.

## (D) Open questions and risks

- Lopez et al. model market log-odds, not point margin, so their σ values don't transfer directly. γ should be re-estimated on margins in the offseason tuning step.
- The per-game SD of model-minus-market and of spread CLV in points must be measured from `game_lines` and the quote tape. My power numbers assume SD about 2 points and are illustrative.
- The in-season discount δ for the bet-gate regression is not established by any source I verified. It needs offseason replay.
- Residual-to-market with shrinkage may just reproduce the market (edge ≈ 0). That is the honest outcome if there is no signal. Hubáček & Šír (F04) suggest decorrelation from the market, not accuracy, drives profit.
- Anytime-valid bounds are wider (up to about 2x, per F07). With about 50–150 shadow bets per season, the stake may stay near zero all season.
- Only 2018+ has opener and snapshot data, which limits bet-gate training to about 8 seasons.
- The Dixon-Coles ξ figure and the momentumnfl 6-week half-life are secondhand. Treat them as grid candidates, not defaults.

Sources:
- https://arxiv.org/abs/1701.05976
- https://github.com/bigfour/competitiveness
- https://github.com/fivethirtyeight/nfl-elo-game
- https://www.cs.upc.edu/~gavalda/papers/adwin06.pdf
- https://riverml.xyz/latest/api/drift/PageHinkley/
- https://github.com/online-ml/river
- https://arxiv.org/abs/2106.00170
- https://onlinelibrary.wiley.com/doi/10.1002/jae.1177
- https://ideas.repec.org/a/eee/econom/v137y2007i1p134-161.html
- https://arxiv.org/abs/1910.08475
- https://pubmed.ncbi.nlm.nih.gov/33157313/
- https://academic.oup.com/biomet/article-abstract/41/1-2/100/456627
- https://dl.acm.org/doi/10.1145/2523813
- https://cseweb.ucsd.edu//~kamalika/teaching/CSE291W11/mar2.pdf
- https://opisthokonta.net/?p=1013
- https://dl.acm.org/doi/10.5555/261170

Prior reports relied on are in /private/tmp/claude-501/-Users-nick-matta-Claude-Artifacts/e22ddbdc-9d23-482e-a1cc-7bc1f39b77c6/scratchpad/research2/: F04-clv-unification.md, F07-sequential-inference-fix.md, F08-bayesian-state-space-ratings.md, F11-conformal-calibration.md, F18-audit-architecture-consolidation.md, GF02-nfl-ratings-elo.md.