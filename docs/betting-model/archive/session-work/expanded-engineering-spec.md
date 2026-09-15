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
