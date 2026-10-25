# EXECUTION WIRING (2026-09-23 ~1:45 AM ET). What each phase needs to move, the tables and their single writer, the routes and pages touched, the jobs, the blockers, and the clock. Planning only.

## 0. The clock (measured pace today: about 2 units/hour while running; bigger model units take 2-3x; the account's 5-hour cap costs about a quarter of wall time; the weekly cap was 53% on Tuesday night and is the real risk)
| Phase | Units | Running time | Lands (if started now, nonstop) |
|---|---|---|---|
| 0 Finish in-flight | BLEND-01, HX-01, S-03, C-01 #160, verify run A (B-01, A-03, SY-02, C-12), skill-split report | ~5 h | Wed 9/23 morning |
| 1 Foundations | CE-05, TR-01, TR-03, AI-01, TM-09, AI-04, TM-06 + FantasyCalc test, GR-05, GR-01 (10) | ~9 h | Wed 9/23 night |
| 2 Engine | CE-01, CE-02 (needs BLEND-02 ranges), CE-03 (ST-01), CE-09, CE-06, CE-10 (6, two big) | ~10 h | Thu 9/24 night |
| 3 Trade Machine v1 | dossiers, LS-01, TM-03, AI-05, TM-17, TM-30, TM-02, TM-04 + counter evaluator, TM-01, TM-05, DD-01, GT-01, LL-01, GR-02, GR-06 (15) | ~14 h | Sat 9/26 |
| 4 Start/sit + rhythm (alongside) | SS-01, WV-01, WV-02, WV-03, SK-01, ST-02, ST-03 (7) | ~6 h | Thu 9/24 (guard + streaming + command center first) |
| 5 AI tier | AI-02, AI-03, TM-08, AI-06, AI-07, AI-08, AI-10, AI-11, CE-07, AI-09, AI-12 (11) | ~14 h | Tue 9/29 |
| 6 Insane + new | ~30 | continuous | through October, each behind its test |
Usable Trade Machine (finder + target board + odds ladder + ledger) about Sat 9/26; week-4 trade window (Thu 10/1) has it. Deploys reach the live app only on Nick's word: propose one deploy a day at a fixed time.

## 1. Blockers and what they block (build vs live)
- N1 ESPN cookie on the live collector: blocks LIVE freshness of trade-block flags, lineup snapshots and transactions on the server, and learning from Nick's own proposals. Does NOT block building: the local copy already holds the 5 payloads and the 2026 lineup snapshots.
- Jev weekly cap: blocks AI-03, AI-06, AI-10, TM-07, TM-08 only. Trees and nets (AI-01/02/04/05/08/09) need no spend.
- N12 phone alerts + write permission: blocks push and ST-04 autopilot only; everything shows in-app first.
- Deploy word: blocks the live app, not main.
- BLEND-01 merge -> ESPN base ship rule -> BLEND-02 ranges -> CE-02. A-01/CE-05 -> all CE-* and TM-39/NX-02. TM-09 -> AI-04 -> TM-01 his-screen. GR-01 -> GR-02/GR-06. ST-01 -> CE-03, SS-01 quality.
- Compute placement (decision, proposed): the server (Fly, small) runs the engine at 2,000 sims nightly and 500-sim increments on events (seconds); this Mac runs 10,000-sim research, backtests and the planner's deep searches, writing aggregates the app reads (no names). If Nick wants full 10k on the server, it needs a bigger Fly machine (his call, cost).

## 2. Tables, one writer each (new; every one has a reader reaching a route or page, per the wiring gate)
- market_price (player, week, league_size, price, n, hype) | writer: job market_price_weekly (TM-09) | readers: trade-engine value (AI-04), target board.
- role_shift (player, as_of, shift, prob, sources) | writer: AI-03 reader job | readers: usage forecaster features, TM-02 tags.
- lineup_signal (league, roster, player, week, signal, evidence, n) | writer: job after each league sync (LS-01) | readers: /trades/:id/brain/managers, ManagerRead, target board.
- sim_state (league, state_hash, run_at, sims, odds_by_team, cache) and action_price (league, action_hash, kind, odds_before, odds_after, ci, ladder_rank) | writer: engine job + event handler (CE-06/CE-09) | readers: /model/:id/simulate, /trades/:id/find, /trades/:id/evaluate, My team ladder, TradeCard.
- scenario_card (league, week, event, prob, response_json) | writer: engine (DD-01) | reader: My team.
- rec_ledger (id, league, kind, made_at, inputs_hash, predicted, baseline_call, graded_at, outcome, score) | writer: one helper called by every recommending route (GR-01) + grader job | readers: /grades/:id/report-card, My team report card, model zoo.
- offer_ledger (league, partner, sent_at, packages_json, style, reply, reply_at, receipt_2w, receipt_5w) | writer: /trades/:id/offer send + counter intake (GR-06, TM-04) | readers: Trade Brain war room, GR-02.
- registry entries per model (exists: routes/model.js registry) | writer: promote flow | reader: AI-12 zoo page. Local-only (never synced): dossiers, twins' retrieval index, Nick's voice samples.

## 3. Routes (extend first, add only where nothing fits)
Extend: /trades/:id/find (TM-01 shape: his_screen, real, odds_delta, tags), /trades/:id/find/sequences (TM-05 decision tree), /trades/:id/evaluate (counter evaluator, pre-mortem), /trades/:id/offer-many (MESO packages, TM-31), /trades/:id/brain/managers (LS-01 signals + dossier aggregates + pain calendar), /trades/:id/brain/plan (roadmap), /trades/:id/ceiling-lineup (ST-02 floor/ceiling), /trades/:id/lineup (SS-01 guard payload), /model/:id/simulate (CE-09 ladder), /model/:id/trade-impact (paired-seed delta with CI, unchanged contract).
Add: /model/:id/scenarios (DD-01), /grades/:id/report-card (GR-02), /trades/:id/offers (offer ledger), /lineup/:id/windows (ST-03 late-swap plan), /waivers/:id/streams (WV-01).

## 4. Jobs (scheduler.js tiers)
Light/event: news ingest -> AI-03 reader -> event bus -> incremental re-sim; league sync -> LS-01 signals; counters intake. Heavy nightly: full engine run per league, market_price weekly, planner deep search, grader (GR-01 at horizons). Gameday: inactives at T-90 per window (SS-01), live ticker (CE-08), late-swap prompts (ST-03). Monthly: injury timelines (TM-11), forward schedule refresh weekly (TM-12).

## 5. Pages and components (8 tabs unchanged)
My team: OddsLadder (new shared component), ScenarioCards (DD-01), ReportCard (GR-02), LuckLedger (LL-01), PortfolioRisk. Trade Brain: TargetBoard (signals, dossier aggregates, pain calendar, reaction lag), OffersOut/CountersIn (offer_ledger, one-tap evaluate), RegressionRadar, Receipts. Trade Lab: EvaluatePanel (his screen vs real, odds delta, tags, pre-mortem, pitch ladder). Start/Sit: DeadStarterGuard, AvailabilityChips, FloorCeilingToggle, LateSwapWindows, LiveTracker. League Hub: ManagerRead (signals), StreamingBoard (WV-01), InjuryAlerts (WV-02), CommandCenter (SK-01). News: ResearchFeed with as-of stamps and briefs. Settings: JevCap, Alerts (N12), AutopilotScope.
Design: three lines per card (what / why with cited numbers / odds delta), one tap to act, guesses labelled, no walls of text, names only in-app.

## 6. Per-unit gate (unchanged): RED test first, builder, four skeptics by risk, fix loop, auditor for any number that prices, CI on Node 22 on the exact head with current main, PR body sections 1-5 and the five questions, merge by the local queue only, integration card, synergy review every 8 merges.
