# ML inventory: the learning code already in Gridiron HQ (read-only audit, 2026-09-14)

## 0. Bottom line
- **No ML library is installed for the app.** `package.json` depends only on `express` and `@anthropic-ai/sdk` (dev: `fast-check`). Every learner is hand-written JS: 4 learner types (boosted trees, a small neural net, about 10 ridge variants, 2 logistic fits), plus about 18 copy-pasted matrix solvers.
- **Python is present but unusable for the research labs today.**
  - `python3` is 3.14.3 with numpy only. `/Library/Frameworks/.../python3.12` has numpy 2.2.2, pandas 2.3.3, scipy 1.17.1 and statsmodels 0.14.6.
  - scikit-learn, lightgbm, xgboost, catboost, tpot and mapie are not installed anywhere, including `/private/tmp/blr-venv`.
  - `research/requirements.txt` pins them for Python 3.11–3.13. `server/data/tree-lab/latest.json` records sklearn 1.7.2 / lightgbm 4.7.0 / xgboost 3.4.1 / catboost 1.2.10, so an environment existed on 2026-09-08 and is gone. Wheels are still in `~/.cache/uv`, but no `uv` binary is on PATH.
- **Every learned residual expert scores worse than just using the closing line.**

The table below uses `nfl_weekly_expert_examples`, latest audit run per game: 1,039 games, 70 weeks, 2021–2025. "Market MSE" is the error of predicting a zero residual (i.e. the closing line) on the same games.

| Expert | Its MSE minus market MSE | Avg size of its forecast (points) | Right direction |
|---|---|---|---|
| qb_state | −0.39 (the only one better) | 0.57 | 52.6% |
| pressure_matchup | +0.05 | 0.51 | 50.7% |
| tendency_matchup | +0.15 | 0.51 | 49.8% |
| teamrankings_line | +0.17 | 0.38 | 49.2% |
| news_reaction | +0.24 | 0.70 | 51.5% |
| situational_efficiency | +0.51 | 0.63 | 51.0% |
| line_movement | +0.53 | 0.30 | 49.1% |
| nfelo_line | +0.54 | 0.48 | 48.5% |
| coordinator | +0.55 | 0.31 | 49.6% |
| trench_continuity | +0.73 | 0.49 | 50.1% |
| boosted_tree | +1.07 | 0.57 | 49.9% |
| similar_games | +1.49 | 0.88 | 49.1% |
| specialist_team | +5.04 | 1.22 | 51.4% |
| deep_residual | +7.67 | 2.17 | 48.5% |
| game_replay | +7.98 | 1.81 | 49.6% |
| rulebook | +26.55 | 3.94 | 47.7% |
| player_builder | +36.57 | 4.95 | 51.2% |

The hand-coded formula experts (rulebook, player_builder, game_replay) are by far the worst.

## 1. Learners (what, training protocol, cutoff safety, gated or starved, tests, quality)

### A. Boosted trees — `server/services/nfl-gbm.js`
- **What it is.** Hand-rolled gradient boosting: `fitTree` :40, `fitGbm` :86, `predictGbm` :114.
- **Inputs** (`buildGbmDataset` :135):
  - 29 home-minus-away season-to-date means from `nfl_team_week_features` (weeks strictly before the game; Week 1 falls back to the prior season).
  - Closing spread, total, temp, wind, dome, divisional flag, rest.
  - An optional `extraFeatures` hook.
- **Target:** actual margin minus market margin (the market residual).
- **Two users:**
  - `gbmWalkForward` :242 trains a season at a time.
  - The council's `boosted_tree` (`nfl-expert-council.js:79-93`) refits for every (season, week) on games strictly earlier: 48 depth-2 trees, learning rate 0.035, 55-game minimum leaf. Cutoff-safe.
- **Status:** not gated. Observed on 7,356/7,356 audit rows and live on all 125 2026 forward rows. Result: MSE +1.07 vs market.
- **Tests:** only `test/nfl-gbm-weather-fallback.test.js` (2 tests, weather fallback). Nothing tests the split, boosting or prediction math.
- **Correctness risks:**
  - Hyperparameters are fixed by hand. There is no validation set, no early stopping and no tuning.
  - Only 5 split points per feature (quantiles 0.2–0.8).
  - Missing context is filled with fixed defaults (60F, 5 mph, total 44, rest 7) with no missing-data flag.
  - A row is dropped entirely if any of the 29 keys is missing.
  - The input is the closing spread, so at bet time the model needs the decision-time line or it is answering a different question.
  - **Live staleness bug.** `datasetCache` (council :72-75) and `gbmCache` (:78) live for the whole process and are never cleared. In the running server, boosted_tree and similar_games train on whatever games were settled when the process started.
- **Honest quality:** the algorithm is simple and correct-looking. It is the most reusable non-linear piece, but under-engineered.

### B. Similar-game finder (nearest neighbours) — `nfl-expert-council.js:95-122`
- **What it is.** Nearest-neighbour search (k=35) over the same feature matrix, with training-only standardisation and shrinkage n/(n+30).
- **Cutoff-safe.** Result: MSE +1.49.
- **Recommendation:** discard as a core learner.

### C. Online neural net — `server/services/nfl-online-neural.js`
- **What it is.** 35 inputs, 10 tanh hidden units, output capped at ±7 points (`createNetwork` :50, `trainBatch` :77). Loss is Huber with L2, full-batch, 20 epochs, replay of the last 512 examples.
- **Inputs** (`spreadFeatureVector` :118):
  - Market state.
  - The ensemble's own hand-coded outputs: per-family mean residual, spread and coverage.
  - Roster unit edges and verified-news burdens.
  - So it learns the residual of a hand-coded ensemble, not patterns in the raw data.
- **Live path** (prediction first, then train on the settled week) is careful about cutoffs.
  - DB state: 128 captured, 70 settled, 0 trained, 0 saved models (`nfl_online_neural_artifacts` is empty).
  - `completeWeek` :259 needs every game final, and 2026 Week 1 has 14 of 16. Settlement also lags (10 settled vs 14 finals).
  - It has never trained and always predicts zero.
- **Historical "audited" version** (`auditedNeuralFor`, council :273-307) retrains from scratch on stored feature vectors from strictly earlier weeks. Observed 7,068 rows. Result: MSE +7.67, the worst of the learned experts.
- **Tests:** 1 test in `test/model-integrity.test.js:1116` (training reduces error, deterministic, output bounded, cold start returns zero).
- **Quality:** the maths looks right. It is badly undertrained (about 20 gradient steps per week), and its inputs echo the ensemble.
- **Recommendation:** discard as a core learner. Keep the prediction-first/train-after capture tables and the "freeze the pregame vector" lifecycle.

### D. Expert coordinator — `server/services/nfl-expert-coordinator.js`
- **What it is.** A combiner learned over the 19 roles' forecasts plus a missing-data flag per role (`fitRows` :174).
  - Robust (Huber IRLS) ridge with λ=36, each week weighted as one unit.
  - Weight caps: 0.35 per role, 0.8 total.
  - Per-regime sub-fits (`fitExpertCoordinator` :253) on strictly earlier audited and forward-settled rows. Cutoff-safe.
- **Warm-up:** 128 games / 8 weeks.
- **A binary gate is built in.** `shrinkageScales` :96 sets a role's scale k=0 unless t>2 AND a cross-gain is positive. That "walk-forward" cross-gain is actually an even/odd row split, not chronological (:124).
  - Roles whose forecasts correlate above 0.6 collapse into one coefficient.
- **Result:** MSE +0.55. Tests: `coordinator-shrinkage` (2), `contextual-coordinator` (1).
- **Recommendation:** keep the ideas (week clustering, robust loss, missing-data columns, Shapley attribution). Replace the t>2 gate with cross-validated regularisation.

### E. Ridge / linear learners of the market residual
1. **`nfl-specialists.js`**
   - `ridgeFit` :99; one ridge per family over 15 families (λ=250, differentials of `nfl_team_week_features`).
   - A meta-model of specialist outputs × 6 context gates (`fitMeta` :463, λ=500).
   - Season-a-time walk-forward (`evaluate` :481) plus a permutation null (:575).
   - **Bug:** the meta-model trains on in-sample specialist predictions (:508-509), a stacking leak inside the training data.
   - A coverage gate drops families that are 80% or more empty (:413). Needs 2 or more prior in-season weeks, so Weeks 1–2 are dropped.
   - News uses day granularity (`days<0` :369), so same-day news after kickoff can get in.
   - Tests: indirect only (`nfl-model-fixes.test.js`, 4 tests, about the snapshot-leak fix).
   - **Recommendation:** its design matrix (about 90 matchup differentials + context) is a good feature spec. Its fitting method should be discarded.
2. **`nfl-orthogonal-specialists.js`**
   - `fitRidge` :62 is robust IRLS on standardised inputs. Families are fit in order on frozen `nfl_team_cards`, each on what earlier families left unexplained.
   - Blocks are 70% train / 15% tune / 15% report (:147).
   - **Starvation bug:** coefficients are never refit on the tune or report blocks, so the most recent 30% of weeks never trains the coefficients.
   - Influence = clamp(6×gain fraction, 0, 1) × n/(n+256), which is zero when the tuning gain is not positive: another near-binary gate.
   - Needs 420 or more card games. 49 saved models. Feeds specialist_team (MSE +5.04). Tests: 1 persistence test.
3. **`nfl-matchup-specialists.js`**
   - `ridge` :183 on standardised inputs (λ=25), with a 4-season rolling window and a 200-row minimum (`fitRole` :202). Forecasts capped at ±4. Cutoff-safe.
   - trench_continuity has no prior-season fallback: it needs 2 snap weeks earlier in the same season (:106-121), hence 5,568/6,901 observed.
   - These are the best-behaved roles (qb_state −0.39; pressure/tendency roughly flat). Tests: 4.
4. **`football-first.js`** (`fitResidualModel` :253, λ=5, season-a-time) and **`weekly-walkforward.js`** (`ridgeFit` :76, refit weekly from a 300-game minimum).
   - Both learn the residual from football-fact features. Audit #15 recorded 48.35% over 242 bets.
   - `weekly-walkforward` has no tests. `football-first` has only a route test.
5. **Movement ridge** in `movementFor` (council :208): a one-variable, heavily shrunk slope. Trivial.
6. **Other ridge/logistic fits:**
   - `line-move-study.js:263`: L2 logistic regression by Newton steps. Reusable for cover/over classification.
   - `nfl-prop-calibration.js:75` `fitLogistic`.
   - `preseason-model.js:144` weighted `ridgeFit` with `ridgeContributions` (fantasy side, 20 tests).
   - `offseason-model.js:902` (24 tests).
   - The nfl-ensemble Massey ridge (`ensemble-massey-ridge` test, 4).
7. **`model-signal-quality.js:13-15`:** `residual_tree`, `residual_linear` and `hierarchical_pool` are only string labels. They generate 416 "shadow" path IDs with `production_authority: 0` and nothing is implemented. Discard.

### F. Joint score-distribution model — `server/services/nfl-joint-score.js`
- **What it is.** A dynamic model of both teams' scores as compound Poisson scoring events with a shared shock.
  - Includes a Nelder-Mead optimiser (:693), a severity fit (:770), and `runFilter` :627, which updates each game from the result.
  - Cutoff-safe by construction (there is a no-lookahead test).
- **Tests:** 26 strong ones (gradient vs numerical difference, parameter recovery, textbook special cases).
- **Status:** `JOINT_SCORE_VERDICT` (:920) says it was never run on real NFL data (synthetic fixtures only), overstates same-game correlation about 1.8×, and misses the CRPS bar. It uses no features, only scoreboards.
- **Recommendation:** keep as a later distribution layer for totals, teasers and same-game parlays. Not a core learner.

### G. `betting/nfl/strategy/margin-distribution.js`
- A discrete margin model with a posterior interval. Its `MARGIN_MODEL_VERDICT` (:1642) says it is beaten on the 8 lines the scanner actually bets.
- Keep for key-number probability mass only.

### H. Python research labs (sound protocols, starved data, cannot run now)
- `research/tree_lab.py` (LightGBM/XGB/CatBoost/HistGB/ExtraTrees/ridge, three targets, market-anchored logit branch), plus `market_lab.py`, `expert_selector_lab.py` (scipy simplex meta-learner) and `book_lag_lab.py`.
- **Protocol:** expanding whole-week inner folds, 7-day label embargo, leakage scan (`research/leakage.py`), observations-per-parameter check (`model_discipline.py`), preregistration files.
- **Shared chronology:** `research/betting/nfl/dataset.py` (results publishable at gameday+3 days, earlier-only lookups).
- **Starved:** the dataset is 1,795 rows, and the 2023 outer fold trained on only 219 games. Labels are the opening line and movement, not the close residual.
- **Results:** on the spread market, movement selected `no_move` and quantiles selected `market_only`. Cover models beat the coin flip only through TPOT, on tiny folds.
- Python unit tests exist (`test_tree_lab.py`, `test_model_discipline.py`, and others).

## 2. Evaluation, validation and authority infrastructure
- **`server/services/forecast-combination.js`**
  - `walkForwardCombination` :717 refits weekly by default. Candidates: equal weight, inverse-MSE, Granger-Ramanathan OLS, constrained least squares, Stock-Watson shrinkage, market-anchored beta, residual OLS, residual constrained (b≥0, sum≤1).
  - Also: a basis reduction fit on training data only (:252), an exact replay of the production gate (`fitIncumbentMarketResidual` :351), and week-clustered Diebold-Mariano with the HLN correction (:930).
  - About 30 tests, including oracle-leak tests and an exact reproduction of the incumbent.
  - Caveats: cover probability uses in-sample training errors (documented), and there is no cross-validated ridge candidate.
  - Best-tested harness in the repo. **Keep.**
- **`server/services/purged-walk-forward.js`**: seasonal folds with purge/embargo (:76). 10 tests. **Keep**; it needs a weekly-cadence mode.
- **`server/modeling/walk-forward.js`**: generic fit/predict walk-forward with a sealed final holdout (:35, :112). Built for timestamped player rows; games would need an adapter. Keep the sealed-holdout idea.
- **`server/modeling/governed-comparison.js`**: 8-gate verdict (Holm correction, effect floor, anytime-valid test with a stability check, cluster count, distinguishability). 28 tests.
  - Right for promoting a model version, but it is binary. Use it for "which learner version", not for sizing each bet.
- **`server/services/conformal.js`**: split-conformal intervals binned by spread bucket with recency weights (`buildConformal` :81). 10 tests, already used by `nfl-ensemble` and `nfl-market`. **Keep** for continuous uncertainty feeding bet authority.
- **`server/services/trial-statistics.js`**: effective trial count, deflated Sharpe, probability of backtest overfitting (:64, :155, :233). 15 tests. **Keep** for the bet-authority layer.
- **`forecast-comparison.js`** (Diebold-Mariano, 11 tests) and **`backtest-significance.js`** (clustered bootstrap, anytime-valid p-values). **Keep.**

## 3. Feature and data assets
- **`nfl_team_week_features`**: 2016–2025 (512–561 team-weeks per season). This is the raw material every learner above uses.
  - `game_lines` closes go back to 1999, but team-week features stop at 2016, so 17 seasons of play-by-play history are unused.
- **`nfl-weekly-feature-store.js` → `nfl_team_feature_vectors`** (writers :193 `freezeTeamFeatureVector`, :308 backfill).
  - 1,662 rows, 2022–2025, weeks 5–18. About 2,620 features each: 13 transforms (latest, means, EWMA, slope, sd, z-score, missing) over play-by-play, snap, injury, formation and charting metrics. 3,795 dictionary entries. Cutoff-safe (strictly earlier weeks).
  - **No learner reads it.** It is only written (and `buildTeamFeatureVector` is also called from `nfl-team-card.js`). This is the richest starved asset.
  - `nfl_player_feature_vectors`: about 16k rows.
- **`nfl-features.js`**: `teamFeatureVector` :457, `formFeatures`, `adjustedFeatures`, `bettingTrends`. Strictly-earlier catalog. No dedicated tests.
- **`nfl_weekly_expert_examples`** (7,356 rows per role, 18 audit runs) and **`nfl_expert_forward_predictions`**: ready-made walk-forward forecasts for stacking.

## 4. Recommendations for a unified learned model

**Sound foundation — reuse:**
1. **Data layer.**
   - Extend `buildGbmDataset`'s strictly-earlier team-week construction with the `nfl-specialists` differential spec and `nfl_team_feature_vectors`, adding missing-data flags instead of fixed defaults.
   - Use `research/betting/nfl/dataset.py` as the chronology spec.
   - Backfill team-week features before 2016 if play-by-play allows.
2. **Learners.** Train everything on the market residual (or margin with market as an offset), on all rows.
   - (a) A ridge/elastic-net over all features, with λ chosen by rolling-origin CV. Start from `nfl-orthogonal-specialists.fitRidge`: Huber IRLS on standardised inputs, refit on ALL prior weeks.
   - (b) Gradient boosting with early stopping on a later-weeks validation block. Either fix `nfl-gbm.js` (more split points, missing-data flags, early stopping, cache invalidation, math tests) or reinstall LightGBM in a Python 3.12 environment and write predictions into a DB table.
   - (c) Stack (a) and (b) with `forecast-combination`'s `residual_constrained` / Stock-Watson using out-of-fold predictions, reusing the coordinator's week clustering and Huber loss but without its t>2 gate.
3. **One linear-algebra module.** Use `forecast-combination.solveLinear`/`ols` (tested; returns null when singular) and delete the roughly 18 duplicate solvers.
4. **Validation.** `forecast-combination.walkForwardCombination` (weekly refit), `purged-walk-forward` and Diebold-Mariano as the honest harness, with `walk-forward.js`'s sealed-holdout rule.
5. **Bet authority, separate from learning.**
   - Continuous: `conformal.js` intervals plus a rolling out-of-sample skill estimate (anytime-valid p-values from `backtest-significance`) scaling the stake.
   - Version-level: `governed-comparison` plus `trial-statistics` (deflated Sharpe/PBO).
6. **Later:** `nfl-joint-score` as the distribution layer, after a real-data run with λc=0 for margins.

**Discard or retire as learners:**
- `model-signal-quality` path labels.
- The online neural net as a core model (inputs echo the ensemble; never trained live; audited MSE +7.67). Keep its capture/settle tables and lifecycle only.
- nfl-specialists' in-sample meta-stacking.
- Orthogonal specialists' 70% train-only coefficient fit and influence gate.
- The coordinator's t>2/cross-gain binary gate.
- similar_games (nearest neighbours).
- The hand-coded formula experts: rulebook (+26.5 MSE), player_builder (+36.6), game_replay (+8.0).
- The market_residual gate in `nfl-ensemble.js` (:1890).
- The ensemble-output features as model inputs (the echo problem).

**Quick fixes if the council keeps running meanwhile:**
- Clear `datasetCache` and `gbmCache` each week (`nfl-expert-council.js:72-78`).
- Let `trainOnlineNeuralThroughSettled` handle weeks that are not fully final (`nfl-online-neural.js:259`).

Scratch query script: `/private/tmp/claude-501/-Users-nick-matta-Claude-Artifacts/e22ddbdc-9d23-482e-a1cc-7bc1f39b77c6/scratchpad/mlinv_q_7731.mjs` (opens the DB read-only).