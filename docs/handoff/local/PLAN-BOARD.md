# Plan board snapshot (2026-09-22 19:53Z)

Live board (private to Nick): https://claude.ai/artifact/X2bB1Mnn7Bg19N9tJtBS56. This file is its snapshot, so the handoff carries it.

| Phase | Merged to main | Counting open PRs | Note |
|---|---|---|---|
| Foundation (7) | 71% | 86% | #98 and #94 open |
| Phase A (3) | 0% | 50% | all three partly built |
| Phase B (8) | 0% | 25% | 4 partly built (B4, B6, B7, B9) |
| Phase C (9) | 0% | 33% | 6 partly built |
| Phase D (5) | 0% | 30% | 3 partly built (D21, D23, D25) |
| **All items (32)** | **16%** | **44%** | |

## Units by status

### building (2)

- **F-05** [F4] Land #94 trade outcome ledger · _Build workflow: builder, then three skeptics (claims, wiring, test liveness), fix loop, one gate run_
- **R-02** [D21 (re-audit of #119, #87, #92)] The formations ingest treats the expected current-season 404 as a skip, not a failure, and backfills finished seasons (the table is empty today) · _Build workflow running with F-05_

### running (4)

- **S-rnd2** [R&D] R&D lab round 2: public-league data for global priors (D22/B6), K/DST inputs, playoff-odds calibration, causal-news natural experiments, latency feeds; absence proven by grep first · _—_
- **S-moon1** [R&D moonshots] Moonshot lab round 1 (your ask): big, risky ideas outside the plan: neural and sequence models, LLM agents over the league chat, simulated opponent managers, public-league data at scale, RL roster management. Each gets cited evidence vs bets, a one-day kill-or-confirm experiment, and a ranking. · _Top ideas go to the validator before anything enters the plan_
- **S-map** [Structure] Structure map (your ask): every number computed by more than one model, every table or field not wired to a page, every hand-set constant behind a served number. Then an independent fan-out runs the competing paths on the same input and compares the numbers. · _—_
- **OPS-01** [Local setup] Refresh the local copy's data: run the scheduler jobs locally (paid keys blanked) so league history, archetypes, usage and PBP features are current · _Local server restarted on bd56319b with the scheduler on (heavy tier included) and every paid key blanked; the Anthropic key is forced invalid so the copy's stored key can't spend. Before: usage and PBP features newest 2026 wk1, formations 0 rows, archetypes 09-18, signals 09-17. Census again at ~20:08Z._

### queued (96)

- **F-02** [F2] Re-measure #98's stall table on real rows, post-MLB job list
- **F-03** [F2] Land #97 (watchdog names the job)
- **F-04** [F2] Resolve and land #77, then retarget #84
- **F-06** [F4] Prove #94's observed-row derivation on real transactions (local)
- **F-07** [F4] Land #103 → #120 → #100 in order
- **F-08** [F3 (licence)] Visible nflverse CC BY credit line that renders even when data is fresh or dismissed
- **F-11** [F5] Fix R66: buildImporterGraph misses bare import './x.js'
- **F-12** [F5] Finish #135 reach-ladder
- **F-13** [F5] Fix the wiring map's foreign-handle collector (chatDb/corpus false findings)
- **F-14** [F5] CONTRACT.md:126-135 §2b low-end correction per the ladder ruling
- **F-16** [F7] Deploy-delta checklist for the current tip (prep only)
- **R-01** [D21 (re-audit of #86)] Data-freshness check can't see a weekly feed falling behind: its only rule is met by one current-season row, so the banner stays hidden when usage is a week late
- **R-03** [D21 (re-audit of #113)] Show the unowned ESPN slot count (#113) where it's meant to appear: the scheduler summary and the trade-brain archetypes block
- **R-04** [D21 (re-audit of #85)] Carry each player's availability basis through to trade assets and the lineup read (#85 vocabulary currently stops at the row)
- **R-05** [B4 (re-audit of #62)] The waiver board Nick actually sees says when kickers and defenses aren't modelled (#62 put that text on dead code)
- **R-06** [D21 (re-audit of #131)] Manager archetypes get rebuilt on a schedule; remove the false 'refreshes on the normal league sync' text
- **S-00** [C18 / method] Statistical method contract on main: a holdout ledger that counts every look at 2025, false-discovery control across the feature program, minimum detectable effect on every decline, 2026 weeks as the forward confirmation
- **C-01** [C12] Standing start/sit gate vs "start highest projection"
- **C-10** [C18] Live decision-win-rate + sealed fantasy holdout + random audits
- **A-01** [A1] Revive #93 league-ingest field contract on main (owner reassigned from the resolved Google sign-in thread)
- **A-02** [A1] Split verifyLeagueConfig out of #88 and serve it
- **A-03** [A1] Map every ESPN scoring stat the 5 leagues use; kill the silent fallback
- **A-04** [A1] The scoring proof: recomputed league points = ESPN's applied points
- **RD-01** [A2 (R&D accepted)] The player page stops saying red-zone and inside-10 touches can't be attributed; show the stored counts
- **A-05** [A1] ESPN ppr/superflex written; OP detected as superflex
- **A-06** [A1] Playoff boundary from settings, never ?? 14 written as measured
- **A-07** [A1] Trade surfaces price under league scoring, not PPR default
- **A-08** [A1] Land #74 (redraft contention window — keeper/dynasty valuation)
- **A-09** [A2] Additive observed_diff in pairedBootstrapDiff
- **A-10** [A2] production() named configuration marker; fix nfl-blind-audit.js:263
- **A-11** [A2] Level correction on the incumbent weekly ensemble (m0)
- **A-12** [A2] Coupled grade: target-share prior × availability multiplier (practice participation)
- **A-13** [A2] Officials + schedules (head coach, referee) ingest from nflverse-data
- **A-14** [A2] Swap 4th-down consumers from the conversion rate to the go-rate (#92 already produces it) and re-derive team-week history
- **A-15** [A2] Lift proof: coaching run/pass tendency + 4th-down aggression
- **A-16** [A2] Lift proof: team pace / play volume (replace "dropped unrun")
- **A-17** [A2] Charting persistence check (reopened OL-vs-DL arm, PREREG-070 rev 3)
- **A-18** [A2] Charting matchup arm at dvpFor behind a third switch, default OFF
- **A-19** [A2] QBR signal re-run as a NEW pre-registered gate (old dismissal struck, UNJUDGED)
- **A-20** [A2] Split yards_per: 34 (projections.js:97 serves ypt, ypc and ypa from one constant)
- **A-21** [A2] Phase A feature-verdict ledger on main (all 7 features, incl. depth-chart evidence lost with /mnt)
- **A-22** [A3] locateGameAndPlayer keys on the player, as-of team
- **A-23** [A3] Schedule the resolvers off the request thread
- **A-24** [A3] Historical source scoring (predicted vs cried wolf)
- **A-25** [A3] The reader reads the best sources first
- **A-26** [A3] transaction claim type resolver
- **B-01** [B9] Page-facing sims start from the current week and real record
- **B-02** [B9] Revive #40 → #44 → #58 and #83 (actual bracket, games played, no carried wins)
- **B-03** [B9] Playoff-odds delta on every add and trade ("62% → 78%")
- **B-04** [B4] K/DST projection + streaming optimizer (schedule-aware)
- **B-05** [B4] Waiver-priority strategy (FAAB moot: all 5 leagues traditional)
- **B-06** [B4] Stash-vs-drop as EV with option value; handcuffs wired to the board
- **B-07** [B4] Land #67 (bye risk not_modelled)
- **B-08** [B4] Simulated-season waiver test vs a sharp-human policy
- **B-09** [B5] Denial value for rostering a DST/K the opponent would stream
- **B-10** [B6] Acceptance: "experimental — N real outcomes" + source/n surfaced; setManagerProfile UI
- **B-11** [B6] Per-manager two-stage P(accept) fit with calibration
- **B-12** [B6] Land #41, #47 (manager reads dated)
- **B-13** [B7] Land #57 → #64, #60 (league-true fantasy week)
- **B-14** [B7] Deadline urgency + propose-the-hour
- **B-15** [B7] Buy-low window graded on history
- **B-16** [B8] Need/surplus matrix + 3-team triangle constructor
- **B-17** [B10] NFL-week ops calendar: jobs and outputs per day; heavy-tier gate resolved
- **B-18** [B11] Web Push + game-day inactives watcher with pivot suggestion
- **C-02** [C12] Waiver gate vs "add highest projected FA"
- **C-03** [C12] Trade gate vs "offer fair value"
- **C-04** [C13] Weekly three-question post-mortem, as-of projections, stored in decision_recommendations
- **C-05** [C14] Luck decomposition in product
- **C-06** [C15] Diff-in-diff on fantasy usage around news events
- **C-07** [C16] News → model → notify latency metric
- **C-08** [C17] Persist considered-not-proposed + counters; two-stage model; bias named
- **C-09** [C18] Fix R45(1) self-referential ceiling target
- **C-11** [C18] Land #138 or #79 (hand-set numbers named), resolve overlap; #70 re-measured
- **C-12** [C19] UI step 0: land #73 design system
- **C-13** [C19/C20] UI step 1: land #75 basis chip + glossary (one stat vocabulary)
- **C-14** [C19] Serve calibrated ranges (split projection-range.js from #88)
- **C-15** [C19] UI step 2: #76 stat block renders "N% chance of a–b"; drop Confidence
- **C-16** [C20] UI step 3: #78 deep-dive drawer, incl. DvP history labelled "did not predict"
- **C-17** [C20] Coach panel on an existing tab
- **C-18** [C20] Required why on every recommendation, from measured inputs
- **C-19** [C20] Fantasy page-explain (replace betting prompt/tools) with grounding
- **C-20** [C20] Land #43, #80, #53; label teams-page seed as assumed + dated
- **D-01** [D21] Land #96 → #104 (served-tables freshness contract + evaluator)
- **D-02** [D21] Land #126, #144 (refresh children) and #101 (epoch fallback loud)
- **D-03** [D21] Land #125, #134 (Chat sync) and #107
- **D-04** [D21] Fix #119's false retry note
- **D-05** [D21] Scheduled weekly fit uses promoteWeeklyFitChecked
- **D-06** [D21] Optional sources trigger their own sync (after a fantasy-route call-reach trace)
- **D-07** [D21] Outbound alerts + per-source fallback order
- **D-08** [D21] Land #50 (ESPN market timer), #66, #45, #15, #39
- **D-09** [D21] Chat-sync findings: picks_without_manager, priorSeasonFantasyCv, storeJevAnswers basis
- **D-10** [D21] Reconcile the two snap ingests
- **D-11** [D22] Hierarchical per-league acceptance/manager priors on global priors
- **D-12** [D23] Phone-first audit + fixes of Sunday flows (Lineup, News, MyTeam)
- **D-13** [D24] Competitive teardown doc
- **D-14** [D25] Kill list with one-line obituaries

### merged (4)

- **M-118** #118 [UI hardening] Merge: a quarterback has no target share, and the page stops blaming the data file · _CI green on 1c9ec0fd (contains main); squash-merged as 35a61fe3_
- **F-01** #128 [F2] Land #128 (MLB out, request thread 29→26) · _CI green on 8d72706f (contained main); squash-merged as bd56319b. MLB is out of the product; every mlb_ table stays on disk._
- **F-09** #116 [F5] Land #116 (symbol-reach namespace imports) · _Passed the new gate script (CI green on 133fafbd, contains main, sections 1-5 present); squash-merged as d6d7bd5a_
- **F-10** #146 [F5] Land #146 (receiver ratchet) · _CI green on f7af966b (contained main); squash-merged as b74e3dc4. Section 5 added to the PR description after merge (the pre-merge check missed it)._

### done (7)

- **S-gate** [Method] Gate script: refuses a merge unless CI passed on a head that contains current main and the description carries every merge-gate section and the five questions · _Controls: refused #67 and #125 (behind main), passed and merged #116. The #146 miss can't recur._
- **S-local** [Setup] Local copy running: latest main on port 5177 against a copy of your DB, scheduler off · _GET /api/health ok:true_
- **S-rnd** [R&D] R&D lab round 1: Explorer scouting free data sources for Phase A-C · _4 packages, all A2; 11 dead ends logged so they aren't re-scouted_
- **S-validate** [R&D] R&D validator round 1: re-derive every number, re-check licences, verify file:line, accept or return · _1 accepted, 3 rejected. Explorer's numbers all reproduced; its 'already exists?' claims were wrong 3 of 4 times._
- **S-queue** [Planning] Build the full work queue: what's left on all 32 items, in order · _94 units written to ~/gridiron-local/WORK-QUEUE.md: 16 Foundation, 26 A, 18 B, 20 C, 14 D; 49 need the independent audit_
- **S-reaudit** [Re-audit] Re-audit today's 37 merges: wired to a live consumer? data fresh? anything dormant or stale? · _9 live, 9 docs, 3 dormant by design, 8 stale data, 6 unwired, 2 broken; 19 independent re-checks_
- **F-15** [F6] Board hygiene: close never-merge snapshots with a comment · _Closed merge-proof snapshots #140, #141, #142, #143 with a comment; branches kept. #136 stays until its pieces are re-derived; #145 and the stale drafts are your call._

## Plan items

- **F1 Wiring map stopped + panel lines**: done. Left: nothing
- **F2 24-job stall table vs a DB copy**: partial. Left: a real-row DB copy run, on the post-#128 job list, each job classed >60 s killer / >10 s suspect / measured / no-verdict-with-reason; merged
- **F3 Freshness registry + banner kill, same PR**: done. Left: bar met. Follow-ups: servedTablesRegistry() data-freshness.js:273-276 finds no servedTables() export in source-registry.js → falls back to player_week_usage only (:251-265) = #96/#104; CC BY credit line not rendered (no attribution string in client/src; #133 is machine-readable only, release handoff)
- **F4 Trade-acceptance outcome logging contract**: partial. Left: merge #94 (+ #103 → #120 → #100 stack); first real observed row
- **F5 Honest-inventory contract**: done. Left: bar met. Follow-ups: #116, #146, #135 (Auditor R62 HELD on reach-ladder.mjs:266 mutant), R66 bare-import gap reach-grade.mjs:99 (changes no cell, wiring-map addendum), CONTRACT.md:126-135 §2b low end after the ladder ruling
- **F6 Open-PR triage**: done. Left: bar met; board now stale (63 open) — §2 below refreshes it
- **F7 Deploy sequence, prep only**: done. Left: nothing for the prep item
- **A1 League config auto-ingest**: partial. Left: (1) #93 fields; (2) verifyLeagueConfig per setting confirmed/defaulted/unavailable, loud; (3) map all ESPN scoringItems (bonuses, 2-pt, first downs) and kill the silent fallback; (4) the proof: league points recomputed from stat lines = ESPN's applied points per player-week; (5) playoff structure from settings, not…
- **A2 Deep predictive feature set**: partial. Left: (a) coaching run/pass tendency + 4th-down aggression untested: go-rate now produced (nfl-pbp.js:484, #92 6e722719) but consumers still read the conversion rate (:481; swap point football-context.js:220; fourth-down-rate-unit-mismatch.md) — swap, re-derive history, then lift-test or decline; (b) pace: a recorded…
- **A3 Beat reporter source map**: partial. Left: (1) no job calls any resolver (coach/catalog.js:185 says so); (2) no historical score per source (predicted vs cried wolf, with interval + min n); (3) reader does not read best first: routes/news.js:75-86 ranks on static reliability; (4) aggregators unlabelled in data; (5) locateGameAndPlayer :92-126 keys game by…
- **B4 Waiver wire system**: partial. Left: FAAB moot (all 5 leagues traditional waivers, FANTASY-ENGINE-MASTER-PLAN.md:298,380) → waiver-priority strategy instead; K/DST/TE streaming (board scores QB/RB/WR/TE only waiver-wire.js:43; K/DST excluded trade-engine.js:123-125); stash-vs-drop as EV with option value; handcuff wired to the board; simulated-season…
- **B5 Defensive adds + kicker denial**: not-started. Left: K/DST projection, opponent-streaming denial value, surfaced on the board
- **B6 Trade acceptance probability**: partial. Left: calibrated per-manager P(accept) (Brier/reliability), "experimental — N real outcomes" label (no hit for experimental), ranking that uses it; receptiveness centred 0.5 counterparty-pricing.js:317 vs ~12% observed (master plan :503)
- **B7 Trade timing**: partial. Left: propose-the-hour output; Tuesday post-waiver shift; deadline urgency (tradeSettings.deadlineDate never read); buy-low window graded on history
- **B8 Three-team trades**: not-started. Left: need/surplus matrix, triangle constructor, per-side value + P(accept), UI
- **B9 Playoff probability engine**: partial. Left: page calls default fromWeek = 1 (model.js:458,475, title-odds-trades.js:66, trades.js:1127) → real record ignored (season-sim.js:122); playoff weeks hard-coded 15-17 (:195, matchups.js:25), not leagueSchedule(); one week per round (:315); K/DEF absent (:32); no playoff-odds delta on adds; calibration vs outcomes
- **B10 Weekly operating rhythm**: not-started. Left: NFL-week ops calendar (Tue/Wed/Thu/Sun/Mon) with jobs and outputs per day
- **B11 Push notifications / game-day mode**: not-started. Left: push channel, inactives watcher, pivot + tap-to-apply, latency metric
- **C12 Beat-the-dumb-baseline gates**: partial. Left: no start/sit gate vs "start highest projection" (lineup-posture.js:292,405 *defaults* to that rule); no trade gate vs "offer fair value"; no waiver gate vs "add highest projected FA"; nothing scheduled; heavy tier runs only if AUTO_HEAVY_SYNC=1 (scheduler.js:2176)
- **C13 Decision post-mortem loop**: partial. Left: weekly three-question teardown (approach / outcome / lesson) per significant lineup, waiver and trade decision, as-of projections, stored, scheduled, shown
- **C14 Luck decomposition**: partial. Left: expected vs actual wins for the user's team in product; decisions vs noise split; season-level "good or lucky" answer; playoff boundary ?? 14 feeds it (league-history.js:116)
- **C15 Causal news impact**: not-started. Left: diff-in-diff on fantasy usage/points with matched controls and negative controls
- **C16 Injury response latency**: not-started. Left: news → model update → user notified, minutes, measured
- **C17 Selection-bias fix for trade logging**: not-started. Left: log considered-not-proposed; two-stage P(propose)×P(accept); counters as partial acceptance; bias named in every report; exploration budget
- **C18 Goodhart / accuracy-theater guards**: partial. Left: live decision-win-rate metric; hidden fantasy decision holdout; random audits of claimed accuracy; R45(1) self-referential ceiling target (ceiling-lineup.js:223 effectiveTarget = target ?? r2(naiveScore.ceiling), ceiling q(0.90) :161)
- **C19 Uncertainty UI**: partial. Left: served, calibrated range_lo/hi/coverage/n; UI "N% chance of a–b"; coverage proven on held-out
- **C20 The "why" engine**: partial. Left: one required, human-evaluable why on every recommendation built from measured inputs; Coach panel; fantasy page-explain with grounding; deep dive (UI step 3)
- **D21 Pipeline fragility fix**: partial. Left: outbound alerting; per-source fallback ordering (platform/providers.js registerProvider has zero callers); optional sources never trigger (nfl-model-growth.js:84-98 required:false; #119 note promises a retry :186); promoteWeeklyFitChecked (weekly-weight-store.js:174; handoffs call it saveAndVerifyWeeklyFit) unused by…
- **D22 One-league overfitting fix**: not-started. Left: hierarchical per-league models on global priors; nothing Nick-league-only ships as general
- **D23 Desktop + mobile**: partial. Left: phone-first audit of Sunday flows; PWA manifest/service worker; viewport tests (no e2e framework)
- **D24 Competitive teardown**: not-started. Left: teardown doc: pricing, strengths, verified wedge for FantasyPros, 4for4, ETR, FantasyPoints, ESPN/Sleeper
- **D25 Kill list**: partial. Left: one kill list with one-line obituaries; orphans still standing: Model.tsx, Edge.tsx, Confidence/Distribution, waiverUpgrades/sellHigh, roster-risk.js:77/147/223, denialValue comment
