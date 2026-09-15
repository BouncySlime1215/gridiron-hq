# Walk-Forward Validation Protocol for the Gridiron NFL Model Redesign

**What this builds on:** F06 covers DSR (the deflated Sharpe ratio), PBO/CSCV (probability of backtest overfitting), Holm and the Harvey-Liu haircut. GF10 covers the purgedcv `effective_n_trials` function and the `research_trials` table design. F02 covers Diebold-Mariano with the HLN correction and Giacomini-White. F07 covers always-valid p-values. GF05 covers walk-forward harnesses. I don't repeat that material. This report adds the protocol design, the data-snooping tests, reuse of a holdout that has already been looked at, sequential live validation, and a power check.

## 1. Leakage: purging and embargo applied to NFL data

López de Prado (*Advances in Financial Machine Learning*, Wiley 2018, ch. 7) defines two fixes:
- **Purging:** drop training rows whose label period overlaps the test labels.
- **Embargo:** also drop training rows that come just after the test period.

NFL game outcomes resolve almost instantly, so the leakage in this app comes from features and from labels that take time to resolve:
- **Labels that take time to resolve.** CLV (closing-line value) resolves between the open and the close. Season-to-date targets resolve over weeks.
- **Carry-over features.** Week-1 priors use last season's results, and ratings get updated after the fact.
- **Revised data.** Injury records are bitemporal and get revised later (F05).

**The rule to enforce:** a training row is allowed for test game g only if its `evaluation_time` (label resolved) is before g's `prediction_time` (feature cutoff T), and every feature has `knowledge_time ≤ T`. purgedcv's `WalkForwardSplit` has exactly this interface: `prediction_times`, `evaluation_times` and `purge_horizon`. I checked this in the local clone (`github/eslazarev__purged-cross-validation/src/purgedcv/_walk_forward.py`, MIT). Its docstring notes that embargo does nothing in walk-forward, because every training row is already before the test fold. Embargo only matters for combinatorial CV.

## 2. Walk-forward vs combinatorial purged CV (CPCV)

- **Cerqueira, Torgo & Mozetič (2020), *Machine Learning* 109:1997–2028** ([arXiv 1905.11744](https://arxiv.org/abs/1905.11744)). Across 174 real series, cross-validation worked for stationary series. For non-stationary real-world series, out-of-sample methods that keep time order gave the most accurate estimates. NFL football is non-stationary (rule changes, kickoff and PAT changes).
- **Bergmeir, Hyndman & Koo (2018), *CSDA* 120:70–83** ([link](https://robjhyndman.com/publications/cv-time-series/)). K-fold CV is valid only for purely autoregressive models with uncorrelated errors. That doesn't describe this model.
- **Arian, Norouzi & Seco (2024), *Knowledge-Based Systems* 305** ([SSRN](https://www.ssrn.com/abstract=4778909)). In a synthetic finance setting, CPCV gave lower PBO and better DSR than walk-forward, which showed "notable shortcomings in false discovery prevention". I only read the abstract; the full text returned a 403, and the setting is synthetic.

**How to reconcile them:** use strict walk-forward to estimate performance, because it matches how the model is deployed. Use season-block CPCV only to diagnose how fragile hyperparameter choices are (PBO). Never use CPCV to select a configuration; the PBO paper itself warns against that (F06).

## 3. Nested selection

**Cawley & Talbot (2010), *JMLR* 11:2079–2107** ([link](https://jmlr.org/papers/v11/cawley10a.html)):
- Overfitting during model selection is "often of comparable magnitude" to the real performance gaps between algorithms.
- A low-variance selection criterion matters as much as an unbiased one.
- The fix is nested resampling.

For this app, that means:
- Keep the hyperparameter grid tiny and fixed in advance.
- Select on a low-variance score (log score or CRPS over many weeks), never on ROI.

## 4. Data snooping across many models

- **White's Reality Check** (White 2000, *Econometrica* 68:1097–1126, [doi](https://doi.org/10.1111/1468-0262.00152)) tests whether the best model found in a search beats a benchmark.
- **Hansen's SPA test** (Hansen 2005, *JBES* 23:365–380, [RePEc](https://ideas.repec.org/a/bes/jnlbes/v23y2005p365-380.html)) is more powerful and less sensitive to poor or irrelevant alternatives. It studentizes the statistic and uses a null distribution that depends on the sample.
- **Romano-Wolf StepM** (Romano & Wolf 2005, *Econometrica* 73:1237–1282, [link](https://www.econometricsociety.org/publications/econometrica/2005/07/01/stepwise-multiple-testing-formalized-data-snooping)) identifies which models beat the benchmark, with FWER control.
- **The Model Confidence Set** (Hansen, Lunde & Nason 2011, *Econometrica* 79:453–497, [doi](https://doi.org/10.3982/ECTA5771)) returns the set of models that can't be told apart. When data are uninformative, the set is large; that is the honest answer for 270 games a season.
- **Bootstrap:** all of these use the stationary bootstrap (Politis & Romano 1994, *JASA* 89:1303–1313; block length per Politis & White 2004, corrected by Patton, Politis & White 2009).
- **Implementation:** `bashtage/arch` has `SPA`, `StepM` and `MCS` classes ([docs](https://arch.readthedocs.io/en/latest/multiple-comparison/multiple-comparison-reference.html)). Its license text is BSD-style (read from the raw LICENSE file; the exact variant is unconfirmed). It needs scipy and pandas, which are not installed.

## 5. Pairwise tests on small samples

- **HLN correction.** Harvey, Leybourne & Newbold (1997), *IJF* 13:281–291 ([EconPapers](https://econpapers.repec.org/RePEc:eee:intfor:v:13:y:1997:i:2:p:281-291)), give the small-sample fix for Diebold-Mariano: a correction factor plus Student-t critical values. F02 already found this in johntwk's DM test script (MIT).
- **Nested models.** A market-anchored model contains the market as a special case. Clark & West (2007), *J. Econometrics* 138:291–311 ([RePEc](https://ideas.repec.org/a/eee/econom/v138y2007i1p291-311.html)), show that under the null the simpler model's MSPE is expected to be smaller, because the bigger model estimates extra parameters that add noise. A plain DM test is then biased against the challenger. Use the Clark-West adjusted differential, or Giacomini-White with a rolling window (F02).

## 6. Reusing a holdout that has already been examined

- **Reusable holdout.** Dwork et al. (2015), *Science* 349:636–638 ([doi](https://www.science.org/doi/10.1126/science.aaa9375)), show a holdout can be reused safely for adaptively chosen analyses by adding noise to how it answers queries (Thresholdout).
- **Ladder.** Blum & Hardt (2015), ICML ([PMLR](https://proceedings.mlr.press/v37/blum15.pdf)), release a new leaderboard score only when a submission beats the previous best by a margin. Their guarantees hold under a fully adaptive setting.
- I read the abstracts and summaries of both papers, not the full proofs.
- **Effective number of trials.** López de Prado & Lewis (2019), *Quantitative Finance* 19:1555–1565 ([SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3167017)), estimate how many effectively uncorrelated trials were run by clustering them. purgedcv's autocorrelation-based `effective_n_trials` is the cheap alternative (GF10).

## 7. Anytime-valid live comparison

- **Choe & Ramdas (2024)**, *Operations Research* 72(4):1368–1387 ([arXiv 2110.00115](https://arxiv.org/abs/2110.00115)):
  - Gives confidence sequences and e-processes for the mean score difference between two forecasters.
  - Valid under continuous monitoring, with no distributional assumptions.
  - Main theorems need bounded scores; unbounded scores are handled separately.
  - Includes a real baseball-forecaster example.
  - Code: [yjchoe/ComparingForecasters](https://github.com/yjchoe/ComparingForecasters) (MIT, needs pandas).
- **Henzi & Ziegel (2022)**, *Biometrika* 109:647–663, with a published correction ([arXiv 2103.08402](https://arxiv.org/abs/2103.08402)):
  - Gives e-values for score differences between probability forecasts of binary events.
  - Valid in finite samples and under optional stopping.
  - Code: [AlexanderHenzi/eprob](https://github.com/AlexanderHenzi/eprob) (MIT, R).

## 8. Power check (my own simulation, not from a paper)

I ran a numpy Monte Carlo (`scratchpad/wf_power.py`) with these **assumptions**:
- Outcome noise SD = 13.3.
- The market's error around the true mean has SD 2.5, so market RMSE ≈ 13.53.
- The model removes a fraction ρ of the market's error and adds its own noise.
- The test is a one-sided paired squared-error test at 5%.

| True RMSE gain vs close | Power at 270 games (1 season) | 1,350 games | 2,700 games |
|---|---|---|---|
| 0.08 | 0.27 | 0.76 | 0.96 |
| 0.14 | 0.42 | 0.94 | 1.00 |
| 0.025 | 0.07 | 0.10 | 0.14 |

**So one season of 2026 live data will most likely be inconclusive, even if the model has real skill.** Anytime-valid methods pay for optional stopping with lower power than a single fixed-sample test.

---

## (A) KEY FINDINGS

1. **Walk-forward vs CV:** time-ordered walk-forward is the right way to estimate performance on non-stationary data; ordinary CV isn't valid here (Cerqueira et al. 2020; Bergmeir et al. 2018). CPCV beat walk-forward at preventing false discoveries only in synthetic finance (Arian et al. 2024, abstract only).
2. **Selection overfitting:** overfitting during model selection is as large as real model differences, so selection must be nested and use a low-variance criterion (Cawley & Talbot 2010).
3. **Many models vs the market:** comparing many models against the close needs SPA or StepM (White 2000; Hansen 2005; Romano & Wolf 2005). The MCS gives the honest "can't tell them apart" answer (Hansen et al. 2011).
4. **Nested models:** a model built around the market needs the Clark-West adjustment, or HLN-corrected DM or GW with a rolling window (Clark & West 2007; HLN 1997).
5. **The 2021–2025 window is no longer a confirmatory holdout.** It can only be reused through a Ladder or Thresholdout-style gate, with trials counted (Dwork et al. 2015; Blum & Hardt 2015; López de Prado & Lewis 2019).
6. **Live monitoring:** checking the model weekly is valid only with e-processes or confidence sequences (Choe & Ramdas 2024; Henzi & Ziegel 2022).
7. **Power:** one season has low power for realistic gains (my simulation above, assumption-dependent).

## (B) CONCRETE RECOMMENDATIONS

**1. One as-of harness.** Every row carries `prediction_time` (the feature cutoff T) and `evaluation_time`.
- A training row is admitted only if `evaluation_time < T` of the test game.
- Every feature must satisfy `knowledge_time ≤ T` (bitemporal, F05).
- Retrain weekly on an expanding window. Optionally down-weight older seasons, with the decay rate as a hyperparameter.

**2. Split history into tiers (seasons):**
- **Tier 0, training only: 1999/2006–2014.** Its labels are used only for fitting.
- **Tier 1, development: 2015–2020.** This is the nested outer loop. For each season s, choose hyperparameters with an inner walk-forward over s−4 to s−1, retrain on all seasons before s, and predict s week by week.
  - Tune once each preseason, not weekly.
  - Keep the grid at 20 cells or fewer (ridge λ, rating half-life, prior shrinkage), all logged in `research_trials`.
  - Select by mean log score or CRPS. Prefer the simplest configuration within one standard error of the best, or average the near-best ones.
- **Tier 2, burned validation: 2021–2025.** Report on it only through a Ladder rule: publish a new number only if it beats the recorded best by more than one week-clustered standard error. Every access is logged and adds to the effective trial count. Never promote a model on Tier 2 alone.
- **Tier 3, sealed backward holdout (optional): e.g. 2009–2011.** Use it only if the registry shows it was never scored. The final configuration is evaluated there once, walk-forward, trained only on seasons before 2009. This is a weaker check, because the game was different then.

**3. Season-block CPCV, diagnostics only.** Run it on Tiers 0–1 for PBO on the hyperparameter grid.
- The embargo after a test season covers the next season's weeks whose priors still carry that season's weight, i.e. until the prior weight falls below about 10%.

**4. Tests to report:**
- **Primary:** walk-forward margin CRPS and cover-probability log score vs the devigged close.
- **Loss differentials:** collapse per-game loss differences to **weekly means**, since games in the same week share shocks. Then run HLN-DM with n−1 degrees of freedom, and Clark-West when the market is an input.
- **Multiple models:** SPA against the close, plus MCS, using a stationary bootstrap that resamples whole weeks.
- **Bet P&L:** DSR using effective N from the registry (F06/GF10).

**5. Gate the bet continuously, not with a binary pass/fail:**
- Stake multiplier = min(1, max(0, lower bound of the confidence sequence on the log-score or CLV edge) ÷ target edge).
- Real stakes require an e-value of at least 20 (α = 0.05) against the close.
- Clip probabilities so the Brier and log scores stay bounded.

**6. 2026 forward validation:**
- Freeze the pipeline code hash (`code-identity.js`, F06) and preregister the metrics and α.
- Log every attempted bet, including rejected ones (GF05).
- Update the e-process after each week. Expect "inconclusive" at season end, and plan to accumulate evidence over multiple seasons.
- Paper-trade until the e-value clears the threshold.

**7. Implementation:** port about 300 lines of numpy/Node code: HLN-DM, Clark-West, stationary bootstrap, SPA, MCS and the e-process. No installs are needed.

## (C) ADOPTABLE CODE / REPOS

| Repo | License | What to borrow |
|---|---|---|
| eslazarev/purged-cross-validation | MIT (verified locally) | The `WalkForwardSplit` and `CombinatorialPurgedCV` interfaces (`prediction_times`, `evaluation_times`, purge/embargo), plus `_pbo.py` and `effective_n_trials`. Port the logic; it imports scipy and pandas. |
| bashtage/arch | BSD-style license text (exact variant unconfirmed) | Algorithms from the `SPA`, `StepM` and `MCS` classes. Transliterate; don't install. |
| johntwk/Diebold-Mariano-Test | MIT (verified locally) | HLN-corrected DM, about 40 lines. |
| yjchoe/ComparingForecasters | MIT | Confidence-sequence and e-process math for the live monitor. |
| AlexanderHenzi/eprob | MIT (R) | Reference implementation of the e-values for binary forecast scores. |

## (D) OPEN QUESTIONS / RISKS

- **Was Tier 3 ever scored?** Nothing in the registry (currently orphaned, per F06) shows whether 2009–2011 or any other season was examined. If every season was examined, no untouched historical holdout exists and 2026+ live is the only confirmatory data.
- **Tier choice leaks slightly.** Choosing hyperparameters on data that come after Tier 3 still lets some information leak into the backward holdout.
- **Unverified guarantees.** I haven't checked the Ladder and Thresholdout guarantees for autocorrelated weekly losses. Treat them as a way to limit the damage, not as proof.
- **Bounded scores.** The anytime-valid tests need bounded scores, so margin squared error needs either clipping or the separate method Choe and Ramdas give for unbounded scores.
- **Power estimate depends on an assumption.** The simulation assumes a market error SD of 2.5, which I haven't measured from the database.
- **Opener coverage.** Opening lines exist only from about 2018, which limits historical CLV grading to Tiers 1–2.
- **Unread full texts.** I read only the abstract of Arian et al. 2024, and haven't read the full HLN, SPA or MCS papers. The citations are verified; details of the formulas should be checked against the originals before porting.