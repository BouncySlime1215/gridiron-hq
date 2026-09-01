# Gridiron HQ AI Model Operating Manual

> Living instruction module for Codex, Claude, and future engineering or research agents.
>
> Status: active working document. Update this file whenever the engine, data contract,
> audit result, promotion state, or highest-priority research queue changes.

## 0. Mission

Build one connected football intelligence engine that improves weekly, produces calibrated
game and player distributions, supports fantasy and betting decisions, and can eventually
demonstrate positive expected value without look-ahead, fake news, reconstructed prices,
selective reporting, or hidden manual overrides.

The system is not allowed to call itself profitable because a backtest has a high hit rate.
Profitability means settled results at prices that were genuinely available at decision time,
positive closing-line value, calibrated probabilities, and uncertainty that survives clustered
forward evaluation.

The aspirational `75%` target applies only to a separately labeled **high-confidence tier**.
It is not the required hit rate of the general model and may never be manufactured by changing
thresholds after outcomes are known. A 75% tier is meaningful only when it also has:

- a preregistered selection rule;
- a useful minimum sample, initially 100 settled independent decisions;
- preserved decision-time and closing prices;
- positive units and ROI after vig;
- a week-clustered lower confidence bound that clears the configured floor;
- no dependence on a single season, team, book, market, or stale data source.

The economically important target for ordinary -110 sides is first to clear the actual stored
break-even rate, usually about 52.4%, with uncertainty. A selective 75% display is secondary.

## 1. Non-negotiable operating rules

Every AI agent working in this repository must follow these rules.

1. Inspect the current code, database state, git diff, audit ledger, and source health before
   proposing a rewrite.
2. Preserve chronological cutoffs. A prediction for week W may use only evidence available
   before the recorded decision timestamp for week W.
3. Never tune on the sealed forward ledger. Never reopen a blind week because a result looks bad.
4. Do not delete failed models. Retain their code, predictions, data coverage, and failure reason.
5. “Shadow” means no bankroll authority. It must not mean invisible to research or unavailable
   as a raw feature to a properly audited meta-model.
6. Separate these states in code and UI: input observed, influence measured, production weight,
   stake permission, and live execution.
7. Missing data must abstain. Never convert unavailable evidence into a numerical zero unless
   zero is the documented real-world value.
8. An AI-written explanation may translate a pick after the number is frozen. It may not invent
   a reason, change the forecast, or create a numeric injury/news adjustment.
9. No unverified news claim may alter a forecast. Rumor is display-only and quarantined.
10. Use stored bookmaker prices. Never grade a bet at a consensus line reconstructed later.
11. Report pushes, voids, stale quotes, unmatched identities, and missing closes explicitly.
12. Do not optimize hit rate alone. Optimize proper scoring, calibration, CLV, ROI, coverage,
    robustness, and drawdown together.
13. Never imply guaranteed profit. Gambling involves loss risk and must remain optional, legal,
    age-appropriate, and bankroll-limited.
14. Make reversible changes, test them, and record what changed and why.
15. Commit cohesive verified work. Do not commit database files, keys, cookies, or local secrets.

## 2. Current truth snapshot — 2026-08-31

This snapshot is a research fact, not a permanent product claim.

### 2.1 Current all-inputs development audit

Comparable core-data era: 2021–2025. The earlier 2022–2025 headline was invalidated because it
excluded the worst opened season and mixed opening-line availability across years.

| Engine | Bets | W-L | Hit rate | Units | ROI | P(ROI > 0) | ROI 95% interval |
|---|---:|---:|---:|---:|---:|---:|---:|
| Champion inputs | 190 | 88-99 | 47.1% | -18.179u | -9.6% | 9.7% | -23.5% to +4.9% |
| All inputs v3 | 273 | 129-139 | 48.1% | -20.536u | -7.5% | 12.8% | -20.2% to +5.3% |

Development delta: +83 bets, +1.0 percentage point, -2.357 units, and +2.1 ROI points. The
candidate loses more total units because it makes substantially more bets.

Verdict: rejected for bankroll authority. Neither engine beats the stored prices, the interval
crosses zero, and the all-input candidate remains below the 52.38% break-even rate at -110.

The stored comparison above is `unified-all-inputs-v3-isolated-roster` and includes the initial
eight advanced team signals plus the roster-strength input. Production and candidate disagreement
sets are isolated; zero-weight inputs cannot silently alter production selection.

### 2.2 Data consistency and 2021

The 2021 core data is not empty. It contains 544 team-weeks, 5,421 player feature rows, 25,271
snap rows, 2,462 Next Gen Stats rows, 7,659 matched usage rows, 7,607 matched player-snap rows,
and 285 complete reciprocal games. All 21 required team features parse, contain finite values,
and vary; feature payload completeness is 99.8%, consistent with 99.8–99.9% in 2022–2025.

The real coverage boundaries are injury reports (2023+), PFR charting (2024+), and historical
depth snapshots (2025). Those inputs abstain outside their coverage window and must be evaluated
separately. Historical completed-game replays now ignore sparse opening-line fields and use the
same stored spread/total policy in every year. Real opening lines remain available to live games.

2021 still performs badly after those repairs: the champion is 34.8% and -15.429u; the candidate
is 30.5% and -24.292u. Removing 2021 raises the candidate slice to 53.1% and +3.756u, but that is
a sensitivity diagnostic, not evidence: removing the worst season after seeing it is cherry-picking.

### 2.3 Historical and forward evidence are different

- Historical replays are development diagnostics.
- A historical “blind audit” whose outcomes have since been seen is no longer untouched proof.
- The 2026 ledger is the forward proof surface.
- Until enough 2026 decisions settle with authentic closes, production staking authority is zero.

## 3. One engine, many heads

Do not describe the repository as a pile of independent pickers. The target architecture is one
engine with shared state and specialized heads.

### 3.1 Shared evidence state

The shared state is keyed by season, week, game, team, player, source, event timestamp, capture
timestamp, and feature cutoff. It contains:

- schedules, scores, play-by-play, drives, possessions, field position, and game state;
- market open, intermediate, decision-time, and closing prices by book;
- team efficiency, opponent adjustment, pace, early-down success, explosiveness, pressure,
  coverage, personnel, formation, motion, and fourth-down behavior;
- player identity, roster, depth, snaps, routes, targets, carries, air yards, blocking, pressure,
  coverage assignments, availability, role, replacement value, and uncertainty;
- weather, venue, surface, roof, travel, time zone, rest, coaching, officials, and divisional state;
- timestamped news evidence and a claim-verification graph;
- model forecasts, confidence, disagreement, calibration, and provenance;
- settled outcomes and error decomposition.

### 3.2 Game distribution head

The game head produces a joint distribution, not just a spread guess:

- home margin distribution;
- total-points distribution;
- win probability;
- team score distributions;
- drive count and pace distribution;
- overtime probability;
- alternate spread and total probabilities;
- state-conditioned live updates.

### 3.3 Player distribution head

The player head shares the game state and produces distributions for:

- attempts, carries, targets, routes, snaps, receptions;
- pass, rush, and receiving yards;
- sacks, interceptions, touchdowns, explosive plays;
- fantasy points by scoring format;
- availability, workload ceiling, workload floor, and role-change probability.

Player totals must reconcile to team opportunity budgets. Targets cannot exceed attempts; player
carries must reconcile to team rush volume; multiple quarterbacks cannot all receive starter
volume in the same simulated draw.

### 3.4 Market residual head

The market is a powerful prior. This head predicts residual movement from the stored market line,
not an unconstrained score in isolation. It must answer:

- what evidence is not already priced;
- how much the model should move from the market;
- whether movement is stable across books and time;
- whether the price remains actionable after vig;
- how much of the apparent edge disappears at close.

### 3.5 Adaptive learning head

Online learning updates only from newly settled, cutoff-valid examples. It may update residuals,
calibration, regime probabilities, or embeddings. It must not rewrite the historical truth table.
Every update records before/after weights, training cutoff, sample count, loss, calibration, and
rollback pointer.

### 3.6 Explanation head

The explanation head translates a frozen numeric decision into plain language. Its inputs are
only structured evidence already used or explicitly marked contextual. Its output schema should
include:

- pick and frozen probability;
- top supporting and opposing factors;
- player/injury contribution with source and timestamp;
- market price and break-even probability;
- uncertainty and disagreement;
- what would invalidate the decision;
- data that is missing;
- a short audit trace of model versions and cutoffs.

The explanation is rejected if it introduces a player, injury, statistic, or causal claim not
present in the evidence packet.

## 4. Input visibility, influence, and gates

Gates exist to control consequences, not curiosity.

### 4.1 Five separate concepts

For every model or signal, store these independently:

1. `observed`: a valid raw input was available at the cutoff.
2. `forecast`: the raw value emitted by the component.
3. `measured_influence`: the meta-model coefficient or attribution for this prediction.
4. `production_authority`: the component is allowed to influence the production number.
5. `staking_authority`: the final decision is allowed to risk bankroll.

A candidate can be observed and heard in a candidate blend without having production or staking
authority. The UI must never collapse these five states into a single “blocked” KPI.

### 4.2 Why regularization remains necessary

Thirty correlated weak inputs can outvote one strong prior. Therefore all-input does not mean
equal-input. The meta-model must use shrinkage, family constraints, missingness indicators,
correlation controls, and walk-forward fitting. Candidate signals can contribute interactions even
when they are weak standalone predictors.

### 4.3 Gate hierarchy

- Data gate: identity, timestamp, source, coverage, and range checks pass.
- Forecast gate: output is finite, schema-valid, and available before cutoff.
- Research gate: chronological replay and ablation are reproducible.
- Robustness gate: lift is not concentrated in one week, season, team, or price bucket.
- Calibration gate: probabilities are reliable enough for their proposed use.
- Forward gate: frozen decisions beat the defined forward benchmarks.
- Staking gate: legal/user controls, quote freshness, bankroll, and loss limits pass.

Failing a late gate never requires deleting early-stage evidence.

## 5. Weekly learning lifecycle

Run this lifecycle after each NFL week becomes final.

### Phase A — freeze and settle

1. Freeze the week’s decision ledger.
2. Ingest final scores and official play-by-play.
3. Settle bets at stored prices and fantasy/player outcomes from official statistics.
4. Preserve stat corrections as versioned amendments.
5. Match closing prices captured before kickoff.
6. Quarantine any row with ambiguous team, player, market, line, or timestamp identity.

### Phase B — generate training examples

For every game and player, write one immutable example containing:

- feature cutoff and evidence manifest hash;
- feature values plus missingness indicators;
- raw component forecasts;
- final ensemble distribution;
- decision policy result, including abstentions;
- stored quote and later close;
- outcome and scoring labels;
- source versions and model version.

Abstentions are data. They reveal coverage and selection bias and must not be discarded.

### Phase C — decompose errors

Decompose misses into categories that can be acted on:

- team strength prior;
- pace or drive count;
- passing efficiency;
- rushing efficiency;
- pressure and protection;
- turnovers and short fields;
- red-zone conversion;
- weather and venue;
- player availability and replacement value;
- role or workload;
- game-script transition;
- market movement or stale quote;
- probability calibration;
- simulation variance.

Do not build a new feature because it explains one memorable loss. Require repeated, timestamp-safe
error structure.

### Phase D — update candidates

1. Train only through the newly settled cutoff.
2. Compare the updated learner with the frozen previous version.
3. Run placebo labels and shuffled-time checks.
4. Measure overall and segmented calibration.
5. Run leave-one-season-out and leave-one-team-out stress tests.
6. Store the candidate; do not overwrite the champion.

### Phase E — forward decision

The champion remains frozen during the next evaluation window. Candidate outputs are captured in
parallel. Promotion is a separate explicit action after enough independent decisions settle.

### Phase F — automatic signal reliability

After a whole week settles, score every frozen component residual against the actual market
residual. The controller performs deterministic pattern recognition across overall,
recent-six-week, and early/middle/late-season regimes. It may only shrink a candidate signal; it
cannot increase authority, promote a model, or size a bet.

The preregistered v1 rules require at least 32 independent games across four weeks. Strong harm
requires the 90% upper bound on directional accuracy to remain below 50% and mean squared-error
gain versus market to be negative. Probable harm requires sub-47% direction, negative error gain,
and no contradictory recent evidence. Small samples remain at a neutral 1.0 multiplier.

This complements rather than replaces machine learning. The ensemble fits linear performance
weights, the online neural network learns bounded nonlinear market residuals, and restricted risk
models test deeper interactions. The reasoning layer runs last and may only translate the frozen
contribution packet, including any reliability shrinkage.

## 6. News ingestion and anti-hallucination system

News is evidence about availability, role, scheme, and environment. It is not a free-form numeric
feature.

### 6.1 Source priority

1. Official league transactions, injury reports, inactives, and game books.
2. Official team communications and named press conferences.
3. Credentialed national reporters.
4. Credentialed local beat reporters.
5. Reputable structured feeds.
6. Aggregators, social reposts, forums, and anonymous claims.

Lower-priority sources may create a watch item but cannot independently change model state.

### 6.2 Claim object

Every extracted claim must store:

- canonical player/team/game identity;
- claim type from a constrained enum;
- normalized status and direction;
- source URL or source record ID;
- speaker/author and source tier;
- published time, captured time, and game cutoff;
- exact supporting evidence span;
- verification state and corroborating source IDs;
- extractor type/version and confidence;
- superseded-by link when the story changes.

### 6.3 Deterministic-first extraction

Parse official injury designations, roster transactions, practice participation, inactives, depth
charts, and snap reports deterministically. Use an LLM only when structured parsing cannot resolve
a known entity and constrained claim type.

### 6.4 AI extraction contract

The LLM must return schema-valid JSON. It may select only known identities, known enums, and a
verbatim evidence span. If the article does not support a claim, return `abstain`. The LLM is not
allowed to infer an injury severity, recovery date, workload percentage, or point adjustment.

### 6.5 Verification graph

Claims become model-eligible only when their source policy passes. Conflicting claims stay visible
with explicit conflict state. Recency never outranks official status automatically; supersession
rules depend on claim type.

### 6.6 Latency metrics

Track source-to-capture lag, capture-to-typed-signal lag, signal-to-model lag, and signal-to-market
movement. This distinguishes genuine news advantage from stories already priced into the market.

## 7. Advanced data expansion queue

Acquire and backfill data based on marginal value and temporal validity, not novelty.

### Tier 1 — required foundation

- official play-by-play and game books;
- multi-book open, intermediate, decision, and close prices;
- roster, depth, injury, practice, inactive, and transaction timelines;
- snaps, routes, targets, carries, air yards, and quarterback participation;
- weather observation and forecast vintages;
- venue, surface, roof, travel, rest, and time zone.

### Tier 2 — likely structural value

- early-down EPA and success rate by personnel and situation;
- pass protection, pressure source, time-to-pressure, scramble and sack responsibility;
- coverage shell, man/zone, target separation, route family, and matchup alignment;
- formation, motion, play action, RPO, box count, and light/heavy personnel;
- explosive-play creation and prevention;
- series conversion, field position, starting drive state, and hidden special-teams yards;
- offensive-line combination continuity;
- replacement value by every position group, not quarterback only;
- coaching tendency changes and coordinator play-calling fingerprints;
- referee crew penalty type, pace effects, and enforcement tendencies.

### Tier 3 — promising interactions

- injury × replacement × scheme fit;
- pressure × quarterback response × protection continuity;
- coverage × route tree × receiver alignment;
- weather × pass depth × quarterback arm/profile;
- travel × body clock × rest × kickoff time;
- pace × no-huddle × defensive substitution constraints;
- lead/trail game script × personnel usage;
- red-zone package availability × touchdown allocation;
- market move timing × verified news latency;
- cross-book disagreement × liquidity × quote age.

### Tier 4 — research-only until proven

- embeddings from press conferences or coach language;
- computer vision from all-22 video;
- graph neural networks over player matchups;
- regime-switching neural state-space models;
- causal treatment models for injuries and substitutions;
- opponent-adaptive simulation policies;
- mixture-of-experts routing by game archetype.

## 8. Team-wide player value and injury impact

Quarterback value is not enough. Build replacement-aware value for every position and unit.

### 8.1 Player state

For each player estimate role probability, expected opportunity, per-opportunity efficiency,
assignment-specific contribution, replacement pool, uncertainty, and recovery/status distribution.

### 8.2 Unit interactions

Player losses are not additive. An absent left tackle changes pressure, depth of target, scramble,
sack, run direction, tight-end routes, and play-calling. A corner injury changes coverage help and
opponent target allocation. Model these through the shared simulation state.

### 8.3 Counterfactual injury simulation

For each material availability event, run paired simulations with identical random seeds:

- player active at expected role;
- limited role distribution;
- inactive with named replacement mixture.

The paired difference estimates impact while reducing Monte Carlo noise. Store effects on margin,
total, team scoring, drives, and relevant player distributions.

## 9. Game simulation redesign

The simulator should generate coherent games rather than independent box-score guesses.

### 9.1 Pre-game latent state

Sample team strength, player availability, role, pace, pass rate, efficiency, pressure, turnover
hazard, explosive-play hazard, special teams, weather, and officiating regime from calibrated
distributions with shared correlations.

### 9.2 Drive engine

Simulate each drive from field position, time, score, possession, timeouts, personnel availability,
and strategic state. Model first-down conversion, explosive plays, sacks, turnovers, penalties,
field-goal attempts, punts, and fourth-down choices.

### 9.3 Play and player allocation

Within a drive, allocate play type and opportunity through team budgets. Player events must sum to
the team event. Injuries and role changes can update state between drives.

### 9.4 Live update

During a game, condition the remaining simulation on observed score, clock, field position,
possession, timeouts, player availability, and realized efficiency. Do not double-count pre-game
priors after enough live evidence arrives.

### 9.5 Calibration

Validate margin, total, team score, win probability, player outcomes, and alternate lines with
reliability curves, proper scoring rules, coverage of prediction intervals, and tail behavior.

### 9.6 Postgame truth and error filtration

A final score is not a sufficient learning label. After official gameplay and participation data
arrive, build one immutable truth packet per game containing:

- the final margin, total, market residual, and stored decision line;
- play counts, pass/run mix, red-zone volume, sacks, turnovers, explosive plays, penalties,
  scoring events, lead changes, challenges, and reversed rulings;
- actual player opportunities, efficiency, snaps, stars, position-group totals, and role surprises;
- actual weather/venue fields with an explicit warning when no pregame forecast vintage exists;
- multiplicity-corrected multi-week team trends plus one-game deltas kept as suggestive context;
- every frozen expert forecast, its evidence hash, directional result, and forecast error.

The filtration gate distinguishes missing/corrupt truth from ordinary football variance. A valid
game with five turnovers, non-offensive touchdowns, explosive plays, or reversed challenges keeps
sample weight 1. Those events become variance and simulator-calibration features; they never
justify deleting a loss. Quarantine only when final identity, market identity, reciprocal team
features, or required outcome evidence is incomplete.

## 10. Candidate research protocol

Every new signal or model proposal must be written before evaluation:

- hypothesis and football mechanism;
- target and proposed use;
- earliest reliable data season;
- feature timestamp and leakage risks;
- missing-data behavior;
- discovery, validation, and forward windows;
- baseline and ablations;
- primary metric and minimum sample;
- robustness checks;
- compute and source cost;
- exact promotion and rejection criteria.

### 10.1 Required comparisons

Compare against:

- market-only prior;
- current champion;
- same engine without the candidate;
- shuffled-label placebo;
- shuffled-time placebo;
- simple linear/shrunk baseline;
- candidate with suspicious/high-risk fields removed.

### 10.2 Required reporting

Always report number of decisions, wins, losses, pushes, hit rate, average price, break-even rate,
units, ROI, CLV, Brier/log loss where relevant, calibration, clustered confidence intervals,
coverage, abstention rate, and results by season.

### 10.3 Kill criteria

Reject or redesign when:

- performance depends on future or revised data;
- the lift disappears against a simple baseline;
- one season supplies most of the profit;
- coefficients or feature importance are unstable;
- the model wins on hit rate but loses after price;
- CLV is negative despite apparent historical ROI;
- missingness itself leaks game outcomes;
- identity or timestamp error rates exceed tolerance;
- an explanation cannot be grounded in stored evidence.

## 11. Path from 48.1% strict development to stronger evidence

Do not immediately add twenty more predictors. Work in this order.

### 11.0 Macro failure trigger

The first cutoff-safe reliability replay improved the all-year candidate from 48.1% to 48.5% and
reduced the loss from -20.536 to -18.627 units. That is useful downside protection, but it fails the
profitability objective. The system must therefore expose a macro diagnosis with the strict audit:

- compare the actual hit rate with the price-specific break-even rate (52.38% at -110);
- distinguish data-integrity failure from forecast, calibration, selection, regime, and pricing failure;
- show edge buckets, season instability, phase and favorite/underdog slices;
- quantify whether new components improved retained decisions or merely increased volume;
- keep every conclusion labeled as opened development evidence;
- convert findings into preregistered forward experiments, never a post-hoc production rule.

The current strict gap is about 4.3 percentage points, not 1.4. No UI, AI explanation, neural layer,
or chosen historical slice may overwrite that fact.

### 11.0.1 Coordination audit: the hard truths

An engine is not unified merely because one registry lists all its artifacts. The August 2026
coordination audit found these concrete breaks:

- the raw ensemble optimized final margin, while a spread bet needs incremental value over the
  posted market margin;
- the auto-pick board used the raw blend while the unified simulation used the residual blend;
- the online neural and risk-lab heads trained and stored predictions but did not feed the pick
  generator;
- verified news reached the neural feature vector, but the neural output did not reach decisions;
- the existing cover calibration described the old raw head and therefore could not safely
  authorize a different residual head;
- the engine registry coordinated versions and cutoffs, but not the actual inference route.

The canonical route is now: verified evidence → component forecasts → market-residual base →
gated adaptive residual → version-matched cover probability → frozen policy → immutable ledger →
post-decision explanation. Any component outside that route must be labeled shadow/disconnected,
not advertised as part of the betting answer.

### 11.0.2 First coordinated neural result

The preregistered two-sided prequential challenger trained on 2018–2020 and evaluated every week
of 2021–2025 before learning that week's result. It produced 304 bets, 155 wins, 141 losses,
52.4% hit rate, +10.592 units, and 3.5% ROI at stored prices. This is a useful research result but
fails promotion for three reasons:

- its clustered 95% ROI interval is -8.9% to +15.8%, so profit is not established;
- 2021 contributes +16.050 units—more than the combined result—while 2023 and 2025 lose;
- 302 of 304 selections are underdogs, showing unresolved decision concentration.

The candidate stays shadow-only. No threshold may be retuned on these opened outcomes. Its next
test is the already-frozen forward ledger, with closing prices preserved before kickoff.

### 11.0.3 Weekly expert council and robust coordinator

Twelve distinct reasoning roles now share one immutable audit contract: football rulebook,
player-built team, drive/game replay, similar-game matching, boosted trees, online neural
residual, specialist family council, line movement, verified-news reaction, live updater, price
shopper, and player opportunity. A role must emit either a finite raw market-residual forecast or
an explicit abstention with its missing reason. Missing is never converted to zero.

Every opened blind-audit week stores, per game and role, the evidence cutoff and hash, raw
forecast, uncertainty, authority, missing reason, actual market residual, and job-specific
settlement. Rows are append-only. Spread-residual experts receive directional and squared-error
scores. The game replay receives margin MAE, total MAE, and interval coverage. Player opportunity
receives team-volume and role-relevant player-volume MAE: QB attempts/carries, RB carries/targets,
and WR/TE targets. Live updates use Brier score and calibration; price shopping uses available-price
gain and CLV. A specialist is never graded as a spread picker merely because the old schema had no
other column.

The coordinator may train only on rows from strictly earlier settled weeks. It uses week-balanced
Huber loss, heavy ridge shrinkage, a 0.35 cap on one expert, and a 0.80 cap on total expert influence.
It remains research-only and requires at least 128 games across eight weeks before emitting a
candidate correction.

The similar-game head standardizes only on prior games, uses 35 distance-weighted neighbors, and
shrinks its raw analog result toward the market according to effective sample size. The boosted
tree head fits only prior cutoff-valid market residuals with shallow depth, large leaves, and slow
learning. The game-replay head stores a deterministic 160-trial drive simulation and joint score
distribution. These choices add genuinely different error structures rather than twelve labels
for the same arithmetic.

Verified news also has a news-to-market latency audit. It pairs claims only with preserved
pre-kickoff quotes and measures publication-to-capture and publication-to-observed-move lag. A
move is not treated as proof of causation, and this measurement has no direct betting authority.

The first job-specific smoke audit used 2021 Week 18, 15 games. The drive simulator recorded
10.35-point margin MAE, 12.19-point total MAE, and 86.7% coverage for its claimed 80% margin
interval. The cutoff-frozen player opportunity engine recorded 1.52 events of player-volume MAE
under the original all-field score; the score was then tightened to exclude trivial zeros and grade
only role-relevant workloads. The online neural correctly emitted missing/cold rather than a fake
zero forecast because no strictly earlier council examples existed. It is now connected to the
same isolated audit run and learns sequentially only from earlier settled weeks. Its first real
outputs were weak: 46.2% direction with 192.1 MSE after 15 examples, then 41.7% with 403.7 MSE
after 28 examples. That proves the connection works; it does not prove the learner is useful.
Shrinkage and the coordinator's influence caps must keep it small unless later weeks demonstrate
incremental out-of-sample value.

The live remainder simulator now starts from the actual possession, field position, down, and
distance instead of silently resetting the current drive to first-and-ten. A 12-game, 36-checkpoint
smoke test produced Brier 0.1194 versus 0.1380 for score-and-clock alone, but expected calibration
error was 0.1696. That is useful ranking skill and unacceptable raw calibration. The Engine Room
therefore exposes a user-run truth test and explicitly withholds probability-sizing claims.

Postgame truth packets now parse in-game exits and documented returns, separate players with
multi-letter initials, compare team performance before and after the exit, attach role share and
replacement-adjusted impact, and carry unresolved exits into the next week. An official injury
report or newer verified availability claim supersedes that carry state. Returns clear it. The
same injury is not counted again when the official weekly availability packet already includes it.

Player identity is a multi-source entity, not a display-name join. Historical projections now use
the cutoff-safe name attached to the GSIS feature row, preventing a corrupted current master label
from rewriting old games. Master rows with GSIS/name conflicts are quarantined for reconciliation;
they are not bulk-renamed because Sleeper, ESPN, rosters, drafts, and attached references may point
to a different identity. External value syncs refuse ambiguous normalized names and prefer an
existing stable Sleeper id.

### Workstream A — understand the lift

1. Produce weekly and game-level deltas between champion and all-input candidate.
2. Attribute changed selections to the eight new inputs and their interactions.
3. Identify whether lift comes from better direction, better ranking, or more bets.
4. Measure results after identical selection counts.
5. Run leave-one-season-out fits.
6. Run team, favourite/underdog, home/away, price, edge, disagreement, and data-coverage slices.
7. Test whether 2022 and 2023 gains survive a model frozen before each season.

### Workstream B — fix weak periods

1. Diagnose the 2021 coverage and failure separately; never backfill unavailable features with
   revised season-end values.
2. Investigate why 2024 candidate ROI fell below the champion.
3. Determine whether 2025’s near-flat result is calibration, selection, or line-price failure.
4. Improve abstention when the input warehouse is incomplete or component disagreement is high.

### Workstream C — improve signal combination

Evaluate, chronologically:

- ridge/elastic-net stacking on market residuals;
- non-negative family-constrained stacking;
- hierarchical shrinkage by season and game archetype;
- out-of-fold isotonic or beta calibration;
- mixture-of-experts with a small preregistered regime set;
- online residual correction with conservative learning rates;
- correlation-aware family caps so duplicated signals cannot dominate.

Start simple. A neural stacker must beat a shrunk linear stacker out of sample to survive.

### Workstream D — price and select better

1. Capture simultaneous prices from multiple books.
2. Select by expected value at the actual price, not raw edge points.
3. Measure quote age and reject stale opportunities.
4. Separate forecast improvement from line-shopping improvement.
5. Learn an abstention policy using only development data.
6. Report performance at fixed volume tiers so selectivity cannot hide sample collapse.

### Workstream E — high-confidence tier

The 75% tier must be preregistered. Candidate definitions may combine calibrated edge, model
agreement, data completeness, verified late news, price quality, and regime stability. Evaluate
tiers at minimum volumes such as 25, 50, 100, and 200 decisions. Never publish only the best tier.
Always show the denominator and uncertainty.

## 12. UI contract

The betting interface should answer five questions immediately:

1. What does the engine believe?
2. What price is available now?
3. Why does the evidence move the probability?
4. How uncertain and fresh is the answer?
5. Is this research-only, decision-eligible, or stake-authorized?

Never display an unexplained `blocked` KPI. Replace it with:

- state;
- exact failed condition;
- current value;
- required value;
- owner/action;
- next evaluation time.

The Engine tab must show champion versus all-input candidate, supported data seasons, raw input
visibility, production weight, forward evidence, and audit intervals. It must distinguish a model
being heard from a model being permitted to spend.

## 13. AI agent work loop

When an AI agent begins work:

1. Read this manual and the relevant current docs.
2. Inspect `git status`, recent commits, schema, source status, and latest audits.
3. State the precise hypothesis or product defect being addressed.
4. Identify immutable evidence and files that must not be overwritten.
5. Implement the smallest coherent slice that advances the goal.
6. Add tests for leakage, missingness, identity, and state transitions.
7. Run targeted tests, then full tests and production build.
8. Run a chronological comparison if numeric behavior changed.
9. Update this manual’s truth snapshot and change log.
10. Commit with a message that names the actual behavior change.

When another AI agent takes over, it must not trust a prose claim that “the model is profitable.”
It must retrieve the stored audit object and verify seasons, policy, prices, and intervals.

## 14. Definition of done by phase

### Data phase

- coverage and freshness metrics exist;
- source and timestamp provenance survive to the feature row;
- backfill is reproducible and cutoff-safe;
- missingness is explicit;
- identity reconciliation is tested.

### Model phase

- raw forecasts are stored;
- baseline and ablations exist;
- probabilities are calibrated;
- chronological and placebo tests pass;
- failure slices are documented;
- champion remains rollback-safe.

### Product phase

- UI state matches backend authority;
- explanation is evidence-grounded;
- stale and missing data are visible;
- no `blocked` state lacks a reason and action;
- mobile/desktop loading and empty/error states work.

### Profit evidence phase

- decisions were frozen before outcomes;
- authentic decision and closing prices exist;
- settlement coverage is acceptable;
- positive ROI and CLV are not isolated to one segment;
- clustered uncertainty passes the preregistered rule;
- stake controls and legal/user safeguards work.

## 15. Immediate execution queue

### Now

- Keep the all-input candidate available in replay and diagnostics.
- Add game-level attribution for changed decisions.
- Add fixed-volume and leave-one-season-out comparison reports.
- Repair remaining stale and erroring high-value news/data feeds.
- Capture 2026 decision/close pairs before kickoff.
- Keep staking authority at zero until forward evidence exists.

### Next

- Build the shrunk market-residual stacker.
- Add team-wide counterfactual player availability impacts.
- Improve simulation coherence and drive/player reconciliation.
- Add news latency-to-market measurement.
- Add high-confidence tier research with fixed minimum volume.
- Expand line coverage and prop settlement quality.

### Later

- Evaluate mixture-of-experts only after linear stacking is stable.
- Evaluate video and language embeddings only with timestamped archives.
- Evaluate causal injury models only with explicit treatment timing and replacement state.
- Consider limited live execution only after quote, permission, and risk controls pass.

## 16. Living change log

### 2026-08-31 — all-input candidate created and strict audit corrected

- Eight advanced-stat challenger forecasts were allowed into a unified candidate blend.
- Challenger status stopped meaning “muted”; it now describes deployment authority.
- Champion behavior remained the default.
- A 2022–2025 slice initially looked profitable, but the headline was withdrawn when the full
  2021–2025 and market-field consistency audit exposed selection and coverage risk.
- The corrected same-policy result is 47.1% / -18.179u for the champion and 48.1% / -20.536u
  for the all-input candidate.
- Fixed-volume, leave-one-season-out, edge-calibration, attribution, and nine signal-ablation
  reports are stored. The candidate is not eligible for staking.
- Next decision: redesign on discovery data and judge only on a preregistered 2026 forward window.

### 2026-08-31 — cross-season data repair

- Backfilled 2021 snap counts, Next Gen Stats, weekly player usage, and matched player snaps.
- Added payload validity checks: parse success, finite-field coverage, variance, identity integrity,
  reciprocal game settlement, real player opportunity, and per-year feed coverage.
- Changed every default full sync and fresh-install bootstrap to ingest 2021–2025 rather than
  silently starting in 2022 or 2023.
- Standardized completed-game market inputs across years; sparse opening lines no longer make
  2021 a different model than 2022–2025.

### 2026-08-31 — automatic signal reliability controller

- Frozen every raw component margin into the pre-kickoff shadow decision packet.
- Added shrink-only pattern recognition for directional harm, market-relative squared error,
  recent-vs-prior drift, and early/middle/late-season regimes.
- Wired the controller into the finalized-week growth cycle and unified candidate blend.
- Production weights, promotion state, and staking authority remain unchanged.
- Added controller lineage to the unified engine version and reliability adjustments to exact
  pick attribution, so AI explanations can translate the decision without inventing a cause.

### 2026-08-31 — preseason roster-strength candidate added

- Added a full-team player ranking from depth, prior snaps, player efficiency, positional value,
  replacement depth, current roster moves, and draft-capital rookie priors.
- The preseason score is the opening state. New weekly snaps and performance adapt it after games
  settle; they do not erase it automatically.
- Trades retain veteran skill but begin with new-role uncertainty until new-team usage appears.
- Rookies begin from draft capital plus depth role and yield to observed NFL opportunity.
- Coaching and scheme changes are attached as explicit context, not unmeasured point bonuses.
- Added an optional licensed PFF API/import adapter. Browser scraping and cookie automation are
  prohibited; without licensed credentials the signal works from local/public evidence.
- This ninth signal is research-only and has not inherited the earlier eight-signal audit result.

### 2026-08-31 — dated player-state ledger connected

- Added immutable roster snapshots labeled with the source fetch time, never the time a cached row
  happened to be read.
- Materialized verified official-wire trades, signings, claims, releases, waivers, reserve moves,
  activations, and practice-squad moves as dated player-state events.
- Reconstructs team and roster status at a requested cutoff without rewriting the master player row.
- Reads both mirrored sides of a trade and uses the position of “for/in exchange for” relative to
  the resolved player so acquiring a draft pick is not mistaken for acquiring the outgoing player.
- Quarantines a transaction unless it resolves to exactly one stable player identity. Current local
  coverage is 27 materialized events from 205 reviewed transaction sentences; 158 large or ambiguous
  items are quarantined and 20 contain no supported roster transition. This is an explicit ingestion
  backlog, not permission to infer the missing moves.
- The configured-season offseason-change engine now uses this cutoff-safe state before Week 1 rather
  than asking nonexistent current-season game usage where a player is rostered.
- At this checkpoint, college production, opponent strength, combine testing, and verified preseason
  roles were still missing. The next change below acquires them and records their first failed ablation.

### 2026-08-31 — rookie evidence acquisition and validation connected

- Added key-free nflverse draft and combine acquisition with GSIS/PFR identity bridges and explicit
  CC-BY-4.0 provenance. The first full backfill stored 2,090 draft profiles and 2,168 combine profiles.
- Athletic percentiles use speed, jumps, agility, and strength within position. A prospect is ranked
  only against his class and earlier classes, never future combines.
- Added a key-free streaming SportsDataverse college adapter. It reads play-level files without
  holding 30–60 MB seasons in memory, derives position-specific opportunity share and efficiency,
  solves 40-iteration margin SRS opponent ratings, and weights schedule strength by the actual plays
  handled by each prospect.
- College seasons 2022–2025 matched 71/80, 65/77, 71/86, and 71/78 drafted skill prospects. Missing
  identities remain explicit; no fuzzy match is forced across a player/school conflict.
- Verified preseason role news enters through typed factual claims. AI prose cannot assign a rookie
  score, and unverified news remains quarantined.
- The evidence learner fits on prior draft classes and must beat draft/depth on the latest held-out
  class. It failed that test: 6.070 opportunity MAE versus 4.838 for draft/depth on 67 players from
  the 2025 class. Its production influence is therefore exactly zero. The evidence remains stored
  and will be retested automatically as new classes settle.
- Full install backfills college seasons 2022–2025; quick install still acquires draft/combine and
  leaves the larger college archive as an explicit on-demand job.

### 2026-08-31 — circumstance-aware coordinator and real player builder

- The player-builder council role now reads the full cutoff-safe home and away roster, depth,
  rookies, offseason moves, unit strength, replacement availability, and unresolved injury carryover.
  Its evidence hash includes those roster summaries.
- Before combining experts, the coordinator diagnoses early/middle/late season, large/competitive
  spread, high/ordinary total, high/normal disagreement, and sparse/broad evidence coverage.
- A contextual sub-fit needs at least 96 prior games across six settled weeks. Its answer is shrunk
  toward the global week-balanced Huber-ridge coordinator; thin circumstances fall back to global.
- Individual expert influence remains capped at 0.35 and total expert influence at 0.80. Context can
  change learned weights; it cannot waive chronology, coverage, or authority rules.

### 2026-08-31 — twelve-role weekly expert audit connected

- Added one frozen weekly contract across twelve expert approaches, including explicit abstentions.
- Added cutoff-safe similar-game matching and shallow boosted residual trees as genuinely distinct heads.
- Added a robust week-balanced coordinator with Huber loss, ridge shrinkage, and influence caps.
- Connected every role and coordinator output to immutable blind-audit rows for later weekly learning.
- Added deterministic drive-simulation evidence to the replay role.
- Added verified-news-to-bookmaker latency measurement using only preserved pre-kickoff quotes.
- Added an automated sequential audit CLI and UI views for council coverage and week-by-week learning.
- No new component received production or staking authority, and no 75% claim was created.

### 2026-08-31 — postgame truth engine connected

- Added append-only truth packets joining the final result to preserved play-by-play, team and
  player features, snaps, position groups, usage surprises, stars, conditions, and trends.
- Added challenge/reversal, turnover, explosive-play, non-offensive-score, penalty, and lead-change
  extraction from the actual game tape.
- Joined each settled game to the exact frozen expert evidence hash and scored every raw opinion.
- Connected truth generation to the live weekly growth cycle and historical blind-audit chain.
- Kept chaotic but valid games at full training weight; only incomplete identity/source truth is quarantined.
- Added Engine Room and week-by-week audit UI for truth coverage, usage changes, trends, and variance.

## 17. Final instruction to every model

Be aggressive about engineering and conservative about claims. Hear every valid signal. Preserve
every failure. Make missing data obvious. Prefer coherent shared state over disconnected pickers.
Use AI to structure evidence, discover interactions, explain frozen outputs, and accelerate tests;
never use AI prose as a substitute for data. The goal is not a beautiful backtest or a magical
percentage. The goal is a system that can be wrong transparently, learn safely, and eventually
earn the right to risk money through evidence.
