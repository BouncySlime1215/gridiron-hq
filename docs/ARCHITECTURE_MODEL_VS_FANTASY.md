# Model (betting) vs. fantasy — the actual map

**Source of truth, not the filename convention.** Gridiron HQ grew an entire
NFL/MLB sports-betting model on top of what started as a fantasy-football
app, over about a month, across ~274 commits. The `nfl-` filename prefix
looks like it marks "this is the betting model" — it does not. Every one of
the 202 files in `server/services/*.js` below was individually classified by
reading its own doc-comment and, wherever the name and content disagreed,
verified against its actual `import` graph rather than trusted by name.

Confirmed unreliable in both directions:
- Purely-betting files with no `nfl-` prefix: `shadow-ledger.js`,
  `book-feeds.js`, `beat-the-close.js`, `odds-api.js`, `evidence-daemon.js`,
  `market-movement.js`, `sharp-lag.js`, `line-shopping.js`, `staking.js`,
  `weekly-ensemble.js` (shared, see below), `mlb-*.js`, and ~15 more.
- `nfl-`-prefixed files that are fantasy-only or genuinely shared:
  `nfl-team-tendencies.js` (fantasy — team roster page only),
  `nfl-advanced.js` / `nfl-pbp.js` / `nfl-player-state.js` /
  `nfl-engine-registry.js` / `nfl-news-signal.js` (all shared-engine).

**Why this file exists.** We deliberately did *not* physically move any of
these 202 files into `betting/`/`fantasy/`/`shared/` directories — the
mechanical cost (rewriting every import path across every route, service and
test that touches them) was judged higher-risk than the value, for one pass.
This document is the substitute: a definitive, importer-verified reference so
a future session (human or Claude) can look up "is this fantasy, betting, or
shared" without re-deriving it, and so new code knows where to actually reach
for cross-tree information instead of guessing from a name or reaching into
the other tree's internals directly.

**The five categories:**
- **Fantasy** — roster/trade/draft/waiver/lineup/VOR/dynasty decisions. No
  spread/CLV/sportsbook concept.
- **Betting** — the NFL/MLB betting model: spreads, totals, props, CLV,
  shadow/forward ledgers, sportsbook feeds, specialists/coordinator, replay.
- **Shared-engine** — one real computation genuinely called from both trees
  (verified by `import` grep, not inferred). Edit these carefully — see
  Coupling points below for the exact blast radius.
- **Bridge** — a file whose actual job is to move information from one tree
  to the other on purpose: `betting-fantasy-link.js` (betting → fantasy
  points, with a documented reliability accessor for what's actually proven
  vs. merely descriptive), `vegas-fantasy.js` (Vegas lines → fantasy
  game-script), `player-case.js` (betting-side football context → a fantasy
  start/sit case). **If you're wiring betting-model information into a
  fantasy feature, one of these three is where it belongs — not a new direct
  import of an `nfl-*` internal.**
- **Infra** — cross-cutting utility with no domain content (db helpers,
  date/stat math, the Claude API wrapper, generic caching/scheduling).

A few close calls, left as noted rather than force-classified: `ffopportunity.js`
and `model-signal-quality.js` feed the shared `player-week-engine.js` but have
no *direct* fantasy-labelled importer, so they're kept in their content-based
category; `nfl-player-context.js` is one import hop from being genuinely
shared (its only importer is `player-week-engine.js` itself); `role-changepoint.js`,
`weekly-ensemble.js` and `weekly-weight-store.js` reach both trees only
transitively through `player-week-engine.js`, not via a direct importer on
either side — classified shared-engine "by cascade," noted in each entry.

---

## Fantasy-only services (27)

| File | Why |
|---|---|
| `ceiling-lineup.js` | variance/correlation-aware DFS-tournament lineup builder (P(score>=target) not expected points); only server/routes/trades.js consumes it |
| `contingency.js` | empirical handcuff/depth-chart usage-cascade estimator for fantasy roster value; only fantasy importers (news-fantasy-impact.js, season-sim.js, trade-engine.js) |
| `correlation.js` | per-archetype player correlation (Gaussian copula) for DFS lineup sampling; only fantasy importers (ceiling-lineup.js, season-sim.js) |
| `draft-assist.js` | live fantasy-draft assistant (roster need vs league lineup, ADP survival); only server/routes/drafts.js |
| `draft-reconcile.js` | transactional reconciliation of the mirrored ESPN fantasy draft board against local state; only server/services/espn-draft.js |
| `draft-survival.js` | Monte-Carlo simulation of who survives to your next fantasy draft pick; only server/routes/edge.js (VOR board) |
| `espn-draft.js` | polls ESPN's live fantasy draft endpoint and mirrors picks; consumed only by fantasy files (routes/drafts.js, routes/espn.js, draft-assist.js, trade-engine.js) |
| `ffopportunity.js` | ingests ffopportunity's expected-fantasy-points CSVs as a fantasy usage benchmark, no spread/CLV concept of its own; direct importers are server/services/nfl-profitability.js (betting status check) and the shared server/services/player-week-engine.js, no direct fantasy-labelled importer found so kept as fantasy by content rather than promoted to shared-engine |
| `format.js` | derives league format (redraft/keeper/dynasty, superflex) for FantasyCalc dynasty valuations; every importer is fantasy (ceiling-lineup, league-brain, lineup-brain, news-lag-trader, position-liquidity, roster-risk, season-sim, td-regression, trade-engine, trend-exploits, waiver-brain, week-postmortem, routes/aggregates, routes/leagues, routes/tradelab, routes/trades) — no betting importer found |
| `league-brain.js` | trade recommender ranked by P(other manager accepts) x title-odds gain; only server/routes/trades.js |
| `lineup-brain.js` | start/sit lineup calls with margin and honest confidence; only server/routes/trades.js |
| `news-fantasy-impact.js` | maps a news signal to its fantasy projection/points impact for the next team game; only server/routes/news.js |
| `news-lag-trader.js` | trades on league information lag, imported by routes/trades.js |
| `nfl-team-tendencies.js` | play-calling tendency percentiles for the team roster page (server/routes/teams.js only importer) despite nfl- prefix |
| `picks.js` | dynasty rookie draft-pick capital valuation; imported only by server/services/trade-engine.js and server/routes/tradelab.js |
| `player-availability.js` | season-ending/released detection shared by two fantasy consumers only: server/routes/teams.js (depth chart) and server/services/trade-engine.js (lineup solver); no betting importer found despite generic name |
| `position-liquidity.js` | which positions have tradeable roster surplus, feeds the trade planner |
| `roster-risk.js` | bye-week and single-point-of-failure roster risk, feeds waiver/trade planning |
| `season-sim.js` | 10k-trial season simulator for playoff/title odds, feeds trade evaluation |
| `shrinkage-fit.js` | fits empirical-Bayes shrinkage constants used by projections.js; sole consumer projections.js |
| `td-regression.js` | touchdown-rate mean-reversion signal feeding trade/waiver value |
| `title-odds-trades.js` | ranks trades by championship-odds delta via the season simulator |
| `trade-engine.js` | core deterministic trade engine (assets/bestLineup/evaluate/findTrades/offerFor/selfScout) |
| `trend-exploits.js` | turns significant weekly trends into roster/waiver/trade actions |
| `trend-watch.js` | sweeps teams/players weekly and alerts on new/faded trends |
| `waiver-brain.js` | ranks waiver claims by expected value vs trades on the same scale |
| `week-postmortem.js` | decomposes a fantasy week's result into decision cost / projection error / variance |


## Betting-only services (139)

| File | Why |
|---|---|
| `audit-registry.js` | pure hypothesis-preregistration audit ledger; only server/routes/betting-hub.js imports it |
| `backtest-significance.js` | paired-bootstrap significance test for backtest deltas; every importer is an nfl-* betting service (nfl-offseason-change.js, nfl-opponent.js, nfl-passing-diagnostic.js, nfl-passing-specialists.js, nfl-player-context.js, nfl-prop-grading.js, nfl-props.js, nfl-scheme.js, nfl-teammate-competition.js) |
| `beat-the-close.js` | Phase-2 shadow CLV test that freezes spread/total decisions and grades vs Pinnacle close; only server/routes/nfl-market.js and server/services/scheduler.js call it |
| `book-feeds-extra.js` | two more free sportsbook odds scrapers (rotowire/sbr) writing nfl_line_snapshots; only nfl-market route/scheduler |
| `book-feeds.js` | free multi-book sportsbook quote feeds (oddstrader/pinnacle/kambi/bovada) plus the immutable quote tape; only betting importers (betting-hub, nfl-market, beat-the-close, evidence-daemon, line-shopping, nfl-clv, nfl-expert-council, nfl-shopping-board, polymarket-lines, scheduler, sharp-lag) |
| `decision-basis.js` | renders each spread/total pick's twenty-two-component ensemble contributions into English, deterministically; only server/routes/betting-hub.js |
| `evidence-daemon.js` | schedules/records pregame evidence-capture windows for the NFL and MLB betting models; only betting importers (routes/mlb.js, routes/nfl-market.js, model-intelligence.js, scheduler.js) |
| `football-first.js` | regresses football facts on the market's RESIDUAL (actual margin minus market margin) for spread/total picks; only betting importers (routes/nfl-betting.js, forward-ledger.js, report-cache.js, weekly-walkforward.js) |
| `forward-ledger.js` | records NFL spread/total predictions before kickoff so results can't be retrofitted (CLV-style forward test); only betting importers (routes/nfl-betting.js, nfl-model-growth.js) |
| `game-cutoff.js` | single canonical pregame-cutoff timestamp for betting evidence windows; only betting importers (beat-the-close.js, nfl-roster-strength.js, nfl-unified-engine.js) |
| `gridiron-model.js` | consolidated registry/audit layer over ~30 spread/total forecasting components, flags measured-dead ones; only betting importers (routes/model.js's betting-diagnostics endpoints, nfl-engine-registry.js, nfl-unified-engine.js) |
| `line-move-study.js` | Beat-the-close Phase 1: fits whether pre-close signals predict the open-to-close spread/total move; only server/services/report-cache.js (betting report) |
| `line-shopping.js` | best-price-across-books shopping board for sportsbook wagers, writes nfl_line_snapshots; only betting importers (routes/nfl-betting.js, routes/nfl-market.js, evidence-daemon.js, nfl-capture-dispatch.js, nfl-clv.js, nfl-expert-council.js, nfl-research.js, nfl-sharp.js, nfl-teaser-execution.js, scheduler.js) |
| `live-edge.js` | live in-game win-probability priced against a tradeable Polymarket exchange; only server/routes/betting-hub.js |
| `market-movement.js` | spread/total/price movement diagnostics from line snapshots, labelled "never edge"; only server/services/model-intelligence.js (betting) |
| `mlb-auto-picks.js` | first-party MLB betting picks generated from local projections and graded vs box scores; consumed by mlb-experiments.js, mlb-research.js, scheduler.js, routes/mlb.js |
| `mlb-calibration.js` | chronological price-aware probability calibration per MLB market; only routes/mlb.js and mlb-research.js |
| `mlb-experiments.js` | locked/preregistered MLB model validation experiment registry; only routes/mlb.js and mlb-research.js |
| `mlb-pregame.js` | pregame-only MLB snapshots (starters/lineups/scratches) plus real sportsbook quotes; consumed by evidence-daemon.js, mlb-auto-picks.js, mlb-research.js, routes/mlb.js |
| `mlb-projections.js` | first-party MLB prop projections (volume x rate, shrunk, simulated) feeding mlb-auto-picks.js and routes/mlb.js |
| `mlb-research.js` | market-separated MLB model readiness/evidence diagnostics dashboard; only server/routes/mlb.js |
| `mlb.js` | first-party MLB data pipeline (games/box scores) from MLB Stats API; consumed by mlb-pregame.js, mlb-projections.js, scheduler.js, routes/mlb.js — MLB has no fantasy tree in this app |
| `model-governance.js` | sport/market feature-contract, evidence-manifest and champion/challenger registry, keyed by sport+market+model_version; only betting importers (routes/mlb.js, routes/nfl-market.js, mlb-pregame.js, mlb-research.js, nfl-pregame.js, nfl-research.js) |
| `model-intelligence.js` | research control-plane gating candidate signals into betting production; only betting importers (routes/mlb.js, routes/nfl-market.js, mlb-research.js, nfl-research.js) |
| `model-signal-quality.js` | uncertainty-layer signal-truth ledger gating candidate paths into a projection/stake; direct importers are server/routes/nfl-betting.js and server/services/nfl-props.js (both betting) plus the shared server/services/player-week-engine.js — no direct fantasy-labelled importer found, so not promoted to shared-engine |
| `nfelo.js` | free nfelo Elo/market CSVs feeding spread model; importers all betting (routes/nfl-market.js, nfl-matchup-specialists.js, beat-the-close.js, line-move-study.js) |
| `nfl-abstention-audit.js` | grades games the betting policy declined to bet |
| `nfl-ai-replay.js` | Claude risk-gate review of historical betting candidates |
| `nfl-auto-picks.js` | locks in weekly spread picks, grades against game_lines |
| `nfl-availability.js` | injury/snap-share weighting feeding the spread ensemble (only importer nfl-ensemble.js) |
| `nfl-blind-audit.js` | content-addressed chronological replay/audit controller for betting picks |
| `nfl-candidate-analysis.js` | candidate-vs-champion robustness audit for betting models |
| `nfl-capture-dispatch.js` | spends metered odds-API credits on movement triggers |
| `nfl-clv.js` | closing-line-value ledger and grading |
| `nfl-coaches.js` | head-coach history feature; direct importers (football-context.js, nfl-roster-strength.js) are betting-side context modules, no direct fantasy-route importer |
| `nfl-context-heads.js` | prop-stat matchup/weather/rest candidate heads |
| `nfl-coordination-audit.js` | machine-readable audit of what reaches the betting decision |
| `nfl-cover-calibration.js` | price-aware spread cover-probability calibration |
| `nfl-data-consistency.js` | cross-season coverage audit of NFL model input features |
| `nfl-diagnostic.js` | one health report aggregating betting-engine sub-audits |
| `nfl-drive-sim.js` | play-by-play game simulator for margin/total/moneyline |
| `nfl-engine-backfill.js` | resumable chronological backfill of the unified betting engine |
| `nfl-ensemble.js` | combines independent rating models into one projected spread line |
| `nfl-espn-line-watch.js` | free ESPN scoreboard line-movement detector, triggers paid odds capture |
| `nfl-espn-pbp.js` | live ESPN play-by-play feeding the drive simulator/live win-prob |
| `nfl-event-archive.js` | cutoff-safe archive of injuries/trades/roster events for betting features; all importers (nfl-team-card, nfl-expert-council, beat-the-close, nfl-model-growth, line-move-study) are betting |
| `nfl-evidence-provenance.js` | flags late/undated timestamps in the forward betting ledger |
| `nfl-evidence.js` | evidence inventory/validation firewall for betting pregame artifacts |
| `nfl-execution-edge.js` | execution-edge/stake-sizing math (line shopping vs prediction edge) |
| `nfl-execution.js` | where to place a bet and tracks realized execution savings |
| `nfl-experiments.js` | locked/immutable betting-model experiment registry |
| `nfl-expert-coordinator.js` | robust market-residual coordinator blending betting specialist signals |
| `nfl-expert-council.js` | weekly auditable contract aggregating every betting modelling approach |
| `nfl-external-ratings.js` | ESPN FPI / TeamRankings public power ratings snapshot; all importers (nfl-market.js, nfl-matchup-specialists.js, beat-the-close.js, line-move-study.js) are betting |
| `nfl-feature-coverage.js` | evidence-backed inventory of variables available at each betting weekly cutoff |
| `nfl-features.js` | variable catalog/feature derivation from play-by-play for the spread model; all importers (betting-hub.js, nfl-betting.js, nfl-ai-replay.js, nfl-context-heads.js, nfl-reasoning.js) are betting |
| `nfl-formations.js` | real formation/personnel data feeding the drive-sim/model-growth pipeline (only importer nfl-model-growth.js) |
| `nfl-gbm.js` | gradient-boosted trees predicting the betting market residual |
| `nfl-live-ledger.js` | possession-by-possession immutable live betting prediction ledger |
| `nfl-live.js` | live ESPN game state and in-game win probability for the betting product |
| `nfl-market.js` | team offense/defense Elo-in-points model driving spread/total probabilities vs sportsbook price |
| `nfl-matchup-specialists.js` | ridge-regression council roles on market residual (trench/tendency/situational/pressure), no fantasy caller |
| `nfl-model-growth.js` | end-to-end retrain pipeline for the spread/props ensemble after new results land |
| `nfl-model-watch.js` | automated discover-and-report evaluation loop that gates promotion of betting model candidates |
| `nfl-neural-replay.js` | prequential audit + calibrator for the online spread-residual neural head |
| `nfl-news-market-latency.js` | measures verified-news latency against bookmaker line snapshots |
| `nfl-officials.js` | tests whether referee crews move a total, no fantasy caller |
| `nfl-offseason-change.js` | changedTeam/vacatedShare features for the betting model's offseason adjustment, imports nfl-player-state.js |
| `nfl-online-neural.js` | persistent online neural challenger learning the spread-vs-market residual |
| `nfl-opening-lines.js` | opening vs closing line CLV benchmark using nflverse initial_lines.csv |
| `nfl-opponent.js` | opponent efficiency (yards-per-opportunity) adjustment for the spread model, no fantasy caller |
| `nfl-orthogonal-specialists.js` | ordered residual specialist ensemble feeding the betting coordinator |
| `nfl-passing-diagnostic.js` | attempts x YPA error attribution for passing-yard prop model |
| `nfl-passing-specialists.js` | twenty component passing-yard prop challengers with promotion gates |
| `nfl-pick-explanation-audit.js` | immutable audit log of AI-generated wording for betting picks, only used by nfl-betting.js route |
| `nfl-player-context.js` | age/injury opportunity multiplier consumed only by the shared player-week engine, no separate direct fantasy or betting importer found (single importer is player-week-engine.js itself) |
| `nfl-player-value.js` | cutoff-safe replacement-value/availability estimate feeding the betting ensemble and expert council, no fantasy-side caller found |
| `nfl-policy.js` | frozen decision policy (markets/thresholds/capacity) for live NFL picks and replay |
| `nfl-postgame-truth.js` | postgame result/error-classification packets for betting model training context |
| `nfl-pregame.js` | immutable pregame context snapshots for forward-shadow betting evaluation |
| `nfl-profitability.js` | operational dashboard/controls wiring together the betting profitability plan's evidence gates |
| `nfl-prop-calibration.js` | chronological calibration registry for player-prop probabilities |
| `nfl-prop-clv.js` | closing-line value tracking/evidence for player props, sportsbook-price comparison |
| `nfl-prop-correlation.js` | joint distribution of prop stats for same-game-parlay mispricing, betting-hub route only |
| `nfl-prop-grading.js` | multi-metric grading of prop model vs baselines |
| `nfl-prop-head-validation.js` | chronological validation pipeline for prop-stat candidate heads, reuses fantasy validation primitives but applied to props only |
| `nfl-props-replay.js` | retrospective grading of prop picks against a synthetic historical line proxy |
| `nfl-props.js` | player prop projections and weekly total picks compared to sportsbook no-vig price |
| `nfl-qbr.js` | ESPN QBR ingestion used as a betting-model evidence input (council role, line-move study), no fantasy caller found |
| `nfl-quote-tape.js` | append-only multi-sportsbook quote archive (price + timing), betting evidence only |
| `nfl-reasoning.js` | derives human-readable rationale for why the betting model likes a pick |
| `nfl-rebuild-progress.js` | progress/checkpoint status reader for the NFL model rebuild run, used only by nfl-betting.js route |
| `nfl-replay.js` | season-by-season replay/backtest and systematic-error analysis for betting picks |
| `nfl-research.js` | market-residual research/ablation and promotion-readiness harness for the betting model |
| `nfl-risk-lab.js` | high-variance research models (deep ensemble, Bayesian online, mixture-of-experts) for the restricted betting challenger pool |
| `nfl-rookie-ingest.js` | ingests draft/combine data feeding nfl-rookies.js; only importers are nfl-betting.js route and scheduler.js |
| `nfl-rookies.js` | draft-capital rookie prior for the game-forecast model; only imported by nfl-roster-strength.js and nfl-betting.js, no fantasy draft/dynasty caller |
| `nfl-roster-strength.js` | cutoff-safe preseason/weekly roster-strength signal feeding team cards for the game model |
| `nfl-scheme.js` | coordinator-change/scheme-identity signal; imported only by nfl-coaches.js, nfl-roster-strength.js, nfl-betting.js |
| `nfl-sharp.js` | sharp-book vs recreational-book line divergence detection, verified via CLV |
| `nfl-shopping-board.js` | best-execution pricing and middles from multi-book snapshot captures |
| `nfl-signal-reliability.js` | shrink-only reliability controller for the unified betting candidate engine |
| `nfl-sim-calibration.js` | immutable chronological calibration artifacts for the play/drive simulator |
| `nfl-sim-learn.js` | learned team rates and expected-points surface underlying the game simulator |
| `nfl-sim-policy.js` | strategic 4th-down/2pt/clock decision modules consulted by the simulated coaches |
| `nfl-slice-diagnostic.js` | accuracy/calibration of the expert council's picks cut by slice |
| `nfl-specialist-audit.js` | RMSE/conviction/duplication audit of the specialist forecasters |
| `nfl-specialists.js` | market-residual specialist models plus context-weighted meta-model blend |
| `nfl-spread-context.js` | ATS cover-record and cover-margin context for spread picks |
| `nfl-team-card.js` | frozen shared team state; consumed only by nfl-betting.js, nfl-live-ledger.js, nfl-expert-council.js, nfl-model-growth.js, nfl-orthogonal-specialists.js |
| `nfl-teammate-competition.js` | teammate share-momentum redistribution signal; sole importer is server/routes/nfl-betting.js |
| `nfl-teaser-execution.js` | operational Wong-teaser routing across books |
| `nfl-teasers.js` | Wong teaser structural edge measurement (the one defensible +EV bet) |
| `nfl-transactions.js` | ESPN transaction wire; only consumers are scheduler.js (sync) and signal-latency.js -> betting-hub.js route, no fantasy waiver-wire caller found |
| `nfl-tweet-line-correlation.js` | tests whether insider tweets move the betting line |
| `nfl-unified-engine.js` | canonical reconciled game/line answer from the ensemble+simulator |
| `nfl-user-bets.js` | user's manually-tracked sportsbook bets, graded like auto-picks |
| `nfl-weather-history.js` | historical wind/weather forecast-lead archive for the line-move study |
| `nfl-weather.js` | kickoff-hour weather archive; only consumed by nfl-weather-history.js, beat-the-close.js, line-move-study.js, nfl-market.js route |
| `nfl-weekly-feature-store.js` | high-dimensional team/player feature vector factory; consumers are nfl-team-card.js, nfl-feature-coverage.js, nfl-model-growth.js, nfl-betting.js route |
| `odds-api.js` | the Odds API sportsbook client/cache, the project's only paid feed |
| `odds-archive.js` | historical multi-book opening/closing quote archive (OddsTrader) |
| `pick-confidence.js` | calibrated win-probability score for sportsbook picks |
| `pick-reasoning.js` | English reasoning trace separating causal drivers from descriptive context for a betting pick |
| `player-head-validation.js` | discovery/redundancy/significance validation harness for player heads; only importers are server/routes/nfl-betting.js, server/services/nfl-context-heads.js, server/services/nfl-prop-head-validation.js (all betting-side), despite validating a "fantasy points" registry |
| `polymarket-lines.js` | derives implied spread/total from Polymarket order books, feeds line-movement/CLV consumers |
| `polymarket.js` | Polymarket props/game-market ingestion and cost/CLV measurement vs sportsbooks |
| `prediction-markets.js` | Kalshi/Polymarket exchange flow vs sportsbook line movement research |
| `press-conference.js` | scrapes coach/player pressers for availability signal; wired only into nfl-betting route + scheduler, no fantasy caller found |
| `prop-feeds.js` | free player-prop quote feeds (Action Network, Underdog) for CLV measurement; sole consumer server/routes/nfl-market.js |
| `shadow-ledger.js` | forward/shadow ledger schema for grading betting picks against frozen lines |
| `sharp-lag.js` | measures how long soft books take to follow Pinnacle line moves (CLV lag) |
| `signal-latency.js` | grades in-house signals against subsequent sportsbook line movement |
| `source-validation.js` | verifies Twitter/X handles are the real reporters before trusting their feed; wired only into nfl-betting route |
| `sportsgameodds.js` | optional second free multi-book odds/spread quote provider |
| `staking.js` | Kelly-fraction bet sizing by confidence |
| `weekly-backtest.js` | week-by-week walk-forward replay of the model; consumed only by server/services/nfl-blind-audit.js and server/services/player-head-validation.js (betting model audit), no fantasy caller found |
| `weekly-walkforward.js` | refits football-first model weekly and predicts next week; consumed only by server/routes/nfl-betting.js, no fantasy caller found |
| `who-plays.js` | joins injury report/news/snap-count sources into one availability answer; wired only into nfl-betting route, no fantasy caller found |


## Shared-engine services (19)

| File | Why |
|---|---|
| `backtest.js` | generic "grade any projection source against real boxscores" harness (MAE/CRPS/etc) — fantasy importers: server/routes/model.js (grades buildProjections/season-sim output via compare/actuals/gradePoint/gradeDistribution/baselines/weeklyDecisionBacktest); betting importers: server/services/nfl-prop-grading.js, server/services/backtest-significance.js, server/services/player-head-validation.js |
| `football-context.js` | assembles the football narrative (injuries, matchup, coaching tendencies, weather) behind one player/game pick — fantasy importers: server/services/player-case.js (explicitly "the fantasy pages"); betting importers: server/routes/nfl-betting.js, server/services/football-first.js |
| `gamescript.js` | fits spread/total to pass/rush volume ("game script") — fantasy importers: server/services/ceiling-lineup.js, server/services/season-sim.js, server/services/waiver-brain.js; betting importers: server/routes/nfl-market.js, server/services/nfl-props.js, server/services/nfl-context-heads.js, server/services/nfl-prop-head-validation.js |
| `matchups.js` | DVP/opponent-matchup and schedule-strength stats from real boxscores — fantasy importers: server/services/ceiling-lineup.js, server/services/season-sim.js, server/services/trade-engine.js, server/routes/trades.js; betting importers: server/services/football-context.js (itself feeding server/routes/nfl-betting.js) and server/routes/nfldata.js |
| `nfl-advanced.js` | NGS/PFR/snaps/depth-charts/injuries sync, consumed by both trees — fantasy importers: server/routes/model.js (syncAllAdvanced), server/services/betting-fantasy-link.js (rolesFor, injuryFor - the bridge feeding fantasy); betting importers: server/routes/nfl-betting.js, server/services/nfl-engine-backfill.js, server/services/nfl-event-archive.js, server/services/nfl-model-growth.js |
| `nfl-engine-registry.js` | content-addressed version clock for the "many-headed" engine, read by both trees — fantasy importers: server/services/player-week-engine.js (nflEngineVersionFor), feeding server/routes/model.js; betting importers: server/routes/nfl-betting.js, server/services/nfl-engine-backfill.js, server/services/nfl-props.js, server/services/nfl-online-neural.js, server/services/nfl-risk-lab.js, server/services/nfl-unified-engine.js, server/services/nfl-model-growth.js, server/services/nfl-ensemble.js, server/services/nfl-profitability.js |
| `nfl-news-signal.js` | typed cutoff-safe news extraction feeding both fantasy player-week state and the betting team-impact candidate — fantasy importers: server/routes/news.js (direct), and via server/services/player-week-engine.js -> server/routes/model.js, server/services/trade-engine.js, server/services/gridiron-model.js, server/services/news-fantasy-impact.js; betting importers: server/routes/nfl-betting.js (direct), server/services/nfl-online-neural.js, server/services/nfl-postgame-truth.js, server/services/nfl-expert-council.js, server/services/nfl-unified-engine.js, server/services/nfl-reasoning.js, server/services/nfl-diagnostic.js |
| `nfl-pbp.js` | streams nflverse play-by-play into team-week/player-week feature rows consumed by both projection and betting engines — fantasy importers: server/routes/model.js (syncPbpSeason, prediction-engine route); betting importers: server/routes/nfl-betting.js, server/services/nfl-props.js, server/services/nfl-model-growth.js, server/services/nfl-prop-clv.js, server/services/nfl-context-heads.js, server/services/nfl-engine-backfill.js, server/services/nfl-pregame.js, server/services/nfl-features.js, server/services/nfl-roster-strength.js, server/services/nfl-reasoning.js, server/services/nfl-prop-head-validation.js, server/services/nfl-player-context.js, server/services/nfl-ensemble.js, server/services/nflverse.js |
| `nfl-player-state.js` | dated roster-snapshot/transaction ledger ("what did we know at cutoff") used for both roster sync and betting offseason features — fantasy importers: server/routes/nfldata.js (captureCurrentRosterSnapshot, sync-rosters endpoint); betting importers: server/services/nfl-offseason-change.js, server/services/nfl-transactions.js |
| `nflverse.js` | core nflverse CSV ingestion (player_week_usage substrate) genuinely consumed by both trees — fantasy importers: server/routes/model.js (prediction-engine API), server/services/ffopportunity.js (fantasy expected-points benchmark); betting importers: server/routes/nfl-betting.js, server/routes/props.js, server/services/nfl-engine-backfill.js, server/services/nfl-officials.js, server/services/nfl-event-archive.js, server/services/nfl-qbr.js, server/services/nfl-model-growth.js, server/services/nfl-rookie-ingest.js |
| `player-head-registry.js` | candidate player-week projection heads genuinely consumed by both trees — fantasy importers: server/services/weekly-backtest.js, server/services/weekly-learning.js (fantasy-points walk-forward learning/replay), server/services/player-head-validation.js's own callers aside, server/services/player-week-engine.js (shared fantasy-scoring consumer); betting importers: server/routes/nfl-betting.js, server/services/nfl-blind-audit.js, server/services/nfl-prop-head-validation.js |
| `player-week-engine.js` | structural+ensemble player-week state estimator consumed by both trees — fantasy importers: server/services/trade-engine.js, server/routes/model.js; betting importers: server/services/nfl-props.js, server/services/nfl-blind-audit.js, server/services/nfl-expert-council.js, server/services/nfl-context-heads.js, server/services/nfl-prop-head-validation.js, server/services/nfl-model-growth.js, server/services/weekly-learning.js (also bridged via server/services/betting-fantasy-link.js and server/services/news-fantasy-impact.js) |
| `projections.js` | volume x efficiency player projection distributions — fantasy importers: server/services/season-sim.js, server/services/week-postmortem.js, server/services/ceiling-lineup.js, server/routes/model.js; betting importers: server/services/weekly-backtest.js |
| `role-changepoint.js` | detects sustained usage/role shifts from snap share, feeds the shared player-week engine — fantasy importers: none direct (reaches fantasy transitively via server/services/player-week-engine.js -> server/services/trade-engine.js); betting importers: none direct (reaches betting transitively via server/services/player-week-engine.js -> server/services/nfl-props.js); only confirmed direct importer is server/services/player-week-engine.js itself |
| `scoring.js` | league scoring applied to a stat line, shared grading primitive — fantasy importers: server/services/season-sim.js, server/services/ceiling-lineup.js, server/services/week-postmortem.js, server/services/trade-engine.js, server/services/correlation.js, server/services/backtest.js, server/routes/model.js; betting importers: server/services/weekly-backtest.js, server/services/weekly-learning.js |
| `weekly-ensemble.js` | frozen Stage 1.3 weekly ensemble weights/architecture — fantasy importers: none direct (reaches fantasy transitively via server/services/player-week-engine.js -> server/services/trade-engine.js, and via server/services/weekly-learning.js -> server/routes/model.js); betting importers: server/services/player-head-validation.js, server/services/weekly-backtest.js (also consumed by server/services/weekly-weight-store.js and server/services/player-week-engine.js, both shared) |
| `weekly-learning.js` | progressive weekly learning with pregame/outcome boundary, promotes challenger weights — fantasy importers: server/routes/model.js; betting importers: server/routes/nfl-market.js, server/routes/nfl-betting.js, server/services/beat-the-close.js, server/services/nfl-model-growth.js, server/services/nfl-profitability.js |
| `weekly-trends.js` | time-series trend detection over team/player metrics with significance filtering — fantasy importers: server/routes/trades.js, server/services/trend-exploits.js, server/services/trend-watch.js, server/services/player-case.js; betting importers: server/services/nfl-postgame-truth.js |
| `weekly-weight-store.js` | versioned champion/candidate weight store for the weekly ensemble — fantasy importers: none direct (reaches fantasy transitively via server/services/player-week-engine.js -> server/services/trade-engine.js, and via server/services/weekly-learning.js -> server/routes/model.js); betting importers: server/services/weekly-learning.js directly (also consumed by server/services/player-week-engine.js, shared) |


## Bridge services (3)

| File | Why |
|---|---|
| `betting-fantasy-link.js` | documented single crossing point from the shared betting event-state to fantasy points, per docs/ARCHITECTURE_MODEL_VS_FANTASY.md; only server/routes/nfl-betting.js calls it |
| `player-case.js` | deliberately assembles betting-side football-context signals (QB picture, availability, coaching, defensive weakness, weather from football-context.js) into a fantasy start/sit case for server/services/lineup-brain.js -> server/routes/trades.js |
| `vegas-fantasy.js` | applies Vegas spread/total/implied-team-total to fantasy projections; deliberate betting-to-fantasy bridge (task-confirmed candidate) |


## Infrastructure / domain-agnostic (14)

| File | Why |
|---|---|
| `claude.js` | Claude API wrapper + token pricing/usage tracking table, called from routes and services on both sides (accolades, analysis, drafts, edge, news, nfl-betting, players, tradelab, trades, nfl-ai-replay.js, nfl-news-signal.js, nfl-tweet-line-correlation.js) |
| `compute-cache.js` | fingerprint-keyed (row-count+timestamp) memoization cache with no domain content, used by both betting-hub/nfl-betting/nfl-market and fantasy files (football-first.js, player-ids.js, td-regression.js, trade-engine.js) |
| `date-util.js` | app-timezone date formatting + IANA-zone kickoff conversion; used throughout both nfl/mlb betting services and fantasy weekly-learning |
| `player-identity.js` | name-normalization/candidate-matching utility with no domain content, used incidentally by both trees (espn.js, nflverse.js, nfl-rookies.js, espn-draft.js, etc.) |
| `player-ids.js` | player id crosswalk (internal id / gsis_id / espn_id / sleeper_id); sole direct importer is the shared utility football-context.js |
| `player-repair.js` | read-only db audit/repair tool for player-identity records, wired only into dev route |
| `report-cache.js` | generic off-thread report compute/cache layer (SQLite + worker thread), no domain content itself |
| `report-worker.js` | worker-thread entry point for report-cache.js, generic execution shell |
| `scheduler.js` | generic timer + staleness-check job runner for data syncs across the whole app, no domain content itself |
| `source-registry.js` | central registry of ingestion sources (cadence/cutoff/failure mode), no decision logic of its own |
| `stats-util.js` | small statistical helpers (shrink, quantile, mean, etc.) shared by matchup/projection/simulation layers on both sides, no domain content of its own |
| `system-connectivity.js` | import-graph audit for orphaned/unreachable modules, no domain content itself |
| `team-codes.js` | single team-code/name normalizer utility; currently consumed only by betting-side files (book-feeds*, odds-archive, nfl-advanced, nfl-postgame-truth, nfl-external-ratings, nfl-news-market-latency, prop-feeds, nfl-event-archive, sportsgameodds, nfl-qbr, nfelo, gamescript) but content is domain-agnostic |
| `twitterapi-io.js` | twitterapi.io API client with a hard db-persisted spend cap, generic cost-capped wrapper |
## Coupling points

Every shared-engine file, and exactly which fantasy-side and betting-side files import it — the blast radius to check before editing one.

### `backtest.js`

- generic "grade any projection source against real boxscores" harness (MAE/CRPS/etc)
- fantasy importers: server/routes/model.js (grades buildProjections/season-sim output via compare/actuals/gradePoint/gradeDistribution/baselines/weeklyDecisionBacktest); betting importers: server/services/nfl-prop-grading.js, server/services/backtest-significance.js, server/services/player-head-validation.js

### `football-context.js`

- assembles the football narrative (injuries, matchup, coaching tendencies, weather) behind one player/game pick
- fantasy importers: server/services/player-case.js (explicitly "the fantasy pages"); betting importers: server/routes/nfl-betting.js, server/services/football-first.js

### `gamescript.js`

- fits spread/total to pass/rush volume ("game script")
- fantasy importers: server/services/ceiling-lineup.js, server/services/season-sim.js, server/services/waiver-brain.js; betting importers: server/routes/nfl-market.js, server/services/nfl-props.js, server/services/nfl-context-heads.js, server/services/nfl-prop-head-validation.js

### `matchups.js`

- DVP/opponent-matchup and schedule-strength stats from real boxscores
- fantasy importers: server/services/ceiling-lineup.js, server/services/season-sim.js, server/services/trade-engine.js, server/routes/trades.js; betting importers: server/services/football-context.js (itself feeding server/routes/nfl-betting.js) and server/routes/nfldata.js

### `nfl-advanced.js`

- NGS/PFR/snaps/depth-charts/injuries sync, consumed by both trees
- fantasy importers: server/routes/model.js (syncAllAdvanced), server/services/betting-fantasy-link.js (rolesFor, injuryFor - the bridge feeding fantasy); betting importers: server/routes/nfl-betting.js, server/services/nfl-engine-backfill.js, server/services/nfl-event-archive.js, server/services/nfl-model-growth.js

### `nfl-engine-registry.js`

- content-addressed version clock for the "many-headed" engine, read by both trees
- fantasy importers: server/services/player-week-engine.js (nflEngineVersionFor), feeding server/routes/model.js; betting importers: server/routes/nfl-betting.js, server/services/nfl-engine-backfill.js, server/services/nfl-props.js, server/services/nfl-online-neural.js, server/services/nfl-risk-lab.js, server/services/nfl-unified-engine.js, server/services/nfl-model-growth.js, server/services/nfl-ensemble.js, server/services/nfl-profitability.js

### `nfl-news-signal.js`

- typed cutoff-safe news extraction feeding both fantasy player-week state and the betting team-impact candidate
- fantasy importers: server/routes/news.js (direct), and via server/services/player-week-engine.js -> server/routes/model.js, server/services/trade-engine.js, server/services/gridiron-model.js, server/services/news-fantasy-impact.js; betting importers: server/routes/nfl-betting.js (direct), server/services/nfl-online-neural.js, server/services/nfl-postgame-truth.js, server/services/nfl-expert-council.js, server/services/nfl-unified-engine.js, server/services/nfl-reasoning.js, server/services/nfl-diagnostic.js

### `nfl-pbp.js`

- streams nflverse play-by-play into team-week/player-week feature rows consumed by both projection and betting engines
- fantasy importers: server/routes/model.js (syncPbpSeason, prediction-engine route); betting importers: server/routes/nfl-betting.js, server/services/nfl-props.js, server/services/nfl-model-growth.js, server/services/nfl-prop-clv.js, server/services/nfl-context-heads.js, server/services/nfl-engine-backfill.js, server/services/nfl-pregame.js, server/services/nfl-features.js, server/services/nfl-roster-strength.js, server/services/nfl-reasoning.js, server/services/nfl-prop-head-validation.js, server/services/nfl-player-context.js, server/services/nfl-ensemble.js, server/services/nflverse.js

### `nfl-player-state.js`

- dated roster-snapshot/transaction ledger ("what did we know at cutoff") used for both roster sync and betting offseason features
- fantasy importers: server/routes/nfldata.js (captureCurrentRosterSnapshot, sync-rosters endpoint); betting importers: server/services/nfl-offseason-change.js, server/services/nfl-transactions.js

### `nflverse.js`

- core nflverse CSV ingestion (player_week_usage substrate) genuinely consumed by both trees
- fantasy importers: server/routes/model.js (prediction-engine API), server/services/ffopportunity.js (fantasy expected-points benchmark); betting importers: server/routes/nfl-betting.js, server/routes/props.js, server/services/nfl-engine-backfill.js, server/services/nfl-officials.js, server/services/nfl-event-archive.js, server/services/nfl-qbr.js, server/services/nfl-model-growth.js, server/services/nfl-rookie-ingest.js

### `player-head-registry.js`

- candidate player-week projection heads genuinely consumed by both trees
- fantasy importers: server/services/weekly-backtest.js, server/services/weekly-learning.js (fantasy-points walk-forward learning/replay), server/services/player-head-validation.js's own callers aside, server/services/player-week-engine.js (shared fantasy-scoring consumer); betting importers: server/routes/nfl-betting.js, server/services/nfl-blind-audit.js, server/services/nfl-prop-head-validation.js

### `player-week-engine.js`

- structural+ensemble player-week state estimator consumed by both trees
- fantasy importers: server/services/trade-engine.js, server/routes/model.js; betting importers: server/services/nfl-props.js, server/services/nfl-blind-audit.js, server/services/nfl-expert-council.js, server/services/nfl-context-heads.js, server/services/nfl-prop-head-validation.js, server/services/nfl-model-growth.js, server/services/weekly-learning.js (also bridged via server/services/betting-fantasy-link.js and server/services/news-fantasy-impact.js)

### `projections.js`

- volume x efficiency player projection distributions
- fantasy importers: server/services/season-sim.js, server/services/week-postmortem.js, server/services/ceiling-lineup.js, server/routes/model.js; betting importers: server/services/weekly-backtest.js

### `role-changepoint.js`

- detects sustained usage/role shifts from snap share, feeds the shared player-week engine
- fantasy importers: none direct (reaches fantasy transitively via server/services/player-week-engine.js -> server/services/trade-engine.js); betting importers: none direct (reaches betting transitively via server/services/player-week-engine.js -> server/services/nfl-props.js); only confirmed direct importer is server/services/player-week-engine.js itself

### `scoring.js`

- league scoring applied to a stat line, shared grading primitive
- fantasy importers: server/services/season-sim.js, server/services/ceiling-lineup.js, server/services/week-postmortem.js, server/services/trade-engine.js, server/services/correlation.js, server/services/backtest.js, server/routes/model.js; betting importers: server/services/weekly-backtest.js, server/services/weekly-learning.js

### `weekly-ensemble.js`

- frozen Stage 1.3 weekly ensemble weights/architecture
- fantasy importers: none direct (reaches fantasy transitively via server/services/player-week-engine.js -> server/services/trade-engine.js, and via server/services/weekly-learning.js -> server/routes/model.js); betting importers: server/services/player-head-validation.js, server/services/weekly-backtest.js (also consumed by server/services/weekly-weight-store.js and server/services/player-week-engine.js, both shared)

### `weekly-learning.js`

- progressive weekly learning with pregame/outcome boundary, promotes challenger weights
- fantasy importers: server/routes/model.js; betting importers: server/routes/nfl-market.js, server/routes/nfl-betting.js, server/services/beat-the-close.js, server/services/nfl-model-growth.js, server/services/nfl-profitability.js

### `weekly-trends.js`

- time-series trend detection over team/player metrics with significance filtering
- fantasy importers: server/routes/trades.js, server/services/trend-exploits.js, server/services/trend-watch.js, server/services/player-case.js; betting importers: server/services/nfl-postgame-truth.js

### `weekly-weight-store.js`

- versioned champion/candidate weight store for the weekly ensemble
- fantasy importers: none direct (reaches fantasy transitively via server/services/player-week-engine.js -> server/services/trade-engine.js, and via server/services/weekly-learning.js -> server/routes/model.js); betting importers: server/services/weekly-learning.js directly (also consumed by server/services/player-week-engine.js, shared)
