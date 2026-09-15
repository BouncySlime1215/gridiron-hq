# Gridiron HQ betting model — implementation plan

**Current execution detail:** see the [master plan](MASTER-PLAN-2026-09-14.md#weekly-training-news-backfill-and-claude-execution-instructions) for the later code reconciliation, weekly training and news/injury backfill procedure, and [Claude instructions](../CLAUDE-IMPLEMENTATION-INSTRUCTIONS.md) for the ordered handoff.

## Decision

Proceed to implementation planning and staged engineering. The recovered research is sufficient to start. Additional research should answer a specific unresolved implementation question, with a defined decision it could change.

Scope: the NFL betting model and its supporting data, training, predictions, pricing, evaluation and monitoring. Fantasy/UI work is outside scope except where a shared dependency prevents the betting pipeline from working.

This plan builds on `gridiron-betting-continuation.md`, `gridiron-ml-ai-audit.md`, and the recovered research/audit index. It does not assume that old audit findings remain unfixed or that changing the architecture guarantees an edge.

**September 14 additions:** [Data sources, research adoption and overfitting controls](../DATA-RESEARCH-AND-OVERFITTING.md) makes the source priorities, research-to-code mapping, and required audit checks concrete. These requirements are part of the stages below, not an optional future research project.

## Target behavior

For every game, the system should be able to show:

1. What it knew at the decision time.
2. Which trained model and calibrator it used.
3. Its predicted margin, total and relevant probabilities.
4. How its forecast differs from the market available then.
5. Whether the offered price justifies a bet, and why it bet or abstained.
6. What happened afterward, including the final score, closing price and prediction error.

The same saved inputs and model must reproduce the same answer. Training and evaluation must exercise the same prediction path used by the app.

## Stage 1 — repair the foundation

**Purpose:** stop feeding broken or stale information into new experiments.

- Reconfirm current status of the specialist fitting defect, corrupt QBR season rows and missing 2026 team features; repair their producers and add targeted regression tests.
- Quarantine invalid records in research extracts. Do not silently rewrite original evidence or erase failed experiments.
- Make a per-source coverage/freshness table: earliest season, latest completed game, missing values, available timestamps, and whether the source can support historical reconstruction or actual prospective capture.
- Separate learning filters, data-integrity checks and betting-authority rules. Identify one owner for each; mark duplicated or incompatible rules for replacement.
- Freeze the baseline code/configuration and historical comparison results before changing model behavior.
- Audit the safeguards themselves: correct the claim that Holm assumes independent trials; treat the MCMC-derived effective-trial count and reconstructed-return diagnostics as unvalidated for promotion. Use aligned prediction/loss panels and independently checked statistical implementations.

**Done when:** valid current-season features update after settled games; invalid future/duplicate QBR rows cannot enter features; specialist coefficients are finite; each input's freshness and provenance is visible. Existing live capture continues undisturbed.

## Stage 2 — create the shared training data

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

## Stage 3 — train a small, serious first model

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

## Stage 4 — connect the complete prediction path

**Purpose:** make the app consume an actual trained model rather than just display research reports.

- Save immutable model artifacts with feature schema, preprocessing, training cutoff, code/data hashes and calibration identity.
- Initially score with the same Python pipeline used offline. Add a Node adapter; postpone a second-language implementation until needed and require numerical parity if introduced.
- Freeze actual feature values and model references in the decision packet, alongside the quote. Remove mutable-table rereads from the learned prediction path.
- Wire the candidate through the T−60 runner, prediction board, decision ledger, settlement and closing-line grader.
- Handle missing artifacts, late data, duplicate retries and restarts explicitly.
- Consolidate betting controls into one versioned policy. Preserve timestamp, numerical validity, execution and exposure checks. Replace mismatched identities and duplicate thresholds with consistent contracts.
- Preserve a decision trace: candidate forecast, served forecast or fallback, calibrator output, offered price, expected value, each gate's result and final action. This lets the error report distinguish a weak learner from a model that never reached the decision, or an advantage lost at execution. Any hypothetical outcomes from bypassing a gate are diagnostic and cannot authorize bypassing it.

**Done when:** one game passes from frozen inputs through trained forecast to recorded shadow decision/abstention and later grading; replay gives the same result after live tables change. Then demonstrate the same behavior across the eligible slate. No automatic increase in live stakes accompanies integration.

## Stage 5 — validate the system as a whole

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

## Stage 6 — choose additions from measured weaknesses

The diagnostic process starts in Stage 3 and continues through shadow serving; it must not wait until this stage. The items below are candidate families, not an automatic build queue. A working system can also conclude that no addition has earned priority.

### Required improvement process

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

### Candidate families after the first complete path works

1. Improve QB/player quality, expected usage, availability and replacement effects.
2. Add play/drive models for efficiency, pace and matchup information; aggregate them into game-level features.
3. Evaluate a joint score distribution/simulator against the simpler calibrated probability baseline.
4. Build a separate early-price/line-movement model if quote coverage supports it.
5. Revisit graph networks, transformers or foundation models only when a specific remaining problem justifies them.

Each addition needs earlier-only upstream predictions and a full-pipeline comparison. More plays or simulated games do not count as additional independent betting outcomes.

## Research and GitHub adoption commitments

The recovered research is explicitly part of the implementation. The [detailed adoption map](../DATA-RESEARCH-AND-OVERFITTING.md) records report identifiers, existing code, assumptions and source links.

| Planned role | Research and code to use |
|---|---|
| Trustworthy historical inputs, Stages 1–2 | Point-in-time/revision research; extend nflverse ingestion; nflreadpy optional if it simplifies access |
| First learned forecasts, Stage 3 | Dynamic team/QB strength and shrinkage, regularized forecast combination; existing sklearn/LightGBM and chronological predictions |
| Probabilities and uncertainty, Stages 3–5 | Calibration, discrete NFL margins/pushes and conformal research; existing corrected code checked against MAPIE |
| Honest selection and evaluation, Stages 1/5 | Harvey–Liu/multiple-testing research, trial registry, chronological evaluation and dependence-aware comparisons; arch as a statistical reference, DSR/PBO only after assumption checks |
| Choosing improvements, Stages 3–6 | Error reports, refitted ablations, declared comparisons and later confirmation; nfelo as a rating benchmark/reference after vintage and license review |
| Conditional deeper work, Stage 6 | Full Bayesian Stan/PyMC models, copulas, injury networks, play models, graph networks and transformers only against a documented weakness and simpler baseline |

Adoption means a method has an assigned purpose and verification requirement; it does not mean all these methods are already in production. Pin adopted versions, preserve licenses/source references and record the relevant paper/report in each build-ledger entry.

## ML and Claude roles

**ML:** learn numerical relationships, forecast distributions, calibrate probabilities and estimate useful corrections to the market.

**Claude:** extract supported facts from text, preserve source evidence, identify contradictions, and explain recorded predictions. Extraction confidence is not a win probability. Any AI-driven allocation or risk-review contribution must compete against a deterministic baseline separately.

## First implementation delivery

Deliver Stages 1–2 and a narrow Stage 3 experiment first: repaired data, a common dataset with a coverage report, one properly trained candidate evaluated against the market, and the error report/improvement backlog described above. Follow immediately with the complete shadow-serving path; do not let the experiment become another disconnected research tab.

Maintain one build ledger for each slice: problem, files changed, evidence reused, tests, measured result and remaining limitation. Reconcile relevant old findings against current code as the slice begins. Preserve the recovered corpus rather than repeatedly rereading or redoing it.

The immediate next action is Stage 1's code-and-data repair slice. Further broad research is not a prerequisite.
