# Stacking hand-built ratings with learned models (Gridiron HQ redesign)

## Starting point: what the earlier research already settled
- **F02-forecast-combination.md** finds that the current `market_residual` blend reduces to `forecast ≈ 0.68 + 0.632·market`. The reason is that each of the 31 components is fit one at a time against the market, never together. It also finds that the components collapse to about 3 independent factors: margin-based, play-efficiency, and market.
- F02 already reviewed Yao et al. 2018 (stacking is unstable when n is small), Claeskens et al. 2016 (weights you estimate add bias and variance), and Smith & Wallis 2009 (the simple average is hard to beat).
- **N12** reviewed Qian et al. 2019 (mAFTER, which keeps the simple average as a permanent candidate).
- **GF02** read the nfelo code. Its in-season update uses market error: the K-factor grows when the model was more wrong than the market. So nfelo already carries some market information.

This report does not repeat those. It adds the primary sources on stacking and super learning, the rules for out-of-fold data when games arrive in time order, the evidence on feeding ratings into a GBM, and how to handle correlated components.

---

## Evidence

**1. Wolpert (1992), "Stacked generalization," *Neural Networks* 5(2):241–259** ([ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0893608005800231)).
- The second-level learner is trained on each component's guesses for data that component did not train on.
- The whole method depends on the component forecasts being out-of-sample.

**2. Breiman (1996), "Stacked Regressions," *Machine Learning* 24:49–64** ([tech report PDF](https://statistics.berkeley.edu/sites/default/files/tech-reports/367.pdf), read in full). What the paper says:
- **Two failure modes.** Fitting weights on the same data the components were built on overfits. Plain least squares or ridge on strongly correlated component forecasts gives weights that swing with small data changes. Ridge was "better... but not consistent."
- **The fix.** Least squares on cross-validated component predictions, with every weight ≥ 0. Adding a sum-to-one constraint is "largely unnecessary," because the unconstrained optimum already sums to about 1.
- **Stacking never did worse than the single best predictor.** Test error was 20.9 → 19.0 on Housing and 23.9 → 21.6 on Ozone.
- **Gains are largest when the stacked predictors are dissimilar.** "The more similar the predictors, the less advantage there is in stacking."
- **Fold choice.** 10-fold cross-validation made better second-level data than leave-one-out.
- LeBlanc & Tibshirani, as cited by Breiman, also found non-negativity gave the most accurate combinations.

**3. Ting & Witten (1999), "Issues in Stacked Generalization," *JAIR* 10:271–289** ([arXiv 1105.5466](https://arxiv.org/abs/1105.5466), read).
- Of four second-level learners (C4.5, IB1, naive Bayes, linear regression), only the non-negative linear regression was suitable.
- The combiner needs the components' confidences (probabilities), not bare picks.
- For classification, non-negativity did not change error, but it kept the weights interpretable.

**4. van der Laan, Polley & Hubbard (2007), "Super Learner," *SAGMB* 6(1)** ([bepress](https://biostats.bepress.com/ucbbiostat/paper222/)).
- Cross-validated weighting of a library of learners.
- An oracle inequality guarantees asymptotically near-best performance.

**5. Phillips, van der Laan, Lee & Gruber (2023), *Int. J. Epidemiology*** ([arXiv 2204.06139](https://arxiv.org/abs/2204.06139), read).
- Use larger V when the effective sample size is small.
- When observations are not independent, keep whole clusters inside one fold.
- With small samples, prefer structured learners (lasso, shallow trees) over highly adaptive ones.
- Put the weighted ensemble in as one candidate of a winner-take-all selector (the "discrete super learner"), next to its own components, so it is only used if its cross-validated risk is actually lower.

**6. Benkeser et al. (2018), "Online cross-validation-based ensemble learning," *Statistics in Medicine* 37:249–260** ([Wiley](https://onlinelibrary.wiley.com/doi/10.1002/sim.7320)).
- Extends the super learner to data arriving in sequence, using online cross-validation.
- Keeps the oracle guarantee for time-series-type dependence.

**7. Dawid (1984), prequential approach, *JRSS A* 147:278–292** ([PDF](https://www.cs.ubc.ca/~murphyk/MLRG/dawid84Prequential.pdf)).
- Judge a method by the sequence of forecasts it makes for data it has not yet seen.
- Elo or a state-space rating updated only with games before kickoff is prequential, so its forecasts are out-of-sample by construction.
- That holds only if its settings (K, home-field advantage, decay) were not tuned on later seasons. This last point is my inference from Dawid's framing.

**8. Forecast-combination evidence**
- **Wang, Hyndman, Li & Kang (2023), *IJF* 39(4):1518–1547** ([arXiv 2205.04216](https://arxiv.org/abs/2205.04216), read in part).
  - Weights that ignore error correlations have beaten covariance-aware weights (Bates-Granger, Newbold-Granger, Winkler-Makridakis).
  - Studies showing nonlinear (neural) combinations win used fewer than 10 series, "possibly hand-picked."
  - Nonlinear combiners suffer from unstable estimates and collinearity from overlapping information.
  - It recommends rolling-origin cross-validation for both the components and the combiner.
- **Aiolfi & Timmermann (2006), *J. Econometrics* 135:31–53** ([EconPapers](https://econpapers.repec.org/RePEc:eee:econom:v:135:y:2006:i:1-2:p:31-53)): cluster the forecasts, average within each cluster, then weight the clusters.
- **Diebold & Shin (2019), *IJF* 35(4):1679–1691** ([SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3235362)): "partially-egalitarian LASSO." Set some weights to zero, then shrink the rest toward equal. The best solution after the fact was to drop most forecasters and average the rest.
- **Genre et al. (2013), *IJF* 29(1):108–121** ([RePEc](https://ideas.repec.org/a/eee/intfor/v29y2013i1p108-121.html)): for GDP and unemployment, few schemes beat the simple average. Inflation was the exception.

**9. Ratings fed into GBMs (the closest real evidence)**
- **2017 Soccer Prediction Challenge (200,000+ matches).**
  - The winners were GBMs trained on rating features: XGBoost on Berrar ratings (RPS 0.2054) and XGBoost on pi-ratings plus PageRank (0.2063).
  - A Bradley-Terry/Poisson hierarchical model scored 0.2087, and a hybrid Bayesian network on four rating features scored 0.2083.
  - The GBM edge is only about 0.002–0.003 RPS, even with a very large sample.
  - Sources: Hubáček, Šourek & Železný (2019), *Machine Learning* 108:29–47 ([Springer](https://link.springer.com/article/10.1007/s10994-018-5704-6)); Berrar, Lopes & Dubitzky (2019) ([MLJ](https://mlanthology.org/mlj/2019/berrar2019mlj-incorporating/)). Numbers as reported in Yeung et al. ([arXiv 2309.14807](https://arxiv.org/abs/2309.14807)); I did not read the originals in full.
- **Yeung et al., same source.**
  - Exact-score task: the raw Berrar rating model (loss 1.0047) beat XGBoost on the same ratings (1.0212).
  - Probability task: CatBoost on pi-ratings was best (0.2085), but its loss varied more across seasons (σ 0.0083).
  - Putting a GBM on top of ratings can make results worse.
- **Hubáček, Šourek & Železný (2019), "Exploiting sports-betting market using machine learning," *IJF* 35(2):783–796** ([PDF](http://ida.felk.cvut.cz/zelezny/pubs/ijf.2019.pdf), read; NBA data).
  - A model whose only input is the odds "would have no choice but to coincide" with the bookmaker, so it loses the vig.
  - A loss term that penalizes correlation with the bookmaker, `(p̂−y)² − c·(p̂−1/o)²`, gave higher profit despite lower accuracy.
- **NFL-specific evidence:** I found no rigorous peer-reviewed comparison of stacked models against the NFL closing line. What surfaced was small-sample accuracy studies that I could not check.

**10. Ranjan & Gneiting (2010), "Combining probability forecasts," *JRSS B* 72(1):71–91** ([OUP](https://academic.oup.com/jrsssb/article/72/1/71/7076442)).
- Any non-trivial weighted average of distinct, calibrated probability forecasts is uncalibrated.
- Linear pools need a recalibration step, such as their beta-transformed pool.

**11. Tooling pitfall (sklearn docs, BSD-3).**
- `StackingRegressor` trains its combiner through `cross_val_predict`, which requires that "each sample belongs to exactly one test set" ([docs](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.cross_val_predict.html)).
- `TimeSeriesSplit` never puts its first block in a test set, so that default path is shuffled K-fold (my inference).
- K-fold out-of-fold predictions for Massey, Colley, or EPA ratings would use future games to estimate a team's strength earlier in the season. That is lookahead.

---

## (A) Key findings
1. **Out-of-fold data is required, and it must run forward in time.** In-sample component forecasts overfit the combiner (Breiman 1996; Wolpert 1992). In time-ordered data, K-fold leaks future team strength (sklearn docs; Wang et al. 2023).
2. **Non-negative least squares is the evidence-backed default combiner.** Unconstrained or ridge weights on correlated forecasts are unstable (Breiman 1996; Ting & Witten 1999; SuperLearner's `method.NNLS`).
3. **Expect little from combination alone.** Gains shrink as components get more alike (Breiman), and ours reduce to about 3 factors (F02). Simple or egalitarian averages are hard to beat (Genre 2013; Diebold-Shin 2019; Claeskens 2016).
4. **A GBM on ratings beats weighting only slightly, and only with large samples.** The best documented gain is about 0.003 RPS on 200,000+ matches. It lost on one task (Yeung et al.). With about 270 games a season, the prior should be that a GBM does not beat a linear stack.
5. **Correlated components: pool first, then weight.** Average within a family, then use a few weights (Aiolfi-Timmermann 2006), or shrink toward equal weights (Diebold-Shin 2019).
6. **Market inputs pull the model onto the market.** Including odds, or ratings like nfelo that already absorb market information, makes the model coincide with the market, which defeats a betting model (Hubáček et al. IJF 2019).
7. **Combine margins, not probabilities.** Linear pools of probabilities are miscalibrated (Ranjan & Gneiting 2010).

## (B) Recommendations for Gridiron HQ

**1. Level 0: components run strictly prequentially.**
- Each component (Elo, state-space/Massey per F08, EPA ratings, pythagorean, external ratings) emits a pre-kickoff predicted margin, computed only from games before that kickoff.
- Tune component settings in an outer loop that uses only seasons before the one being forecast; retune once per offseason.
- Massey and Colley must be refit through week w−1, never fit on the full season.
- Store each output in a bitemporal table (`component_forecast(game_id, component, as_of_ts, margin)`, per F05) so combiner training always reads the values as they existed.

**2. Pool before weighting.**
- Group components into about 4 families using out-of-fold error correlation from prior seasons (e.g. |ρ| > 0.9): margin ratings, play efficiency, external ratings (nfelo etc.), situational (rest, weather, QB/injury adjustments).
- The family forecast is the equal-weight mean of its members.
- This removes double counting before any weight is estimated. Never give the combiner 20 near-duplicates.

**3. Level 1: a small discrete super learner with a forward-in-time validation scheme.** Candidates:
- (a) Equal average of the family forecasts. This is a permanent fallback, per Qian and Phillips.
- (b) Non-negative least squares with an intercept.
- (c) Ridge shrunk toward equal weights: minimize `‖y−a−Zw‖² + λ‖w−w_eq‖²`, with w ≥ 0.
- (d) Only later, if wanted: a shallow boosted-tree residual model on top of (c) (depth 2, learning rate ≤0.05, ≤200 trees, early stopping on forward folds).

How to validate and choose:
- For each (season s, week w), train only on games before (s, w), weighted by exponential time decay (Claeskens warns that stale weights add bias).
- Keep each week's games together in one validation block (Phillips on clustered data).
- Pick the candidate by out-of-fold risk from rolling-origin validation over prior seasons. Use a one-standard-error rule in favor of (a).
- Count every candidate tried in the trial registry (F06).

**4. Keep the market out of the fundamentals stack.**
- Stack A (fundamentals): excludes the market line and any market-tainted rating. Per GF02, nfelo's update depends on market error, so nfelo goes to stack B or gets its own audited family.
- Stack B (bet model): opener plus a shrunk coefficient times (stack A minus opener), with nfelo-minus-opener as a separate feature. This keeps the one +CLV signal already in memory.
- Grade B on CLV, and grade A on RMSE against the margin.

**5. Probabilities: map the combined margin through one fitted margin distribution** (F17 key-number handling, then F11 conformal calibration). Do not average component win probabilities.

**6. Implementation fits the current stack with no installs.**
- Lawson-Hanson non-negative least squares for ≤6 weights is about 80 lines in JS or numpy.
- Ridge-to-target has a closed form, then an active-set pass to enforce w ≥ 0.
- A depth-2 regression-tree booster is about 200 lines of numpy. Build it only if (a)–(c) are stable first.

**7. Set expectations.**
- Recombining rating variants will not close most of the 14.8 vs 13.55 RMSE gap. Breiman: stacking similar predictors adds little.
- Real gains have to come from dissimilar information (QB/injury, weather, market-relative signals) entering as new families.

## (C) Adoptable code and repos

| Repo | License | What to borrow |
|---|---|---|
| [ecpolley/SuperLearner](https://github.com/ecpolley/SuperLearner) (R, v2.0-40) | GPL-3 | Idea only: `R/method.R` `method.NNLS` (non-negative least squares on cross-validated predictions, then normalize coefficients to sum 1; handles the all-zero-weight case) and `method.CC_LS` (convex-constrained quadratic program). |
| [tlverse/origami](https://github.com/tlverse/origami) | GPL-3 | Idea only: `R/fold_funs.R` `folds_rolling_origin`, `folds_rolling_window`, `folds_vfold_rolling_origin_pooled` (the `gap` argument, pooling by id and time). This is the template for week-clustered forward folds. |
| [flennerhag/mlens](https://github.com/flennerhag/mlens) | MIT | Reference design for layered ensembles; last push 2023. |
| [scikit-learn](https://github.com/scikit-learn/scikit-learn) `StackingRegressor` | BSD-3 | Cautionary reference only: its default K-fold out-of-fold path and the partition rule above. |
| ceweiss/ForecastComb | GPL | Already covered in F02 (simple average, Bates-Granger, constrained least squares). |

Reimplement from the papers rather than copying GPL code into the Node app.

## (D) Open questions and risks
1. **nfelo lookahead in backtests.** I have not verified whether the stored nfelo history is an as-published snapshot or a recomputation using settings tuned on the full history (the per-season prior sigmas in GF02 are retrained). If it is recomputed, nfelo leaks into the backtest.
2. **Effective sample size.** Games in the same week share league-wide shocks, so the true count of independent observations may be closer to weeks (about 18 a season) than games. Combiner weights may still be noisy, which is Yao's small-n instability.
3. **Drift versus history.** A time-decayed fit on post-2018 data is a tradeoff against 1999+ history; the decay half-life has to be tuned with the same forward-in-time validation, which adds another trial to the registry.
4. **Decorrelation for stack B is unproven for NFL spreads.** Hubáček et al. is NBA moneyline; the correlation penalty `c` would be yet another searched setting.
5. **The GBM candidate has low power.** Beating the linear stack by the soccer-scale margin (about 1–2%) is probably not detectable within a few seasons.
6. **The families themselves are a modelling choice.** Deriving them from out-of-fold correlations must also use only prior seasons, or the grouping step leaks.