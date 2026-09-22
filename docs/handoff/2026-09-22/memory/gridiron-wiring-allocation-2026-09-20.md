---
name: gridiron-wiring-allocation-2026-09-20
description: Coordinator allocation of the wiring-map inventory, 06:15Z 2026-09-20: who owns which formerly unowned server file, the 19 decisions D1-D19, and the display-only rule
metadata:
  type: project
---

Full dispatch (per-thread file:line lists, Rulings): /mnt/project-files/wiring-dispatch-2026-09-20.md. Inventory: /mnt/project-files/wiring-findings-inventory.md. Sent 06:15Z-06:18Z. Extends [[gridiron-wiring-map]]; PR state in [[gridiron-pr-board-2026-09-19-night]].

## File-owner additions (append to MEMORY.md "File allocation")
- UI: routes/nfldata, stats, accolades, news, analysis, players; offseason-data.js (read accessors only); trend-watch; news/store, news/twitter-ingest, source-validation; the four dead pages + StaleBanner, ModelRegistryPanel, StatTable (to delete).
- Fantasy plan: player-week-engine.js in full; player-ids, player-career, nfl-player-context, nfl-rookies, nfl-rookie-ingest, historical-adp-scrapes, role-scenario-engine, nfl-espn-pbp, model-governance, nfl-blind-audit, nfl-engine-backfill, nfl-model-growth, nfl-postgame-truth, nfl-weekly-feature-store(-v2), offseason-model (server/services/offseason-model.js confirmed 07:54Z), weekly-learning, nfl-scheme.
- Feature audit: draft/store.js, draft-reconcile, draft-ingest, routes/draft-capture, routes/drafts.js outside :1050, draft-abstention-audit.
- Scheduler: routes/dev.js, platform/paths, platform/jobs, db/preflight, server/scripts/*.
- Trade Brain: manager-signals.js. Chat sync: routes/league-chat.js, league-chat-sync, bluff-detector.
- Coach: llm-budget, nfl-page-explain-audit, routes/coach.js, nfl-page-explain, page-explain-tools.
- Wiring map: routes/model.js, decision-inbox.js, edge.js, audit-registry, decision-basis, gridiron-model.js (07:51Z).
- Google sign-in: routes/espn.js (= memory's "espn.js"), platform/providers, provision-auth. matchups.js untouched.

## Decisions (06:15Z)
- D1 delete Edge, Model, Projections, Rankings pages; never re-route.
- D2 delete StaleBanner, ModelRegistryPanel; StatTable KEPT as the #73 table (06:43Z).
- D3 routes/model.js: delete routes whose only client was /model; keep script-called ones, comment naming the caller, in the gate's accepted list.
- D4/D12 six route files to UI; 16 uncalled routes wired from TeamDetail/Player where the redesign has a place, rest deleted; no new page.
- D5 scout_reports: Coach reads; edge.js KEPT (06:37Z), 3 routes go. decision_recommendations: Coach cites; four inbox routes deleted; writers stay.
- D6 off_* five tables: Coach cites; UI depth-chart panel (TeamDetail) + advanced-stats block (Player); display only; efficiency arm needs Nick.
- D7 slot_weakness: lineup-brain weak-slot label; trade-engine need list; display only.
- D8 manager_archetype_jev: Trade Brain displayed read with as-of; no weight; chat sync keeps writer.
- D9 trend_findings: Coach reads; News tab with as-of.
- D10 shrinkage_fits/_k served from routes/model.js with "no fit yet", after 065.
- D11 weekly_prediction_snapshots: Coach answers "how did we do"; no Home strip without Nick.
- D13 16 migrations left; no drop tonight.
- D14 22 betting-adjacent + nfl-candidate-analysis, model-intelligence, td-features, football-first, routes/props.js: betting, accepted_orphan_modules; nfl-scheme to fantasy plan.
- D15 joint-score/forecast family (11): fantasy plan if a fantasy surface reaches one, else betting.
- D16 routes/espn.js to Google sign-in.
- D17 fantasy plan serves one availability basis field (name via coordinator); each `?? 0.92` site replaces it with basis + label (news-fantasy-impact:87 UI; role-scenario-engine:124, season-sim:310 fantasy plan; roster-risk:257, trade-engine:346 feature audit). No new model.
- D18 81 = 77 + 4 external-caller routes. D19 108 recorded; 119 list asked.

## Rule
Every fix is display/wiring, never a model change; on -hold branches under the freeze; mutations stated APPLIED; served-field deletion check on every served-not-rendered row.
- Continues: [[gridiron-wiring-allocation-2-2026-09-20]].
