# Codex Platform Audit & Product Suggestions

Audit date: 2026-08-24  
Audited build: `1a2d359` on `main`  
Scope: every visible navigation tab from Dashboard downward, hidden/legacy routes, shared UI, APIs, persistence, data freshness, and release engineering.

## How Claude should use this document

This is an implementation brief, not a request to build everything at once.

- **P0 — Trust/reliability:** fix before adding major product surface.
- **P1 — Core product:** highest user value; build next.
- **P2 — Differentiation:** creative features that can make Gridiron HQ unusually useful.
- **P3 — Polish/scale:** valuable after workflows are coherent.
- **Quick win:** narrow enough for one focused change.
- **Design project:** requires schema/API/UX decisions and should be proposed before implementation.

For each completed section, Claude should update `CLAUDE_FEEDBACK.md` with files changed, migrations, API contracts, tests, and screenshots/manual verification. Codex should then review the diff and run acceptance checks.

---

# Executive assessment

## What the platform already does unusually well

Gridiron HQ already contains more real analytical machinery than most personal fantasy tools:

- Multi-league ESPN and Sleeper ingestion.
- Format-aware market values and roster analysis.
- Optimal-lineup, trade, VOR, schedule, volatility, correlation, and season simulation engines.
- A real mock/live tracking draft board with persisted picks.
- NFL team scheme, coaching, depth, cap, and roster context.
- First-party NFL and MLB modeling, pick ledgers, line shopping, replay, and model evidence.
- Explicit freshness banners and honest model limitations in several betting screens.
- Local-first storage and optional AI prose instead of making AI a prerequisite.

The core opportunity is not “add more models.” It is to turn these engines into a coherent decision operating system.

## The biggest platform weaknesses

### P0: Trust is uneven

- There is no automated application test suite, no `test` script, and no isolated test database.
- Tables are created across route and service modules at import time. Schema ownership and migration order are difficult to reason about.
- Many pages do not render API errors; some silently swallow failures or use browser `alert()`.
- Data freshness is excellent on a few betting pages and unclear almost everywhere else.
- Several destructive or expensive operations have weak busy-state protection.
- The default offline draft pool cannot complete the default draft size; K/team DEF representation remains unresolved.
- Browser-local pick tracking creates split-brain persistence: some records live in SQLite, some only in one browser.

### P1: The app does not answer “what should I do today?”

The Dashboard mostly links to sections. It does not synthesize lineup moves, waivers, injuries, trades, news, draft status, model freshness, and betting exposure into a prioritized command queue.

### P1: Workflows are fragmented

- Fantasy Lab is a menu linking to two older pages instead of a unified workspace.
- NFL Auto Picks routes to the same component as NFL Board, so the navigation promises a distinct product that does not exist.
- ESPN Settings duplicates functionality now available through My Leagues and ESPN Connect.
- MLB first-party and proxied/legacy products overlap without a clear migration story.
- Player, roster, news, draft, and trade insights rarely deep-link into the next useful action.

### P1: Accountability is inconsistent

The betting side has ledgers and holdout evidence, while fantasy advice has little “what did the app recommend, what happened, was it right?” memory. The app needs a recommendation journal across lineup, waiver, trade, draft, and betting decisions.

### P2: The platform has enough data for a true “digital twin”

The combined roster, league, schedule, market, usage, injury, game-script, and simulation data could power a persistent digital twin of each fantasy team: title odds, playoff odds, weekly risk, replacement plans, and the marginal value of every possible action.

---

# Global product and engineering recommendations

## 1. Build a universal “Decision Inbox” (P1, design project)

Every engine should emit normalized recommendations into one table:

```text
decision_recommendations
id, league_id, sport, type, subject_ids, title, rationale,
expected_value, confidence, urgency, expires_at, status,
source_model, source_version, created_at, resolved_at, outcome
```

Examples:

- Start Player A over Player B before Thursday kickoff.
- Add a free-agent RB before waivers process.
- Sell a player whose role and market value are diverging.
- Respond to a positional run in a live draft.
- A line moved through the model’s fair price; do not bet anymore.
- Probable pitcher changed; invalidate MLB picks.

The Dashboard becomes a ranked queue, and every tab can publish to or resolve items from it.

## 2. Add a global command palette and entity navigation (P1)

`⌘K` should search players, NFL teams, fantasy teams, leagues, drafts, games, and actions. Results should support verbs:

- “Open player”
- “Compare with…”
- “Trade for…”
- “Add to watchlist”
- “Draft / mark taken” when a draft is active
- “Open matchup”
- “Explain this model signal”

This removes dependence on a long sidebar and makes the app feel like an operating system.

## 3. Standardize page states (P0, quick-to-medium)

Create shared components:

- `PageLoading`
- `PageError` with retry
- `EmptyState` with a primary next action
- `FreshnessStamp`
- `MutationBanner` / toast queue
- `ConfirmDialog`
- `DataProvenance` drawer

Every API-backed page must show loading, failure, empty, stale, and success states. Eliminate silent catches and browser `alert()`/`confirm()` over time.

## 4. Create a data health center (P0/P1)

The header refresh button is useful but opaque. Add a Data Health page/drawer showing, per source:

- Last successful sync and duration.
- Records added/updated.
- Expected cadence and next scheduled run.
- Current season/week/date represented.
- Authentication or quota state.
- Last error and retry button.
- Downstream features affected when stale.

Sources: ESPN players/news/leagues, Sleeper, FantasyCalc, FFC, nflverse, schedules, depth charts, injuries, lines, Odds API, MLB schedule/starters/batters, proxied Diamond Signal.

## 5. Centralize schema and migrations (P0, design project)

Move all `CREATE TABLE` statements out of routes/services into numbered migrations. Add:

- `schema_migrations` table.
- `PRAGMA foreign_keys = ON`.
- startup integrity check.
- backup before migration.
- configurable DB path (`GRIDIRON_DB_PATH`) for tests.
- transaction wrappers for multi-write workflows.

Routes should not mutate schema merely because they were imported.

## 6. Add real test and release gates (P0)

Minimum scripts:

```json
"typecheck": "tsc --noEmit",
"test": "node --test",
"test:integration": "...isolated SQLite DB...",
"check": "npm run typecheck && npm test && npm run build"
```

Critical integration coverage:

- Fresh install/seed/migrate/start.
- League add/sync and roster normalization.
- Draft create/pick/undo/reload/complete.
- Trade evaluate invariants.
- Pick ledger lock/grade/idempotency.
- Stale-data suppression.
- API error contract snapshots.

Add a release manifest containing commit, schema version, data snapshot ages, build timestamp, and test results.

## 7. Recommendation provenance and replay (P1/P2)

Every recommendation should save:

- Inputs known at the time.
- Model/version.
- Market line/value at recommendation time.
- Confidence and alternatives.
- User action: accepted, rejected, ignored, modified.
- Later outcome.

This powers “Was Gridiron right?” scorecards and enables honest model improvement.

## 8. Accessibility and responsive navigation (P1)

The fixed 224px sidebar plus dense tables will be difficult on laptops/tablets and unusable on phones. Add:

- Mobile drawer/bottom navigation.
- Keyboard focus styles and table navigation.
- Text alternatives for emoji-only meaning.
- ARIA labels for modal/dialog semantics.
- Color-independent status indicators.
- Density toggle for large boards.

---

# Fantasy navigation audit

## 1. Dashboard / Home

### What it does now

- Links to an active draft, rankings, and My Team/leagues.
- Shows five recent camp stories.
- Hardcodes six “deep dive” teams.
- Runs a large refresh-all + optional AI outlook pass.

### What is bad or missing

- It is a directory, not a dashboard. It does not summarize the user’s current roster, matchup, injuries, waiver needs, title odds, trade opportunities, or pending decisions.
- “Training camp, July 2026” and the deep-dive list are hardcoded; this ages badly and can contradict current data.
- “Active draft” relies on status, but draft status is not clearly updated on completion.
- Refresh duplicates the global header refresh and couples network sync with an expensive AI pass.
- No freshness summary, partial-failure details, or retry per source.
- No personalization by active league beyond the My Team card.

### Additions

1. **Morning Briefing** (P1): generated locally from deterministic signals, with optional AI wording. Sections: urgent lineup moves, injuries, waivers, trades, matchup leverage, news, and data warnings.
2. **Decision Inbox** (P1): top five expiring actions, each with “do,” “snooze,” and “why.”
3. **League Pulse** (P1): standings, projected weekly win probability, playoff odds, median score, points luck, and strongest/weakest roster changes.
4. **My exposure** (P2): players shared across leagues, correlated bye weeks, injury concentration, and betting/fantasy conflicts.
5. **What changed since last visit** (P2): player value movers, depth-chart changes, new injuries, line moves, and model refreshes.
6. **Season timeline** (P2): draft → waivers → lineup → trade deadline → playoffs, with current phase-specific widgets.
7. **Custom dashboard builder** (P3): pin any card from another tab.

### Acceptance target

Within five seconds, the user should know the top three actions for the active league and whether the data supporting them is fresh.

## 2. My Team

### What it does now

- Selects a connected league/team.
- Shows a scouting report and engine-optimal lineup.
- Displays a formation, starters, bench, and ESPN-only realized weekly scores.

### What is bad or missing

- “Optimal” is season/PPG-oriented and not clearly opponent/week/availability-aware in the UI.
- No direct comparison against the platform’s currently submitted lineup.
- No start/sit alternatives, confidence intervals, floor/ceiling, or late-swap plan.
- Sleeper users lose matchup history even though Sleeper has matchup endpoints that could be synced.
- Save failure for the selected team is silently swallowed.
- No waivers/free agents, IR eligibility, bye conflicts, or roster transaction workflow.
- The formation is visually engaging but omits much of the actionable bench/slot context.

### Additions

1. **Roster Digital Twin** (P1/P2): weekly points distribution, playoff/title odds, positional replacement curves, and sensitivity to each player missing time.
2. **Submitted vs Recommended lineup diff** (P1): fetch platform lineup, highlight exact swaps, projected gain, and kickoff deadline.
3. **Start/Sit Lab** (P1): compare two players using median, floor, ceiling, matchup, role trend, weather, game script, and correlation with the rest of the lineup.
4. **Late-swap tree** (P2): if an early questionable player sits, show conditional replacements by kickoff window.
5. **Waiver prescription** (P1): free-agent candidates ranked by marginal lineup/playoff value, suggested FAAB, and drop candidate.
6. **Contingency bench** (P2): automatically identify handcuffs and role replacements for the roster’s highest fragility players.
7. **Portfolio mode** (P2): across all leagues, show exposure to players, teams, bye weeks, and injuries.
8. **Opponent exploit card** (P2): opponent weaknesses, likely starters, boom path, and blocking moves.

## 3. Players

### What it does now

- A dense multi-view board for rankings, value, projections, volatility, and underlying stats.
- Search/filter/sort, ranking set integration, sparklines, and player popovers.

### What is bad or missing

- At ~450 lines, it is becoming a monolithic grid with many concepts competing at once.
- Column meaning and source freshness are not consistently visible.
- No saved views, watchlists, comparisons, tags, or “players relevant to my roster.”
- No ownership/free-agent context by active league.
- Rank, projection, VOR, ADP, market, and trend can disagree without an explanation layer.
- Large tables lack virtualization and could degrade as player coverage expands.

### Additions

1. **Player compare tray** (P1): pin 2–5 players and compare projection distributions, role, schedule, market, injury, age, and roster fit.
2. **Watchlists and hypotheses** (P1): “camp risers,” “post-hype,” “injury discounts,” with notes and alerts when evidence changes.
3. **League-aware availability** (P1): owned by whom, waiver status, trade cost, and fit for the active team.
4. **Disagreement lens** (P2): explicitly explain why VOR, ADP, market, and projection disagree.
5. **Role fingerprint** (P2): route/target/carry/red-zone/snap trend visual compressed into a recognizable mini-card.
6. **Similarity search** (P2): “show historical player-seasons most like this profile.”
7. **Scenario sliders** (P2): change team pass rate, injury status, depth rank, or workload share and recompute projection.
8. **Saved column presets + export** (P3): CSV and printable draft sheet.

## 4. Draft Room

### What it does now

- Creates mock or live-tracking drafts.
- Persists picks, runs CPU teams, shows recommendations, roster, recap, and AI grade.
- Supports pause, undo, sim-to-end, board zoom, and filters.

### What is bad or missing

- P0 unresolved: default offline pool has 100 players for a 192-pick default draft; no coherent team DEF model.
- Live tracking is manual only; no official provider synchronization is present in this published build.
- CPU teams have no persistent identity, strategy, roster settings, or league-specific tendencies.
- Recommendation logic is primarily market + coarse roster target counts; it is not a full expected-roster-value optimizer.
- Timer auto-pick and mutations still need stronger busy/error protection.
- No queue, favorites, avoid list, position scarcity forecast, or “will he make it back?” probability.
- Draft state has no explicit event log/versioning or crash-recovery indicator.

### Additions

1. **Draftable pool guarantee** (P0): complete offline pool, team DEF entities, and maximum-size validation.
2. **Real live draft sync** (P1): ESPN/Sleeper provider adapter, polling health, source pick IDs, reconciliation UI, and manual fallback.
3. **Draft queue** (P1): starred targets, do-not-draft list, conditional priority by round/position.
4. **Will he come back?** (P1/P2): probability a player survives to the next user pick based on ADP distribution, room behavior, and positional runs.
5. **Expected roster value optimizer** (P2): compare taking Player A now versus position alternatives and future replacement availability.
6. **Room personality** (P2): CPU team archetypes—Zero RB, Hero RB, early QB, hometown bias, rookie hunter—with visible tendencies.
7. **Roster construction guardrails** (P1): starter/bench requirements, max positions, bye-week concentration, stacks, and injury risk.
8. **Draft event journal** (P1): append-only events, source, timestamp, undo lineage, and recovery after restart.
9. **Post-draft action plan** (P2): immediate waiver watchlist, trade strengths, Week 1 lineup, and roster fragility—not just a letter grade.
10. **Practice scenarios** (P2): simulate from every slot, keeper costs, auction values, superflex, best ball, and custom roster rules.

## 5. 32 Teams

### What it does now

- Grid of all NFL teams and detailed formation/scheme/coaching/roster pages.
- News refresh, AI outlook refresh, data validation, grades, offseason information, and accolades.

### What is bad or missing

- The teams index is extremely thin; it is mostly navigation.
- Team pages mix static snapshot analysis, live roster data, AI prose, and model grades without a prominent freshness/provenance hierarchy.
- No side-by-side team comparison or league-wide scheme taxonomy.
- Scheme information is not strongly connected to player projections, matchups, or betting recommendations.
- A missing/error team can look like endless loading.

### Additions

1. **League-wide scheme matrix** (P1): pace, pass rate over expected, motion, personnel, coverage, pressure, run concepts, coordinator continuity.
2. **Scheme-to-fantasy translation** (P1): which roles gain/lose targets, carries, red-zone work, or volatility.
3. **Depth-chart battle tracker** (P1/P2): competing players, evidence timeline, confidence, and impact if either wins.
4. **Team change graph** (P2): coaches, quarterback, line, weapons, defense, cap, draft capital, and resulting uncertainty.
5. **Team compare** (P2): compare two offenses/defenses and all relevant fantasy roles.
6. **Interactive formation explorer** (P2): click a role in a formation to see players, usage, historical comps, and fantasy implications.
7. **Schedule map** (P1): matchup strength by role/week with playoff emphasis.

## 6. Fantasy Lab

### What it does now

- A 95-line landing page that links to Edge Tools and Prediction Engine.
- The supposedly consolidated experience still routes to separate `Edge.tsx` and `Model.tsx` pages.

### What is bad or missing

- It is a menu, not a lab.
- Duplicate `/edge` and `/model` route declarations exist in `App.tsx`; later “legacy redirect” declarations are unreachable/confusing.
- Tools do not share a common scenario state, selected league, selected players, or saved experiment.
- Advanced model outputs are disconnected from practical decisions.

### Additions

1. **Scenario workspace** (P1): one canvas where selected league/team/player/week persists across tools.
2. **Notebook runs** (P2): save named experiments with inputs, outputs, notes, and model version.
3. **What-if builder** (P2): injuries, trades, workload, game script, schedule, lineup, and market assumptions as composable toggles.
4. **Decision comparison** (P2): compare “do nothing,” waiver add, trade, lineup swap, or draft choice on the same outcome axes.
5. **Uncertainty lab** (P2): show distributions, sensitivity, and which assumptions drive the answer.
6. **Shareable report** (P3): export a scenario to HTML/PDF for league discussion.

## 7. Trade Lab

### What it does now

- Finds deals, builds offer ladders, evaluates packages, shows lineup impact, market fairness, and AI pitch copy.
- Uses active league context and real roster/value data.

### What is bad or missing

- The UI is very large and combines several workflows in one component.
- No draft-pick assets in the visible trade builder despite pick-value infrastructure.
- No trade history, negotiation state, counters, or owner preference memory.
- No “why would they accept?” evidence based on the other roster’s actual needs beyond computed balance.
- No transaction legality checks, roster-limit aftermath, or keeper/dynasty tax context surfaced clearly.
- Suggestions can become stale as rosters/values change without an expiration marker.

### Additions

1. **Negotiation CRM** (P2): offers sent, counters, owner tendencies, response times, and notes.
2. **Pick and FAAB assets** (P1): dynasty picks, keeper costs, auction dollars/FAAB, conditional assets.
3. **Acceptance probability** (P2): calibrated from fairness, need fit, owner behavior, and package shape—shown as uncertain, not fact.
4. **Counteroffer generator** (P1): preserve the user’s target while changing the asset the opponent values.
5. **Trade deadline board** (P2): league-wide buyers/sellers, playoff odds, schedule leverage, and expiring windows.
6. **Three-team trade solver** (P2/P3): route surplus from one roster to satisfy two others.
7. **Collusion/fairness explainer** (P2): transparent commissioner-facing rationale.
8. **Post-trade waiver impact** (P1): roster spots opened, best free-agent replacements, and total net value.
9. **Trade replay** (P2): grade prior deals using information available at the time versus eventual outcome.

## 8. Camp News

### What it does now

- Pulls ESPN/team news, filters by date/team, supports manual entry, optional AI analysis, roundup, and story deletion.

### What is bad or missing

- Feed is not deduplicated/clumped into developing stories.
- Source credibility and publication URL are weak or absent in the visible experience.
- AI analysis can become detached from the exact source evidence.
- “What it means for my team” is prose, not an explicit affected-player/roster action graph.
- No watchlists, alerts, read state, or confidence.
- Manual deletion is immediate and not recoverable.

### Additions

1. **Story clustering** (P1): one evolving card per event with source timeline and contradictions.
2. **Impact graph** (P1/P2): injury/news → depth chart → workload → projection → roster/waiver/trade/draft impact.
3. **Source credibility labels** (P1): team reporter, official, national, speculative, anonymous.
4. **Evidence-linked AI** (P1): every claim references the source sentence(s) used.
5. **Personal alerts** (P1): watched players, roster players, opponents, draft queue, and betting exposures.
6. **Rumor resolution memory** (P2): track whether prior camp reports proved predictive.
7. **News shock score** (P2): quantify projected-points and market-value movement caused by the event.

## 9. My Leagues

### What it does now

- Adds ESPN/Sleeper leagues, syncs them, selects an active league, removes leagues, and shows roster strength by position.

### What is bad or missing

- Credentials are entered in a normal text input; should be password-masked with reveal controls.
- No validation preview before persisting a league.
- No sync history, health, or difference report.
- No editable league rules after import or explicit verification of scoring/roster parsing.
- Analysis is a wide table and not action-oriented.
- Removing a league has no visible explanation of dependent cached data.

### Additions

1. **Connection wizard** (P1): validate credentials/ID, preview league/team, confirm rules, then save.
2. **Rule inspector** (P1): scoring, slots, waivers, playoffs, trade deadline, keepers, IR, and deviations from inferred defaults.
3. **Sync diff** (P1): roster adds/drops, team rename, scoring changes, ownership changes, and failures.
4. **League archetype profile** (P2): aggressive traders, hoarders, positional scarcity, waiver activity, parity, contender/tanker map.
5. **Cross-league dashboard** (P2): exposure, combined waiver targets, simultaneous lineup deadlines, and conflicting decisions.
6. **Backup/export/import** (P1): encrypted credentials excluded by default; portable league configuration and analysis.

## 10. ESPN Settings

### What it does now

- Stores legacy single-ESPN-league settings and cookies.
- Syncs league, players, and news.
- Also renders `EspnConnect`, while My Leagues supports ESPN independently.

### What is bad or missing

- Duplicates and conflicts conceptually with My Leagues and the global active-league system.
- “ESPN Settings” as a top-level product tab is too implementation-specific.
- Cookie fields are not password inputs.
- Legacy `espn_settings` and multi-league `leagues` can diverge.
- No credential expiry warning or test-connection result before sync.

### Recommendation

Replace this tab with **Connections & Data** (P1 design project):

- Provider connections (ESPN, Sleeper, Odds API, Anthropic, GitHub/proxied MLB).
- Masked secrets, status, expiry/last validation, and revoke.
- Data-source sync health and quotas.
- Import/export/backup.
- Keep legacy routes temporarily, migrate settings into one credential store, and remove duplicated UI after compatibility validation.

---

# Betting navigation audit

## 11. Betting Home

### What it does now

- Summarizes NFL standing, model health, variable count, MLB tracking, and Odds API status.

### What is bad or missing

- MLB grading is acknowledged as client-side, so the server summary cannot report a true record or units.
- No bankroll, open exposure, CLV, drawdown, calibration, or risk concentration.
- “No parlays, flat stake” is honest but the rest of the app includes staking services not integrated here.
- No date/season/model-version filters.

### Additions

1. **Unified bankroll cockpit** (P1): open risk, settled P/L, ROI, CLV, drawdown, exposure by sport/market/team/player/book.
2. **Model trust dashboard** (P1/P2): calibration by probability bucket, edge bucket, market, season phase, and line source.
3. **Kill switches** (P1): automatically suppress markets when stale, uncalibrated, overexposed, or outside validated range.
4. **Daily slate briefing** (P1): what changed, best research targets, invalidated picks, and remaining line value.
5. **Fantasy conflict monitor** (P2): betting positions that hedge or amplify fantasy lineup exposure.

## 12. NFL Board

### What it does now

- Shows model-versus-market edges with reasoning.
- Refreshes lines, runs weekly analysis, stores/grades spread picks, and shows model accuracy.

### What is bad or missing

- Week defaults to 1 rather than current NFL week.
- Board and Auto Picks share the same component/route behavior, making navigation misleading.
- “Run Weekly Analysis” combines sync, fit, simulation, and pick lock without a preview/confirmation boundary.
- No line history chart directly on a row.
- No explicit edge threshold tuned to out-of-sample calibration and price availability.

### Additions

1. **Current-week resolver** (P0/P1): infer season/week from schedule and date.
2. **Separate research board and locked pick ledger** (P1).
3. **Line movement sparkline + CLV forecast** (P1/P2).
4. **Edge durability** (P2): how often the bet remains positive under model/line uncertainty.
5. **Matchup dossier** (P1): injuries, trenches, scheme, pace, weather, rest, travel, and model disagreement.
6. **Price target alerts** (P2): “bet only at -2.5 or +105.”
7. **No-bet explanations** (P2): surface games rejected because uncertainty or market efficiency is too high.

## 13. NFL Props

### What it does now

- Fetches Odds API player props and compares them with first-party projections.

### What is bad or missing

- API-credit usage and cache behavior are described elsewhere, not at decision time.
- Player availability, role uncertainty, injury designation, and expected snaps need stronger gating.
- No correlation/exposure view across props from the same game/player.
- Limited result ledger/CLV integration compared with game markets.

### Additions

1. **Role confidence gate** (P1): suppress props when snap/route/carry uncertainty is too high.
2. **Same-game correlation matrix** (P1/P2): prevent accidental concentration and identify coherent game scripts.
3. **Projection distribution** (P1): median and tail probabilities rather than one probability.
4. **Book/line selector** (P1): best price and break-even line across books.
5. **Prop lifecycle** (P2): open → moved → closed → graded → CLV, with invalidation on lineup/injury changes.
6. **Fantasy-to-prop crossover** (P2): show where fantasy role insight creates a prop hypothesis and vice versa.

## 14. Ensemble Line

### What it does now

- Displays component model predictions and ensemble output by week/game.

### What is bad or missing

- Model names and disagreement are technical without enough decision framing.
- No model contribution/explanation, stability, or historical performance conditional on disagreement.
- No user-defined scenario weighting.

### Additions

1. **Model disagreement radar** (P1/P2): visualize spread and identify which input family drives divergence.
2. **Conditional trust** (P2): which models perform best in divisional games, high wind, rookie QB, short rest, etc.
3. **Leave-one-model-out analysis** (P2): show whether an edge depends on one outlier model.
4. **Ensemble lab** (P3): user-adjustable weights with strict holdout warning and no retroactive score inflation.
5. **Prediction intervals** (P1): fair line plus credible range, not only point estimate.

## 15. NFL Auto Picks

### Current critical UX defect

The route `/betting/nfl/picks` renders `NflMarketBoard`, the same component as `/betting/nfl`. The navigation promises an Auto Picks product but delivers the research board.

### Build a distinct Auto Picks page (P1)

- Today/this week’s locked picks.
- Lock timestamp and line.
- Model/version and eligibility rule.
- Pending/won/lost/push.
- CLV and closing line.
- Flat-stake and recommended-stake results kept separate.
- Immutable audit log; corrections recorded, never overwritten.
- “Why no pick?” when the system passes.
- Season filters and export.

## 16. Line Shopping

### What it does now

- Best lines, book disagreement, snapshots, and CLV.

### What is bad or missing

- Snapshot is user-triggered rather than clearly scheduled around market lifecycle.
- No alerting, target price, or deep-link from board picks.
- Book availability and user jurisdiction/preferences are not modeled.
- CLV is isolated from the pick ledger and bankroll outcomes.

### Additions

1. **Price target watchlist** (P1).
2. **Book profile** (P2): available books, limits, preferred odds format, and excluded operators.
3. **Automatic snapshots** (P1): open, recommendation, major move, pre-kick, close.
4. **Middle/arbitrage detector** (P2), with realistic limits and stale-quote safeguards.
5. **Pick-linked CLV** (P1): every locked pick carries its exact price history.
6. **Line provenance** (P1): book, timestamp, market key, and refresh status on every displayed number.

## 17. Training

### What it does now

- Runs NFL replay/training and surfaces model evaluation.

### What is bad or missing

- “Training” is ambiguous to a user: model fitting, backtest, replay, or validation?
- Heavy operations need clearer run IDs, progress, cancellation, and reproducibility.
- No side-by-side comparison to prior accepted model.
- Risk of promoting a model based on one flattering metric.

### Additions

1. Rename to **Model Lab** (P1).
2. **Experiment registry** (P1/P2): dataset cutoff, features, parameters, seed, code commit, metrics, artifacts.
3. **Champion/challenger gate** (P1): a candidate cannot replace production unless predeclared metrics improve without calibration/regime regressions.
4. **Slice explorer** (P2): performance by season/week/market/team/weather/edge bucket.
5. **Failure gallery** (P2): worst misses with data and reasoning replay.
6. **Leakage audit** (P1): automatic checks that each feature existed before prediction time.

## 18. MLB Board

### What it does now

- First-party MLB slate/model board with manual refresh and freshness behavior.

### What is bad or missing

- The product runs inside a football-branded app without a clear multi-sport identity.
- Probable pitcher/lineup changes need stronger invalidation semantics.
- No weather/umpire/park uncertainty timeline in the core row.
- No clear bridge from model-only projections to priced, actionable markets.

### Additions

1. **Slate readiness checklist** (P1): schedule, starters, lineups, weather, market prices, model freshness.
2. **Change detector** (P1): pitcher scratched, lineup posted, weather shift, odds move; invalidate affected rows.
3. **Game card timeline** (P2): evolving certainty from morning to first pitch.
4. **Park/weather/umpire scenario bands** (P2).
5. **Pass list** (P2): games intentionally excluded and why.

## 19. MLB (proxied)

### What it does now

- Proxies private Diamond Signal CSV artifacts through GitHub CLI authentication.

### What is bad or missing

- Operationally fragile: runtime depends on local `gh auth token`, repository access, and a separate pipeline.
- Duplicates the first-party MLB product and exposes internal architecture in navigation.
- Cached token and CSV cache are process-local only.
- No formal schema/version contract with the upstream repo.

### Recommendation (P1 design project)

Treat this as a provider adapter, not a user-facing product name:

- Define a versioned artifact manifest/schema.
- Persist last known good snapshot and integrity hash locally.
- Display provider/source inside MLB views.
- Merge useful proxied markets into one MLB research experience.
- Hide “legacy/proxied” navigation after parity, retaining a diagnostics page for maintainers.

## 20. MLB Auto Picks

### What it does now

- Selects first-party MLB picks, supports backfill, and tracks history.

### What is bad or missing

- Need strict distinction between generated, eligible, locked, bet, and graded.
- Backfill can create hindsight concerns unless it preserves what was knowable at the time.
- No bankroll/CLV integration.
- No reason shown when fewer than target picks qualify.

### Additions

1. **Immutable pick lifecycle** (P1).
2. **Eligibility audit** (P1): exact rule and snapshot for every pick.
3. **No-pick day badge** (P1): celebrate discipline rather than force volume.
4. **Market-close grading + CLV** (P2).
5. **Backfill quarantine** (P1): visibly separate reconstructed research from real-time locked picks.

## 21. MLB My Picks

### What it does now

- Saves user slips in browser localStorage and grades against upstream results.

### What is bad or missing

- Picks disappear across browsers/profiles and are absent from server summaries.
- Clearing localStorage is destructive with no export/restore.
- No stake, book, timestamped price, CLV, notes, or tags.
- Server and client disagree on what the authoritative ledger is.

### Additions

1. **SQLite-backed unified pick journal** (P1 design project).
2. Optional stake/book while preserving privacy and no account connectivity.
3. Import/export JSON/CSV.
4. Tags: model pick, manual, hedge, experiment, tail.
5. Closing line and CLV.
6. Decision notes and screenshot/reference attachment.
7. Browser-local offline queue that syncs into SQLite when available.

## 22. Variables

### What it does now

- Displays a catalog of hundreds of NFL team/player variables.

### What is bad or missing

- A catalog is documentation, not insight.
- No lineage, freshness, missingness, leakage risk, distribution, or actual model usage.
- No search by prediction or downstream consumer.

### Additions

1. **Feature lineage graph** (P1/P2): source → transform → feature → model → recommendation.
2. **Data quality profile** (P1): coverage, null rate, outliers, update cadence.
3. **Leakage classification** (P1): pregame-safe, postgame-only, unknown.
4. **Drift monitor** (P2): distribution changes versus training.
5. **Usage and importance** (P2): models using feature, coefficient/importance, stability.
6. **Entity inspector** (P2): pick a team/player/week and see actual feature vector with provenance.

## 23. Model Info

### What it does now

- Explains the proxied MLB pipeline, holdout metrics, factors, health, and limitations.

### What is bad or missing

- It is MLB-specific but labeled generically “Model Info.”
- Static explanatory content is mixed with live health and evaluation.
- Metrics lack baseline comparison and confidence intervals.
- No model/version history or promotion record.

### Additions

1. Rename **MLB Model Card** and place within MLB section.
2. **Model registry** (P1/P2): versions, training cutoffs, code commits, metrics, promotion status.
3. **Baseline comparison** (P1): market, naive rate, prior model.
4. **Confidence intervals** (P2): uncertainty on Brier/MAE/AUC and performance slices.
5. **Calibration plots and reliability tables** (P1).
6. **Change log** (P1): what changed and why the model was promoted.

---

# Hidden, legacy, and navigation issues

## Route cleanup (P0/P1)

- `/edge` and `/model` are each declared twice in `App.tsx`. Remove unreachable duplicates and implement explicit redirects where needed.
- `/projections` points to `Players`, while a separate `Projections.tsx` exists but is not routed. Decide whether it is retired or should be reachable.
- `/betting/nfl/picks` points to `NflMarketBoard`; implement a real Auto Picks page.
- Legacy `/props/*` and `/betting/mlb/legacy` routes should be governed by a migration/deprecation plan.
- Add a catch-all 404 route with search and navigation recovery.
- Generate navigation and routes from one typed configuration to prevent label/component drift.

## Information architecture proposal

Reduce the sidebar to outcomes, not implementation modules:

```text
Command Center
  Today
  My Teams
  Players
  Draft
  Trades & Waivers
  NFL Intelligence

Betting
  Portfolio
  NFL
  MLB
  Model Lab

System
  Connections & Data
  Settings
```

Sub-navigation inside NFL/MLB can hold board, props, picks, lines, model, and history. This preserves depth without 23 permanent sidebar rows.

---

# Creative flagship features

## A. Gridiron Autopilot (P2)

A rules-based assistant that watches deadlines and produces proposed actions, never executing externally without confirmation:

- Thursday player in FLEX → suggest slot optimization.
- Questionable starter with late kickoff → build contingency tree.
- Waiver target’s role jumps → recommend bid and drop.
- Trade target’s price drops below roster value → create offer ladder.
- Draft target unlikely to return → alert while on clock.
- Betting line crosses target → alert; suppress if stale/injury uncertainty rises.

## B. Counterfactual Season Replay (P2/P3)

Ask: “What if I had followed every Gridiron recommendation?” Replay lineup, waiver, trade, and betting decisions using only information available at the time. Compare points, wins, playoff odds, and units without hindsight leakage.

## C. League Intelligence Graph (P2)

Represent owners, players, positions, trades, waivers, needs, surpluses, and behavior as a graph. Use it to identify:

- Most realistic trade pathways.
- Owners who overvalue stacks/rookies/team fandom.
- Waiver competition.
- Three-team trade opportunities.
- Who benefits if a role changes.

## D. Narrative-to-Number Engine (P2)

Convert news into explicit assumptions:

```text
“RB taking first-team goal-line reps”
→ goal-line share +18 percentage points
→ TD distribution change
→ weekly projection +1.6
→ VOR rank +7
→ trade value alert
```

The user can accept/edit/reject the assumption before it affects recommendations.

## E. Risk Budget, not just rankings (P2)

Model the user’s total risk across fantasy teams and bets:

- Player/team/game exposure.
- Injury and bye concentration.
- Correlated upside/downside.
- Fragile assumptions.
- Bankroll drawdown.

Recommend diversification only when it improves expected utility, not merely for variety.

## F. “Explain the disagreement” (P1/P2)

Whenever two systems disagree—projection vs ADP, model vs market, news vs role, lineup model vs platform starter—the UI should expose:

- Which inputs differ.
- Which assumption matters most.
- What new evidence would change the decision.
- A confidence interval and fallback action.

## G. Personal model calibration (P3)

Track the user’s own confidence estimates and decisions. Compare user versus model calibration over time, identify domains where the user adds value, and create a blended decision rule without pretending a tiny sample is conclusive.

---

# Recommended delivery roadmap

## Phase 0 — Trust and release foundation

1. Isolated test DB, migrations, foreign keys, integration tests.
2. Complete draftable pool and team DEF design.
3. Shared loading/error/empty/freshness states.
4. Route cleanup and real NFL Auto Picks route.
5. Unified data health and source provenance.
6. Move browser-only picks into a durable ledger.

## Phase 1 — Daily utility

1. Decision Inbox and Morning Briefing.
2. Submitted-vs-recommended lineup and start/sit lab.
3. League-aware player availability and waiver prescription.
4. Draft queue + “will he come back?”
5. Trade counteroffers and pick/FAAB support.
6. Unified betting portfolio and locked pick lifecycle.

## Phase 2 — Differentiation

1. Roster Digital Twin.
2. News impact graph and editable assumptions.
3. Scenario workspace / real Fantasy Lab.
4. Model disagreement radar and edge durability.
5. Cross-league/player/betting exposure map.
6. Recommendation outcome journal and counterfactual replay.

## Phase 3 — Scale and polish

1. Command palette, mobile navigation, accessibility.
2. Saved dashboards/views/watchlists.
3. Exports and shareable reports.
4. Experiment/model registry and drift monitoring.
5. Performance work: table virtualization, route-level code splitting, caching.

---

# Claude implementation protocol

For each phase or feature:

1. Write a short design note first for any schema, navigation, persistence, or provider change.
2. State acceptance criteria and non-goals.
3. Add migrations and automated tests before UI wiring where practical.
4. Preserve local-first behavior and make external dependencies optional/degradable.
5. Show data source, freshness, model version, and uncertainty near recommendations.
6. Never backfill a supposedly real-time recommendation ledger without marking it reconstructed.
7. Avoid adding another standalone tab when the feature belongs in an existing workflow.
8. Update `CLAUDE_FEEDBACK.md` with changed files, test output, migrations, screenshots/manual checks, and open risks.
9. Hand back to Codex for independent diff review, build/start checks, and targeted regression tests.

# First Claude assignment recommended

Start with a **Phase 0 design + implementation proposal** covering:

1. Central migrations/configurable test DB.
2. Complete draft player pool/team DEF representation.
3. Real `/betting/nfl/picks` page backed by the existing pick ledger.
4. Shared page-state components and conversion of Dashboard, My Team, Draft Room, and My Leagues.
5. Route deduplication and legacy-route redirects.

Do not begin the flagship features until these foundations pass automated integration tests.
