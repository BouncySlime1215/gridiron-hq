> Start with [LATEST-PLAN.md](LATEST-PLAN.md). Its September 15 update controls sequencing; dated findings below require reconciliation with current code.

# Gridiron plan additions: data, research and overfitting

**Current execution detail:** see the [master plan](archive/MASTER-PLAN-2026-09-14.md#weekly-training-news-backfill-and-claude-execution-instructions) for the later code reconciliation, weekly training and news/injury backfill procedure, and [Claude instructions](CLAUDE-IMPLEMENTATION-INSTRUCTIONS.md) for the ordered handoff.

September 14, 2026. This supplements the build plan with specific adoption decisions. It is planning and source verification; no paid data requests, downloads of full datasets, library installations, or application edits were performed.

## 1. What to obtain or improve

| Priority | Source/work | What it adds | Admission rule |
|---|---|---|---|
| First | Extend the existing nflverse ingestion | Older PBP, team/player production, snaps, roster/depth and stable player/game identifiers | Source-specific coverage; prior information only; record release/version and missingness |
| First | Repair and retain the existing multi-book quote tape | Actual handicap, price, movement so far, book disagreement and later CLV reference | Quote and receipt time before cutoff; stale/missing quotes explicit; one canonical game identity |
| First | Official team/league availability reports and inactives, using existing collection paths where possible | Who was expected to play, when that changed, and who would replace them | Preserve report text, publication/receipt times, revisions, player IDs and conflicting claims |
| First | Validate existing Open-Meteo forecast history and capture future runs | Wind/gusts/precipitation expected at kickoff and forecast changes known before a decision | Explicit model/run/lead/availability; distinguish forecast vintage from realized weather |
| Next | Additional historical quotes at the chosen horizon | More honest price-qualified training and evaluation games | First measure gaps in the current archive; acquire a bounded sample before deciding whether a larger paid backfill is worth it |
| Next | External nfelo-style ratings as comparisons and carefully reconstructed features | Independent team/QB-strength benchmarks and implementation ideas | No closing-market leakage, retrospectively tuned parameters or actual-starter hindsight in a historical betting feature |
| Later | Formation/charting, detailed player interactions and other specialist data | More specific matchup features | Add only with a defined target, deployment-time availability and full-pipeline incremental-value test |

The highest-value immediate expansion is from an ecosystem the app already uses. nflverse documents PBP availability back to 1999 and offers files through GitHub releases. This is public data availability, not a claim that all fields, seasons or historical vintages are already clean in Gridiron. [PBP documentation](https://nflreadr.nflverse.com/reference/load_pbp.html), [official data repository](https://github.com/nflverse/nflverse-data).

Use stable IDs and canonical games across sources, normalize team aliases/time zones/units, and verify home-spread signs. Retain contradictory source records for reconciliation instead of letting the last update silently win. Report coverage by season, game week, source and decision horizon. Do not multiply sample size by counting both team rows or every bookmaker quote as a new game.

### Three source traps the plan must handle

**A previous game is not enough to prove a field was available.** nflverse states that participation data from 2023 onward is delivered after the postseason. Its update schedule also documents the injury-source failure after 2024 and changes to depth-chart timestamps from 2025. Such sources require release-time checks or alternatives for live availability features. [Publisher's update schedule](https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html).

**Historical weather products are not interchangeable.** Open-Meteo's Historical Forecast API stitches the first hours of successive runs into a time series. The Single Runs API exposes a particular initialization, with different coverage dates. Existing `nfl-weather-history.js` preserves previous-day lead values and a lead-0 fallback, but does not establish precise run publication/receipt time. A day-of label must not automatically pass a T−60 eligibility check. Earlier-lead data may be usable if its availability is established; unknown vintages remain reconstructed/diagnostic. [Historical Forecast API](https://open-meteo.com/en/docs/historical-forecast-api), [Single Runs API](https://open-meteo.com/en/docs/single-runs-api).

**Derived metrics can contain a second kind of hindsight.** Historical EPA, win probabilities and published QB ratings can come from models trained or revised later. Pin the upstream model/data vintage; for strict historical experiments use a defensible earlier-trained model or an explicitly labeled reconstruction/sensitivity comparison. Never use future-informed WP or closing-spread fields as early-price features.

The Odds API documents historical snapshots, making it a candidate for filling measured gaps in the archive. Before buying or consuming credits, specify the games, dates, books, markets and horizon required; inspect pricing/timestamp semantics and estimate the resulting unique usable games. More snapshots of the same games improve price reconstruction, not the independent outcome count. [Historical odds documentation](https://the-odds-api.com/historical-odds-data/).

## 2. Put the recovered statistics into the build

“PhD-level research” is a description of the research ambition, not a guarantee of correctness. The reports, their verification reviews and executable reference comparisons should drive implementation decisions together.

| Recovered research | Existing implementation/state | Concrete adoption |
|---|---|---|
| F05: point-in-time/bitemporal data | Quote/packet contracts exist; complete feature freezing and revision coverage do not | Stage 2: shared as-of feature construction with publication and receipt clocks; Stage 4: freeze values and artifact references |
| F02: forecast combination | `forecast-combination.js` is implemented but explicitly research-only | Stage 3: combine chronological out-of-fold predictions with a market baseline; fit regularization on earlier inner folds |
| F08/F15: dynamic team strength and shrinkage | Team-strength and joint-score modules exist, but are not proof of a complete Bayesian game model | Stage 3: league/team/QB priors, early-season borrowing, offseason mean reversion and recency handling; estimate their strength inside earlier folds. Full Stan/PyMC models are later comparisons |
| F11/GF08: conformal uncertainty | Split-conformal code and a MAPIE cross-check already exist; earlier checks used fixtures | Stages 3/5: reuse corrected finite-sample math and verify real chronological coverage. Time dependence/shift limits the usual guarantees. Keep probability calibration separate |
| F06/GF10: Harvey–Liu, multiple testing, trial registry | Registry, DSR and PBO code exist, with material assumptions needing review | Stage 1: validate audit math. Stage 5: record every candidate and compare aligned week-level losses; correct the declared family of tests |
| F07: sequential inference | Several monitoring/significance paths exist; no blanket anytime-valid claim is justified | Stage 5: prespecified review times initially; only use continuous significance-based stopping after a suitable confidence-sequence/e-process implementation is independently checked |
| F17: NFL margin distributions | Discrete-margin code and joint-score experiments exist; not all cleared real-data comparisons | Stages 3–5: preserve mass at key margins and pushes; evaluate log score, calibration and probability at the actual offered handicap |
| F10/GF06: copulas/dependence | Research and candidate dependence machinery exist | Preserve same-game/exposure dependence; do not multiply leg probabilities as if independent. Advanced copulas wait until marginals are calibrated and enough joint data supports fitting |
| F13/N13: news impact and injury networks | Typed news extraction exists; much impact mapping is rule-based or research-only | Stage 6: model expected availability and replacement/usage effects, then test whether the market already incorporates them |
| N01–N12/GN catalogs: deep models, ensembles, AutoML | Several experiments exist; scale-up synthesis did not finish | Keep as a later candidate backlog. Each needs a task, data size and baseline; do not add all architectures to the first search |

This means the research is **partly used already**, but its adoption is uneven. The next task is to connect the useful implemented pieces and apply the missing principles, not port every paper into a new module.

## 3. What to reuse from GitHub

- **nflverse/nflverse-data:** extend the existing ingestion rather than introducing a competing database. Check each dataset's dictionary and terms.
- **nflreadpy:** official ecosystem Python access wrapper, useful if it simplifies extraction; optional because direct release ingestion already exists. Its Polars-based outputs require an explicit conversion boundary if the training pipeline uses pandas. [Documentation](https://nflreadpy.nflverse.com/).
- **MAPIE:** independent reference for uncertainty calculations. The repository already contains a cross-check; refresh it against the supported version and real held-out residuals before adding a new production dependency. [Repository](https://github.com/scikit-learn-contrib/MAPIE).
- **arch:** reference implementation for SPA, stepwise model comparisons and model confidence sets using common loss panels. Adapt time-block construction to NFL game/week dependence. These methods help assess selection effects; they do not rescue previously exposed holdouts. [Multiple-comparison documentation](https://bashtage.github.io/arch/multiple-comparison/multiple-comparison_examples.html).
- **nfelo:** inspect as a team-rating/market-comparison architecture reference. Recheck repository and data licenses before code reuse; preserve our own chronological fitting rather than importing retrospective predictions as if live. [Repository](https://github.com/greerreNFL/nfelo).
- **Existing sklearn/LightGBM/XGBoost/CatBoost:** use established implementations instead of creating more custom numerical solvers. Start with the small declared comparison in the main plan.

Pin versions/commits and preserve source/license references. Before adoption, test feature and prediction parity on representative fixtures. No repository's claimed betting record establishes performance on our information, prices or future games.

## 4. Overfitting control contract

Overfitting cannot be guaranteed absent. The objective is to reduce it, expose it, and prevent apparent backtest gains from being mistaken for deployable evidence.

### Required controls

1. **Freeze the experiment before scoring:** target, horizon, source rules, feature groups, candidate settings, primary metrics and selection rule. Record failed and abandoned experiments too.
2. **Limit the initial search:** ridge and one shallow boosted-tree family, with a small declared tuning grid. Further models/feature searches become new tracked experiments, not invisible retries.
3. **Nest every learned choice:** feature selection, imputation, scaling, upstream player models, early stopping, ensemble weights, prior strengths and calibrators all fit within earlier data. The outer test week is never a stopping or tuning set. [Nested-validation rationale](https://scikit-learn.org/stable/auto_examples/model_selection/plot_nested_cross_validation_iris.html).
4. **Use honest out-of-fold stacking:** every training feature representing another model's prediction must have been generated without fitting that model on the example's result.
5. **Respect dependence:** keep an entire game in one split; retain its players, plays, both sides and all books together. Compare candidates on common eligible games and use prespecified week/block resampling for uncertainty. Check sensitivity to plausible block lengths.
6. **Test time integrity directly:** add later news, scores, revised stats or quotes to a fixture; an earlier prediction must remain identical. A feature-importance leakage scan is supplementary, not proof of safety.
7. **Test the selection process under no signal:** on synthetic/noise or appropriately permuted residual panels, the complete search/selection procedure must not routinely claim an edge. Use many replicates and intervals; one lucky or unlucky null run proves little. Do not tune to those diagnostic outcomes indefinitely either.
8. **Use simple baselines and full-pipeline ablations:** market, zero residual, simple ratings; retrain after removing a feature family. Do not attribute the improvement of a combined model to every input independently.
9. **Report stability and sample size:** per season/era/horizon performance, training-versus-test gap, sensitivity to settings, and effective sample size after recency weighting. Twenty-five years with aggressive decay may behave like a much smaller sample.
10. **Correct selection claims:** use valid base tests on aligned losses and an appropriate family correction, retaining the raw trial count. Unknown prior searches remain a limitation; a correction cannot make reused history untouched.
11. **Keep uncertainty methods distinct:** conformal coverage is not a guarantee of point accuracy or profitable betting; a good Brier score is not evidence of executable returns; CLV and game results from the same bets are correlated evidence.
12. **Freeze future shadow evidence:** record predictions before games, evaluate at declared review times, and segment model versions. Changing the model or peeking repeatedly creates additional selection; ordinary p-values do not support arbitrary stopping.
13. **Treat error-driven additions as another search:** build the error report with the first model, including abstentions and matched baseline errors. Predeclare a small diagnostic group set; record post-hoc groups and every attempted fix. A weakness discovered in inspected games needs confirmation on later untouched games. Require full-pipeline refits and both target-group and overall results. Follow the improvement protocol in Stage 6 of the [build plan](archive/BETTING-MODEL-BUILD-PLAN.md); noisy subgroup losses and feature importance alone do not establish a cause.

### A newly confirmed audit issue

`server/services/trial-statistics.js` describes Holm as assuming independent trials. This is incorrect: Holm's family-wise control does not require independence when the underlying p-values are valid. [R statistical documentation](https://stat.ethz.ch/R-manual/R-devel/library/stats/html/p.adjust.html).

The code also derives an effective number of trials using an MCMC autocorrelation estimator. `scripts/run-purged-evaluation.mjs` feeds it a chronological sequence mixing ROI, probability errors and point errors after mostly sign/centering changes. Those values are not genuinely standardized to comparable units, and this does not establish the dependence among competing forecasts on the same games. It then supplies that effective count to DSR.

**Plan decision:** retain those historical outputs as diagnostics, but do not use the discounted trial count or reconstructed returns to justify promotion. First obtain aligned per-game/per-week predictions, losses and actual-price returns. Validate statistical calculations against reference implementations, and use a conservative declared-family correction until a better justified dependence-aware procedure is ready. DSR/PBO remain supporting diagnostics with assumptions and incomplete-trial-history limits stated.

## 5. Acceptance criteria added to the build

- Every new source has a reason to exist, timing contract, identity mapping, coverage report and incremental-value test.
- Every adopted research method names its paper/report, implementation, assumptions and verification.
- Every forecast has a reproducible upstream training and feature chain.
- Every performance claim states its candidate search, data exposure, baseline, eligible sample and uncertainty.
- Engineering completion and improved prediction are reported separately from profitable execution.
- The first model ships with an error report and improvement backlog. Each proposed addition names its observed weakness, baseline comparison, hypothesis, research/code reference, smallest fix and later confirmation period; reject/inconclusive outcomes are retained.

These are concrete additions to Stages 1–5. Broad new research, expensive feeds, copulas, or deeper networks are not prerequisites for starting the repaired learning pipeline.
