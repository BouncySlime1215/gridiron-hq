# Gridiron HQ — master betting model plan

September 14, 2026 · Consolidated implementation plan and evidence register

**Scope:** NFL betting: data, numerical forecasting, ML, AI news use, prices, evaluation, gates and monitoring. This is the main plan to work from. Research adoption and the process for choosing future improvements are included here.

**Status:** this task has recovered research, inspected selected code/data and produced the plan. A later inspection found HEAD `21789a9` and ongoing edits to the dataset builders/labs; foundation work elsewhere has progressed. The new weekly-training execution section records that update. The earlier findings and counts remain a dated `43af933` inspection snapshot, not a fresh open-defect list. Reconcile current implementation and data before each slice; this planning pass did not run training, backfill collectors or live database changes.

**Expanded scope:** the detailed specification below contains 20 work packages and execution prompts, six milestones, 28 research guardrails, 12 code-review additions, exact edit/test maps, output standards, operational failure cases and a conditional advanced-model backlog. The core effort estimate is 41–78 engineer-days, to be revised after the pilot.

## Plain-English decision

The app has real ML experiments and useful infrastructure, but it does not yet have a coherent trained betting pipeline. In the recorded production decisions inspected, its forecast matched the market. There are also concrete data and numerical defects, disconnected training/serving paths, and overlapping gates. Historical models that did make independent predictions did not establish an edge either.

Keep the useful infrastructure, repair the foundations, train a small first candidate on trustworthy history, and connect the exact same model to reproducible shadow predictions. Build the error report alongside it so future additions address measured weaknesses. Improved prediction and profitable betting require separate evidence. Overfitting can be reduced and detected; it cannot be guaranteed absent.

## Contents

1. [Implementation stages and first delivery](#implementation-stages-and-first-delivery)
2. [Data sources, research and GitHub adoption](#data-sources-research-and-github-adoption)
3. [Overfitting controls and acceptance requirements](#overfitting-controls-and-acceptance-requirements)
4. [Weekly training, news backfill and Claude execution instructions](#weekly-training-news-backfill-and-claude-execution-instructions)
5. [Expanded work packages, dependencies and effort](#expanded-engineering-specification-dependencies-and-effort)
6. [Agent context, research guardrails, new code findings and output standards](#agent-operating-manual-research-guardrails-and-code-review-additions)
7. [Prompts and edit maps for all 20 packages](#package-prompts-and-exact-edit-map)
8. [Current system findings and problem register](#current-system-findings-and-problem-register)
9. [ML and AI evidence](#ml-and-ai-evidence)
10. [Recovered Claude research and audits](#recovered-claude-research-and-audits)

## Implementation stages and first delivery

Proceed to implementation planning and staged engineering. The recovered research is sufficient to start. Additional research should answer a specific unresolved implementation question, with a defined decision it could change.

Scope: the NFL betting model and its supporting data, training, predictions, pricing, evaluation and monitoring. Fantasy/UI work is outside scope except where a shared dependency prevents the betting pipeline from working.

### Target behavior

For every game, the system should be able to show:

1. What it knew at the decision time.
2. Which trained model and calibrator it used.
3. Its predicted margin, total and relevant probabilities.
4. How its forecast differs from the market available then.
5. Whether the offered price justifies a bet, and why it bet or abstained.
6. What happened afterward, including the final score, closing price and prediction error.

The same saved inputs and model must reproduce the same answer. Training and evaluation must exercise the same prediction path used by the app.

### Stage 1 — repair the foundation

**Purpose:** stop feeding broken or stale information into new experiments.

- Reconfirm current status of the specialist fitting defect, corrupt QBR season rows and missing 2026 team features; repair their producers and add targeted regression tests.
- Quarantine invalid records in research extracts. Do not silently rewrite original evidence or erase failed experiments.
- Make a per-source coverage/freshness table: earliest season, latest completed game, missing values, available timestamps, and whether the source can support historical reconstruction or actual prospective capture.
- Separate learning filters, data-integrity checks and betting-authority rules. Identify one owner for each; mark duplicated or incompatible rules for replacement.
- Freeze the baseline code/configuration and historical comparison results before changing model behavior.
- Audit the safeguards themselves: correct the claim that Holm assumes independent trials; treat the MCMC-derived effective-trial count and reconstructed-return diagnostics as unvalidated for promotion. Use aligned prediction/loss panels and independently checked statistical implementations.

**Done when:** valid current-season features update after settled games; invalid future/duplicate QBR rows cannot enter features; specialist coefficients are finite; each input's freshness and provenance is visible. Existing live capture continues undisturbed.

### Stage 2 — create the shared training data

**Purpose:** give the learners appropriate history without introducing future information.

- Build one versioned feature contract shared by offline training and serving. Include game identity, cutoff, source versions, values, missingness, information age and label availability.
- Produce a broad **football dataset**, starting with the existing 1999+ scores/schedule history and available team/player features. Missing old opening prices must not exclude these games from football learning.
- Produce a separate **betting dataset** using actual quotes available at the declared decision time. Start with the existing T−60 contract. Retain earlier-price records for a separately evaluated early-betting model.
- Never substitute a later closing quote for T−60. Missing price history limits the betting evaluation, not the football dataset.
- Backfill missing historical football sources in bounded, resumable seasons. Start with aggregates needed by the first learner; expand raw play data for named features, rather than downloading everything speculatively.
- Rebuild existing ratings/formula predictions chronologically before using them as learned features.
- Prioritize nflverse historical PBP/team/player/snap/roster data, genuine decision-time multi-book quotes, timestamped official availability reports, and correctly versioned weather forecasts. Check the publisher's actual release schedule: some participation data arrives only after the season, and nflverse's injury feed has documented gaps.
- Freeze both source publication/availability and local receipt times. Preserve revised snapshots. Derived EPA/ratings need model-vintage review as well as game-date filtering. Weather lead labels alone do not establish the forecast was available at T−60.

**Done when:** dataset manifests show unique games and coverage by era; optional missing features do not erase usable games; changing future rows cannot alter an earlier feature vector; every betting example has an eligible quote or an explicit exclusion reason.

### Stage 3 — train a small, serious first model

**Purpose:** determine whether learning from the repaired data adds predictive value.

- Reuse `research/.venv`, existing lab code and evaluation infrastructure.
- Compare a regularized linear model and one shallow LightGBM candidate with the market baseline. Avoid a large AutoML search in the first pass.
- Train football estimates from lagged efficiency, opponent strength, pace, QB/player quality, availability, schedule and legitimate weather inputs.
- For the betting head, learn the correction to the decision-time market. Include chronological football-model predictions as features; their training must precede each example too.
- Tune only within earlier inner folds. Save every outer-fold prediction, including bad results. Record all feature/configuration attempts.
- Fit probability calibration on earlier out-of-fold predictions, handle pushes explicitly, and evaluate spreads and totals separately.
- Allow the market/zero-correction baseline to win. Do not require each individual feature to prove profitable before the learner may consider it.
- Apply the recovered shrinkage/team-strength research to the first model's priors and offseason carryover. Reuse forecast-combination and conformal work with their assumptions tested; retain a separate probability calibrator because a conformal interval is not a cover probability.
- Predeclare a small configuration set and primary metrics. Changes after seeing results create a new registered experiment, rather than retroactively changing the test. Report season and feature-era performance, along with sample size after time weighting.
- Build the error report with this first experiment. Save predictions for every eligible game, including abstentions, alongside matched baseline predictions, actual outcomes, source freshness/missingness and model identity. Report signed and absolute margin/total errors, probability quality and uncertainty; keep price-qualified betting metrics separate. Predeclare a small set of diagnostic groups using information known at the cutoff, such as expected QB changes, season phase, forecast weather and market horizon. Show unique-game counts and week/block uncertainty; flag sparse groups as inconclusive.

**Done when:** one reproducible report compares identical eligible games across candidates, with prediction error, probability quality, calibration and coverage, plus an error report that can distinguish candidate weaknesses from market-wide difficulty. Any simulated betting returns use actual eligible prices. A negative result is a valid completion, not a reason to keep searching until a positive result appears.

### Stage 4 — connect the complete prediction path

**Purpose:** make the app consume an actual trained model rather than just display research reports.

- Save immutable model artifacts with feature schema, preprocessing, training cutoff, code/data hashes and calibration identity.
- Initially score with the same Python pipeline used offline. Add a Node adapter; postpone a second-language implementation until needed and require numerical parity if introduced.
- Freeze actual feature values and model references in the decision packet, alongside the quote. Remove mutable-table rereads from the learned prediction path.
- Wire the candidate through the T−60 runner, prediction board, decision ledger, settlement and closing-line grader.
- Handle missing artifacts, late data, duplicate retries and restarts explicitly.
- Consolidate betting controls into one versioned policy. Preserve timestamp, numerical validity, execution and exposure checks. Replace mismatched identities and duplicate thresholds with consistent contracts.
- Preserve a decision trace: candidate forecast, served forecast or fallback, calibrator output, offered price, expected value, each gate's result and final action. This lets the error report distinguish a weak learner from a model that never reached the decision, or an advantage lost at execution. Any hypothetical outcomes from bypassing a gate are diagnostic and cannot authorize bypassing it.

**Done when:** one game passes from frozen inputs through trained forecast to recorded shadow decision/abstention and later grading; replay gives the same result after live tables change. Then demonstrate the same behavior across the eligible slate. No automatic increase in live stakes accompanies integration.

### Stage 5 — validate the system as a whole

**Purpose:** establish what the new pipeline actually adds.

- Compare the complete learned path with the market, the preserved incumbent and a simple football baseline using weekly chronological evaluation.
- Treat repeatedly inspected history as development data. Freeze the prospective protocol before using future games as evidence.
- Run shadow predictions before kickoff, recording all games and abstentions. Monitor input freshness, model version, errors, calibration, closing-line value and realized returns separately.
- Measure incremental value with full-pipeline ablations: remove a feature family, refit appropriately, and compare. An isolated component win is insufficient.
- Distinguish engineering success, predictive improvement, paper execution results and evidence supporting live betting authority.
- Require future-data mutation tests, chronological out-of-fold stacking, train-only preprocessing, and null controls on the selection procedure. Calibrate uncertainty using week/block dependence; do not treat multiple books, both sides, or plays from the same game as independent game outcomes.
- Maintain a complete trial registry and correct batch comparisons for the actual declared candidate family. Keep historically examined data labeled development, regardless of whether a sophisticated correction produces a favorable result.
- Freeze the prospective evaluation and review schedule before future games. Model changes start a new versioned evidence segment. Repeated ordinary p-value checks cannot be called anytime-valid monitoring.
- At scheduled reviews, turn the error report into a ranked improvement backlog using the Stage 6 protocol. Separate data/pipeline failures, forecast errors, probability errors and pricing/execution failures. Include no-bet games and excluded-game counts so betting gates cannot hide weak forecasts or coverage failures. Post-hoc groups are exploratory and require later confirmation.

**Done when:** there is an auditable performance ledger and a clear verdict about what improved and what remains unproven. A working pipeline can still correctly conclude that no betting edge has been demonstrated.

### Stage 6 — choose additions from measured weaknesses

The diagnostic process starts in Stage 3 and continues through shadow serving; it must not wait until this stage. The items below are candidate families, not an automatic build queue. A working system can also conclude that no addition has earned priority.

#### Required improvement process

1. **Identify and classify the weakness.** Compare the candidate and market/simple baseline on the same games. Record effect size, unique-game count, uncertainty, era stability and the discovery period. Large errors shared by both models are not automatically a missing model capability. Check data and routing before proposing more ML.
2. **Write a specific hypothesis.** State the suspected mechanism, what information was available before the bet, and the smallest change that could address it. Error patterns and feature importance are clues, not causal proof.
3. **Register the experiment before comparison.** Record the relevant recovered research/report, proposed code or GitHub reference, source coverage, configuration budget, primary metric, meaningful improvement threshold, regression checks and confirmation period. Rank candidates by evidence strength, affected coverage, potential benefit, data readiness and cost; do not rank by architecture novelty or a few large losses.
4. **Compare the complete systems fairly.** Fit baseline and modified pipelines on earlier data, including their upstream features, weights and calibrators. Use identical eligible games and prices, and refit ablations where appropriate. Show whole-population performance as well as the target group so a local gain cannot hide broader deterioration.
5. **Confirm beyond the discovery data.** Once inspected to choose a fix, those games are development data. Use later untouched chronological evaluation and then frozen prospective predictions. Count subgroup searches and failed attempts in the trial registry; predeclared review times and appropriate multiplicity controls still apply.
6. **Keep a concrete verdict.** Mark the addition retain, reject or inconclusive with the evidence and limitations. Predictive improvement does not automatically establish profitable betting or change betting authority. Retain the incumbent when the evidence is insufficient.

Each backlog entry must contain: failure category, hypothesis, affected games, baseline-relative evidence, source timing, research/code reference, smallest proposed fix, estimated effort, experiment ID, confirmation window and verdict. The first delivery must include the report and backlog format even if no weakness has enough evidence yet.

| Observed pattern to investigate | First checks or candidate improvement |
|---|---|
| Errors around expected QB changes | Availability timing, stale inputs, replacement quality and expected usage |
| Weak early-season forecasts | Offseason carryover, roster changes, shrinkage and rating update speed |
| Repeated total errors under certain conditions | Pace/possessions, forecast weather and scoring distributions |
| Reasonable average margins but poor cover probabilities | Calibration, distribution shape, key margins and pushes |
| Candidate differs from market but served forecast never does | Artifact loading, routing, fallback and gate trace |
| Useful forecasts but poor executable prices | Quote age, decision timing, book availability and execution assumptions |
| Strong training results and weak later results | Leakage, excessive search, sample size and unstable relationships |

These patterns nominate investigations; none alone proves an explanation or justifies a new data purchase/model.

#### Candidate families after the first complete path works

1. Improve QB/player quality, expected usage, availability and replacement effects.
2. Add play/drive models for efficiency, pace and matchup information; aggregate them into game-level features.
3. Evaluate a joint score distribution/simulator against the simpler calibrated probability baseline.
4. Build a separate early-price/line-movement model if quote coverage supports it.
5. Revisit graph networks, transformers or foundation models only when a specific remaining problem justifies them.

Each addition needs earlier-only upstream predictions and a full-pipeline comparison. More plays or simulated games do not count as additional independent betting outcomes.

### Research and GitHub adoption commitments

The recovered research is explicitly part of the implementation. The [detailed adoption map below](#data-sources-research-and-github-adoption) records report identifiers, existing code, assumptions and source links.

| Planned role | Research and code to use |
|---|---|
| Trustworthy historical inputs, Stages 1–2 | Point-in-time/revision research; extend nflverse ingestion; nflreadpy optional if it simplifies access |
| First learned forecasts, Stage 3 | Dynamic team/QB strength and shrinkage, regularized forecast combination; existing sklearn/LightGBM and chronological predictions |
| Probabilities and uncertainty, Stages 3–5 | Calibration, discrete NFL margins/pushes and conformal research; existing corrected code checked against MAPIE |
| Honest selection and evaluation, Stages 1/5 | Harvey–Liu/multiple-testing research, trial registry, chronological evaluation and dependence-aware comparisons; arch as a statistical reference, DSR/PBO only after assumption checks |
| Choosing improvements, Stages 3–6 | Error reports, refitted ablations, declared comparisons and later confirmation; nfelo as a rating benchmark/reference after vintage and license review |
| Conditional deeper work, Stage 6 | Full Bayesian Stan/PyMC models, copulas, injury networks, play models, graph networks and transformers only against a documented weakness and simpler baseline |

Adoption means a method has an assigned purpose and verification requirement; it does not mean all these methods are already in production. Pin adopted versions, preserve licenses/source references and record the relevant paper/report in each build-ledger entry.

### ML and Claude roles

**ML:** learn numerical relationships, forecast distributions, calibrate probabilities and estimate useful corrections to the market.

**Claude:** extract supported facts from text, preserve source evidence, identify contradictions, and explain recorded predictions. Extraction confidence is not a win probability. Any AI-driven allocation or risk-review contribution must compete against a deterministic baseline separately.

### First implementation delivery

Deliver Stages 1–2 and a narrow Stage 3 experiment first: repaired data, a common dataset with a coverage report, one properly trained candidate evaluated against the market, and the error report/improvement backlog described above. Follow immediately with the complete shadow-serving path; do not let the experiment become another disconnected research tab.

Maintain one build ledger for each slice: problem, files changed, evidence reused, tests, measured result and remaining limitation. Reconcile relevant old findings against current code as the slice begins. Preserve the recovered corpus rather than repeatedly rereading or redoing it.

The immediate next action is Stage 1's code-and-data repair slice. Further broad research is not a prerequisite.

## Data sources, research and GitHub adoption

### What to obtain or improve

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

#### Three source traps the plan must handle

**A previous game is not enough to prove a field was available.** nflverse states that participation data from 2023 onward is delivered after the postseason. Its update schedule also documents the injury-source failure after 2024 and changes to depth-chart timestamps from 2025. Such sources require release-time checks or alternatives for live availability features. [Publisher's update schedule](https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html).

**Historical weather products are not interchangeable.** Open-Meteo's Historical Forecast API stitches the first hours of successive runs into a time series. The Single Runs API exposes a particular initialization, with different coverage dates. Existing `nfl-weather-history.js` preserves previous-day lead values and a lead-0 fallback, but does not establish precise run publication/receipt time. A day-of label must not automatically pass a T−60 eligibility check. Earlier-lead data may be usable if its availability is established; unknown vintages remain reconstructed/diagnostic. [Historical Forecast API](https://open-meteo.com/en/docs/historical-forecast-api), [Single Runs API](https://open-meteo.com/en/docs/single-runs-api).

**Derived metrics can contain a second kind of hindsight.** Historical EPA, win probabilities and published QB ratings can come from models trained or revised later. Pin the upstream model/data vintage; for strict historical experiments use a defensible earlier-trained model or an explicitly labeled reconstruction/sensitivity comparison. Never use future-informed WP or closing-spread fields as early-price features.

The Odds API documents historical snapshots, making it a candidate for filling measured gaps in the archive. Before buying or consuming credits, specify the games, dates, books, markets and horizon required; inspect pricing/timestamp semantics and estimate the resulting unique usable games. More snapshots of the same games improve price reconstruction, not the independent outcome count. [Historical odds documentation](https://the-odds-api.com/historical-odds-data/).

### Put the recovered statistics into the build

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

### What to reuse from GitHub

- **nflverse/nflverse-data:** extend the existing ingestion rather than introducing a competing database. Check each dataset's dictionary and terms.
- **nflreadpy:** official ecosystem Python access wrapper, useful if it simplifies extraction; optional because direct release ingestion already exists. Its Polars-based outputs require an explicit conversion boundary if the training pipeline uses pandas. [Documentation](https://nflreadpy.nflverse.com/).
- **MAPIE:** independent reference for uncertainty calculations. The repository already contains a cross-check; refresh it against the supported version and real held-out residuals before adding a new production dependency. [Repository](https://github.com/scikit-learn-contrib/MAPIE).
- **arch:** reference implementation for SPA, stepwise model comparisons and model confidence sets using common loss panels. Adapt time-block construction to NFL game/week dependence. These methods help assess selection effects; they do not rescue previously exposed holdouts. [Multiple-comparison documentation](https://bashtage.github.io/arch/multiple-comparison/multiple-comparison_examples.html).
- **nfelo:** inspect as a team-rating/market-comparison architecture reference. Recheck repository and data licenses before code reuse; preserve our own chronological fitting rather than importing retrospective predictions as if live. [Repository](https://github.com/greerreNFL/nfelo).
- **Existing sklearn/LightGBM/XGBoost/CatBoost:** use established implementations instead of creating more custom numerical solvers. Start with the small declared comparison in the main plan.

Pin versions/commits and preserve source/license references. Before adoption, test feature and prediction parity on representative fixtures. No repository's claimed betting record establishes performance on our information, prices or future games.

## Overfitting controls and acceptance requirements

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
13. **Treat error-driven additions as another search:** build the error report with the first model, including abstentions and matched baseline errors. Predeclare a small diagnostic group set; record post-hoc groups and every attempted fix. A weakness discovered in inspected games needs confirmation on later untouched games. Require full-pipeline refits and both target-group and overall results. Follow the improvement protocol in Stage 6 of the implementation stages above; noisy subgroup losses and feature importance alone do not establish a cause.

### A newly confirmed audit issue

`server/services/trial-statistics.js` describes Holm as assuming independent trials. This is incorrect: Holm's family-wise control does not require independence when the underlying p-values are valid. [R statistical documentation](https://stat.ethz.ch/R-manual/R-devel/library/stats/html/p.adjust.html).

The code also derives an effective number of trials using an MCMC autocorrelation estimator. `scripts/run-purged-evaluation.mjs` feeds it a chronological sequence mixing ROI, probability errors and point errors after mostly sign/centering changes. Those values are not genuinely standardized to comparable units, and this does not establish the dependence among competing forecasts on the same games. It then supplies that effective count to DSR.

**Plan decision:** retain those historical outputs as diagnostics, but do not use the discounted trial count or reconstructed returns to justify promotion. First obtain aligned per-game/per-week predictions, losses and actual-price returns. Validate statistical calculations against reference implementations, and use a conservative declared-family correction until a better justified dependence-aware procedure is ready. DSR/PBO remain supporting diagnostics with assumptions and incomplete-trial-history limits stated.

### Acceptance criteria

- Every new source has a reason to exist, timing contract, identity mapping, coverage report and incremental-value test.
- Every adopted research method names its paper/report, implementation, assumptions and verification.
- Every forecast has a reproducible upstream training and feature chain.
- Every performance claim states its candidate search, data exposure, baseline, eligible sample and uncertainty.
- Engineering completion and improved prediction are reported separately from profitable execution.
- The first model ships with an error report and improvement backlog. Each proposed addition names its observed weakness, baseline comparison, hypothesis, research/code reference, smallest fix and later confirmation period; reject/inconclusive outcomes are retained.

These are concrete additions to Stages 1–5. Broad new research, expensive feeds, copulas, or deeper networks are not prerequisites for starting the repaired learning pipeline.

## Weekly training, news backfill and Claude execution instructions

This section turns the architecture into ordered work. Execute the steps in order, reconciling completed work first. Do not start another broad research sweep. The source files named below are repository-relative locations to inspect or extend; proposed modules and commands do not exist merely because they are specified here.

### Fresh inspection: what changed and what remains

A later September 14 inspection found repository HEAD `21789a9`, with uncommitted edits in the shared dataset builder, both labs, their tests and governance documents. Recent commits address season defaults, baseline preservation, quarantine, freshness reporting and gate ownership. Another commit is titled “Wire the overfitting/deflated-Sharpe correction into a real promotion gate”; inspect the resulting authority path and assumptions rather than assuming the earlier audit describes its current state. Preserve work in progress. No implementation or live-database verification was performed by this planning pass.

| Current inspected behavior | Action required |
|---|---|
| `research/betting/nfl/dataset.py` now shares chronology and quote-pair extraction; `tree_lab.py` and `market_lab.py` call it | Extend this common builder and its consumer-parity tests; do not recreate two independent extractors. The edited code is not certified by this read-only inspection. |
| `build_football_dataset` is present with 1999+ defaults and optional PBP | Verify its actual output and consumers. It uses `gameday` as a decision instant and also exports market fields: distinguish date-only records from actual kickoff timestamps, and exclude unqualified market columns from training features. |
| The shared chronology uses a three-day publication proxy and a seven-day settled-label lag | Preserve them as explicitly modeled historical assumptions until source-specific clocks are available. They do not prove real publication times. Separate label availability from corrected-feature availability; compare conservative versions without selecting whichever produces the best profit. |
| The existing betting builder still pairs Pinnacle opening and closing quotes, defaulting to 2022–2025 | Add a separate exact T−60 builder. A missing close must not remove an otherwise valid outcome-training example; it only prevents CLV/movement evaluation. |
| Main tree-lab branches fit on earlier seasons and score a whole later season; inner folds keep weeks together | Preserve as historical comparators. Add weekly refitting that matches the intended deployment cadence. It must incorporate newly settled eligible games without tuning on the scored week. |
| The tree lab measures movement MAE, conditional non-push classification log loss/Brier, quantiles and paper returns | These are useful, different targets. Add explicit push probabilities and price-based EV to the serving evaluator; movement error is not game-outcome accuracy. |
| `nfl-news-events.js` extracts typed claims with exact evidence spans and a content cache, but takes recent relative-day windows and stamps extraction time as `first_seen_time` | Add absolute date-range backfill and separate source receipt from extraction time. Never backdate extraction to an old article date. |
| `nfl-advanced.js::syncInjuries` writes current player-week rows and attempts revision capture | Reuse it, verify actual revision coverage and as-of reads. Importing a final weekly CSV today cannot recover every earlier daily report version. |
| News and press extraction can consult current player/team identity; press discovery uses recent channel feeds | Resolve players against historical rosters/transactions. Add archive discovery for old documents; a recent feed is not a season archive. |
| `nfl-news-event-impact.js` selects the fastest next quote pair and predicts absolute implied-probability movement | Retain as a limited historical diagnostic. It is not a directional game predictor. Review contract matching when handicaps change, event grouping, time windows and price-only controls before reuse. |

### Step 1 — reconcile the repository and create one execution ledger

Read this master plan, relevant `AGENTS.md` instructions, `docs/CLAUDE-NEXT-STEPS.md`, the current work log, and the recovered research index. Inspect current git status and commits before editing. Do not reset, overwrite or duplicate someone else's in-progress work. Recheck each relevant earlier defect against the current source and a read-only database snapshot.

Create one ledger row per work package: existing implementation, remaining task, files, research references, tests, output artifact, state and limitation. Use states such as planned, implemented, verified, connected, observed and qualified; a passing test is not evidence of betting profit. Carry forward the specialist, QBR, freshness, gate, calibration and audit-math findings without falsely calling fixed items open.

**Return:** a short reconciled status and the next uncompleted slice. Continue with that slice; do not stop after restating the plan.

### Step 2 — define training examples and clocks

Extend `research/betting/nfl/dataset.py`, the existing feature contract, and their tests. Keep three related datasets:

- **Football:** one game/cutoff example with legal prior football information; labels are home margin and total points. Use broad history without requiring archived opening or closing prices.
- **Player availability/usage:** one player/game/cutoff example. Labels distinguish game-day active status from actual participation and usage. An active player taking zero snaps is not automatically injured. Actual snaps or starters can be labels after the game, never inputs for that same earlier prediction.
- **Betting:** game, cutoff, exact market/period/handicap/side/book and offered odds. Use T−60 first. Signed home spread residual is actual home margin plus home handicap; total residual is actual total minus offered total. Preserve win/push/loss outcomes. Attach closing prices later as optional labels.

Every row needs canonical game/player IDs, season type, UTC kickoff and timestamp precision, cutoff, source IDs/versions, feature values and missingness, provenance mode, training/label availability, and immutable dataset identity. Keep labels, future quotes and retrospective metadata outside a strictly allowlisted feature matrix. Multiple books, players, snapshots and plays do not create independent game outcomes.

For each source distinguish: event/practice time, source publication/update time, independently evidenced availability bound, actual local receipt time, extraction completion time, and later revision time. Date-only evidence is an interval, not midnight masquerading as precise publication. If the conservative upper bound does not precede the cutoff, exclude it from that strict example.

**Pass:** future rows cannot change an earlier vector; no final-score/closing-price column can enter the feature matrix; date-only schedule rows cannot qualify as precise T−60 packets; missing odds/news do not delete football examples.

### Step 3 — inventory history and run a bounded backfill pilot

Produce coverage by source, team, season, week and cutoff using the existing freshness audit. Start from stored `news_items`, `press_conferences`, `press_availability`, `nfl_news_events`, `nfl_news_signals`, `nfl_injuries`, feature revisions, roster history and quote tape. Count usable documents and game coverage rather than just rows.

Use **2024 regular-season Weeks 1–4, all teams**, as the initial engineering pilot. This choice tests archive retrieval and chronology; it is development data, not a performance holdout. Exercise Thursday, Sunday and Monday/other kickoff times. Include uneventful games, rather than selecting only famous injuries or losing bets. Then expand sequentially across 2022–2024 where sources support it; assess 2025 separately because injury coverage differs. Broad football backfill can extend further independently.

Source order:

1. Existing locally preserved source versions and live capture logs.
2. nflverse structured injury, roster, player and snap data, after field/timing checks. `date_modified` documents an update, not a complete history of changes. The publisher documents an injury-feed gap after 2024. [Injury dictionary](https://nflreadr.nflverse.com/articles/dictionary_injuries.html), [availability schedule](https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html).
3. Official team article archives/sitemaps, dated injury reports, transactions, inactives and media transcripts. A verified example is the [Eagles September 2024 archive](https://www.philadelphiaeagles.com/sitemap/html/articles/2024/9), which lists pregame reports separately from recaps. Generalize adapters only after testing each site.
4. Existing reputable reporter/news sources for missing details, with duplicate and provenance checks. Use accessible historical snapshots where available; inspect their actual capture time and content version. Search snippets alone cannot establish an eligible claim.
5. Written official transcripts before video transcription. Test dated video archives if transcripts are missing, retain transcript offsets and source identity, and review player-name/status extraction errors. Current channel feeds alone cannot backfill old seasons.

The pilot must report retrieval success, usable timestamp/version coverage, revision loss, duplicate rate, identity failures, extraction quality, dollars/tokens per accepted document, and projected season cost. Use a manifest of absolute date ranges and resume cursors. Cache downloads by source/content version and extraction by content, prompt, model, parser and historical identity-map version. Do not repeatedly send unchanged articles to an LLM.

**Pass:** a reviewable pilot archive and coverage report, with explicit unavailable records. No guarantee of complete 1999+ news history; sparse text history must not block the first football model.

### Step 4 — preserve source documents and extract supported events

Extend the existing news-event and bitemporal schemas rather than adding an unrelated news database. Store an immutable source document/version, its full timing metadata, content hash, retrieval status and source URL. Keep claim records tied to that exact version. Preserve contradictions and superseding events instead of overwriting Wednesday with Friday.

Parse structured injury tables with deterministic code. Use Claude only for text that needs interpretation: named player/team, practice participation, injury designation/body part as stated, expected role change, return/transaction, quote speaker and exact supporting span. Supply historical identity candidates and the document text. Require `unknown` for unsupported claims. Do not ask Claude what happened in the historical game, to infer a diagnosis/recovery duration, or to assign a point spread from prose. Extraction confidence is neither probability of playing nor probability of winning.

Keep these provenance classes separate:

- **Captured:** the source version was received and its features were ready before the actual decision. Preserve the then-used extractor/artifact. Reprocessing an old captured text with a new extractor creates a retrospective experiment, not the originally served result.
- **Archived reconstruction:** there is evidence this exact source version existed by the historical cutoff, but our new pipeline processed it later. Suitable for explicitly labeled retrospective model development; not evidence of actual historical capture, execution or low latency.
- **Uncertain reconstruction:** only a current page, final weekly row or ambiguous date/version survives. Use only for clearly labeled sensitivity/auxiliary work where timing permits; exclude from strict decision-time performance claims.
- **Post-cutoff:** available only later. Keep as later labels/context, never earlier features.

A modern LLM can know historical outcomes. Restrict historical use to span-supported extraction, keep irrelevant recap/sidebar content out of the prompt, and validate on prospective text as well. Masking dates alone does not prove absence of model memory.

**Pass:** annotated tests cover multiple players, pronouns, negation, vague quotes, historical trades, duplicated syndication, late corrections, revised pages and postgame content. A source being official does not eliminate typos or extraction mistakes.

### Step 5 — build each week's information timeline

Create one shared as-of reducer over source events, used by both Python extraction and the frozen serving packet. Reuse current `playerNewsSignal`, `teamNewsSignals` and event/revision contracts only after fixing their timing and historical identity limitations. Avoid separate historical and live business logic that silently diverges.

For each upcoming game, reconstruct changes leading up to its actual kickoff. Use a bounded recent-news window plus carried-forward unresolved states such as injured reserve; stale snippets expire, but unresolved long-term statuses need explicit resolution rather than a blind 14-day reset.

Initial snapshots are **T−72 hours, T−24 hours and T−60 minutes**. T−60 is the primary betting experiment; earlier snapshots support diagnostics and later separately declared experiments. They are alternative views of one game, not three independent tests. Do not force a Friday/Sunday template onto short weeks, international games or Monday fixtures. Retraining schedule and snapshot schedule are distinct.

Illustrative synthetic timeline:

| Source update | What a later eligible snapshot can contain |
|---|---|
| Wednesday: player did not practice | DNP, stated injury, time since update; playing status still unresolved |
| Thursday: coach says player will be evaluated | Supported uncertainty; no invented “70% active” |
| Friday: official questionable designation | Latest designation and practice trajectory; prior claims retained |
| Game day: player listed inactive before T−60 | Inactive status at T−60, if the report met that mode's timing rules |
| After kickoff: recap says replacement excelled | Outcome/usage label only; never an earlier input |

Real official pages show why versions matter: the [Eagles Week 1 report](https://www.philadelphiaeagles.com/news/packers-vs-eagles-injury-report-week-1-2024) includes several days' reporting, while [Packers game-day inactives](https://www.packers.com/news/inactives-packers-eagles-week-1-2024) provide later availability. A final page containing Wednesday text cannot establish that its Friday information was available Wednesday.

Emit compact numerical/categorical features: practice trajectory, stated designation, known active/inactive state, learned active probability where unresolved, expected usage, role uncertainty, last update age, source conflict, replacement quality from earlier games, and coverage indicators. Missing collection is **unknown**, not healthy. No-report is meaningful only when a complete expected official report was actually observed. Syndicated copies do not increase confidence as independent reports.

**Pass:** advancing the replay clock changes only events newly eligible at that time; later updates cannot alter saved earlier packets; persistent statuses, byes and rescheduled games behave explicitly.

### Step 6 — learn how availability and news matter

Start with a regularized availability model using structured reports and lagged usage; add span-supported text features as a registered comparison. Predict active/inactive separately from expected snaps/touches conditional on availability. Treat exits during the game and coaching non-use explicitly when evaluating usage rather than teaching that every low-snap game was a predicted injury absence.

Turn those earlier-only estimates into small game-level features: expected QB contribution, expected lost usage by position group, likely replacement strength and uncertainty. A possible initial aggregation is the sum of expected unavailable usage times an earlier-estimated player-to-replacement difference, with units and assumptions stated. Fit its downstream value against outcomes; do not install fixed universal “QB out = X points” adjustments or call observational associations causal injury effects.

Every upstream player model must produce chronological out-of-fold predictions for downstream game-model training. Training a player model on the whole dataset and then joining its historical outputs would leak, even if the final game split were chronological.

Compare on identical eligible games:

1. Market baseline and football baseline.
2. Football plus structured availability.
3. The same system plus text/quote features.

Compare both standalone football improvement and incremental value after conditioning on the contemporaneous market. News can be useful football information already fully reflected in the price. Start with the first two systems; do not let scarce text delay a working model.

**Pass:** predictions trace to source events and earlier upstream fits; text's added benefit is measured separately; weak or absent benefit yields an explicit inconclusive/reject verdict.

### Step 7 — implement weekly training and historical replay

Add a weekly replay entry point under `research/betting/nfl/`, reusing existing lab estimators, dataset code and probability contracts. Preserve current whole-season lab outputs as comparisons. Expose explicit season/week bounds, fit time, cutoff policy, provenance mode, dataset ID, seed and candidate configuration; commands must be implemented and exercised before documenting them as runnable.

Initial deployment policy: fit the candidate **Wednesday at 12:00 America/New_York**, using only labels and source versions available then. Store the timezone-aware UTC instant for each fit. Keep model parameters fixed through the following Tuesday; refresh legal news/quotes at each game cutoff. A game before a scheduled fit uses the previous eligible artifact. If collection or fitting fails, preserve the last eligible model and record freshness rather than fabricating a successful update. This is a declared starting schedule, not an optimized claim.

Replay this same policy historically. For each fit origin:

1. Build an immutable eligible training manifest. Exclude unsettled labels. Use prior-season and already available current-season games; do not impose an entire-season lockout on weekly learning.
2. Generate earlier-only upstream football/player predictions and preprocessing within inner chronological folds.
3. Fit the small preregistered ridge/LightGBM comparison. Select settings only on inner folds. Estimate calibration and ensemble weights from earlier held-out predictions, never fitted values.
4. Save the chosen model, preprocessing, feature schema, training cutoff, calibrator and hashes.
5. At each game's cutoff, reduce the eligible event timeline, join its quote, score once and freeze predictions for every eligible game including abstentions.
6. Append outcomes when available; append closing quotes separately. Refresh the next fit using the declared policy. Do not alter earlier predictions after settlement.

Weekly refitting of a fixed recipe is allowed; changing the feature set, search budget or selection rule starts a new experimental version. The full adaptive recipe is what the evaluation measures. Old repeatedly inspected years remain development data.

### Step 8 — measure the right things in separate reports

| Layer | Required report |
|---|---|
| Sources/extraction | Eligible coverage, timing/version failures, freshness, duplicate rate, historical identity errors, sampled claim precision/recall, conflicts and unknowns |
| Player availability/usage | Active-status Brier/log loss and calibration; usage error with clearly defined labels, subgroup sizes and unresolved cases |
| Football predictions | Paired MAE/RMSE versus simple baseline; signed bias; distribution scores where available; season/era and diagnostic-group results |
| Betting probabilities | Log loss/Brier on a stated outcome space; calibration; key-margin/push behavior at the actual offered handicap |
| Prices/execution | Offered odds and quote age, EV, attainable-paper-bet accounting, stake-weighted ROI, uncertainty and drawdown; CLV as a separate aligned-price metric |
| News contribution | Full-pipeline comparisons with/without structured injury and text features, both before and after adding the market |

If a binary classifier excludes pushes, its estimate is conditional on a non-push. Preserve it as such. To price a bet, use unconditional probabilities: `EV per unit risked = P(win) × profit_if_win − P(loss)`, with pushes returning stake. Estimate push mass from earlier data or a validated discrete distribution; do not use a generic probability disagreement threshold as a substitute for positive EV after vig.

Report unique games, weeks, bets, prices, exclusions and coverage for every comparison. Compare paired losses on the same games with week/block uncertainty and sensitivity to cross-week dependence. Label small groups inconclusive. Do not turn game snapshots, books or multiple players into inflated sample counts. Keep probability edge distinct from realized closing-line movement.

### Step 9 — treat news-to-market movement as its own later experiment

Review `nfl-news-event-impact.js`, its runner and tests. The inspected target is absolute next-quote probability movement; neither direction nor a fixed horizon is established by that target. Group all claims for the same game/week together in evaluation so duplicate stories cannot land in both train and test.

If quote coverage supports the experiment, predeclare reaction horizons and tolerances, maximum stale-before quote age, and the reference book/contract. Join each event to the intended game, rather than any future fixture involving that team. Use only information available at the event cutoff. Require actual local receipt/extraction clocks for latency claims; retrospective publication-based results are a different experiment.

Compare price-only/no-move, structured event, and combined models. Measure line movement and price movement separately: implied probabilities at different handicaps are not probabilities of the same event. Use matched-handicap prices or explicitly model the handicap change. Keep no-reaction/stale/missing cases in the coverage report rather than selecting only fast-moving quotes. Record overlapping news events and do not interpret correlation as the causal effect of one article.

### Step 10 — verify integrity, connect serving and choose improvements

Run targeted checks on the new pipeline: future-data mutation, extraction/revision clocks, historical player identity, exact market/price matching, duplicate events, game-grouped splits, upstream out-of-fold fits, missing sources, push settlement, interrupted/resumed backfill, and training/serving numerical parity. Reuse relevant repository tests; do not run live collectors or mutate live databases merely to import a module for a check.

Use the master plan's error report to decide the next experiment. A weak subgroup nominates a hypothesis; it does not justify a model automatically. Test the smallest fix, refit both full systems, retain failed attempts, and confirm on later uninspected games. Do not silently change gates to force a positive result.

Connect the trained Python artifact to the frozen T−60 runner, decision trace, settlement and error report. Produce a complete shadow game/slate demonstration using identical saved inputs. Keep learning, engineering integrity and betting authority distinct. No automatic stake increase accompanies a successful implementation.

### First work package Claude should deliver

Deliver Steps 1–5 as a narrow, verified slice: reconciled current status; shared dataset/time contracts; pilot source manifest; versioned claim extraction; and replayable player/game timelines. Develop the basic football model independently where news is missing. Then deliver the weekly baseline and structured-injury comparison from Steps 6–8, followed by shadow integration. Text impact and market-reaction models earn later priority through evidence.

For each slice return changed files, commands actually run, test results, dataset/source coverage, example frozen records, measurements where available, and remaining limitations. Save the runnable command/configuration manifest in the repository alongside the evidence. Finish the authorized slice before proposing more research. If source history is unavailable, name the gap, retain unknown values and continue the parts that do not depend on it.

## Expanded engineering specification, dependencies and effort

This expansion defines the implementation work behind the six stages and ten execution steps. It adds depth to the betting pipeline, measurement and football modeling; it does not authorize every experimental architecture to enter the first model. The master plan remains the source of truth. Work-package IDs below are implementation units, not separate agents or automatic task launches.

### Size of the project and estimating assumptions

This is a data-engineering, applied-statistics and model-serving project inside an existing application. Training a tree is a small part of it. Reconstructing legitimate historical inputs, joining player and quote identities, reproducing weekly learning, validating measurements and connecting the result to actual decisions account for much of the work.

The following are **rough planning estimates in engineer-days**, not measured task durations, a fixed quote, or an estimate of unattended AI runtime. One engineer-day means a focused working day including review and relevant verification. Existing fixes may shorten work after reconciliation; missing source history may lengthen it or make particular experiments impossible.

| Workstream | Estimated effort | Main uncertainty |
|---|---:|---|
| Current-state reconciliation, defects and statistical contracts | 5–9 days | Which fixes already work in the active checkout and populated database |
| Historical data, identity, clocks and extraction contracts | 8–15 days | Actual source completeness and historical version quality |
| News/injury pilot, extraction, timelines and availability features | 8–16 days | Recoverable reports, historical identity and text extraction accuracy |
| Weekly training, calibration and fair comparisons | 8–15 days | Existing lab reuse, sample sizes and upstream chronology |
| Serving, frozen decisions, settlement and operational verification | 7–14 days | Existing runner integration and migration/restart behavior |
| Error analysis, adversarial checks and final integration review | 5–9 days | Defects discovered by full-pipeline exercises |
| **Core implementation estimate** | **41–78 days** | Re-estimate after the first end-to-end pilot |

For one experienced engineer this is roughly **8–16 working weeks** for the core scope, subject to these assumptions. A useful initial baseline and frozen shadow path is a smaller milestone, provisionally **15–30 engineer-days** within that total. The estimates overlap in dependencies but must not be added twice. AI assistance may accelerate implementation; it does not eliminate data validation, review or waiting for future games. No staffing or external spending is committed by this estimate.

A broader follow-on with validated player/drive/distribution models could require another **20–50 engineer-days**, conditional on what the error report shows. Graph networks, transformers and foundation models are not included in that range without a specific experiment design. Do not interpret this as a commitment to build them.

**Evidence time is separate:** historical development tests can run once data and code are ready. Prospective performance accumulates only as eligible games occur. Engineering completion cannot establish a durable betting edge; the time needed depends on effect size, uncertainty and bet frequency and may exceed a season. Estimate data-fetch, LLM and compute costs from the pilot, not from invented prices or an assumed complete archive.

### Milestones and the critical path

| Milestone | Required result | Dependencies |
|---|---|---|
| M0: trustworthy status | One reconciled defect/implementation ledger and frozen baseline | WP01–WP02 |
| M1: replayable examples | A historical week can be rebuilt with source lineage and honest cutoffs | WP03–WP07 |
| M2: first learned comparison | Baseline plus one restrained tree family, chronological predictions and error report | M1, WP11–WP14 |
| M3: complete shadow path | Frozen input → actual trained artifact → decision trace → later settlement | M2, WP15–WP17 |
| M4: news earns or fails its place | Structured availability and text contributions measured separately | WP08–WP10, M2 |
| M5: maintainable weekly operation | Repeatable updates, restart recovery, versioned evaluation and prioritized improvements | M3–M4, WP18–WP20 |

M1–M3 must be able to proceed with explicit missing-news features. News ingestion and extraction can progress independently after the source contracts are settled. New deep models must not delay getting one verifiable prediction through the complete path.

Within each milestone start with one complete example, then a representative fixture set, then the bounded real pilot, then larger history. Do not spend the entire budget building warehouse tables before testing their consumption by a learner and a serving packet.

### WP01 — reconcile current work and preserve the baseline

**Inspect:** git status/log, the repository work log, `docs/CLAUDE-NEXT-STEPS.md`, baseline evidence and the current gate-ownership/freshness reports. Treat comments and commit messages as pointers to inspect, not proof that an issue is fixed.

**Implement:** a machine-readable work ledger with work-package ID, source commit, dirty-file hashes where applicable, task state, evidence paths, dependencies and open limitations. Preserve incumbent predictions, exact configs, data identities and results. Record a distinction between the current working checkout and the version actually running in the app.

**Verify:** recreate at least one saved baseline calculation from its evidence. Where old runs lack reconstructable inputs, retain the limitation rather than manufacturing a new baseline with today's data.

**Exit:** every relevant original finding is classified confirmed-open, already-fixed-with-evidence, partially-fixed, superseded or unverified. A reviewer can identify the next unfinished package without rereading the entire audit corpus.

### WP02 — repair numerical defects and define gate responsibilities

Recheck specialist row/weight dimensions, QBR season identity, current feature updates, calibrator identities and the statistical promotion path. Add regression tests for actual failure mechanisms, including realistic row/feature shapes and data versions; a finite array alone is not enough if predictions or gradients remain wrong.

Define one owner and one recorded reason for each check:

| Check class | Permitted effect |
|---|---|
| Source/schema/time invalid | Exclude the invalid input or example; disclose coverage loss and the fallback behavior |
| Optional source missing | Mark missingness/age and apply a trained or declared fallback |
| Candidate output invalid | Suppress that candidate's invalid output and record the failure |
| Evidence insufficient for money | Continue legitimate shadow predictions; withhold betting authority |
| Price/execution/exposure invalid | Abstain from that action; retain the underlying prediction for measurement |

Audit effective-trial adjustments and DSR/PBO inputs against appropriate references. A newer promotion integration does not fix an invalid statistical assumption automatically. Preserve legitimate data/execution controls when replacing per-component significance filters. Do not make the model appear better by excluding its bad predictions after seeing outcomes.

**Exit:** each stage records input count, rejected count/reason, output identity and fallback. A test demonstrates that insufficient betting evidence does not erase otherwise valid candidate forecasts from the research ledger.

### WP03 — canonical game, player and source identities

Create shared mapping contracts for canonical games, season type, relocated/renamed teams, neutral venues, rescheduled kickoffs, players, roster intervals, books and provider event IDs. Retain both the source identity and normalized identity. Resolve players using the roster/transaction interval valid at the event, not their current employer.

Handle exact-match confidence, ambiguous names, missing IDs and corrections explicitly. A player-week key alone is insufficient for every roster event, postseason case or source revision. Link injury/quote evidence to the specific target game. A future fixture for the same team must not accidentally become the event-study target.

**Exit:** fixtures cover a trade, duplicate player surname, changed team abbreviation, neutral venue, reschedule, bye and postseason week. Unresolved identities remain quarantined with raw evidence intact.

### WP04 — immutable source and dataset contracts

Use existing tables where their contracts are sound. The following are **logical records**, not instructions to create a second database with duplicate tables:

| Record | Minimum contents |
|---|---|
| Source document version | Source/URL, retrieval ID, content hash, raw or reproducibly retained content, publication/version bounds, receipt time, parser version and provenance class |
| Structured event | Source version, canonical entity, event type, supported value, evidence span/offset, historical roster version, event/publication/receipt/extraction clocks, supersedes/conflict references |
| Feature snapshot | Game/cutoff, schema ID, feature names/order/values, missingness/age, source-event references, extractor/transform identities, provenance mode |
| Training manifest | Eligible row IDs, label availability, split identities, source/schema/code hashes, random seeds, exclusion summary and configuration |
| Model artifact | Algorithm/settings, preprocessing, feature contract, fitted state, train-through instant, upstream model IDs, calibrator/combiner IDs and content hash |
| Prediction/decision | Snapshot/artifact IDs, numerical outputs, market quote and exact contract, policy/version, gate trace, timestamp, action/abstention and idempotency key |
| Outcome record | Game result, settlement rule/version, actual contract return, closing reference where available, append-only corrections and grading time |

Separate facts about historical public availability from facts about what this app actually received and processed. A later reconstruction is a valid research record with a different claim; never relabel it as actual prior capture.

**Exit:** changing a mutable upstream table after a snapshot is frozen cannot change its replayed output. A material source correction generates a new version and a new experiment identity rather than overwriting prior evidence.

### WP05 — source availability and coverage qualification

For each source write an admission specification: useful target, earliest/latest reliable period, publication semantics, units, identity fields, revisions, missingness, legal deployment availability, terms/source reference and expected refresh behavior. Use the publisher schedule as a starting point and actual records as evidence.

Maintain a coverage matrix by era and horizon. Expose the difference between “available in today's download,” “publicly available then,” and “captured by us then.” Old football seasons need not contain every modern field. Version each feature family’s availability rather than pretending the 1999 and 2024 rows have identical information.

**Exit:** the dataset report states games retained before/after each join and reveals concentration by team, season, source and horizon. Adding an optional field cannot silently turn the dataset into complete cases only.

### WP06 — common football feature pipeline

Extend the current shared dataset builder. Start with lagged scoring/efficiency, pace, opponent strength, rest/travel, venue and prior player usage. Define orientation once: home-minus-away for relative quantities, clear units for efficiency/pace and explicit season/era handling. Audit roof/weather fields for what was expected before kickoff rather than realized afterward.

For learned strength features implement offseason carryover, league/team/QB pooling and uncertainty about limited samples. Fit pooling and recency choices within inner earlier folds. Include a simple benchmark that uses longer historical information and a stated recent window; evaluate old-data usefulness rather than assuming all 25 years help equally.

Do not join closing-market summaries, actual future starters, full-season statistics or later-fitted ratings into an earlier feature row. Derived EPA/WP values need upstream model-vintage review. Preserve missingness and the number/age of prior observations.

**Exit:** a feature dictionary explains every first-model input, its time rule, training dependencies and valid range. Future-game mutation and home/away sign tests exercise the entire builder.

### WP07 — price-qualified examples and execution assumptions

Separate broad football training from exact-horizon betting extraction. Preserve the existing open/close experiments, but construct T−60 rows from an actual eligible offered quote. Missing close affects CLV coverage, not outcome-label eligibility. Retain exact period, market, side, handicap, odds, book, provider timestamps and local receipt.

Define book selection before evaluation: which books are considered accessible, how stale quotes are handled, how contemporaneous opposite sides are paired, and how ties are resolved. Best-price comparisons must use prices observable at that instant, not the best later snapshot. If historical data cannot demonstrate a fill, report an attainable-price assumption and a conservative sensitivity scenario, not an actual trade.

**Exit:** a saved quote reproduces payout and settlement on positive/negative American odds, integer pushes and both sides. Price movement and handicap movement remain separately labeled. Correlated books do not multiply the sample count.

### WP08 — news archive pilot and source adapters

Follow the weekly pilot protocol in the preceding section. Implement bounded date/team/source jobs with resume cursors, content caching, duplicate clustering and an explicit output manifest. Prioritize existing storage and structured reports, then official archived text, then available transcripts. Do not make a full-season LLM sweep the first action.

Build a reviewed extraction set of approximately 100–200 source passages from the pilot, spanning relevant claim types, ambiguous cases, multiple teams and uneventful reports. Separate examples used to revise the extractor from examples used to evaluate it. Measure errors by class and by player identity; do not hide a dangerous entity mistake behind high overall accuracy. These sample sizes are an engineering starting point, not a statistical guarantee.

**Exit:** source fetch/extraction can resume without duplicate claims or repeat billing for unchanged inputs, and its coverage/cost estimate supports a bounded expansion decision.

### WP09 — claim extraction, revisions and historical state

Extend typed extraction and evidence-span validation. Keep stated fact, source verification, extraction confidence and downstream playing probability separate. Correctly handle “not ruled out,” “did not practice,” estimated walkthrough participation, personal absence, rest, suspension and roster transactions. Neither an inactive designation nor zero snaps automatically establishes a medical cause.

Require deterministic historical identity resolution and exact supporting spans. Preserve source contradictions as features/uncertainty until resolved by later eligible evidence. Do not treat a repeated headline as independent corroboration. Support late-arriving reports without altering previously frozen decisions.

**Exit:** an annotated timeline demonstrates before/after states for at least a normal report progression, a same-day reversal, a long-term status and an ambiguous coach quote. The system can display exactly why a given cutoff has a given state.

### WP10 — availability, expected usage and replacement features

Build a player-game target dictionary before fitting. Distinguish active status, dressed but unused, expected offensive/defensive/special-teams participation, and realized postgame usage. Specify handling for unobserved labels, limited prior history and injuries occurring during the target game.

Fit a small regularized availability model; use pooled position/team priors when player-level samples are sparse. Estimate conditional usage and replacement strength using earlier observations. Propagate uncertainty to game features instead of replacing an unresolved player with a hard-coded point penalty.

Aggregate a manageable feature set: QB expectation, expected missing usage by position group, replacement quality, continuity/rotation uncertainty and missing-source indicators. More complex interaction networks can be proposed later when a documented error pattern survives simpler modeling.

**Exit:** downstream training consumes earlier out-of-fold upstream predictions. Structured-injury and text additions have separate ablations on the same games, including the market-conditioned comparison.

### WP11 — experiment configuration and capacity budget

Use one versioned experiment configuration. At minimum it specifies training target, decision horizon, provenance mode, allowed sources/features, fit schedule, data interval, inner/outer folds, candidates, seeds, primary metric, calibration method, betting policy, review schedule and output location.

A concrete starting search budget is three declared ridge regularization settings and three shallow LightGBM settings per primary target; choose exact values before inspecting comparative outcomes. This is a bounded engineering choice, not an optimal set proved by the research. Track separate targets, horizons, feature additions and calibrator variants in the experiment family. Record every attempted fit, including exceptions and rejected candidates.

Report games, weeks, class balance, time-weighted sample size and tree/feature complexity. Observation-to-parameter ratios and nominal week counts are diagnostics with limitations, not a universal theorem determining validity. Prefer regularization and measurable learning curves to arbitrary feature-by-feature profitability gates.

**Exit:** another run with the same manifest reproduces the fold membership, chosen candidate and predictions to declared numeric tolerances. Failed fits remain in the output.

### WP12 — nested weekly training and honest stacking

Implement the declared weekly fitting policy, using labels available at the fit instant. All learned transforms belong inside the fitting boundary: imputation, normalization, feature selection, strength ratings, availability models, ensemble weights, early stopping and calibration.

Use chronological inner folds for configuration decisions and outer weekly origins for assessment. Prevent the same game and its player/book/cutoff rows from straddling fitting and scoring partitions. Maintain explicit training row IDs for every upstream artifact; inspecting only the final model's cutoff is insufficient.

Compute learning curves over a small prespecified set of training spans to diagnose whether the first learner is data-limited, overfit or insensitive to extra history. These are tracked comparisons, not an unlimited search for a profitable start year. Report computation time and sample coverage.

**Exit:** an automated lineage check can trace one game prediction through every upstream fit and prove its result label did not enter any of them.

### WP13 — probability, push and uncertainty contracts

Return expected margin/total together with probabilities appropriate to the exact quoted contract. Define win, push and loss probabilities that sum to one and remain in bounds. Distinguish probability conditional on a non-push from unconditional probability used for EV. Preserve key-margin behavior in the simplest candidate distribution before trying advanced joint models.

Fit calibration on earlier held-out predictions. Score calibration, log loss/Brier, interval coverage/width and distribution coherence separately. Use the recovered conformal code and MAPIE comparisons to check mathematics, while measuring chronological coverage under time dependence and shift. A nominal interval is not a promise of game-by-game coverage or calibrated betting probabilities.

**Exit:** a known handicap change produces a coherent new probability from the stored distribution or an explicit unsupported-contract result. The app cannot reuse a probability for a different line simply because the team and game match.

### WP14 — evaluation engine and error report

Write prediction rows before aggregation. Every report must be reproducible from those rows and a versioned metric definition. Compare market, incumbent, simple football and candidate on identical eligible game sets; separately report the candidate's full coverage so common-set filtering cannot conceal failures.

Use paired loss differences, uncertainty that respects game/week dependence, season/era summaries and the prespecified diagnostic groups. Show bias as well as average error. Avoid discovery through hundreds of small slices without recording the search. Distinguish performance degradation from a source/route failure.

**Exit:** the report can answer: what changed, on which games, versus which baseline, by how much, with what uncertainty, using which prices, and whether the evidence was retrospective or captured prospectively. It can also return “inconclusive.”

### WP15 — artifact scoring and frozen prediction packets

Package the actual fitted Python preprocessing/model/calibration pipeline. Use a narrow, versioned scoring interface to Node. Validate schema, feature order, artifact hash, model age, finite outputs and probability coherence. Initially use one implementation for training and scoring; a second-language port needs numerical parity evidence.

Freeze all inputs and upstream model IDs, not just quotes. Include the valid candidate forecast even if betting is withheld. Record fallback identity and cause. A research report reader is not a model-serving interface.

**Exit:** after mutable tables change and the service restarts, the same frozen packet/model produces the same prediction within stated tolerance. Corrupt/incompatible artifacts fail explicitly with a recorded fallback or abstention.

### WP16 — decision policy and exposure accounting

Build one versioned policy that converts valid probabilities and offered odds into expected value and a recorded action. Preserve stake-return conventions, pushes, minimum usable price quality, freshness and exposure rules. Continue shadow-only operation until evidence supports a separately reviewed change in betting authority.

Treat correlated positions as related exposure: two books offering the same side are not independent opportunities, and opposing bets at different lines do not cancel automatically. Record any allocation logic and compare it against a deterministic baseline. Advanced copulas are not required to prevent obvious duplicate exposure.

**Exit:** both accepted and abstained decisions carry an explanation that can be regenerated from saved numbers and the policy version. A persuasive LLM explanation cannot change the numerical decision silently.

### WP17 — settlement, CLV and record corrections

Separate final-score settlement from closing-reference grading. Define how postponed/cancelled games, voids, pushes and result corrections are handled. Store corrections as new records with links to the original; never rewrite a historical prediction or apparent bet after the outcome.

For CLV specify a reference-book set, cutoff convention, missing-price treatment and whether the metric compares handicap points or prices at the same contract. Report it separately from realized returns; both arise from the same wagers and are not independent replications of an edge.

**Exit:** an independent fixture grader reproduces wins/losses/pushes, profit, total risked and ROI. Aggregate metrics reconcile to the row ledger, including abstentions, voids and missing closes.

### WP18 — operational reliability and resource accounting

Add idempotent jobs and an observable lifecycle: discovered, fetched, parsed, validated, snapshotted, scored and settled. Track attempts, last successful completion, source failures and pending work. Separate data arrival from model fitting so a new injury report can update features without retraining the entire model.

Design migration tests against both clean and representative populated database copies, especially where append-only guards exist. Exercise a restart during extraction, during artifact publication and near a cutoff. Late jobs must not backdate their output. Use atomic artifact publication and preserve the last eligible model when a new fit fails.

Measure local runtime, peak memory, data size, accepted documents and actual LLM usage. Record per-source failure/cost concentration. The plan does not create schedulers or initiate paid requests by itself; implementation must use the existing execution and authorization context.

**Exit:** failures produce visible records and recoverable queues rather than silently skipped weeks or fabricated successful jobs. A cutoff missed during an outage remains identified as missed.

### WP19 — adversarial review of the complete pipeline

Test the system, not only the helpers. Required challenges include:

- Append future games, revised stats, later news and closing quotes; prior features/predictions must remain unchanged.
- Move an article's receipt/extraction beyond cutoff; captured-mode eligibility must change correctly.
- Duplicate and syndicate a story; confidence and independent-sample count must not inflate.
- Change player/team mappings later; frozen historical identity must stay stable.
- Remove a source family; use the explicit missing-data path and measure coverage/forecast effects.
- Repeat game snapshots across books/horizons; split grouping and uncertainty accounting must remain correct.
- Supply wrong units, sign conventions, market period or handicap; quarantine or contract checks must catch them.
- Run the declared selection procedure on repeated suitable no-signal controls; investigate false discoveries without tuning indefinitely to the controls.
- Compare a naive time-leaking positive-control fixture with the valid path so integrity tests demonstrate they can detect a known leak.

No finite suite proves all leakage or overfitting absent. Document which failure classes were exercised and which historical sources remain unverifiable.

**Exit:** one integrated evidence package contains source/feature manifests, split lineage, predictions, reference metric checks, failure-injection results and remaining limitations.

### WP20 — prospective observation and improvement decisions

Freeze the adaptive recipe, decision horizon and evaluation review schedule before collecting new evidence. Record every eligible game and abstention. Allow scheduled refits under the same recipe; version any change to model families, feature sets, selection rules or authority policy.

Use the error report to prioritize specific hypotheses. Each proposed addition includes the observed weakness, sample size, mechanism, source readiness, simplest fix, research reference, complexity budget, confirmation period and accept/reject/inconclusive rule. Correct multiple comparisons and treat inspected future data as development if it becomes the basis for a redesign.

**Exit:** the system can operate, measure itself and choose a justified next experiment without another unbounded research sweep. Qualification remains a separate evidence decision; no fixed number of games automatically proves profitability.

### Advanced research backlog with explicit admission tests

These are research-backed options to evaluate after the basic path works, not mandatory extra modules.

| Candidate | Trigger worth investigating | First implementation and comparison | Main failure to guard against |
|---|---|---|---|
| Hierarchical Bayesian team/QB ratings | Early-season or replacement-QB weakness relative to baseline | Dynamic pooled ratings with offseason mean reversion; compare simpler shrinkage and current rating features | Priors/hyperparameters tuned on scored seasons; posterior certainty overstated |
| Player/lineup interaction model | Errors persist around multi-player absences or continuity after individual effects | Small position-group interactions before a graph model; chronological player estimates | Sparse combinations and retrospectively known starting lineups |
| Play/drive model | Repeated pace/possession or matchup errors | Estimate drive counts and scoring components from earlier plays; aggregate to game features | Treating plays as independent betting outcomes or using target-game plays |
| Discrete joint score model | Margins/totals reasonable but tails, pushes or joint behavior wrong | Validate integer support and marginal calibration, then compare joint likelihood and actual-contract probabilities | Synthetic validation mistaken for real edge; extra degrees of freedom without data |
| Copula/dependence model | A specific joint-probability/exposure task has miscalibrated dependence | Fit only after marginals work; compare a simple dependence baseline on later data | Multiplying unsupported marginal probabilities or unstable tail dependence |
| Mixture of experts | Stable evidence that different regimes need different mappings | Small regularized gate using only pregame inputs and honest expert predictions | Selecting the best expert after the game or multiplying searches |
| News/market event model | Timely text adds information beyond price history | Separate directional/fixed-horizon movement experiment and outcome-value comparison | Publication-to-receipt hindsight, mixed handicaps, overlapping stories |
| Transformer/graph/foundation model | Simpler models leave a defined sequence/interaction problem and adequate data exists | Fixed-budget benchmark against tabular/aggregated features, with model-vintage audit | Pretraining contamination, opaque historical knowledge, expensive overfitting |

For each adopted method cite the recovered paper/report and verification notes, pin the implementation/reference version, test mathematical contracts and measure its incremental benefit. A method being sophisticated is neither a promotion criterion nor a reason to discard useful simple baselines.

### Common acceptance checklist for every delivery

A work package is reviewable only when its return includes: problem and observed evidence; changes and current code identity; applicable research/source references; actual commands and relevant test results; example input/output; coverage and excluded cases; measured results where available; and limitations/next dependency. Avoid claiming connected or observed based solely on a synthetic test.

The minimum complete delivery is one full path with ordinary cases and failure cases: source capture/reconstruction → as-of features → earlier-only training → immutable artifact → frozen forecast → price/decision trace → settlement → error report. The advanced backlog begins only when this path can reveal whether an addition helped.

## Agent operating manual, research guardrails and code-review additions

This is the execution contract for agents implementing the work packages. Use it with the package specification and prompt below. It is not evidence that implementation has occurred. Agent prompts are prepared for the user to assign; this planning task has not launched implementation agents or changed the application.

### Context every agent must receive

- The objective is an NFL betting pipeline that learns from legitimate information, produces reproducible forecasts and measures incremental value against the market. Fantasy product work is outside scope; shared-module changes require checking affected callers.
- Real ML already exists. Do not start from “there is no ML,” rebuild every expert, or infer model quality from a working UI. The unresolved issue is trustworthy data, numerical correctness, training/serving integration and honest measurement.
- Use the active checkout, inspect its dirty changes, and reconcile prior work. The latest source inspection here was HEAD `21789a9` with dataset/lab/governance edits in progress. Earlier database counts belong to their recorded inspection; they are not automatically current.
- Reuse the installed `research/.venv` and the existing data, temporal, probability, decision and execution contracts. Do not choose a new database/framework simply because a research report mentions one.
- Work from immutable extracts or disposable database copies for experiments. Importing database-owning app modules can initialize state; inspect the import chain and use explicit test databases. Preserve append-only evidence and original failed runs.
- Read only the relevant research bundle plus its verification notes at first. Read a primary paper's relevant assumptions before implementing its mathematics. A report's recommended code change is an engineering suggestion, not a theorem.
- Separate development results, reconstructed historical evidence, actual prospective capture and confirmed execution. A manually recorded acceptance is not an independently confirmed sportsbook fill; the current execution lifecycle explicitly distinguishes that.
- A valid model may legitimately predict little beyond the market. Do not force nonzero model influence, relax an invalid-input check or select a convenient subset to make the result look successful.
- Keep learning and valid shadow scoring available when betting evidence is insufficient. Source integrity, forecast validity, evidence qualification and exposure checks have distinct purposes.
- Every new comparison belongs in the trial registry, including abandoned settings and post-hoc slices. “The test season is later” does not make repeatedly inspected history untouched.
- Output numbers only when computed. Use null plus a reason for unknowns, not invented probabilities, reconstructed timestamps presented as observations, or estimated test results.

### Reading priority and how to handle contradictory research

Start with the current package, the relevant code/tests, and one or two indexed reports. Use the [research index](../../archive/recovery-indexes/START-HERE-research-and-audits.md) to find the broader corpus and the [complete inventory](../../archive/recovery-indexes/INDEX.md) for supporting documents. The recovered research is substantial, but this plan does not claim every page has been independently reread or every recommendation validated.

The September 14 verification reviews are particularly useful:

- [Point-in-time architecture corrections](../../research/september-14-sweeps/wf_65f8c9e5-bf5/verify-point-in-time-ml-architecture.json): mutable tables, training/serving skew and why a single event timestamp is inadequate.
- [Walk-forward corrections](../../research/september-14-sweeps/wf_65f8c9e5-bf5/verify-walk-forward-validation.json): do not misquote sufficient conditions for cross-validation as universal prohibitions; deployment realism and non-stationarity justify our chronology. Synthetic finance comparisons do not establish the best NFL protocol.
- [Calibration/authority corrections](../../research/september-14-sweeps/wf_65f8c9e5-bf5/verify-bet-authority-calibration.json): do not import unstable ROI claims, assume a prior automatically eliminates no-edge bets, or equate calibration with safe Kelly sizing.
- [JS/Python corrections](../../research/september-14-sweeps/wf_65f8c9e5-bf5/verify-js-vs-python-implementation.json): claims that no alternative bindings exist, that ONNX must use float32, or that a toy tree is a production learner were overstated. Our Python-first choice is based on existing infrastructure and parity, not those claims.
- [QB/availability corrections](../../research/september-14-sweeps/wf_65f8c9e5-bf5/verify-qb-injury-availability-value.json): benchmark formulas, data cutoffs and repository terms must be checked before reuse.

Some old reports prescribe native JS, prohibit new Python dependencies, require a particular old significance gate, or say “read-only tonight.” Those are dated implementation/session choices. They do not override the current user-authorized scope, Python-first architecture or the need to repair a defective gate. Keep the underlying lesson—chronology, explicit authority and verification—without reinstating obsolete mechanics.

In particular: Holm does not require independent base p-values, but it does require valid base tests. Do not repeat the old grouping of Holm with independence-dependent corrections. Likewise, a weighted conformal or block method is not automatically guaranteed under arbitrary NFL drift; state its actual assumptions and measured behavior.

### Research-backed mistakes to avoid

The references below point to recovered reports and, where available, verification corrections. They explain the design constraints. Any numerical guarantee must be checked against its primary source and the implemented assumptions before being advertised.

| ID | Do not do this | Required alternative and verification | Research reading |
|---|---|---|---|
| R01 | Join old games to today's final feature values and call the result historical | Retain publication, receipt, extraction and revision clocks; mutate future rows to test invariance | [F05 point-in-time](../../research/advanced-methods-and-github/F05-bitemporal-pit.md) and architecture verification |
| R02 | Invent first receipt from provider publication or request start | Preserve actual response receipt; label reconstructions and timing uncertainty | F05; current quote/event contracts |
| R03 | Recreate Wednesday injury status from a final Friday report | Preserve exact source versions; unknown earlier versions stay unknown | F05; QB/availability verification |
| R04 | Fit preprocessing, team ratings, availability or calibration on the whole dataset before splitting | Fit the entire dependency chain inside earlier folds, retaining row-level lineage | Walk-forward and architecture verification |
| R05 | Stack in-sample predictions from component models | Use earlier out-of-fold component predictions and regularized combination | [F02 forecast combination](../../research/advanced-methods-and-github/F02-forecast-combination.md) |
| R06 | Add many correlated experts because more models sound stronger | Compare a small candidate family; measure collinearity and incremental value; fit any reduction only on training data | F02 |
| R07 | Treat a 1999–2025 dataset as 25 years of equally informative modern football | Report era/feature coverage and time-weighted sample size; test recency choices inside the training protocol | [F08 dynamic ratings](../../research/advanced-methods-and-github/F08-bayesian-state-space-ratings.md), [F15 shrinkage](../../research/advanced-methods-and-github/F15-team-strength-shrinkage.md) |
| R08 | Turn millions of plays or repeated book quotes into millions of independent betting outcomes | Group by game/week and preserve the relevant dependence in uncertainty estimates | Walk-forward verification; F06 |
| R09 | Choose a favorable metric, subgroup, seed, horizon or start year after seeing results without counting the search | Preregister the comparison; retain all attempts and changes | [F06 multiplicity](../../research/advanced-methods-and-github/F06-trial-registry-multiplicity.md), [GF10 registry](../../research/advanced-methods-and-github/GF10-trial-registry-preregistration-code.md) |
| R10 | Use PBO/DSR as an objective to optimize or claim they restore a used holdout | Treat them as assumption-dependent diagnostics; confirm redesigned models on later uninspected data | F06; walk-forward verification |
| R11 | Discount model trials using incomparable ROI/MAE/Brier sequences without justification | Use aligned loss panels and a declared comparison family; validate dependence treatment | F06; statistical audit issue in this plan |
| R12 | Repeatedly check ordinary significance and stop when it looks good | Use prespecified review times or independently verified sequential methods with their assumptions satisfied | [F07 sequential inference](../../research/advanced-methods-and-github/F07-sequential-inference-fix.md) |
| R13 | Assume a wide predictive interval means the expected edge is too uncertain, or vice versa | Distinguish outcome variability, model uncertainty and calibration uncertainty in the contract | F11; calibration/authority verification |
| R14 | Treat conformal coverage as proof of accuracy, cover probability or profit | Measure interval coverage/width separately from proper probability scores and executable returns | [F11 conformal](../../research/advanced-methods-and-github/F11-conformal-calibration.md), [GF08 code](../../research/advanced-methods-and-github/GF08-conformal-prediction-code.md) |
| R15 | Reuse one residual distribution/calibrator across different model identities and price horizons | Bind calibration to the actual prediction and contract; use earlier calibration data | F11; calibration/authority verification |
| R16 | Price an integer spread from a non-push binary probability without push mass | Return unconditional win/push/loss probabilities and use exact-price EV | [F17 NFL margins](../../research/advanced-methods-and-github/F17-margin-distribution-lit.md); probability contracts |
| R17 | Copy a soccer goal model or fixed historical NFL standard deviation as the full score model | Validate NFL score support, key margins, tails and era behavior; compare simpler distributions | F17; [F01 simulator mechanics](../../research/advanced-methods-and-github/F01-drive-sim-mechanics.md) |
| R18 | Calibrate around broken simulator mechanics and declare the physics fixed | First validate possessions, field direction, clocks, turnovers and period/OT behavior | F01, F17 |
| R19 | Treat related bet legs/positions as independent | Model or conservatively constrain dependence; fit copulas only after useful calibrated marginals exist | [F10 copulas](../../research/advanced-methods-and-github/F10-copula-correlation.md), [GF06 dependence code](../../research/advanced-methods-and-github/GF06-copula-dependence-code.md) |
| R20 | Convert a coach quote into an arbitrary injury probability or point adjustment | Extract supported facts; learn availability and impact from earlier labeled examples | [N13 injury interactions](../../research/advanced-methods-and-github/N13-injury-network-propagation.md); QB/availability verification |
| R21 | Call market movement after a story its causal effect | Separate prediction from causal identification; handle overlapping events, price history, receipt delays and controls | [F13 news impact](../../research/advanced-methods-and-github/F13-causal-news-impact.md) |
| R22 | Feed a modern LLM a historical game and accept its remembered outcome as blind prediction | Use span-supported extraction and prospective validation; maintain reconstruction labels | Architecture/calibration reviews; current AI audit |
| R23 | Treat publication, extraction, truth, activity probability and win probability as one confidence number | Keep each quantity separately named and measured | F05, N13, F13 |
| R24 | Transfer rankings, thresholds or claimed profits from baseball, NBA or finance directly to NFL | Use them as hypotheses/reference math; test on appropriate NFL information and outcomes | F15; walk-forward and calibration verification |
| R25 | Assume a known advanced method or GitHub repository is correct, licensed for reuse, or production ready | Read relevant code/terms, pin a version, use independent fixtures and an actual full-pipeline comparison | [GF09 nflverse](../../research/advanced-methods-and-github/GF09-nflverse-ecosystem-code.md), GitHub catalog and verification reviews |
| R26 | Present better CLV and better returns from the same bets as two independent proofs | Report both, recognize dependence, use exact contracts and a stated close benchmark | F13; calibration/authority verification |
| R27 | Increase stakes or remove safeguards because the model now produces non-market numbers | Require valid outputs, matching calibration, explicit evidence and separately authorized betting policy | Calibration/authority verification |
| R28 | Call an uncomputable robustness test a pass | Return not-estimable/inconclusive with the missing sample requirement | F06/F07; new error-analysis finding below |

### Additional gaps found in the current source

This was a targeted review, not a new claim of complete line-by-line coverage. Findings refer to `21789a9` plus the reported working changes. Recheck before implementation. “Reproduced” below means isolated synthetic behavior, not demonstrated financial loss. The [probe results](../../audits/plan-code-checks/PLAN-CODE-CHECKS.json) preserve the output.

| ID / priority | Evidence | Required work and completion check |
|---|---|---|
| C01 / P1 | `server/betting/nfl/contracts/forecast-packet.js:89–163`: isolated probes accepted an invalid receipt timestamp, null/empty feature values, a nonfinite feature, odds of zero, `market='totals'` with spread-style fields, and a cutoff after kickoff | WP02/WP04/WP13: validate field types, enum combinations, timestamp ordering, finite values, allowed missingness and schema compatibility. Each reproduced malformed case needs a regression test. |
| C02 / P1 | Same module, `packetHash` at line 193: `[NaN]` and `[null]` yielded identical hashes through JSON serialization; nonfinite features also passed validation | Validate before hashing/sealing or make nonfinite values unrepresentable. Preserve legitimate explicit null/missing values. Test semantic distinctions rather than replacing every null with zero. |
| C03 / P1 | `nfl-t60-packet.js::resolvePacketMarketQuote` independently chooses latest home/away rows. An isolated fixture returned home −3 and away +2.5 as one available result without mismatch disclosure; downstream `quoteFor` uses the home timestamp for either side | WP07/WP15: preserve per-side identity/time and exact contracts. Two different lines can be individual offers, but cannot be treated as opposing prices for one de-vigged contract. Add asynchronous-update and moved-line fixtures. |
| C04 / P2 | The same resolver chooses a preferred book before checking it has a home quote. A fixture with only an away quote there and a complete second book returned unavailable | Select among eligible complete candidates under a declared policy or state why a single-sided quote is used. Test fallback without fabricating a missing price. |
| C05 / P1 | `t60-runner.js:141–235`: selection reads only `state='scheduled'`; a board/tape failure leaves the row `frozen`. The inspected `runT60Pass` has no separate frozen-packet retry phase | WP15/WP18: recover from frozen evidence without refetching its inputs. Distinguish an on-time result from a late reconstruction; record actual completion/action times. Retry idempotently if a tape write succeeded before linking the observation failed. No claim is made here about the cause of each historical stranded row. |
| C06 / P1 for historical cutoff use | `nfl-t60-packet.js:674` constructs all historical kickoffs with fixed `-04:00`; its comment acknowledges the standard-time error | WP03/WP07: use a canonical UTC kickoff or an explicit America/New_York conversion with date/DST tests. Existing coarse diagnostic output is not a safe T−60 training builder. |
| C07 / P1 | `server/news/store.js:33–47` updates headline/body/publication metadata on a duplicate row while retaining its original `ingested_at` | WP08/WP09: preserve immutable document versions before updating the current view. Today's revised body plus an old ingestion clock is not proof that body was known earlier. Test a Friday edit of a Wednesday article. |
| C08 / P2, coverage-contract risk | `nfl-t60-packet.js` injury/news queries admit unresolved teams; the news coverage query also lacks a verification-state filter. These paths primarily report counts, not frozen claim values | WP03/WP09/WP15: separate discovered, identity-resolved, verified, timely and actually consumed counts. Do not count unknown-team/unverified evidence as usable game features. Preserve raw records for later resolution. |
| C09 / P2 | `nfl-replay.js:648` already implements error slicing, Holm adjustment and effect checks. At line 721, fewer than three seasons returns `robust: true` with a caveat | WP14/WP20: reuse useful code, replace not-estimable-as-pass with an explicit state, retain full-precision test values for decisions and review base-test assumptions. Passing a later heuristic does not establish valid inference. |
| C10 / design gap | `nfl-slice-diagnostic.js` analyzes historical expert rows, derives probabilities from a normal-CDF approximation and joins current `game_lines`; `nfl-replay.js::analyzeErrors` takes bets | WP14: adapt reporting to saved all-game candidate probabilities, abstentions and frozen context. Existing diagnostics are useful foundations but not the complete new model error ledger. |
| C11 / design gap | `nfl-family-contribution.js` already has matched-game comparisons and paired weekly bootstrap; it is oriented to the current ensemble and spread path | WP12/WP14: reuse metric contracts, but verify full refits and upstream lineage for the new Python candidate; separately wire totals. Do not label a family with no numerical consumer a scientific zero-effect result. |
| C12 / design gap | The declared forecast contract and current packet-board path are spread oriented; totals appear in research but are not automatically supported by this contract | WP13/WP15–WP17: version market-discriminated spread/total schemas, scoring and settlement. Complete one spread slice first, then a full total slice; do not pass totals through by renaming one field. |

**Verification performed:** the existing pure forecast-packet test file passed all 14 tests. The additional isolated probes still accepted the seven malformed cases above. This is concrete evidence that passing the existing suite does not cover these cases. No application modules owning a database were imported for the probes, and no application source, live database or bet settings were changed. The quote selector was evaluated in an isolated JavaScript context with synthetic values.

### What a good deliverable looks like

Every package returns one concise human report plus structured artifacts. Its evidence must let the next agent reproduce the result without relying on the previous agent's explanation.

| Deliverable | Required content | Unacceptable substitute |
|---|---|---|
| Status/change report | Actual source identity, package ID, existing work reconciled, changed files, completed state, remaining dependency | “Implemented everything” without evidence |
| Source/coverage manifest | Source versions, timing/provenance, unique games, exclusions by reason, fetch/extraction cost where applicable | Total row count or “data cleaned” |
| Example lineage | One game and each upstream source/feature/artifact reference, including clocks and missingness | Only a hash, aggregate counts or a screenshot |
| Training/selection record | All candidates/settings, exact splits, fitting row IDs, seeds, upstream OOF artifacts and failures | Only the winner's score |
| Prediction ledger | All eligible games, actual saved outputs/probabilities, quoted contract, artifact/policy identity, abstentions | Selected winning bets or regenerated predictions |
| Evaluation | Paired baseline comparison, metric definition, sample/coverage, uncertainty, search exposure and verdict | ROI alone, unsupported significance or “beats Vegas” |
| Verification | Actual command, runtime, exit status, test counts, representative failures addressed | A test plan described as tests run |
| Handoff | Artifacts, accepted contracts, next dependency, remaining uncertainty and rollback/recovery behavior | A long narrative with no executable next step |

An example **synthetic verification result**, not a real model result: a Wednesday DNP report, Friday questionable update and pregame inactive notice produce different eligible feature snapshots. Adding the later inactive notice leaves Wednesday's saved feature hash and prediction unchanged. Running a revised article through the source store creates a new version instead of making Friday text appear received Wednesday. Running the same completed extraction again emits no duplicate events.

An example **synthetic pricing check**: `P(win)=0.53`, `P(push)=0.02`, `P(loss)=0.45`, odds `−110` gives expected profit per unit risked of `0.53×(100/110)−0.45 ≈ 0.03182`. Probabilities sum to one; a push returns stake. This is an arithmetic fixture, not an estimated edge or permission to bet.

An example **acceptable performance verdict**: “Candidate comparison completed, coverage and parity verified. Its improvement interval includes zero, so predictive benefit is inconclusive. Shadow scoring is connected; betting qualification is unchanged.” A negative or inconclusive finding can complete the engineering task successfully.

For artifact paths use a package/run directory under the repository's existing evidence layout, with manifest, commands, test results, coverage, predictions and comparison as applicable. Store large source/data/model artifacts in the established data/artifact location with a manifest reference; do not commit the live database or raw secrets. Generated filenames and CLI names proposed in this plan must be labeled proposed until implemented and exercised.

### Coordination and file ownership

One lead owns shared contracts, schema/migrations, the master ledger and cross-package integration. A package agent owns its assigned source/test changes and returns a patch or commit plus evidence. A reviewer checks the result against an independent expected behavior, not just the implementation's own outputs.

Do not concurrently edit `dataset.py`, forecast-packet contracts, the migration list or shared governance files without explicit ownership. Agents discovering a cross-package issue should report its reproduction and dependency to the owner. Do not reset another worker's changes. A large number of research or implementation agents is not a quality metric.

The critical handoff chain is: stable identities/clocks → feature/schema contract → weekly training/probability outputs → frozen serving/settlement → evaluation. News retrieval can progress once the document/timing contract exists; richer text features must not block the basic model. Review one complete spread path before copying the design to totals.

### Review prompt to use after each package

> Review this package against its assigned WP specification, R guardrails and relevant C findings. Inspect the actual diff, tests and saved artifacts. Independently recompute at least one numerical or temporal result where applicable. Check that the output corresponds to the same data, model, horizon and code used by the consumer. Search for a counterexample the new tests do not cover. Classify findings by consequence and separate confirmed reproductions from hypotheses. Do not declare a whole system qualified from helper tests, require unrelated scope, or silently fix the author's code while reviewing. Return accept, changes required, or inconclusive; name the exact evidence and remaining integration dependency.

### Lead-agent kickoff prompt

> Implement the Gridiron betting rebuild from GRIDIRON-MASTER-PLAN.md. First reconcile the active checkout, existing implementation and dirty changes. Use the agent operating manual and WP01–WP20; begin with the first unfinished dependency, not another broad research sweep. Resolve the new C01–C12 findings in their owning packages. Assign bounded package prompts only when delegation is authorized and file ownership is clear. Require the specified evidence from each package, review it, and integrate one complete frozen spread prediction through settlement before broadening to totals or advanced models. Preserve existing research and failed experiments. Keep model learning, data integrity and betting authority distinct. Continue useful work when a source gap blocks another package; record unknowns honestly. Return the updated ledger, actual artifacts/tests, measured results and limitations. A working pipeline with no demonstrated edge is an acceptable outcome; do not manufacture a positive verdict.

## Package prompts and exact edit map

Use the shared operating manual with each prompt. Existing paths below were checked during planning, but must be rechecked against the active checkout. Paths are relative to the repository root declared in each prompt. Proposed modules are suggestions, not claims that files or commands already exist. The lead owns shared contracts/migrations and must resolve overlapping edit ownership before assigning concurrent work.

### WP01 prompt — Reconcile implementation and preserve baseline

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** None; starts the implementation.

**Existing code/docs to inspect and edit within scope:** `docs/CLAUDE-NEXT-STEPS.md`, `docs/reference/model-governance-manual.md`.

**Existing verification to extend:** Choose focused tests after inspecting the active callers; do not claim a nonexistent test command was run.

**Proposed additions, only if the existing code cannot own the contract cleanly:** Prefer extending the existing owners. Add focused fixtures/artifacts as required, not a duplicate subsystem.

**Task:** Reconcile the current checkout, dirty-file ownership, deployed version and prior evidence. Classify earlier findings using actual source/tests rather than comments. Create the single work ledger and preserve the incumbent configuration, predictions and metric definitions. Do not overwrite a current plan or rerun paid/live jobs just to inventory them.

**Required return:** A current status ledger; a frozen baseline manifest or an explicit explanation of missing reconstruction evidence; a dependency/ownership map identifying the next unfinished package.

**Acceptance/counterexamples:** Recompute one available baseline example from its saved inputs. Distinguish historical inspection counts from refreshed observations. A written claim that a bug is fixed is not verification.

**Research guardrails:** R01,R09,R25. **Code findings:** C01–C12.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP02 prompt — Repair defects and gate responsibilities

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP01.

**Existing code/docs to inspect and edit within scope:** `server/services/nfl-orthogonal-specialists.js`, `server/services/nfl-qbr.js`, `server/services/trial-statistics.js`, `scripts/run-purged-evaluation.mjs`, `server/services/model-governance.js`, `server/betting/nfl/contracts/forecast-packet.js`.

**Existing verification to extend:** `test/nfl-qbr.test.js`, `test/trial-statistics.test.js`, `test/forecast-packet-contract.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** test/nfl-specialist-weight-shape.test.js

**Task:** Reproduce relevant numerical/data/gate defects on isolated fixtures before fixing them. Check specialist dimensions, QBR season identity and the current DSR promotion integration. Resolve validator behavior C01/C02 with the contract owner. Separate invalid data/output from insufficient betting evidence so valid shadow predictions remain measurable. Do not repair a statistical assumption merely by lowering its threshold.

**Required return:** A defect-by-defect before/after report and targeted regression tests; one gate responsibility table with caller, condition, effect and recorded reason.

**Acceptance/counterexamples:** Exercise tall and small design matrices, corrupt or duplicate season rows, malformed packet fields and a valid forecast withheld only from staking. Reference-check statistical calculations before using them for promotion.

**Research guardrails:** R04,R11,R27,R28. **Code findings:** C01,C02.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP03 prompt — Historical identities and exact clocks

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP01 and ownership agreement for dataset/packet contracts.

**Existing code/docs to inspect and edit within scope:** `server/services/team-codes.js`, `server/services/nfl-contract-key.js`, `server/services/nfl-t60-packet.js`, `research/betting/nfl/dataset.py`.

**Existing verification to extend:** `test/team-codes.test.js`, `test/nfl-t60-packet.test.js`, `research/betting/nfl/test_dataset.py`

**Proposed additions, only if the existing code cannot own the contract cleanly:** test/nfl-historical-clock-identity.test.js

**Task:** Define canonical game/player/provider mappings and timestamp precision. Replace the fixed historical -04:00 assumption for cutoff construction with reliable UTC or named-timezone conversion. Resolve player identity from historical roster intervals and retain ambiguous cases. Preserve schedule revisions and distinguish date-only records from precise kickoff instants.

**Required return:** An identity/time dictionary; mapping and exclusion manifest; fixtures for a trade, alias, ambiguous name, neutral venue, reschedule, bye, postseason and winter/summer offset.

**Acceptance/counterexamples:** Check one winter and one summer kickoff independently. A date-only game must not silently qualify as an exact T−60 packet. Later roster changes must not rewrite a frozen historical mapping.

**Research guardrails:** R01,R02,R03. **Code findings:** C06,C08.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP04 prompt — Immutable records and validated contracts

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP02–WP03.

**Existing code/docs to inspect and edit within scope:** `server/betting/nfl/contracts/forecast-packet.js`, `server/services/nfl-bitemporal.js`, `server/services/nfl-decision-tape.js`, `server/db/migrate.js`.

**Existing verification to extend:** `test/forecast-packet-contract.test.js`, `test/nfl-injuries-bitemporal.test.js`, `test/migration-027-populated-upgrade.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** A new migration allocated after inspecting the current migration sequence; never rewrite an applied migration

**Task:** Implement the source/event/feature/artifact/decision contracts from WP04. Reuse existing stores and append-only conventions. Validate semantic types, market discriminants, timestamp order, finite numbers and missingness before hashing. Define compatible schema evolution and retain exact values rather than counts. Separate the general forecast schema from the older T−60 source-summary packet with an explicit adapter.

**Required return:** A versioned schema/adapter and migration where needed; real example records; lineage links; old/new compatibility behavior and invalid-record reasons.

**Acceptance/counterexamples:** C01 malformed cases must fail or follow a documented legitimate missing-value path. C02 nonfinite values cannot collapse into null unnoticed. Replaying frozen evidence after source mutations is invariant. Test a populated database copy as well as clean setup.

**Research guardrails:** R01,R02,R13,R15,R16. **Code findings:** C01,C02,C12.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP05 prompt — Coverage and source admission

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP03–WP04.

**Existing code/docs to inspect and edit within scope:** `server/services/nfl-feature-coverage.js`, `server/services/nfl-evidence-dataset.js`, `research/betting/nfl/dataset.py`.

**Existing verification to extend:** `test/evidence-dataset.test.js`, `research/betting/nfl/test_dataset.py`

**Proposed additions, only if the existing code cannot own the contract cleanly:** A source-admission manifest in the existing evidence/artifact layout

**Task:** Extend the current source/freshness reports into source-specific admission rules and coverage by game, era, team and horizon. Distinguish discovered, resolved, verified, timely, snapshotted and consumed records. Record every join denominator and exclusion reason. Consult nflverse release schedules and pin source versions; a present-day file is not proof of past availability.

**Required return:** A coverage matrix, source admission contracts and before/after-join game counts with sampled source records. Mark unverifiable timing and missing data explicitly.

**Acceptance/counterexamples:** Removing one optional source does not delete valid football examples. A source with many unrelated/unverified rows cannot pass game-specific readiness. Every excluded example has a reproducible reason.

**Research guardrails:** R01,R03,R07,R08,R25. **Code findings:** C08.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP06 prompt — Shared football features and strength priors

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP03–WP05.

**Existing code/docs to inspect and edit within scope:** `research/betting/nfl/dataset.py`, `research/market_lab.py`, `research/tree_lab.py`, `server/services/nfl-features.js`, `server/services/nfl-team-strength.js`, `server/services/nfl-preseason-blend.js`.

**Existing verification to extend:** `research/betting/nfl/test_dataset.py`, `research/test_market_lab.py`, `research/test_tree_lab.py`, `test/nfl-team-strength.test.js`, `test/preseason-blend-cutoff.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** Prefer extending the existing owners. Add focused fixtures/artifacts as required, not a duplicate subsystem.

**Task:** Extend the common builder already being edited; do not fork its chronology. Define the small first feature set, units, missingness and prior-observation ages. Use broad price-independent football history, earlier opponent/QB information and learned shrinkage where justified. Keep labels and unqualified market fields outside the allowlisted model matrix. Preserve old extractor results as explicit comparisons when semantics change.

**Required return:** A feature dictionary, shared extract, consumer-parity report, source lineage and era coverage. Each learned feature names its own training cutoff.

**Acceptance/counterexamples:** Future scores, revised EPA or target-game players cannot change an earlier vector. Home/away signs, away-team rest, Week 1 fallback and optional PBP are covered. Calibrate priors within earlier folds, not globally.

**Research guardrails:** R04,R05,R07,R24. **Code findings:** C06 and earlier dataset chronology findings.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP07 prompt — Exact-horizon quote and betting datasets

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP03–WP05; coordinate shared dataset ownership with WP06.

**Existing code/docs to inspect and edit within scope:** `research/betting/nfl/dataset.py`, `server/services/nfl-quote-tape.js`, `server/services/nfl-contract-key.js`, `server/services/nfl-evidence-dataset.js`, `server/services/nfl-t60-packet.js`.

**Existing verification to extend:** `research/betting/nfl/test_dataset.py`, `test/evidence-dataset.test.js`, `test/nfl-t60-packet.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** A T−60 extraction entry point under research/betting/nfl, sharing the current dataset module

**Task:** Add exact T−60 examples separately from opening-line experiments. Resolve C03/C04 with a declared eligible-book policy, per-side identities/clocks and correct opposing-contract pairing. Missing closing prices must not discard valid outcome examples. Preserve spread and total label definitions, provenance mode and actual odds. Do not infer a fill from an archived offer.

**Required return:** A betting dataset manifest and quote-selection trace showing retained, missing, stale, mismatched and fallback cases; labels are separate from feature columns.

**Acceptance/counterexamples:** Test a moved handicap, asynchronous opposite-side update, missing preferred-book home side, alternate period and unavailable close. Two individual offers at different lines must not be de-vigged as the same contract.

**Research guardrails:** R02,R08,R16,R26. **Code findings:** C03,C04,C06,C12.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP08 prompt — Historical news source pilot

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP03–WP05; document schema owner assigned.

**Existing code/docs to inspect and edit within scope:** `server/news/ingest.js`, `server/news/store.js`, `server/news/normalize.js`, `server/services/press-conference.js`.

**Existing verification to extend:** `test/news-ingest.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** A bounded archive backfill runner with absolute date/team/source filters and resume state

**Task:** Run the specified 2024 Weeks 1–4 engineering pilot only after defining source/version contracts. Use existing stored material, structured reports and official dated archives before expensive transcription. Add content-addressed source versions before updating the current news view. Preserve raw supported content and timing precision. Build an independently reviewed extraction sample and measure coverage/cost before extending seasons.

**Required return:** Source manifests, retrieval/resume log, source-version examples, a reviewed passage set and measured usable coverage/cost. No performance claim from this pilot.

**Acceptance/counterexamples:** A changed Friday body cannot inherit Wednesday ingestion as its own receipt. Repeating the same fetch does not duplicate versions. Missing archives are explicit and do not block the football baseline.

**Research guardrails:** R01,R02,R03,R22,R25. **Code findings:** C07.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP09 prompt — Typed events and historical injury timelines

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP03–WP04 and initial WP08 material.

**Existing code/docs to inspect and edit within scope:** `server/services/nfl-news-events.js`, `server/services/nfl-news-signal.js`, `server/services/nfl-advanced.js`, `server/services/nfl-bitemporal.js`, `server/services/nfl-t60-packet.js`.

**Existing verification to extend:** `test/nfl-news-events.test.js`, `test/nfl-injuries-bitemporal.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** An absolute-date-range event extraction/replay interface using existing stores

**Task:** Extend supported-span extraction, historical roster resolution, source-version references and separate receipt/extraction clocks. Build the shared as-of state reducer. Retain practice trajectories, contradictions, superseding events and unresolved persistent statuses. Unknown teams and unverified claims remain preserved but are not admitted as usable game features. Keep structured parsing separate from LLM interpretation.

**Required return:** Player/game timelines at T−72h, T−24h and T−60; event schema/examples; extraction quality by claim type; coverage and unresolved-state reports.

**Acceptance/counterexamples:** Test negation, ambiguous pronouns, multi-player stories, an inactive reversal, traded players, byes and long-term IR. Later events cannot alter an earlier snapshot; repeated syndicated text is not independent evidence.

**Research guardrails:** R01,R03,R20,R22,R23. **Code findings:** C07,C08.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP10 prompt — Availability and replacement learning

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP06, WP09 and WP11 protocol; may proceed after baseline launch.

**Existing code/docs to inspect and edit within scope:** `server/services/nfl-availability.js`, `server/services/player-availability.js`, `research/betting/nfl/dataset.py`.

**Existing verification to extend:** `test/player-availability.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** research/betting/nfl/availability.py; research/betting/nfl/test_availability.py

**Task:** Define active-status and conditional-usage targets, including healthy non-use and in-game exits. Implement a small regularized availability baseline and earlier-estimated replacement features. Use historical rosters, structured reports and lagged usage. Treat LLM extraction confidence as separate from playing probability. Add text only as a separately registered experiment after structured availability works.

**Required return:** Target dictionary, player model artifacts and chronological OOF outputs, calibration/usage reports and compact game-level availability features.

**Acceptance/counterexamples:** Audit upstream train row IDs for every output used by the game learner. Actual target-game snaps/starters cannot enter features. Compare structured and text additions on identical games with and without contemporaneous market information.

**Research guardrails:** R04,R05,R20,R23,R24. **Code findings:** Earlier news/availability integration findings.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP11 prompt — Registered experiments and bounded model selection

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP01, WP04–WP05; before comparative model fitting.

**Existing code/docs to inspect and edit within scope:** `server/services/research-trials.js`, `server/modeling/registry.js`, `research/requirements.txt`, `research/tree_lab.py`, `research/market_lab.py`.

**Existing verification to extend:** `test/research-trials.test.js`, `test/model-registry-persistence.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** A versioned NFL experiment specification under research/betting/nfl

**Task:** Define a machine-readable experiment specification covering data/source mode, target/horizon, folds, candidates, seeds, metrics, calibration, policy and review schedule. Reuse the existing trial registry; inspect whether generic model-registry APIs actually apply to NFL before integrating. Freeze a small ridge/LightGBM configuration family and record all attempted settings, failures and later changes. Snapshot installed dependency versions.

**Required return:** Experiment specification, trial records, candidate budget, runtime/dependency manifest and artifact-naming rules. No hidden best-seed or best-era selection.

**Acceptance/counterexamples:** Changing data, schema, source mode or feature family produces a distinguishable experiment identity. Failed fits and unsuccessful variants remain discoverable. A registration after scoring is labeled retrospective.

**Research guardrails:** R06,R09,R10,R11,R25. **Code findings:** Statistical promotion integration requires current reconciliation.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP12 prompt — Weekly nested training and OOF lineage

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP06–WP07, WP11; availability optional until WP10 ready.

**Existing code/docs to inspect and edit within scope:** `research/betting/nfl/dataset.py`, `research/tree_lab.py`, `research/market_lab.py`, `server/services/purged-walk-forward.js`, `server/services/forecast-combination.js`.

**Existing verification to extend:** `research/betting/nfl/test_dataset.py`, `research/test_tree_lab.py`, `test/purged-walk-forward.test.js`, `test/forecast-combination.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** research/betting/nfl/walk_forward.py; research/betting/nfl/test_walk_forward.py

**Task:** Implement weekly refits matching the master schedule while preserving old seasonal comparisons. Every preprocessing step, upstream learner, early-stopping choice, combiner and calibrator must use earlier data. Keep entire games and related snapshots together. Produce chronological OOF features for downstream fitting, and save train/test row IDs. Do not replace old holdout predictions with fitted values after final refitting.

**Required return:** Runnable weekly experiment entry point, immutable split manifests, all-candidate predictions, selected artifacts and a complete upstream lineage example.

**Acceptance/counterexamples:** A held-out outcome mutation does not change its model or feature inputs. Same-game leakage through player/book/horizon rows is refused. Newly available current-season labels can enter the next scheduled fit under the declared policy.

**Research guardrails:** R04,R05,R07,R08,R09. **Code findings:** C11 reuse requires actual refit verification.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP13 prompt — Probability, calibration and pushes

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP04, WP07, WP11–WP12.

**Existing code/docs to inspect and edit within scope:** `server/betting/nfl/contracts/spread-probabilities.js`, `server/betting/nfl/contracts/forecast-packet.js`, `server/services/nfl-cover-calibration.js`, `server/services/nfl-total-calibration.js`, `server/services/conformal.js`.

**Existing verification to extend:** `test/spread-probabilities.test.js`, `test/nfl-total-calibration.test.js`, `test/forecast-packet-contract.test.js`, `test/conformal-finite-sample.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** A Python probability/calibration module with parity fixtures for the declared serving contract

**Task:** Bind probabilities/calibration to model identity and exact market/horizon. Specify spread versus total schemas explicitly. Convert conditional non-push probabilities to unconditional win/push/loss probabilities using earlier-estimated push mass. Keep conformal intervals distinct from betting probabilities. Reuse existing corrected math and independent references; do not port a second implementation without parity evidence.

**Required return:** Market-discriminated probability contract, earlier calibration manifest, proper-score and coverage reports, key-margin/push fixtures and explicit unsupported cases.

**Acceptance/counterexamples:** Probabilities are finite, sum to one and yield correct price-based EV. Changing the line requires rescoring that contract. C01 malformed market combinations fail; valid totals require their own complete path, not a renamed spread.

**Research guardrails:** R13,R14,R15,R16,R17. **Code findings:** C01,C02,C12.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP14 prompt — Measurement and actionable error analysis

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP11–WP13; reuse historical reports as references only.

**Existing code/docs to inspect and edit within scope:** `server/services/nfl-replay.js`, `server/services/nfl-slice-diagnostic.js`, `server/services/nfl-family-contribution.js`, `server/services/stats-util.js`.

**Existing verification to extend:** `test/nfl-replay-error-analysis.test.js`, `test/nfl-family-contribution.test.js`, `test/family-contribution-scoring.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** A report adapter for the new Python row-level prediction ledger

**Task:** Reuse existing diagnostics and paired-score contracts, but connect actual all-game outputs, abstentions and frozen context from the new learner. Fix not-estimable-as-robust in C09. Separate loss, probability and return comparisons; evaluate base-test/dependence assumptions before applying multiplicity. Preserve full precision for decisions and round only displays. Measure full-pipeline refitted ablations, not just disabled outputs.

**Required return:** A reproducible error report and ranked hypothesis backlog; row-level inputs; matched baselines; sample/coverage and uncertainty; explicit inconclusive states.

**Acceptance/counterexamples:** A one-season slice cannot pass a multi-season check. No-bet games are retained for forecast evaluation. A family with no numerical consumer is labeled disconnected. Hypotheses discovered in the report require later confirmation.

**Research guardrails:** R08,R09,R11,R24,R28. **Code findings:** C09,C10,C11.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP15 prompt — Trained-artifact serving and frozen recovery

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP04, WP07, WP12–WP13.

**Existing code/docs to inspect and edit within scope:** `server/services/nfl-auto-picks.js`, `server/services/nfl-t60-packet.js`, `server/betting/nfl/contracts/forecast-packet.js`, `server/betting/nfl/strategy/t60-runner.js`, `server/services/nfl-decision-tape.js`.

**Existing verification to extend:** `test/t60-runner.test.js`, `test/forecast-packet-contract.test.js`, `test/nfl-decision-identity-pipeline.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** A narrow versioned Python artifact-scoring adapter with integration tests

**Task:** Connect the actual fitted pipeline to the app through a narrow scoring interface. Freeze all consumed features, quotes, transforms and model identities; no mutable-table rereads in the learned path. Implement recovery of frozen observations using their stored evidence and idempotent tape linkage. Preserve actual late completion times and classify replay versus on-time decisions correctly.

**Required return:** One complete spread-game demonstration and then a slate; artifact/snapshot/decision linkage; numerical parity; explicit fallback and recovery traces. Extend to totals only with WP13 contracts ready.

**Acceptance/counterexamples:** A restart or source mutation cannot change frozen outputs. Invalid artifacts fail explicitly. A tape write/link interruption neither duplicates the decision nor strands it forever. The same quote is not falsely assigned another side’s timestamp.

**Research guardrails:** R01,R02,R15,R16,R27. **Code findings:** C01–C05,C12.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP16 prompt — Betting policy and related exposure

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP02, WP07, WP13, WP15.

**Existing code/docs to inspect and edit within scope:** `server/services/nfl-execution-edge.js`, `server/services/nfl-execution-exposure.js`, `server/services/nfl-execution-staking-policy.js`, `server/services/model-governance.js`, `server/services/nfl-auto-picks.js`.

**Existing verification to extend:** `test/nfl-execution-edge.test.js`, `test/nfl-execution-exposure.test.js`, `test/nfl-execution-decision.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** Prefer extending the existing owners. Add focused fixtures/artifacts as required, not a duplicate subsystem.

**Task:** Make one versioned authority/execution policy consume saved valid probabilities and actual offered odds. Keep shadow prediction available while qualifications are unresolved. Trace every gate result and reason. Preserve related-position accounting across books/markets. Review any AI allocation separately against a deterministic baseline. Do not increase live stakes as a side effect of integration.

**Required return:** Policy contract, deterministic EV/action fixtures and examples of valid forecasts that abstain for distinct reasons; exposure and duplicate-opportunity behavior.

**Acceptance/counterexamples:** Push EV, invalid price, stale quote, duplicate same-side opportunity, opposite positions at different lines and no-edge cases behave explicitly. An LLM explanation cannot silently change numerical authority.

**Research guardrails:** R16,R19,R23,R27. **Code findings:** C03 and market-specific policy integration.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP17 prompt — Independent settlement and CLV grading

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP07, WP13, WP15–WP16.

**Existing code/docs to inspect and edit within scope:** `server/services/nfl-execution-lifecycle.js`, `server/services/nfl-execution-clv.js`, `server/services/nfl-execution.js`, `server/services/nfl-decision-tape.js`.

**Existing verification to extend:** `test/nfl-execution-lifecycle.test.js`, `test/nfl-execution-clv.test.js`, `test/nfl-execution-clv-abstained.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** Prefer extending the existing owners. Add focused fixtures/artifacts as required, not a duplicate subsystem.

**Task:** Grade the exact recorded contract and price with versioned settlement rules. Keep actual confirmed fills, user-reported acceptance and paper opportunities distinct. Append corrections without rewriting original predictions. Define the close benchmark and report missing closes separately. Handle spreads and totals through their declared contracts, not shared ambiguous field names.

**Required return:** Independent settlement fixture calculations, a reconciled row-to-summary ledger, closing-reference specification and cancellation/push/correction examples.

**Acceptance/counterexamples:** Win/loss/push/void and positive/negative American odds reconcile to risked stake and profit. Missing close does not erase a settled outcome. CLV at different lines is not mislabeled same-contract price improvement.

**Research guardrails:** R16,R19,R26,R27. **Code findings:** C12.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP18 prompt — Reliable jobs, migrations and resource limits

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP04, WP08–WP09 as available, WP15–WP17.

**Existing code/docs to inspect and edit within scope:** `server/betting/nfl/strategy/t60-runner.js`, `server/db/migrate.js`, `server/services/nfl-news-events.js`, `server/news/store.js`, `server/platform/paths.js`.

**Existing verification to extend:** `test/t60-runner.test.js`, `test/nfl-prospective-collection.test.js`, `test/migration-027-populated-upgrade.test.js`, `test/news-ingest.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** Targeted job-recovery, artifact-publication and populated-schema tests

**Task:** Implement observable job states, bounded retries, resume cursors and atomic artifact publication. Separate source arrival from scheduled fitting. Recover frozen decisions without new inputs and retain the previous eligible model if a fit fails. Exercise migration behavior on populated copies and append-only guards. Track accepted-document costs, time, memory and failure concentration from actual runs.

**Required return:** Lifecycle/retry specification, restart evidence, populated/clean migration results, resource report and a recovery/rollback runbook.

**Acceptance/counterexamples:** Interrupt fetch, extraction, artifact publish and tape linking. Resume without duplicate writes or repeat billing for cached unchanged work. Missing a cutoff remains visible; no job backdates receipt or completion.

**Research guardrails:** R01,R02,R25. **Code findings:** C05,C07.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP19 prompt — Challenge the complete system independently

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** M3 complete path; can review individual packages earlier.

**Existing code/docs to inspect and edit within scope:** `test/offline-guard.mjs`, `test/forecast-packet-contract.test.js`, `test/nfl-replay-error-analysis.test.js`, `test/nfl-family-contribution.test.js`.

**Existing verification to extend:** Choose focused tests after inspecting the active callers; do not claim a nonexistent test command was run.

**Proposed additions, only if the existing code cannot own the contract cleanly:** An integrated frozen-prediction/chronology challenge suite and self-contained synthetic fixtures

**Task:** Review the complete implemented path against the master threat cases and all C findings. Write tests that cross module boundaries, not mirrors of implementation formulas. Use independent arithmetic/temporal expectations, known-leak positive controls and repeated appropriate no-signal controls. Inspect import-time effects before testing, keep databases disposable and prevent provider calls. Report failures to their owning packages rather than rewriting unrelated production code.

**Required return:** A reproducible adversarial verification report, coverage of each failure class, actual commands and clear unresolved findings. Preserve raw negative outcomes.

**Acceptance/counterexamples:** Exercise future mutation, source revisions, historical identities, duplicate stories, player/book split leakage, moved contracts, malformed packets, restarts and metric reconciliation. Passing 14 existing packet tests is insufficient if the seven known malformed cases still pass validation.

**Research guardrails:** R01–R28. **Code findings:** C01–C12.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP20 prompt — Prospective ledger and evidence-driven expansion

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP14–WP19; protocol must be frozen before using future results.

**Existing code/docs to inspect and edit within scope:** `server/services/research-trials.js`, `server/services/model-governance.js`, `server/services/nfl-replay.js`, `docs/CLAUDE-NEXT-STEPS.md`.

**Existing verification to extend:** `test/research-trials.test.js`, `test/nfl-replay-error-analysis.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** A versioned prospective protocol and hypothesis-backlog artifact in the existing evidence layout

**Task:** Freeze the adaptive fitting recipe, prospective observation horizon and review schedule. Preserve every eligible prediction and abstention, including version changes and missed observations. Use the error report to propose the smallest fix for a measured weakness. Require later confirmation for discovered hypotheses and retain rejected/inconclusive additions. Distinguish engineering completion from predictive value and betting qualification.

**Required return:** Prospective protocol, versioned evidence ledger, ranked improvement backlog and one example accept/reject/inconclusive decision with its evidence requirements.

**Acceptance/counterexamples:** Changing a feature/search/policy starts a new evidence segment. A failed or uncomputable robustness check never becomes a pass. Advanced methods need a specific error, suitable data and a simpler baseline before implementation.

**Research guardrails:** R09,R10,R12,R24,R27,R28. **Code findings:** C09–C12.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

## Current system findings and problem register

**Historical inspection snapshot:** the findings below were checked at `43af933` or reported in recovered inventories. Consult the later execution-section reconciliation at `21789a9` before treating any as still open. Database counts have not been refreshed in this planning pass.

### Verified findings

| Finding | Evidence and consequence |
|---|---|
| Production forecast copies the market | 65/65 rows in `nfl_decision_events` have `is_market_identity=1`, `matching_calibration_missing`, and `calibration_not_proven`. This describes recorded decisions, not every historical experimental prediction. |
| Component gate never passed | 1,390 `nfl_ensemble_fit_artifacts` contain 43,090 component rows; zero have `residual_gate_passed=true`. `nfl-ensemble.js:1887` requires n≥250, RMSE gain≥0.03 and a computable DM p≤0.05, then zeroes failing components. |
| A real numerical defect silences specialists | `nfl-orthogonal-specialists.js:71` allocates observation weights by feature count. An isolated 40-row reproduction produced all-NaN coefficients. Changing the allocation to row count produced finite coefficients. The change was tested in isolation only; the repository remains unchanged. |
| Historical training counts were overstated | There are **7,276** completed home-game rows with scores and spreads in 1999–2025, not the inventory's stated 7,445. Two team rows must not count as two games. |
| Detailed history is much shorter | `nfl_play_by_play` has 254,191 rows spanning 2021–2026. `nfl_team_week_features` spans 2016–2025, with **zero 2026 rows**. Current predictions risk stale football inputs even though quote capture continues. |
| QBR feed contains corrupt season data | 520 rows labeled 2026 match 2025 rows on player/week/team and four statistical fields; 508 rows are labeled future weeks 2–18. Repair ingestion and quarantine affected source versions, including erroneous Week 1 copies; merely dropping future weeks is insufficient. |
| Frozen decisions are only partly wired | T−60 observations: one decided with a linked run, 13 frozen without a run, one scheduled. These counts do not establish why each remains frozen. `autoPickDecisionBoardForPacket` freezes the quote but reads game context and team features from live tables. |
| General revision store is empty | `nfl_feature_revisions` has zero rows. `nfl_pregame_snapshot_history` has 3,914 rows, but that is not a substitute for complete revision history of every feature. |
| Live neural model has no trained artifact | `nfl_online_neural_artifacts` has zero rows. Historical council neural experiments are a separate path. |
| Python tree libraries are already available | `research/.venv/bin/python` is Python 3.12.4; LightGBM, XGBoost, CatBoost, sklearn, pandas, scipy and TPOT are discoverable. Torch is absent. No installation is needed to start the tabular rebuild. Existing recorded runs also establish that these learners have executed before. |
| Tree tests were small, but not all 219 games | `server/data/tree-lab/latest.json` contains 1,795 market rows, not unique games. Its first movement folds use 219/215 games; later branches/folds reach 733. The 449 exclusions are reported as invalid/unpaired timestamp rows, not verified unique games. The extract explicitly restricts archive seasons to 2022–2025. |

The old tree results are negative evidence for the tested configurations. A small sample and limited features justify a better experiment; they do not establish that more data will make the model profitable.

### Remaining problem register

These items come from the recovered inventories, selected code checks, and existing evidence documents. Entries not independently reproduced in this review remain reported findings to validate during their implementation slice.

#### Learning and model construction

1. Challenger-only flags exclude nine components without a normal promotion path. Convert their legitimate underlying information into candidate features; do not grant them betting authority automatically.
2. The production council is disconnected from the primary forecast. Some roles are support functions with no forecast; “19 experts” does not mean 19 independent predictive models.
3. The coordinator applies another significance gate before combination. Its reported split-half check uses even/odd rows, not chronological folds.
4. `MIN_SEASON=2015`, pre-2022 component calibration, and Week-5 feature/audit defaults exclude useful old data, recent recalibration, and early-season games respectively.
5. Many formulas use fixed scales; several market-derived components reuse the same information. Raw blending can pull a strong market forecast toward weaker estimates.
6. Existing specialists reportedly stack in-sample predictions, and some same-day news filters lack timestamp precision. Reusing their output blindly can introduce leakage.
7. Listwise feature deletion, current-season-only warmups, and unexplained residual clipping discard data. Replace missingness with explicit flags and priors where appropriate; preserve genuine data-integrity exclusions.
8. Neural epoch resets and whole-week settlement dependencies can strand training examples. Preserve historical evidence across epochs while separating incompatible feature/model versions.
9. Signal-reliability updates are disabled in production and their artifact store was empty in the inventory. Multiple controllers currently apply overlapping shrinkage or authority rules.
10. Forecast combination, joint-score, and specialist code is not equivalent to an approved learned pipeline. The joint-score report explicitly uses synthetic data and does not clear its stated gate. Validate any distribution on real chronological football data before reuse for prices.

#### Data and time integrity

11. Scores/closing lines extend to 1999; raw plays, charting, player detail, and verified quotes do not. Backfill data by source and season, rather than just changing a year constant.
12. Older opening lines have mixed identities and provenance: contest lines, lookahead lines, and unresolved medians are not interchangeable with real opening quotes.
13. Some archive quotes are timestamped after kickoff; historical near-kickoff snapshots are sparse. Apply the actual decision cutoff, not merely “before kickoff,” when evaluating T−60.
14. Historical final weather is not a forecast. Use archived forecast vintages where available. Missing weather forecasts remain missing.
15. Injury rows are overwritten; absent publication/receipt times cannot be replaced with an assumed Friday timestamp and called verified history.
16. Imported ratings, retrospectively generated QB values, full-season coach game counts, Hi/Lo ratings, actual starters, and late-revised feature aggregates can encode the future. Audit each field, not just the enclosing table's timestamp.
17. Derived vectors/cards with thousands of features and a cutoff label need lineage checks. A hash proves identity, not historical availability.
18. Current-season team feature refresh and QBR season validation need fixing before claiming that the system adapts to current football.

#### Serving, evaluation, and betting

19. Quote-only freezing is insufficient for reproducibility. Freeze feature values, model artifact identity, preprocessing and calibrator, alongside the quote.
20. Calibration identity differs between historical raw/closing and live market-residual modes. Preserve identity checks and generate matching calibration; do not bypass the check.
21. Several policy/staking thresholds conflict: 200 versus 250 observations, fixed edge/disagreement limits, and a 24-point prediction-width ceiling versus observed 32–33-point widths. Outcome unpredictability is not the same as uncertainty about expected advantage.
22. Recorded staking remains disabled. Enabling units or deleting gates cannot create predictive value.
23. 2021–2025 has been repeatedly inspected. It is development data, including when tested by a chronological “blind audit.” A new model cannot acquire prospective evidence retroactively.
24. Trial history is incomplete. Record every new feature set, tuning choice and failed candidate, not just survivors. Multiplicity corrections cannot reconstruct forgotten experiments or erase prior selection.
25. Point accuracy alone cannot establish betting profitability. Need probabilities at the exact handicap, push treatment, attainable prices, fees where relevant, realistic fills, correlated exposure, and independent settlement/CLV grading.
26. More plays improve estimates of football processes; they do not create millions of independent game outcomes. Cluster validation by game/week across every model level.

## ML and AI evidence

The following usage map and counts are from the earlier September 14 inspection. They remain evidence of that state, not a new measurement after subsequent commits.

### Usage map

| Component | Is it ML/AI? | Does it drive the main betting forecast? | What to do |
|---|---|---|---|
| `nfl-ensemble.js` | Statistical learning: fitted component scales and blend weights, with many hand-built formulas | Yes, but the production residual mode zeroes all model contributions in every stored fit checked | Reuse honest football inputs; replace the component significance filter with regularized learning/combination |
| Python `tree_lab`, `market_lab` | Genuine ML: LightGBM, XGBoost, CatBoost, ridge and other estimators | No deployed Python artifact-loading path was found in the main forecast. `nfl-research-lab.js` reads their reports for display | Reuse the installed environment, extraction lessons and evaluators; build a shared training/scoring interface |
| Council boosted-tree and neural experts | Genuine custom ML implementations | Research/historical candidate paths; the council appears in unified projection detail, but does not set that projection's mean or the main auto-pick mean | Generate legal chronological features/predictions; compare with library learners before adopting |
| `nfl-online-neural.js` | A small neural network with a training routine | The auto-pick path can use an eligible artifact, but the artifact table contains zero rows | Diagnose capture/settlement lifecycle; do not present an untrained head as current learning |
| Expert coordinator/specialists | Ridge, robust fitting, nearest neighbors and rules | Mostly research; several filters zero influence, and one numerical defect invalidates fitted coefficients | Repair math, use out-of-fold training, reduce duplicated shrinkage layers |
| `gridiron-model.js` | Primarily a capability/permission router, not a trained “master model” | Controls/explains which components may inform or size decisions | Keep authority separate from learned prediction and name the distinction accurately |
| `nfl-unified-engine.js` | Composes ensemble forecast, simulation and explanatory heads | Ensemble supplies target means; simulation supplies score shape. Council/news are attached as detail | One output object is not end-to-end learning. Validate mean and distribution contributions separately |
| Claude news extraction | LLM converts stories into typed facts | Facts enter cards and candidate neural/specialist features; direct numerical authority is zero and no predictive contribution is established | Keep source spans, identity, timestamps and contradictions; learn football impact from data |
| Claude pick/page/tweet explanations | LLM translation and summarization | Explains existing outputs; does not create calibrated probabilities | Keep optional and grounded; measure cost/usefulness separately from forecasting |
| Historical Claude replay gate | LLM reviews a preselected bet and returns approve/reduce/abstain/press | Separate retrospective research. Code labels incomplete source timestamps and denies production promotion | Do not mistake prompt memory for model training or filtered backtest returns for live proof |
| AI execution slate | Claude proposes/reviews allocation over already-gated shopping/teaser opportunities | Can affect recommended allocation in a separate endpoint; does not forecast game outcomes or transmit wagers | Require a deterministic allocation baseline and measured incremental benefit before crediting AI |

### What the usage records show

Recorded application API usage spans July 31–September 14. These records do **not** include the separate Claude desktop research conversation or its subscription usage, and token counts are not a billing reconciliation.

- 178 typed-news extraction calls; current signal table has 163 verified Claude-extracted signals and 36 quarantined ones. Rules separately generated 288 verified and 71 quarantined signals. Counts represent current rows, not extraction precision or recall.
- 557 tweet/line explanation calls, 32 page explanation calls, and 11 pick explanation calls.
- 203 historical replay-gate calls recorded on August 24. The current `nfl_ai_replay_runs` table is empty, so the corresponding performance cannot be established from that table today. The discrepancy needs provenance investigation, not an invented result.
- 28 execution-slate proposal calls and 28 review calls, recorded September 7. Calling an LLM twice is not independent verification; the review sees its own initial allocation.
- The newer news-event extractor and press-role inference have only one recorded call each. The event table holds 10 news-item and 20 press-conference events.
- Team-analysis prose accounts for 536 calls, approximately 1.49 million input and 350,335 output tokens. It is not evidence of a trained game predictor. Fantasy/draft calls were also recorded but are outside this review's scope.

There is real AI activity. There is no demonstrated link here from the volume of that activity to an improved betting forecast. No fine-tuning API path was found in the inspected server/research code. The replay's “learning memory” supplies past summary statistics in a prompt; it does not update Claude's model weights.

### AI-specific weaknesses

1. **Fact extraction is not impact estimation.** The news expert uses fixed multipliers such as burden difference ×0.75 (and a fallback ×0.5). Claude identifying “QB out” does not mean the system learned the replacement's effect or what the market already priced.
2. **Extraction confidence is not win probability.** Keep text confidence, source reliability, player availability probability and forecast uncertainty as separate quantities.
3. **News timing needs both clocks.** `playerNewsSignal` filters `published_at` but not the time the app first received/extracted the claim. Historical reconstruction must not label a later extraction as a captured-before-decision fact. The typed-event path has `first_seen_time`; carry this through the shared feature contract.
4. **Outcome-blind prompts do not prove historical blindness.** A modern pretrained LLM may know identified historical games. The replay packet includes game identity; hiding the score alone is insufficient. Treat such experiments as retrospective and test contribution prospectively.
5. **Self-review is not an independent forecast.** Allocation simulation evaluates assumptions supplied to it; a persuasive second explanation cannot validate the assumptions or the probabilities.
6. **Labels overstate integration.** “Unified engine,” “expert council,” “learning memory,” and “research complete” refer to different mechanisms. Surface the actual artifact ID, training-through date, current input age and contribution to the served number.

## Recovered Claude research and audits

The recovered collection is substantial. Much was in Claude's temporary session folders rather than the repository's docs directory; the preserved originals and source manifest remain available.

- **Research2:** 56 main topic reports, two architecture/code catalogs and 12 scoring-note documents, totaling 70 Markdown files. Topics include point-in-time data, forecast combination, Bayesian ratings, shrinkage, conformal calibration, multiple testing, sequential inference, NFL margins, copulas, injury/news effects and deeper ML architectures.
- **September 14 methods sweep:** 14 reports and 13 verification reviews. The open-source survey has no completed verification result.
- **System audit:** 59 Markdown documents, including the large full-system synthesis and detailed code-group reviews.
- **Audit-system review:** 41 Markdown documents covering historical evaluation, timing, evidence and deployment consistency.
- **Plans and references:** the Giant Plan, What Next, master-plan versions and 81 source/reference files. Some are PDF/text duplicates; this is not 81 unique papers.

The final learned-model redesign produced four inventories, but the design, critique and revised specification failed at the usage limit. A completion notification did not mean the final design was delivered. The broader scale sweep had no finished reports in its journal. The original audit also has a completeness critique documenting coverage gaps; do not describe it as verified line-by-line coverage of everything.

Read relevant reports together with verification corrections when implementing their slice. Historical reports contain superseded findings; the problem register distinguishes reproduced checks from items still requiring confirmation. The current plan incorporates selected research methods with explicit jobs and validation requirements, rather than assuming advanced terminology proves correctness.

Original evidence entry points:

- [Research and audit index](../../archive/recovery-indexes/START-HERE-research-and-audits.md)
- [Complete preserved inventory](../../archive/recovery-indexes/INDEX.md)
- [Full system audit](../../audits/recovered-line-by-line/SYSTEM_AUDIT_2026_09_11.md)
- [Audit completeness critique](../../audits/recovered-line-by-line/COMPLETENESS-CRITIC.md)
- [Audit-system review](../../audits/recovered-audit-system/AUDIT_SYSTEM_REVIEW.md)
- [Recovered research architecture](../../research/advanced-methods-and-github/FIX_AND_ADD_ARCHITECTURE.md)
- [Recovered GitHub catalog](../../research/advanced-methods-and-github/GITHUB_BUILD_CATALOG.md)
- [Claude's Giant Plan](claude-september-12/GRIDIRON_GIANT_PLAN.md)
- [Claude's What Next](claude-september-12/WHAT_NEXT.md)

The implementation, data/research choices, improvement-selection process and acceptance requirements are consolidated in this master document. The linked originals preserve supporting evidence and historical context.
