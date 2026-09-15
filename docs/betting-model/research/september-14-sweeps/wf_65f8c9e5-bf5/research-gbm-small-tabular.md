# GBMs on small, noisy tabular data: what to use for the Gridiron NFL game model

The prior research (FIX_AND_ADD_ARCHITECTURE.md #23, GITHUB_BUILD_CATALOG.md, N11) never looked at GBMs on small data directly. It only pointed at `research/tree_lab.py`. That script has already been run in this repo, and its output is the most relevant evidence available, so it comes first.

## 0. What this repo has already measured (read-only)
The run is `server/data/tree-lab/20260908T164200Z-2e46b49a/report.json` (research only, nothing promoted).
- **Setup:** 1,795 rows and 86 features, with 449 rows dropped for bad timestamps. Walk-forward outer seasons 2023, 2024 and 2025, with 219 to 733 training games each. Inner folds were expanding whole weeks with a 7-day embargo.
- **Models:** LightGBM (depth 4, 11 leaves, min_child 25, learning rate 0.04, λ2 = 5, 150 trees), XGBoost (depth 3), CatBoost (depth 4, l2 = 8), HistGB, ExtraTrees, ridge/logistic and TPOT.

**Results:**
- **Cover log-loss:** in all 6 market-seasons, no fitted model beat market-only. Market-only was 0.692–0.694. LightGBM ran 0.719–0.748, XGBoost 0.712–0.739, CatBoost 0.701–0.727. The only exception is TPOT on totals 2023 (0.689 vs 0.693), one of 6. Logistic with C = 0.05 was worst (0.705–0.836).
- **Line-movement MAE:** no-move won 5 of 6. The only wins were totals 2025 (HistGB/ExtraTrees 1.57 vs 1.64) and TPOT/ExtraTrees on totals 2023. LightGBM was the worst of the GBMs almost everywhere.
- **Residual quantiles:** market-only won 5 of 6.
- **Market-anchored logit** (`logit p_mkt + λ·residual`): the inner folds picked shrinkage λ = 0.0. Log-loss rose steadily from 0.694 at λ = 0 to 0.813 at λ = 1.

So at 200–700 rows, moderately regularized GBMs on 86 features got worse the more weight they had. The planned redesign has about 7,000 rows (1999+), which is 10–30× more data. Whether that changes the result is **untested**. Also, neither `lightgbm` nor `sklearn` is currently installed on python3.12 or python3.14. The run's 3.12 environment is gone.

## 1. Benchmark evidence: trees vs linear vs deep learning, and whether it transfers

- **Grinsztajn, Oyallon & Varoquaux 2022** (NeurIPS D&B, https://arxiv.org/abs/2207.08815):
  - Trees beat neural nets at around 10k samples. The reasons given are robustness to uninformative features, irregular target functions, and axis-aligned structure.
  - **Their selection rules make the result not transfer here.** They removed "too easy" datasets, meaning any where logistic regression came within 5% of both ResNet and HistGB. They also excluded non-IID and time-series data and datasets under 3,000 samples (https://arxiv.org/html/2207.08815, §3.1).
  - The benchmark was built to find tasks where trees beat linear models. Low-signal NFL residuals are exactly the kind of task it filtered out.
- **McElfresh et al. 2023** (NeurIPS D&B, https://arxiv.org/abs/2305.02997):
  - 19 algorithms on 176 datasets. They call the NN-vs-GBDT debate "overemphasized" and find light tuning often matters more than the model family.
  - GBDTs win on skewed or irregular data.
  - TabPFN was best on average, but only for datasets of about 3,000 training rows or fewer.
- **TabArena** (Erickson et al., NeurIPS 2025 D&B spotlight, https://github.com/autogluon/tabarena):
  - 51 curated datasets. GBMs are still strong, deep learning catches up with large compute budgets, foundation models are best on small data, and cross-model ensembles are state of the art.
  - I did not verify whether any time-ordered or low-SNR datasets are included.
- **TabPFN** (Hollmann et al., *Nature* 2025, https://www.nature.com/articles/s41586-024-08328-6): best on datasets up to 10k samples.
  - It needs PyTorch and pretrained weights, it assumes IID in-context data, and it cannot run in Node. It is ruled out under the current constraints. I did not verify its license terms.
- **Low-SNR finance analogue:** Gu, Kelly & Xiu (RFS 2020, https://www.nber.org/papers/w25398) found trees and neural nets beat linear models by capturing interactions in return prediction.
  - That panel is far larger than 7k rows, so it is **not** evidence that trees win at this sample size.

**Feature selection vs shrinkage.** Hastie, Tibshirani & Tibshirani (arXiv 1707.08692, later *Statistical Science* 2020) found lasso beats best-subset and forward-stepwise at low SNR, with relaxed lasso best overall. That supports the owner's preference for continuous shrinkage over binary gates. It argues against hard feature selection here.

## 2. Hyperparameter evidence
- **Friedman 2002, "Stochastic gradient boosting"** (*CSDA* 38:367–378, https://ideas.repec.org/a/eee/csdana/v38y2002i4p367-378.html). I read the PDF.
  - N = 500, SNR 1:1: best subsample fraction was f ≈ 0.4, with a median 11% absolute-error improvement over no subsampling. They used learning rate ν = 0.005.
  - N = 5,000: best f ≈ 0.6, median gain 5%.
  - Best tree size averaged about 6 terminal nodes. Larger trees overfit, and subsampling reduced that overfitting.
  - NFL residual SNR is far below 1:1, so these are upper bounds on the benefit, not settings to copy.
- **LightGBM overfitting guidance** (https://lightgbm.readthedocs.io/en/latest/Parameters-Tuning.html): small `max_bin`, small `num_leaves` plus `max_depth`, `min_data_in_leaf`/`min_sum_hessian_in_leaf`, bagging, `feature_fraction`, `lambda_l1`/`lambda_l2`, `min_gain_to_split`, `extra_trees`, larger `path_smooth`.
- **Missing values:** LightGBM handles NaN natively and learns a default direction per split (https://lightgbm.readthedocs.io/en/latest/Advanced-Topics.html). For small data it recommends `min_data_per_group` and `cat_smooth` on categoricals.
- **Monotone constraints** (XGBoost docs, https://xgboost.readthedocs.io/en/stable/tutorials/monotonic.html): set per feature as +1/−1/0.
  - With `hist`, constraints can leave trees unnecessarily shallow. Raising `max_bin` helps.
  - nflfastR's xgboost win-probability model uses monotone constraints (per the prior catalog, GITHUB_BUILD_CATALOG.md).
- **CatBoost ordered boosting** (Prokhorenkova et al. 2017/NeurIPS 2018, https://arxiv.org/abs/1706.09516): addresses the prediction shift that standard GBMs get from target leakage.
  - The abstract makes no claim about small data. Locally, CatBoost was the least-bad GBM.
- **Probst, Bischl & Boulesteix** (https://arxiv.org/abs/1802.09596) derives tuned defaults per parameter. I could not verify their XGBoost numbers from the abstract, so none are used here.

## 3. Stacking a GBM on a strong baseline (residual learning)
- XGBoost `base_margin` exists to "train XGBoost model based on other models" (https://xgboost.readthedocs.io/en/stable/prediction.html). LightGBM's equivalent is `init_score`.
- **Gotcha:** `init_score` is **not saved in the model**. At inference you must add the offset back yourself (https://github.com/microsoft/LightGBM/issues/4148). A JS serving layer has to do the same.
- **Componentwise L2 boosting** (Bühlmann & Hothorn, *Statistical Science* 2007, doi:10.1214/07-STS242) is the linear-learner version. It boosts one feature at a time from an offset, relates closely to the lasso, and uses early stopping by AIC or CV.
  - Its update loop is simple and could be written in numpy or JS. That feasibility is my own assessment, not a claim from the paper.
- **Decorrelating from the bookmaker:**
  - Hubáček, Šourek & Železný (*IJF* 35(2):783–796, 2019, https://ida.fel.cvut.cz/papers/hubacek2019exploiting.html) penalized correlation with the bookmaker's odds and got better profit. The same idea is behind residual targets.
  - Hubáček & Šír 2020 (arXiv:2010.12508, not peer-reviewed) argue a model can profit while being worse at prediction if it is decorrelated from the market.
- **Walsh & Joshi** (*Machine Learning with Applications* 2024, arXiv:2303.06021): on NBA data, choosing models by calibration returned +34.69% ROI vs −35.17% when choosing by accuracy. This is one study with very noisy ROI, so it supports selecting on log-loss or CRPS, not the size of the effect.

**Power arithmetic (my own calculation, not from a source).**
- Market RMSE is about 13.55 points on margin. A residual model that is perfectly right and cuts RMSE to 13.45 lowers MSE by only v ≈ 2.7, about 1.5% R² on the residual.
- The paired squared-error difference then has t ≈ √(v·n)/(2σ). That gives about 1.0 SE per 270-game season and about 5 SE over 7,000 games.
- So any real improvement will look like noise week to week. The bet gate needs cumulative, shrunk evidence across many seasons, not a weekly pass/fail test.

## (A) KEY FINDINGS
1. The benchmark papers that favor trees (Grinsztajn) deliberately excluded datasets where linear models do about as well, plus time-series data and datasets under 3,000 rows. They do not show that GBMs win on NFL residuals.
2. In this repo's own test at 219–733 training rows, **no GBM beat the market** on cover log-loss in 6/6 market-seasons, and the market-anchored residual picked zero weight (tree-lab report above).
3. At low SNR, shrinkage beats hard selection (Hastie et al. 2017/2020).
4. Subsampling (0.4–0.6), small trees (about 6 leaves) and a small learning rate reduce overfitting (Friedman 2002). These are the settings to borrow, but the gains will be smaller here.
5. Offset boosting is natively supported, but the offset is not saved in the model (LightGBM #4148).
6. TabPFN and tabular deep learning are strong under 10k rows on IID benchmarks, but they need torch, are not time-aware, and cannot be served from Node.

## (B) CONCRETE RECOMMENDATIONS
1. **Stack in order:** market offset → ridge/hierarchical residual → optional GBM residual. The offset is the decision-time implied margin: the current line when betting, the close for evaluation. The redesign's main work is getting to market-level RMSE from 14.8. A GBM only goes after interactions that ridge misses.
2. **Target and loss:** actual margin minus the offset, with Huber loss (δ about 7–10 points, as a starting guess). Select models by CRPS or log-loss, never by ATS hit rate.
3. **Starting GBM regime** (my synthesis from the sources above):
   - Trees: depth 2 (4 leaves; depth 3 max), `min_data_in_leaf` 150–300 (about 3–5% of rows), `lambda_l2` 10–50, `min_gain_to_split` > 0, `max_bin` 32–63, `path_smooth` > 0, `extra_trees` on.
   - Learning and sampling: learning rate 0.01–0.02, `bagging_fraction` 0.5, `feature_fraction` 0.3–0.5.
   - Monotone constraints only on features whose direction is not in doubt.
4. **Round count:** don't early-stop on one validation fold. Pick the round count as the **median best iteration across 4–6 expanding, season-level, embargoed inner folds**, then refit on all past data. Early stopping on a single ~270-game fold is pure noise, per the power arithmetic in §3.
5. **Add a final continuous shrinkage factor:** prediction = offset + λ_ridge·ridge + λ_gbm·gbm, with each λ in [0, 1]. Estimate the λs walk-forward (the tree-lab logit branch already does this) and shrink them toward 0. This replaces binary gates. **Bet stake scales with the posterior-shrunk λ and cumulative out-of-sample CLV**, not with pass/fail.
6. **Missing data:** encode NaN plus an `_available` flag (tree-lab already does). GBMs route NaN natively. Ridge needs mean-impute plus the flag.
7. **Implementation without installs:** write (a) a numpy histogram GBM with depth ≤ 3, Huber/L2 loss, offset, row/column subsampling, L2 leaves and a learned NaN direction, and (b) a JSON tree dump plus a JS evaluator. At 7k × 150 features, weekly retraining should take seconds to a minute. That is an estimate; I haven't benchmarked it.
   - If the owner approves installs, put LightGBM in a separate venv **for parity checks only**, and keep serving from JSON in Node.
8. **Pre-register** the configuration grid (F06 registry) so choosing among GBM settings doesn't create a multiple-testing problem.

## (C) ADOPTABLE CODE/REPOS
| Source | License | What to borrow |
|---|---|---|
| `research/tree_lab.py` (local) | project | Embargoed fold design, `model_discipline` observation-per-parameter check, leakage scan, market-anchored shrinkage loop. Its sklearn/LightGBM imports can't run on the current interpreters. |
| microsoft/LightGBM | MIT | Parameter semantics (`init_score`, `path_smooth`, `extra_trees`, NaN default direction) to copy into the numpy GBM. Its parity oracle if installed. |
| xgboost-scorer (github.com/prvnsmpth/xgboost-scorer) | MIT | Pattern for walking JSON trees in JS. The author calls it "extremely naive" and it is binary-classification only, so borrow the idea, not the code. |
| interpretml/interpret (EBM) | MIT | Idea: cyclic per-feature boosting plus a few pairwise terms gives additive lookup tables, easy to serve in JS and suited to small n. Export format not verified. |
| mboost (Bühlmann & Hothorn 2007) | GPL-2 (not verified here) | Algorithm only: componentwise L2 boosting from an offset. Reimplement; don't copy the code. |
| m2cgen | MIT | **Avoid:** last release 0.10.0 (April 2022), Python 3.7–3.10 only. |

## (D) OPEN QUESTIONS / RISKS
1. Whether GBMs beat ridge-on-residual at about 7k rows is **unmeasured**. The only local evidence is at 200–700 rows, and GBMs lost there.
2. Point-in-time lines: closing lines go back to 1999, but opener and snapshot data are recent only. Residuals against the close can be learned on large n, but tradable edge can only be tested on the few recent seasons. That keeps the power problem.
3. Changes in league regime over 1999–2025 (rules, scoring environment) may mean non-stationarity hurts more than extra sample helps. Consider time-decay weights, and test whether they help.
4. A homemade numpy GBM needs a parity test against LightGBM before anyone trusts it, which may itself need install approval.
5. Friedman's settings came from SNR 1:1 simulations. The best subsample fraction and tree size at NFL-level SNR are unknown.
6. I did not verify: Probst et al.'s XGBoost defaults, the TabPFN license, whether TabArena includes non-IID data, EBM's JSON export, or the `@wlearn/xgboost` WASM package (npm returned 403).