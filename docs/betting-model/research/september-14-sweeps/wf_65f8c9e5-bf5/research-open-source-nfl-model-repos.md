NFL model repo survey: most published repos agree the closing line wins, and three to five are worth copying from as architecture references

Scope and caveats. I read the READMEs, file trees and key source files through the GitHub API for 18 repos, and opened code in 7 of them. I ran nothing, so every number below is what the repo reports about itself, not something I reproduced. None of these repos is peer-reviewed. Most have 0 to 20 stars. Several were created in the last few weeks and are clearly built with AI coding agents: they contain CLAUDE.md or AGENTS.md files. Where I lean on earlier research I cite GF02, GF05, GF09 and GITHUB_BUILD_CATALOG.md. Local copies of what I pulled are in `/private/tmp/claude-501/-Users-nick-matta-Claude-Artifacts/e22ddbdc-9d23-482e-a1cc-7bc1f39b77c6/scratchpad/nflrepos/`.

## Repo-by-repo

**1. ryanpmcintire/nfl_py3** (https://github.com/ryanpmcintire/nfl_py3). MIT license, 15 stars, active since 2018, last push 2026-09-13.
- **Target:** `ats_margin = result − spread_line`, the "market_residual" target. Positive nflverse spread means home favored.
- **Model** (`src/nfl_ats/margin.py`): median imputation plus missingness indicators, a standard scaler, then Ridge with α=10 over about 249 "weak_stack" columns. There is optional per-feature-group penalty scaling.
- **Predictive distribution:** empirical residuals from an out-of-time final 20% of the training window. The model is then refit on the full window.
- **Features:** EWM team states, opponent-adjusted PBP (ridge offense/defense decomposition, 16-week half-life), QB state, injuries filtered to a 24-hour decision cutoff, and roster continuity. Weekly rosters are delayed one week because they have no timestamps.
- **Validation:** nested chronological walk-forward. Calibrators use only out-of-sample rows from before the week's first kickoff. Confidence intervals are week-blocked. Graph (PageRank/HITS) features and HistGradientBoosting were tested and not promoted (`docs/modeling.md`).
- **Results:**
  - Graded against the close, 2018–2025: 52.29% ATS on 2,075 games, 95% CI [50.21, 54.41]. The -110 break-even is 52.38%.
  - Graded against the Tuesday opener: 54.49% on 1,537 games, CI [51.86, 57.09].
  - Market-residual MAE is 9.905, versus 10.148 for a pure football margin model.
- **Two standout tools:**
  - A deliberate-leak positive control (`docs/leak_ceiling_control.md`). Fitting in-sample on the scored games themselves with pregame features reaches only 55.6% ATS, while same-game PBP reaches 84%. So the ceiling for pregame features is roughly 55–56%, even when cheating.
  - A synthetic-signal recovery audit that injects known 0.5, 1 and 2-point effects (`scripts/sensitivity_audit.py`).
- **Warnings:** the production card flips picks on hand-made situational rules ("coach fade", "division revenge", "player arrests"). Its registry holds 6,484 weak-signal results, and it has a rule that a CI containing zero is "NEVER grounds to reject". Both are forking-paths risks, even inside the most rigorous repo in this survey.

**2. kshreyan/nfl-predict** (https://github.com/kshreyan/nfl-predict). No license. Created 2026-09-13.
- **Models:** Elo with season-refit home-field advantage (2.53 points in 2003, 2.10 in 2026), trailing EPA, and per-QB trailing EPA keyed to the nflverse `home_qb_id`. Spread and total use a Normal(Ridge mean, σ) model. Moneyline uses logistic regression. Each is blended in log-odds with de-vigged juice, using weights fit on prior seasons.
- **Results, 2010–2025 walk-forward:**

| Market | Model | Market |
|---|---|---|
| Margin MAE | 10.33 | 10.08 |
| Moneyline Brier | 0.2183 | 0.2110 |
| ATS accuracy | 50.7% | — |
| Totals accuracy | 51.6% | — |

- **XGBoost:** nested walk-forward was "tested, not adopted". Log loss, Brier and ECE got worse every time.
- **Leakage suite:** `tests/leakage/`. It sets future scores to 999 or 1000–0 and asserts that earlier predictions are byte-identical. It also includes a sign-convention regression test, because a flipped `spread_line` once produced a false 76% ATS.
- **Weather:** it refuses nflverse `wind`/`temp`, which are observed conditions that are missing for unplayed games.

**3. roni-altshuler/nfl_predictor** (https://github.com/roni-altshuler/nfl_predictor). No license. Next.js plus a numpy-only Python backend.
- **Features:** 9 total — Elo diff, neutral site, rest diff, bye flags, rolling margin and total, division game, week progress.
- **Model:** closed-form ridge for margin and total. The margin distribution is a discrete lattice, `P(k) ∝ w(k)·N(k; μ, σ)`, with key-number weights shrunk by a gamma-Poisson prior (α=8). The weights are refit inside `fit()` against the model's own predicted means, so they are walk-forward.
- **Validation:** weekly expanding-window refit on rows with `date_utc` earlier than the week's first kickoff (`backend/scripts/benchmark_market.py`).
- **Results:** Brier 0.2199 vs 0.2117 for the close, with a paired-bootstrap CI that excludes zero. The margin model does not beat Elo alone.
- **Caveat:** α was chosen by a sweep against the full-corpus tie rate, which is mild hyperparameter lookahead.

**4. ltx-kt/NFLPred** (https://github.com/ltx-kt/NFLPred). No license.
- **Model:** a six-model calibrated ensemble for straight-up winners. Weekly walk-forward refit with a recency half-life.
- **Validation splits:** train 2006–15, calibrate 2016–18, validate 2019–21, test 2022–25 touched once.
- **Results:** 64.8% vs 67.3% for the de-vigged close. Weekly refit gains 0.0069 log loss over a frozen split, and recency weighting adds 0.0008. Ensemble members correlate at 0.959, and the ensemble beats its best single member by only 0.0004 log loss. A 29-column feature set lost to the 16-column set.
- **Leakage tests:** one `lagged()` shift function; a test that perturbs one game and asserts its own row is unchanged while later rows do change; and a 72% accuracy tripwire.

**5. Hijodeagua/Can-Tre-Beat-Vegas** (https://github.com/Hijodeagua/Can-Tre-Beat-Vegas, see `NFL/model/v2/README.md`). No license.
- **Model:** LightGBM on 45 features, including the closing spread, total and no-vig probability. Retrained once per season: fit on data before S−1, Platt-calibrate on S−1, score S.
- **Results, 2010–25:** straight-up 64.3% vs 66.4% for the close. ATS 50.5%, totals 49.5%. Flat-stake ROI is −4.9% on spreads and −4.5% on totals.
- **Stacking check:** a market-plus-model logit stack is worse than the market alone (log loss 0.613 vs 0.610). The model's stacker weight swings between +0.57 and −0.16.
- **Flaws:** it uses observed temp/wind, and a once-per-season retrain means week-17 predictions use start-of-season state.

**6. gmalbert/nfl-predictions** (https://github.com/gmalbert/nfl-predictions). No license.
- **Cautionary example.** Its own 2026 review (`docs/COMPREHENSIVE_REPOSITORY_REVIEW_2026.md`) withdraws the earlier "60.9% ROI, 91.9% selective win rate" claims.
- **Causes named in that review:** full-sample `groupby().mean()` cover and favorite rates (effectively target encoding), shuffled `train_test_split(stratify=...)`, thresholds chosen on the test set, calibration not isolated in time, and inconsistent team codes (LA/LAR, OAK, SD, STL, JAC).
- **Verified result now:** 28–26 on 54 bets, −1.01% ROI.

**7. The rest, briefly:**
- **BlairCurrey/nfl-analytics** (https://github.com/BlairCurrey/nfl-analytics): linear regression, trained before 2023 and tested on 2023+. MAE 10.3 vs 9.8 for Vegas vs 11.2 for a constant home-field guess.
- **Bsanchez650/nfl-model** (https://github.com/Bsanchez650/nfl-model): XGBoost with `spread_line` as a feature and a single 2024 holdout. When it disagrees with the close it is right only about 19–31% of the time. It trains on historical weather but serves NWS forecasts, which is a train/serve mismatch.
- **lmchugh17/nfl-betting-model**: scaffold only (Task 0); no results yet.
- **peanutshawny/nfl-sports-betting** (https://github.com/peanutshawny/nfl-sports-betting): averages FiveThirtyEight Elo by year, including `elo1_post` (post-game Elo), which is direct lookahead.
- **slieb74/NFL-Betting-Data**: "54.79%" is from scoring every game since 1979 with a model trained on those same games, i.e. in-sample.
- **rohanprabhu7/nfl-prediction-model**: raw EPA leaked and gave 64% ATS; after a confidence-band filter chosen after seeing results it claims 59.8% on 199 games.
- **Tkcool28/nfl-edge** (MIT): design only — an independent probability first, and a stacker trained only on out-of-sample predictions. No results to verify.
- **greerreNFL/nfelo:** already covered in GF02. It is an Elo/market hybrid whose update is throttled by market error; no license.

## (A) Key findings

1. **Every honest repo loses to the closing market, by about the same amount.**
   - Margin MAE: +0.25 points in kshreyan, +0.5 in BlairCurrey.
   - Brier: +0.007 to +0.008 in kshreyan, roni and Hijodeagua.
   - Straight-up accuracy: 2–2.5 points behind in Hijodeagua and ltx-kt.

   Gridiron's RMSE of 14.8 vs 13.55 is a wider gap than these repos show, so a well-built ridge model should narrow it. It should not be expected to close it.
2. **ATS accuracy against the close sits at 50.5–52.3% everywhere.** The best case, nfl_py3's 52.29%, has a CI that straddles break-even. nfl_py3's leak-ceiling experiment puts the pregame-feature ceiling for this model class at about 55.6%.
3. **Adding complexity does not help at NFL sample sizes.**
   - XGBoost/LightGBM worsened calibration (kshreyan) or merely tied Elo (Hijodeagua).
   - HistGradientBoosting and graph features were not promoted in nfl_py3.
   - A six-model ensemble gained 0.0004 log loss (ltx-kt).
   - A nine-feature ridge did not beat Elo (roni).
   - Regularized linear models plus good ratings are the consistent winner.
4. **Weekly refitting matters more than model choice or recency weighting** (ltx-kt, measured on the same construction).
5. **Where anyone claims an edge, it is against the opener, not the close:** nfl_py3's opener grade, and Hijodeagua's "beat the close, not the closer". This matches Gridiron's memory note that the opener path is dead for the current model, but it is the only place anyone reports a signal.
6. **Every inflated result traced back to a named leak:** sign flip (76%), full-sample target encodings (91.9%), post-game Elo, in-sample scoring, observed weather, or thresholds tuned on the test set.

## (B) Recommendations for Gridiron

1. **Primary model: ridge on the market residual, in Node, closed form.**
   - Target: actual margin minus the line as of decision time.
   - Solve with a normal-equations/Cholesky ridge in plain JS: about 40 lines, no dependencies. roni's `_ridge_solve` and nfl_py3's standardize-then-Ridge pipeline are the templates.
   - Also fit a football-only ridge on actual margin as the independent forecast, and report both.
   - Replaces the binary evidence gates with shrinkage.
2. **Shrinkage by feature group, not gates.** Use one penalty multiplier per group (ratings, PBP-adjusted efficiency, QB, injuries, rest/travel, weather-forecast), as in nfl_py3's `GroupPenaltyScaler`. Choose α and the multipliers by inner walk-forward on earlier seasons only, from a small grid that is frozen before scoring.
3. **Predictive distribution from out-of-time residuals.** Use the last 20% of the training window, then apply roni's lattice reweighting so 3/7 key numbers and pushes are handled. The w(k) weights are refit each week inside the fit; α is fixed in advance.
4. **Refit weekly, strictly as of the week's first kickoff.** Every feature is stamped with its own availability time: a bitemporal filter (F05) on `injuries`, and opener/quote-tape rows. Never use `game_lines` closes as a feature when making a decision before the close.
5. **Gate the bet continuously, not the model.** Stake only when the rolling out-of-sample model-vs-line edge, in residual terms, has a lower confidence bound above zero, and scale stake by that bound. Report CLV against Gridiron's snapshot close.
6. **Build the harness tests first:**
   - Future-corruption invariance: set future scores to 1000–0 and assert earlier predictions are byte-identical (kshreyan).
   - Own-row-unchanged / later-row-changed perturbation (ltx-kt).
   - A spread-sign regression test (kshreyan).
   - A too-good tripwire, e.g. ATS above 56% or RMSE below the market's, halts the run.
   - A leak-ceiling positive control plus synthetic 0.5/1/2-point signal recovery (nfl_py3).
7. **Always keep baselines:** market close, market opener, Elo/nfelo-only, and constant home-field advantage, compared with paired week-blocked bootstraps.
8. **Do not ship hand-coded situational flip rules.** Register every candidate feature in the trial registry (F06). Promotion requires out-of-sample improvement with multiplicity accounted for.
9. **Python with numpy only is enough** for research parity. Nothing needs installing: ridge, bootstrap and lattice code are all a few lines in numpy or JS. Gradient boosting should be a registered challenger only, and only if the owner later approves LightGBM; the evidence above says not to expect a gain.

## (C) Code and ideas worth adopting

| Repo | License | What to borrow |
|---|---|---|
| ryanpmcintire/nfl_py3 | MIT | Can port directly: `fit_margin_model`'s out-of-time residual split; `GroupPenaltyScaler`; the `prediction_safety.py` fail-closed contract; the design of `scripts/sensitivity_audit.py`; the leak-ceiling control protocol; opener-vs-close grading separation (`docs/tuesday_card_clv.md`). |
| kshreyan/nfl-predict | none | Reimplement the idea only: the `tests/leakage/*` corruption tests, spread-sign regression test, realistic-ceiling INVESTIGATE flag, per-QB trailing EPA keyed on `home_qb_id`/`away_qb_id`. |
| roni-altshuler/nfl_predictor | none | Reimplement the idea only: the key-number lattice pmf with gamma-Poisson shrunk w(k), ridge margin plus total with residual correlation, paired bootstrap against the close. Its numpy-only design fits Gridiron's constraints. |
| ltx-kt/NFLPred | none | Reimplement the idea only: a single `lagged()` choke point, the perturbation test pair, weekly refit plus half-life weighting, the accuracy tripwire. |
| Hijodeagua/Can-Tre-Beat-Vegas | none | Idea: a stacker-weight stability diagnostic — does the model add anything to the market logit out of sample? |
| georgedouzas/sports-betting | MIT | Already in GF05: a `TimeSeriesSplit`-only backtest and a point-in-time odds-column grammar. |
| greerreNFL/nfelo | none | Already in GF02: market-throttled Elo update as a feature. |

## (D) Open questions and risks

- **Self-reported numbers.** I did not rerun any backtest. The agent-built repos could still have subtle leaks their own tests don't catch.
- **Possible train/serve mismatch in nfl_py3.** Its market_residual model trains on the closing `spread_line` but is graded at the Tuesday opener. I did not check whether serving substitutes the opener into the spread feature. Gridiron will face the same choice and should train on the line as of decision time; that requires line snapshots, which exist only for recent seasons and shrink the training sample.
- **Weather.** It is unverified whether Gridiron's weather table holds forecasts as of decision time or observed conditions. If observed, it cannot be used as a feature.
- **Selection and multiple-testing risk.** nfl_py3's 54.49% opener grade came after extensive research in which thousands of signals were recorded. Treat it as an upper bound, not a target.
- **Sample size.** At about 270 games per season, detecting a 1-point residual edge takes several seasons. nfl_py3 describes its evaluator's resolution as roughly 2 points. A continuous bet gate will rarely open, and that is the honest outcome.
- **Licensing.** Most of these repos have no license, so their code can inform a clean-room reimplementation but must not be copied verbatim.