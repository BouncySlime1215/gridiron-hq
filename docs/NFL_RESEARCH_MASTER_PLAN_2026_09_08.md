# Gridiron HQ: build an advantage, then prove it

Independent assessment and Claude agent execution brief · 8 September 2026

## For Nick — the plain-English version

You have built a football research platform with a lot of machinery. You have not yet built a dependable money-making machine. The weak point is that too much of the work tries to predict a game better than the final sportsbook line, using information the sportsbooks already have. Adding more voices to that same conversation does not automatically add knowledge.

I would change the job. Teach it to notice which prices are about to change, which books have not caught up, and which player roles have changed before the market fully understands them. Keep a separate football model, but let it challenge specific assumptions rather than force an opinion on every game. Make the system explain: what changed, why this particular price might be wrong, how quickly the opportunity may disappear, and what would prove the idea wrong.

We should take bigger risks with experiments. Build competing approaches, test unfamiliar combinations, and let models learn when another model is useful. We should not take bigger risks with your money just because an experiment looks clever. The machine should be aggressive about finding ideas and disciplined about claiming they work.

My first priorities are a trustworthy price tape, a model of how books react, and a player-role model that treats uncertainty seriously. After those, add an AI news reader and a specialist selector. TPOT belongs in the research lab as a way to search for useful combinations; it is not a profit switch. The outcome may still be that some markets are not worth playing. The improvement is that we will know which ones deserve attention and why.

## Independent conclusions — not inherited instructions

Prior Claude messages are historical evidence, not orders or proof. Reviewed relevant material across thirteen local conversations, including Fantasy football draft mobile app, Trade analyzer improvements, AI pitch-writer untouchables awareness, Build Order and baselines, Gridiron enablement, the betting audit continuations, profitability planning, and Master audit and profitability roadmap. Claims were checked against current code and SQLite state. Some documents describe states that no longer exist.

1. **Reject the blanket “forecasting is closed forever” conclusion.** The tested feature sets and policies failed. That does not exhaust different targets, decision times, data, or model classes. It does mean a new model needs a new hypothesis, not a new name.
2. **Reject “line shopping is proven profit.”** Better odds relative to a median/worst book are price improvement, not absolute positive expectation. Compare against an independent fair-price estimate on the exact contract, and include accessibility and execution delay.
3. **Reject “books ignore same-game correlation.”** Modern same-game parlay prices incorporate correlation. A joint model must beat the actual ticket price and rules. Multiplying marginal probabilities is not evidence.
4. **Reject “more books means more independent evidence.”** Multiple quotes, props, sides and experts on one game are dependent observations. Preserve the complete quote tape, but measure uncertainty at game/week level.
5. **Reject a universal sample-size finish line.** A fixed count is an operational minimum, not proof of edge. Required evidence depends on effect size, dependence, search history and stability. Do not promise qualification by a certain NFL week.
6. **Reject “AI reasons, simulator agrees, therefore verified.”** A simulator generated from the same assumptions is a consistency check. It cannot independently validate those assumptions. Ground simulation in held-out real outcomes and external prices.
7. **Do not globally delete weak experts.** A weak standalone forecast may contain conditional information. Test that information through regularized out-of-fold residual stacking or regime-specific experts. Do not simply average weak predictions into production.
8. **Do not automatically stop on two losing weeks or refit until a backtest wins.** Both are selection policies that must be tested. Separate data-break alarms from statistical evidence of decay; retain the original frozen strategy for an honest comparison.

## What actually exists now

Repository: `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard`; initial working tree clean except existing `scratchpad/`.

- Hand-built boosted trees in `server/services/nfl-gbm.js`; market-residual training and season walk-forward evaluation already exist. “Add trees” by itself is duplicate work.
- Team ensembles, an expert council, online neural models, Bayesian/mixture risk challengers, shared player-week forecasts, props, line shopping, news/line watchers and immutable evidence stores already exist.
- Historical game data covers 1999–2025; team-week play-by-play features cover 2016–2025. The inspected database holds 135,930 archived odds rows and over 750,000 quote-tape rows. Their size is not their effective training sample.
- Last completed comparable blind audit: run 17, 56 weeks, 831 games; its betting subset loses. Run 19 failed after 25/56 weeks. Run 18 is merely registered. Do not present run 19 as pending success or report its partial data as complete.
- Current cover calibration is blocked. Multiple forward ledgers exist, but the inspected `forward_picks` table is empty and expert-forward settlements are empty. The season has not yet produced results in this database; empty settlement counts alone are not a settlement bug.
- Fantasy/player additions were already tested as betting challengers. They did not demonstrate the required incremental benefit. Shared inputs should remain available; fantasy accuracy does not imply profitable prop probabilities.
- The shopping board cached time-sensitive eligibility indefinitely, accepted a capture age up to one day in its summary, and could label stale comparisons live. This session fixes the wall-clock expiry path and adds regression tests.
- `nfl-gbm.js` reconstructs actual kickoff weather as a feature. That can support retrospective football diagnosis, but it is not a historical pregame forecast. The new research runner excludes that shortcut.
- `line-move-study.js` groups some external ratings at opening time without proving the exact forecast version existed then. Wednesday/Friday features can also be paired with an opener no longer available. Existing labels warn about some of this; a hypothesis still needs a truly executable decision-time dataset.
- Historical multi-book archive fetch time is today, while book timestamps describe the past. These are reconstructed third-party records, not our own contemporaneously captured receipts. Preserve that distinction.

## Concrete work started in this session

- Added an isolated Python market research runner: `research/market_lab.py` and `research/requirements.txt`.
- Target: opening-to-closing movement, separately for spreads and totals. Competes against “no movement,” ridge, histogram boosted trees and extra trees; optional bounded TPOT searches.
- Uses a read-only transaction on the existing database. Requires paired opening sides, matching contracts, real prices, valid ordering and a pre-kickoff close. Prior results/features have a conservative availability delay; no kickoff weather or unverified news/ratings are admitted.
- Whole-week expanding inner validation, purged labels and a week embargo; candidate selection happens before scoring each outer season. Persisted protocol, dataset/code hashes, attempted TPOT candidates, model files, predictions, per-season results and uncertainty intervals. Historical opening-price ROI remains indicative, not executable proof.
- Adds an Engine → Research lab view showing live data/audit state, actual experiment results, failed searches, research limits and the plan. No production promotion or stake authorization.
- Fixes stale shopping eligibility and misleading claims. These are reliability improvements, not claims of higher expected profit.

This is a starter laboratory, not completion of the research program below. Its short initial TPOT run is a wiring/evaluation pilot, not an exhaustive search. Read the saved report for what ran and failed.

## The architecture to build

`Timestamped observations → canonical exact-contract tape → point-in-time features → independent forecasting heads → out-of-fold selector → execution simulator → frozen paper decisions → settlement/close → evaluation → explicit promotion`

Keep three forecast targets distinct:

- **Football outcome:** a distribution over margin, total and player events.
- **Market response:** where a specified reference price will be later, and when it will move.
- **Execution:** whether a quoted advantage is still available after realistic delay and under the user's actual access/limits.

The economic objective is expected net return at an obtainable price under uncertainty. Predictive losses help estimate that quantity; they are not interchangeable with it. In particular, MAE of line movement is a first research target, not a final staking objective.

## Agent operating contract

One integration owner assigns bounded packages below. Separate worktrees for agents; no concurrent writers to the live SQLite database. Inspect current code and contracts before adding modules. Never run a historical “rebuild” directly against personal league data. Use immutable extracted datasets or read-only connections; migrations and ingestion changes require a backup and explicit rollback procedure in the PR.

Every experiment must specify: economic hypothesis, exact market/side/line/book, decision horizon, data publication times, target/label time, baseline, model search budget, split policy, all attempted trials, selection rule, costs, failure criteria and artifacts. Record the declaration before seeing its evaluation. Previously opened 2022–2025 data stays research forever; reserve new forward blocks prospectively.

The split policy is declared by **citing `OOF-1`** (see "Acceptance and release"), not by restating it. Cite the rule, then declare only what your package adds on top of it — the block boundaries, the embargo margin, the group unit if it is finer than a week. If you find yourself writing out the isolation rule in your own words, you are about to weaken it.

Every agent returns: what changed; what it depends on; what genuinely ran; results including negatives; tests; source/license provenance; rollback; and a short explanation for Nick. Do not call a stub, permission gate, future-data dependency or merely registered run “complete.” Do not add another top-level navigation section for each experiment.

### A — Evidence and exact contracts (first dependency)

**Owner:** data agent. **Existing code:** `nfl-quote-tape.js`, `odds-archive.js`, `nfl-evidence-provenance.js`, `nfl-event-archive.js`, `source-registry.js`, `book-feeds.js`.

Build a canonical key including league, event, participant, market, period, side, line, overtime treatment and settlement rule. Store source publication, provider retrieval, our receipt, decision and availability times separately. Resolve team/player aliases without fuzzy silent binding. Store raw payload hash and provenance; keep duplicates in raw data but deduplicate learning observations.

Add a bitemporal feature interface: `value_as_known(entity, feature, decision_at)`, retaining revisions and not just the latest value. Ingest freshness is distinct from price change time: an unchanged direct price can be current, an aggregator copy can be old. Require a source-specific validity contract, then snapshot market status and book timestamp alongside the price.

Audit archive timestamps and historical ratings explicitly. A nfelo row named “pre” is not proof of an opening-time vintage. Labels may use a close; features may not. An asynchronous third soft-book opener must not use first/second-book prices assumed to remain available. Report dropped rows by reason and selection bias from dropped coverage.

**Deliver:** versioned dataset builder, quarantine report, source-health view and chronology tests. **Done when:** fabricated future features, stale quotes, mismatched periods/lines and duplicate events all fail closed, with representative real source rows preserved for inspection.

### B — Learn who moves the price, and who follows (highest research priority)

**Owner:** market-microstructure agent. **Depends on:** A. **Existing:** `sharp-lag.js`, `nfl-shopping-board.js`, `nfl-quote-tape.js`, `beat-the-close.js`, `line-move-study.js`.

Do not hardcode a permanent “sharp” book. Estimate lead/lag relationships per market and horizon from asynchronous price innovations, controlling for shared providers. Compare a regularized distributed-lag model, boosted trees and a marked-event/hazard model. A Hawkes-style model is an optional high-risk challenger only after timestamps support it; common news arrivals can mimic book-to-book causation.

Predict: probability and size of the reference book's next move; time until the offered book follows; probability an opportunity survives the proposed delay. Use exact same-line no-vig prices first. For changing lines, fit a discrete margin distribution conditional on spread/total; unconditional key-number frequencies are not adequate for every game.

Evaluate at receipt time plus measured delays, not at the originating source timestamp. Simulate 5s, 30s, 2m and 10m delays, disappearance, suspension, one-step price worsening and stake limits. Route output to “watch / refresh / paper opportunity” states.

**Deliver:** trained response models, book relationship explorer and delayed-execution replay. **Failure criterion:** apparent gain vanishes after freshness and delay checks, or cannot beat a simple reference-price baseline on new weeks. Keep useful timing predictions even if they do not justify wagers.

### C — TPOT and tree research factory (starter built; extend it)

**Owner:** tabular ML agent. **Depends on:** A; can extend the starter with current reconstructed data while A progresses.

Use the existing `research/market_lab.py` as a baseline. Add LightGBM/CatBoost/XGBoost as separate, bounded families. Compare classification of cover/over outcomes, quantiles of residuals, and line-movement regression. Consider a ranker over opportunities within a slate, but preserve real dollar return as the downstream evaluation; ranking metrics alone do not prove value.

TPOT must receive chronological, grouped, label-purged folds. Never use default random folds, randomized final validation, or a scaler/calibrator fitted on all years. Fit calibrators only on prior out-of-fold predictions. Count every attempted pipeline/threshold/feature search, retain failed candidates, and freeze a small chosen policy before opening a new forward block.

Search residual interactions such as: market movement × quarterback uncertainty; offensive line continuity × opponent pressure; pace × available pass catchers; forecast revision × stadium exposure; rest/travel × game time. Include missingness flags, age of information and a market-only baseline. Do not use SHAP importance as causal proof.

Advanced branch: a market-anchored probability model, `logit(p) = logit(p_market) + residual(features)`, with shrinkage of the residual learned only on earlier folds. Another branch: quantile predictions with coherence checks, key-number push mass and held-out distribution calibration. Start with separate markets; allow multitask sharing only after demonstrating transfer without negative transfer.

**Deliver:** reusable experiment manifests, candidate registry, model cards, exported pipelines and drift checks. **Done when:** reruns reproduce splits and results, synthetic leakage tests fail, and selection produces a frozen forward-ready artifact. A failed model with an honest result is a completed experiment, not a promoted model.

### D — Player roles, not a single yards guess

**Owner:** player-distribution agent. **Depends on:** A. **Existing:** `player-week-engine.js`, `nfl-player-state.js`, `role-changepoint.js`, `nfl-teammate-competition.js`, `nfl-props.js`, `nfl-prop-calibration.js`.

Represent a player's future role as scenarios: full role, limited role, backup share, inactive, and teammate-return states. Separate availability, snaps/routes, opportunities and efficiency. Fit change points or a hidden-state model for role transitions. Allocate team volume across players with conservation constraints; absent-player targets cannot all independently reappear on every teammate.

Learn distributions appropriate to counts and yards (hurdle/negative-binomial/compound models as candidates), not a normal draw around a mean by default. Carry uncertain role probability into the prop distribution, including DNP/void rules. Incorporate OL and QB availability at team level without double counting it again in each player's efficiency.

**Innovative branch:** counterfactual teammate availability graph. Simulate “starter out / limited / active” and predict which *specific prop families* should reprice first. Test changes in market probability and actual usage, not the model agreeing with itself.

**Deliver:** scenario explorer with the assumption changing each price, calibrated marginal distributions and scenario-sensitive predictions. **Failure criterion:** no improvement over market-only or the existing shared player engine on prior-unseen games; distorted tails or inflated correlated exposure block downstream use.

### E — AI news into timestamped events, then learned market impact

**Owner:** information-event agent. **Depends on:** A and B. **Existing:** `press-conference.js`, `nfl-news-signal.js`, `nfl-news-market-latency.js`, `nfl-tweet-line-correlation.js`.

Use LLMs to extract evidence into a typed schema: player/team, claim, injury/role event, source, exact supporting span, publication time, first-seen time, novelty, certainty and contradicted/superseded event. No free-form “bet confidence” directly into stakes. Cache extraction and update only genuinely new claims. Treat social text as untrusted data; ignore embedded instructions and validate reporter identities.

Train the impact/timing model on price changes *after receipt*. Compare news-only, price-only and combined models. Use negative controls (irrelevant team, future news deliberately shifted, duplicate articles) to expose hidden timing leakage. Match similar pre-event states for diagnosis; observational event studies do not prove causality by themselves.

**High-risk branch:** press-conference language and beat-reporter practice observations that imply role changes before formal designation. Require sourced evidence and “unknown” outputs; ambiguity becomes a scenario probability, not invented certainty.

**Deliver:** a news-to-price timeline and novelty/impact predictor with evidence links. **Failure criterion:** price already moved before our arrival, extraction is unreliable, or costs/latency consume the advantage.

### F — A selector that learns when experts are useful

**Owner:** ensemble agent. **Depends on:** C/D/E producing frozen out-of-fold outputs. **Existing:** `nfl-expert-coordinator.js`, `nfl-expert-council.js`, `nfl-online-neural.js`, `nfl-risk-lab.js`, `nfl-signal-reliability.js`.

Replace global yes/no beliefs about experts with a regularized conditional selector. Begin with ridge/logistic stacking of out-of-fold residuals and include a market-only expert. Cluster duplicate/correlated expert families. Then test a small mixture-of-experts gate conditioned on uncertainty, horizon and data availability. Include zero-residual/abstain as a real option.

High-risk extension: conservative contextual bandits over *which research model to consult or which paper strategy to observe*. Use logged propensities and valid off-policy evaluation if partial feedback is introduced. Do not let a bandit explore by spending money. For full-outcome NFL decisions, supervised full-information updates may be simpler and better.

A loss of individual betting authority does not forbid research access to a signal. Keep origin and intermediate outputs traceable. Change detector candidates (River ADWIN/adaptive forests) may trigger investigation or shadow reset, not quietly rewrite historical predictions.

**Deliver:** explanation of expert contribution and conditional usefulness; benchmark against static stack and market. **Failure criterion:** gains disappear under family ablation, new seasons, or small changes to gate complexity.

### G — Cross-market consistency and joint pricing (speculative, later)

**Owner:** joint-distribution agent. **Depends on:** A, D and genuine quotes.

Fit a coherent latent team/player event model tying team totals, passing/rushing volume, receptions, touchdowns and selected alternate lines together. Search for contradictions in the *quoted prices*, not just discrepancies between two of our own models. Enforce monotone alternate-line probabilities, event compatibility, participant rules and correct push/void handling.

Test copulas or shared-latent-factor models against simple conditional-independence baselines. Compare the actual SGP payout to a joint distribution learned on prior real games. Use sport/market-specific uncertainty; do not assert that books forgot correlation. Separate a real guaranteed payoff inequality from a model-dependent EV estimate. A future exchange branch must model fees, depth, partial fills and settlement differences; no “same sport means same contract.”

**Deliver:** contract-consistency scanner and research ticket analysis. **Failure criterion:** edge disappears after same-contract matching, joint calibration or actual ticket pricing. No new live ticket generator before this evidence exists.

### H — Execution simulator and experiment economics (build before promotion)

**Owner:** execution/evaluation agent. **Depends on:** A; B/C can supply candidates later. **Existing:** `nfl-execution.js`, `nfl-execution-edge.js`, `nfl-prop-clv.js`, `nfl-teaser-execution.js`, `staking.js`.

Track offered, observed, decision, refreshed, accepted and settled states separately. User-recorded acceptance is not an automatic sportsbook execution. Model accessible books and limits supplied by Nick; unavailable/offshore/restricted books can inform research but must not silently become executable prices.

Replay realistic slippage, missed fills, correlated positions, voids, maximum loss, fees and changing bankroll. Report price improvement separately from fair-price EV and realized results. Both legs must be available for a middle/arb. Stored extreme prices should be challenged first, because they often represent bad joins or stale feeds.

Compare fixed small paper stakes and uncertainty-shrunk fractional Kelly after probabilities are calibrated. Do not infer safe bet size from historical hit rate. Keep an aggregate game/player exposure budget. Stress tests should include QB scratch, feed outage, correlated slate shock and model probability error.

**Deliver:** a replayable decision/acceptance ledger and P&L attribution separating prediction, price selection, timing and luck. **Done when:** synthetic guarantees/pushes/missing fills reconcile exactly and real paper decisions are re-creatable from frozen evidence.

### I — Research product and lifecycle (integration owner)

Extend the new Research lab rather than adding more disconnected screens. Show four things first: what can be used now; what is being tested; why an idea failed; what must happen next. Keep the full technical evidence behind expandable details.

Add a durable experiment queue with run IDs, progress, error/cancellation state, worker heartbeat, saved protocol and resumable stage boundaries. Heavy ML must run outside the web server. Do not resume an old audit after its code hash changes. Audit 19 is failed; start a new run only if it answers an explicit new question. Preserve last completed evidence independently from latest attempted evidence.

Expose the exact engine version and decision cutoff, quote age, missing sources, abstentions and forward status in each research opportunity. An AI explanation should cite the evidence packet and state what would invalidate its conclusion. Never turn a successful software build into a green profitability badge.

**Deliver:** coherent UI, accessible errors/empty states, report download, experiment cards and one integration runbook.

## Scheduling and priority

These are suggested bounded assignments, not promises of profitable completion dates.

| Wave | Work | Intended outcome |
|---|---|---|
| First | A + H + I; C extends the pilot on immutable extracted data | Correct evidence, realistic replay, visible status and reusable training |
| Next | B and D; C benchmarks their new features | Test book response and changing player roles |
| Then | E and F | Extract genuinely new information and select experts conditionally |
| Speculative | G, advanced hazard models, richer sequence models | Test joint price inconsistency and more complex dynamics only with sufficient data |

Suggested research allocation: most effort to B/D and data needed by them; a smaller part to C/E/F; a bounded exploration allocation to G. Track experiments killed as well as experiments advanced. Stop a package when its information requirement is unavailable; deliver the exact missing feed/vintage contract rather than inventing replacements.

## Data acquisition — buy or scrape only what answers a question

| Source | What it contributes | Important restriction |
|---|---|---|
| [nflverse releases](https://github.com/nflverse/nflverse-data) | Outcomes, usage, snaps, NGS, play-by-play, rosters | Publication schedules differ; historical revisions are not historical snapshots |
| [nflverse availability schedule](https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html) | Cadence and known missing feeds | Injury source stopped after 2024; participation data from 2023 onward is postseason-only, so do not use it as an in-season known feature |
| [nflverse nfldata](https://github.com/nflverse/nfldata/blob/master/data/games.csv) | Independent schedule/result reconciliation | Closing fields are evaluation labels or close-time features, never opening-time facts |
| [nfelo](https://github.com/greerreNFL/nfelo) | External rating benchmark, QB adjustment concepts | Already integrated; verify version availability and market dependence before claiming independent opening-time signal |
| Existing direct/aggregated book feeds | New timestamped quotes and market responses | Record source timestamp and receipt; respect access controls and reasonable backoff; public availability is not evidence of executable book access |
| [The Odds API historical data](https://the-odds-api.com/historical-odds-data/) | Timestamped additional-market snapshots, including props | Paid plan required; request a specific small market/horizon sample only after a quality check, not an unbounded purchase |
| Official team practice/injury reports, pressers and weather forecast archives | Event timing and plausible role/forecast changes | Need actual publication/forecast vintages; later recap text cannot become earlier evidence |

A public schedule CSV was downloaded and pinned by commit and SHA-256 during this review. It is an independent reconciliation source. Do not confuse downloading another copy of already-held data with adding predictive information. Keep repository licenses and dataset/provider terms separately documented; data-use rights and code licenses are different.

## Methods worth borrowing, and what they do not prove

- [TPOT](https://epistasislab.github.io/tpot/latest/tpot_api/regressor/): searches pipelines; its own documentation warns about overfitting cross-validation. Supply our temporal folds and keep search bounded.
- [scikit-learn temporal validation](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html): useful reference; ordinary row-based splitting does not by itself keep related games, quotes and future labels out of training.
- [CatBoost quantile and uncertainty losses](https://catboost.ai/docs/en/concepts/loss-functions-regression): concrete tools for conditional distributions. Their intervals still need calibration and temporal evaluation.
- [LightGBM ranking](https://lightgbm.readthedocs.io/en/stable/pythonapi/lightgbm.LGBMRanker.html): can rank opportunities within groups; ranking quality does not guarantee positive returns.
- [River adaptive forests](https://riverml.xyz/dev/api/forest/ARFRegressor/): possible streaming challenger and drift instrumentation. A detected shift does not identify its cause or justify automatic staking changes.
- [Moskowitz, Asset Pricing and Sports Betting](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2635517): evidence that financial-style patterns can be studied in betting markets. It is not proof that our NFL implementation survives vig and execution costs.

## Acceptance and release

**OOF-1 (canonical OOF-isolation statement).** Every package's `split_policy` declaration (required by the Agent operating contract above) independently restates some version of the same rule: folds are chronological and grouped; any calibrator, shrinkage prior or risk threshold is fit on training-fold data only and scored on untouched, later, out-of-fold data; a one-week (or equivalent) embargo separates a fold boundary's train and test sides. That rule is now stated once, here, as **OOF-1**, and a future package declaration should cite "OOF-1" rather than re-derive its own wording — restating it independently, package by package, is how a future declaration ends up a subtly weaker version by accident (see docs/MODEL_ARCHITECTURE_ASSESSMENT_2026_09_08.md Part 3.5 and Part 4 item 5, which first identified this as worth consolidating). OOF-1 is not exempted for anything framed as "risk management" rather than "alpha" — a corridor width, a downsize coefficient or a staking threshold tuned on the same data it is evaluated on is exactly as overfit as a model tuned that way (Part 1.4). Package H's two stress-test rules (the Market Line Corridor threshold in `nfl-execution-corridor.js`, and the CLV-miss-triggers-downsize control law in `nfl-execution-clv-downsize.js`) both cite OOF-1 directly instead of restating it.

An idea moves through: specified → data-qualified → implemented → historical diagnostic → frozen forward → evaluated → eligible for review. There is no shortcut from a good backtest to production authority.

### OOF-1 — the out-of-fold isolation rule

Every package's split policy previously restated some version of this rule in its own words. That is how a subtly weaker version gets adopted by accident. **This is the canonical statement. A package declaration cites `OOF-1`; it does not paraphrase it.** A declaration may strengthen the rule and must say how. A package that genuinely needs something weaker must name the specific clause it is relaxing and defend it in the declaration, before evaluation — never in the write-up afterwards.

1. **Splits are chronological, never shuffled.** Test blocks are strictly later than training blocks. Random k-fold over a pooled set of games is not an acceptable estimate of skill on this data at any sample size.
2. **The group unit is the week, not the game.** Games in a week share weather regimes, injury news cycles, rest patterns and a common market state. Any resampling, bootstrap or confidence interval clusters on the week. A row-level bootstrap overstates significance and is not a valid interval here.
3. **Purge on label settlement time, not on kickoff.** A training row is admissible only if its label had already settled before the earliest *decision* time in the test block, with an explicit embargo margin. A game that finished on Monday night is not training data for a decision made on Sunday morning, even though its season is "earlier."
4. **A feature carries the value that was observable at that row's decision time.** Not the value published at that time, and not the currently stored value: what this system would actually have held, including retrieval and availability delay. Revisions are kept as revisions; the latest value never silently backfills an earlier row.
5. **Everything fitted downstream of a model is also out-of-fold.** Calibrators, shrinkage, devig parameters, meta-learners and stackers, decision thresholds, staking coefficients and risk rules are fitted only on out-of-fold predictions from strictly earlier blocks. **Risk management is not exempt.** A corridor width or a downsize coefficient tuned on the same data it is evaluated on is exactly as overfit as a model tuned that way, and is more dangerous because it wears the costume of caution.
6. **Selection is fitting.** Choosing among trials, model families, hyperparameters, regularization strengths, feature sets or gate configurations consumes the same statistical budget as fitting a coefficient. The number of trials attempted is declared, all of them are preserved, and the selection rule is written down before the results are seen.
7. **Stacking inherits the guarantee of its inputs, and cannot exceed it.** A stacker over per-row held-out predictions must itself be fit chronologically across the blocks those predictions came from. Fitting a meta-learner on all seasons at once and reporting its in-sample fit reintroduces precisely the leak the base models avoided. Where the inputs carry a stronger guarantee than shuffled out-of-fold — as `research/tree_lab.py`'s `emit_oof` does, fitting each candidate only on strictly earlier seasons under a settled-label cutoff — that stronger guarantee is stated, not rounded down to "OOF."
8. **A backfilled or simulated cutoff is labelled as such on every result derived from it.** "Retrospective backfill: cutoff-simulated" is not a footnote to be dropped in a summary. Only rows frozen at a real decision time count as forward evidence.

The rule exists because the failure it prevents is invisible in the metric. A leak does not announce itself; it shows up as a good number.

Use chronological, clustered estimates of predictive skill, calibration, execution-adjusted returns and price movement. Preserve all attempted strategies; correct family comparisons and distinguish exploratory from confirmatory work. Repeatedly checking a fixed-sample confidence interval until it turns positive is not a valid stopping rule. Predeclare the forward endpoint or adopt a valid sequential method. A bootstrap of selected winners does not undo selection bias.

Use new forward blocks for the exact frozen model/policy; a new version starts a new cohort. No retroactive “paper bet” should appear in a forward ledger. A candidate may qualify for more paper observation without qualifying for money. Actual wagering, account connections, paid feeds and spending limits remain separate user decisions.

The agent program is successful if it produces a reliable system for finding and testing advantages, with clear failures and a smaller set of defensible candidates. Profitability is an outcome to establish, not a completion checkbox.


## Initial execution results (8 September 2026)

The bounded pilot completed all six market/year folds with TPOT enabled and no reported search errors after repairing two local dependency problems (OpenMP runtime and the legacy pkg_resources dependency). Earlier failed attempts remain saved separately; they were not silently counted as successful TPOT searches.

Final run: `20260908T152845Z-334b4b45`. It used 1795 reconstructed market observations and 42 input columns. The brief time-bounded TPOT search evaluated 192 pipeline trials across six folds. This is a smoke-sized exploratory search, not an exhaustive model comparison.

- **Spreads:** selected models by year: 2023 no_move, 2024 no_move, 2025 no_move. Selected-policy paper bets: 0. The selected policy abstained; no ROI is defined.
- **Totals:** selected models by year: 2023 tpot, 2024 tpot, 2025 no_move. Selected-policy paper bets: 104. Indicative archived-price ROI: 0.0205; week-clustered interval: [-0.17557408027576263, 0.2202203801457889].

Treat these as development diagnostics. The starter models have not established an executable or forward-validated edge. The new targets and richer book-response/player-role datasets in packages B and D remain the next substantive model builds.

Validation: TypeScript check and production build passed; the full JavaScript suite passed with one existing skipped test; the three Python checks passed. The Research lab and updated stale-price status were verified in the running local app. An independently downloaded, commit-pinned nflverse schedule reconciled 7,276 settled game results against the local database without score mismatches; this does not validate odds availability.

Changes are local and reviewable, not committed or pushed. The live local server was restarted to load them. No production model was promoted and no wager was placed.
