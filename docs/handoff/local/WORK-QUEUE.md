# Gridiron HQ — single work queue (2026-09-22, built 19:1x-19:4xZ)

**Next unit: F-01** (land #128). Then run §3 top to bottom, one fresh session per unit.

- **Main tip:** 35a61fe3 (#118 merged 19:15:49Z; main CI in progress at 19:17Z). Cites are on b600afa1 unless marked; #118 touched only `AdvancedStatsPanel.tsx`, `player-advanced-stats.js`, its test and evidence files.
- **Deployed:** c5ee3b54 (#99). Everything after is not live. 2 migrations wait for the next deploy (063, 070).
- **Sources:** $H = `…/scratchpad/wt-handoff/docs/handoff/2026-09-22` (PLAN-ITEMS-1-25.md, PHASE-BOARD, 15 thread handoffs, memory/), repo docs, live `gh pr list` (19:1xZ), `git grep` on origin/main. Read-only census of `~/gridiron-local/data.sqlite` (a local app-DB copy, 15:07 local: 5 ESPN leagues all `redraft`, all payloads carry `scoringItems`; 1,466 `league_transactions_raw`; 187,890 `nfl_play_charting`; 177,855 `nfl_depth`; 1,427 `news_items`) — **local, not production**.
- **Corrections to inputs** (checked against main):
  - A3: a per-team beat-reporter *handle* list does exist (`server/news/twitter-ingest.js:95-114`). What's missing is scoring it and ordering sources by trust.
  - Waiver 0.9-as-confidence is already fixed by #62 (`waiver-brain.js:53,370-381`).
  - The handoffs' `saveAndVerifyWeeklyFit` is `promoteWeeklyFitChecked` on main (`weekly-weight-store.js:174`).
  - 4th-down go-rate is already produced by #92 (`nfl-pbp.js:484`).
  - All 5 leagues use traditional waivers, so there is no FAAB (`FANTASY-ENGINE-MASTER-PLAN.md:298,380`).
  - #128 and #146 have no §5 in their bodies.
  - #88 carries A1's `verifyLeagueConfig` and C19's `projection-range.js`.

## NICK-ONLY blockers (14 blocking + 1 observation)

| N | Blocker | Blocks | Best work without him |
|---|---|---|---|
| N1 | ESPN cookie on the live transaction collector (first real `trade_outcomes` row) | F4, B6, C17 | F-06: derive outcomes from the local copy's 1,466 real transactions |
| N2 | Next deploy + brake on/off (#127 re-sets `SCHEDULER_DISABLED=1` each press) | F7; makes every merge since c5ee3b54 live | F-16 deploy-delta checklist |
| N3 | Rollback-image confirmation (`deployment-01M2VZ9JRYSXVHCRWJ83V360QH`) | F7 recovery | re-set brake first is in the runbook |
| N4 | Key rotation: 5 credentials across 3 exposures, 0 rotated | security risk | nothing to build; presence-only reads |
| N5 | Production DB read (Explorer READ-B, 5 commands; also `fly secrets list` names for `AUTO_HEAVY_SYNC`) | F2 production column, charting census, #115 injury probe, heavy-tier state | local copy runs, labelled local |
| N6 | Chat-corpus run on his Mac (`build-person-profiles.mjs` + `grade-person-profiles.mjs`) | B6 per-manager person variables (40 ship `priceable:false`) | B-10/B-11 on transactions only |
| N7 | Paid data (twitterapi-io reads, PFF grades, subscriptions) | A3 backfill breadth, D24 depth | score already-ingested news; public pages |
| N8 | Advanced-stats projection arm (air-yards share + WOPR) not approved | A2 | other A2 units |
| N9 | Migration words: #94 067 (confirm GO covers), #93 068, #88's 063/064 (numbers collide with main's 063/064; allowed only if `name` exports differ), C-08 schema | F-05, A-01, C-14, C-08 | build + test on local copy; merge waits |
| N10 | Keep-or-close on stale drafts (#66 #79 #80 #83 #144 #46; START-HERE "Nick's call") | board hygiene | F-15 closes only never-merge snapshots |
| N11 | Deletions: `Model.tsx`, `Edge.tsx`, branch `tdd/xiezr0-hosted`, any MLB table | D25 | obituaries only |
| N12 | B11 channel/device + permission to write lineups to his ESPN account ("tap to apply") | B11, C16 | Web Push + deep link |
| N13 | C17 exploration offers (each is a message to a league-mate on his behalf) | C17 | logging + model, no offers |
| N14 | Usage: BURST/STEADY/PUSH pick + meter readings; auto-mode permission classifier | fleet pace | one fresh session at a time under the 25% cap |
| obs | Public repo has no LICENSE file | nothing in the plan | none |
## 1. Plan items (32) — status on origin/main

Status words: **done** = the item's bar in PLAN-ITEMS-1-25.md is met on main; **partial** = code on main or in an open PR serves it, bar not met; **not started** = nothing on main or in a PR maps to it. file:line is on b600afa1 unless marked (main tip 35a61fe3 adds only #118: AdvancedStatsPanel.tsx + player-advanced-stats.js). **NICK-ONLY** = only Nick can clear it; the "proceed" column is the best work that does not need him.

### Foundation (Nick's GO, 1-7)

| # | Status | What exists | LEFT to meet the bar | NICK-ONLY → proceed without |
|---|---|---|---|---|
| F1 Wiring map stopped + panel lines | done | self-report "DONE 01:11Z" (memory gridiron-go-plan-2026-09-22) | nothing | — |
| F2 24-job stall table vs a DB copy | partial | #95 eb861feb (heavy jobs off request thread); `job-worker.js:32-42`; `ON_REQUEST_THREAD` `scheduler.js:1707`; #98 draft: `scripts/measure-live-tier-stalls.mjs` + `docs/evidence/2026-09-22/live-tier-stall-table.md`, max 1,835 ms on an **empty** 265-table copy (its body: lower bound) | a real-row DB copy run, on the post-#128 job list, each job classed >60 s killer / >10 s suspect / measured / no-verdict-with-reason; merged | production copy (Explorer READ-B, 5 commands) → run on a copy of `~/gridiron-local/data.sqlite` (820 MB; 5 ESPN leagues, 2,488 roster rows, real nfl tables), labelled "local copy, not production" |
| F3 Freshness registry + banner kill, same PR | done | #86 7eca9a8b: `data-freshness.js:242` `dataFreshness`, banner `DataFreshnessBanner.tsx:132` | bar met. Follow-ups: `servedTablesRegistry()` `data-freshness.js:273-276` finds no `servedTables()` export in `source-registry.js` → falls back to `player_week_usage` only (`:251-265`) = #96/#104; CC BY credit line not rendered (no attribution string in client/src; #133 is machine-readable only, release handoff) | — |
| F4 Trade-acceptance outcome logging contract | partial | #94 open (`trade_outcomes`, migration 067, `trade-outcomes.js`); main has no `trade_outcomes`; `scripts/collect-league-transactions.mjs:21` creates `league_transactions_raw` outside the schema | merge #94 (+ #103 → #120 → #100 stack); first real observed row | **first real row needs Nick's ESPN cookie on the live collector** → validate #94's observed-row derivation on the local copy's 1,466 real `league_transactions_raw` rows (local only, never shown as production) |
| F5 Honest-inventory contract | done | #99 c5ee3b54 + #108 eb19f475 (`docs/inventory/CONTRACT.md`, `INVENTORY.md` 881 rows, `scripts/reach-grade.mjs`); #137 bd903669 + #147 532fe18a (reach column adds to 321) | bar met. Follow-ups: #116, #146, #135 (Auditor R62 HELD on `reach-ladder.mjs:266` mutant), R66 bare-import gap `reach-grade.mjs:99` (changes no cell, wiring-map addendum), `CONTRACT.md:126-135` §2b low end after the ladder ruling | — |
| F6 Open-PR triage | done | #102 140d436b `docs/board/pr-triage-2026-09-22.md` (49 PRs vs 654ff93) | bar met; board now stale (63 open) — §2 below refreshes it | keep-or-close on stale drafts is Nick's call (START-HERE) → close only the never-merge snapshots |
| F7 Deploy sequence, prep only | done | deployed c5ee3b54 17:05Z; `docs/runbooks/deploy-654ff93.md`; #127 9d262adf `deploy.yml:62` re-sets the brake, never unsets (`:18`) | nothing for the prep item | **next deploy, brake on/off, rollback image** → deploy-delta checklist: 2 migrations since c5ee3b54 (`063_beat_reporter_claim_resolutions`, `070_play_formations_participation_columns`), DB + 2 GB free check, merged-not-deployed list |

### Phase A (1-3)

| # | Status | What exists | LEFT to meet the bar | NICK-ONLY → proceed without |
|---|---|---|---|---|
| A1 League config auto-ingest | partial | fetch `routes/leagues.js:125` (mSettings), raw JSON in `leagues.payload` `:136-166`; `scoring.js:52-78` `scoringFor` maps 9 stat ids (`:26-41`), silent fallback `:72-75`; keeper → `dyn_` pricing `format.js:23-25,62` → `trade-engine.js:279-280,326`; `trade-horizon.js:54-70` labels default vs league. Open: #93 (waiver_type, faab_budget, trade_deadline, playoff_teams, playoff_week_start via migration 068; full slot map), #88 `league-config-verification.js` (verifyLeagueConfig, 03:46Z run: ESPN 2/8 settings confirmed), #74 (redraft window) | (1) #93 fields; (2) verifyLeagueConfig per setting confirmed/defaulted/unavailable, loud; (3) map all ESPN scoringItems (bonuses, 2-pt, first downs) and kill the silent fallback; (4) **the proof**: league points recomputed from stat lines = ESPN's applied points per player-week; (5) playoff structure from settings, not `?? 14` (`league-history.js:116` written as `is_playoff` `:134`; `season-sim.js:77` `?? 14`, `:198` `?? 6`); (6) ESPN ppr/superflex never written (`leagues.js:161`; `format.js:52-54` reads Sleeper `SUPER_FLEX` only); (7) PPR-default callers (`week-postmortem.js:99`, `title-odds-trades.js:66`, `trades.js:1127`, `news-fantasy-impact.js:20`, `season-sim.js:363`) take `scoringFor(lg)`; OP/BENCH/IR dropped by `leagues.js:118` map | none blocking — the 5 real ESPN payloads (all with `scoringItems`, all `redraft`) are in the local copy |
| A2 Deep predictive feature set | partial | lift proofs on main via #68 26a5002a (`docs/evidence/2026-09-22/`): routes run declined (`phase-a-routes-run-lift-proof.md`, −0.0010 [−0.0027,+0.0008]); red zone inside 10 declined (`phase-a-red-zone-inside-10-lift-proof.md`); practice participation declined for production (`phase-a-practice-participation-measurement.md`, +0.0007 [−0.0032,+0.0047]); OL-vs-DL declined, opponent pass-EPA detected pooled but failed split-half → REOPENED (`phase-a-ol-vs-dl-lift-proof.md`; memory gridiron-phase-a-feature-verdicts); depth-chart change declined (memory gridiron-depth-rank-rejected; evidence off-repo `/mnt/project-files/DEPTHRANK-SPEC.md`); pace dropped unrun. Ingest: `inside_10_carries` `nfl-pbp.js:633` (#92), `was_pressure` `nfl-formations.js:124` (migration 070), tendencies `nfl-team-tendencies.js:38-44`. Harness: #121 prereg `coupled-prior-and-availability-preregistration.md` (no result), `backtest-significance.js:114` `mean_diff` = bootstrap mean, target-share prior default-off `projections.js:601` | (a) coaching run/pass tendency + 4th-down aggression untested: go-rate now produced (`nfl-pbp.js:484`, #92 6e722719) but consumers still read the conversion rate (`:481`; swap point `football-context.js:220`; `fourth-down-rate-unit-mismatch.md`) — swap, re-derive history, then lift-test or decline; (b) pace: a recorded decline, not "dropped unrun"; (c) reopened OL-vs-DL = charting matchup unit (PREREG-070 rev 2, Auditor R62(2) CLEARED with 3 text conditions; persistence check first, lower bound > 0.20); (d) depth-chart evidence file onto main; (e) coupled grade per #121; (f) harness: `observed_diff`, `production()` marker + `nfl-blind-audit.js:263` fix; (g) `opp_adj_def_epa` reaches betting only (`opp-adj-def-epa-wiring-audit.md`) — the research baseline lacks it (memory gridiron-phase-a-baseline-caveat); ridge only, trees not ruled out | **advanced-stats arm (air-yards share + WOPR) not approved** (gridiron-ui-redesign-approval-2026-09-20); production `nfl_play_charting` census → run persistence on the local copy (187,890 charting rows) after the FTN licence check, labelled local |
| A3 Beat reporter source map | partial | per-team **handle** list exists: `server/news/twitter-ingest.js:95-114` `BEAT_REPORTER_HANDLES` (32 teams, identity-verified via `source-validation.js:88-123`), `NATIONAL_INSIDER_HANDLES` `:48-59`; static reliability 0.75 insider / 0.95 team (`:167`); ingest job `scheduler.js:810-815` via `twitterapi-io.js` (**paid**, $10 prepaid, `:4-18`). #90 6224fade: `beat-reporter-accuracy.js` resolvers for 4 of 6 claim types (injury `:163/222`, return `:250/282`, role `:321/370`, suspension `:429/461`), table `beat_reporter_claim_resolutions` (migration 063), `sourceTrustScore` `:477` (caller only `coach/tools.js:30,234`), `orderByTrust` `:517` (no caller) | (1) no job calls any resolver (`coach/catalog.js:185` says so); (2) no historical score per source (predicted vs cried wolf, with interval + min n); (3) reader does not read best first: `routes/news.js:75-86` ranks on static reliability; (4) aggregators unlabelled in data; (5) `locateGameAndPlayer` `:92-126` keys game by team, player by *current* team → traded players unresolved; (6) `transaction` claim type unbuilt; (7) trusted/noise must come from scores, not the hand list | **new paid tweet reads** (twitterapi-io) → score from already-ingested `news_items` (1,427 rows in local copy) and free ESPN player notes; no new paid reads |

### Phase B (4-11)

| # | Status | What exists | LEFT to meet the bar | NICK-ONLY → proceed without |
|---|---|---|---|---|
| B4 Waiver wire system | partial | served board `waiver-wire.js:152` `waiverBoard()` (route `trades.js:668`, `WaiverWire.tsx:8`); claim/cut `:95-113`; stash vs drop as rest-of-season point difference `:236-257`; #62 ea69d9f3 labels 0.9 as `CLAIM_FRICTION` hand-set (`waiver-brain.js:53,59-67`), confidence null (`:370-381`); `handcuffValue()` `contingency.js:1111` from real backup production, route deleted (`routes/model.js:8-26`); `waiverUpgrades()` `waiver-brain.js:248` no caller | FAAB moot (all 5 leagues traditional waivers, `FANTASY-ENGINE-MASTER-PLAN.md:298,380`) → waiver-**priority** strategy instead; K/DST/TE streaming (board scores QB/RB/WR/TE only `waiver-wire.js:43`; K/DST excluded `trade-engine.js:123-125`); stash-vs-drop as EV with option value; handcuff wired to the board; simulated-season test vs a sharp-human policy; "+3.45pp all-play" presented as measured (`waiver-wire.js:4-13`, harness not committed, master plan `:501`) | none |
| B5 Defensive adds + kicker denial | not started | stale comment only `league-brain.js:46-51` (`denialValue()` retired `:182-201`); K/DEF excluded from sim `season-sim.js:32` | K/DST projection, opponent-streaming denial value, surfaced on the board | none |
| B6 Trade acceptance probability | partial | `trade-acceptance.js:142` `acceptanceBand()` (centre = observed rate or 0.30 `:92,:204`; never claims fitted `:10,:280,:325`), shown `ManagerRead.tsx:81-97`; blend `counterparty-pricing.js:323-327` (min(1,n/15)); `tx_accept_rate` withheld < 5 `manager-signals.js:225`; `setManagerProfile` `league-brain.js:156` via `trades.js:233`, no client UI; ranking ignores the band (`trade-engine.js:1637,1650-1651,1683`) | calibrated per-manager P(accept) (Brier/reliability), "experimental — N real outcomes" label (no hit for `experimental`), ranking that uses it; receptiveness centred 0.5 `counterparty-pricing.js:317` vs ~12% observed (master plan `:503`) | real outcomes need F4 rows (**ESPN cookie**) and Nick's chat-corpus run (Coach handoff) → label + source/n surfacing + two-stage model on the local copy's 1,466 transactions |
| B7 Trade timing | partial | `trade-tactics.js:229` `timingRead()` (median decision time, busiest UTC hour; needs ≥3 decisions); `sendWindow()` `:333` returns now / wait-48h only; `trade-horizon.js:80-102` playoff-weighted horizon; buy-low tags `trade-engine.js:1257`, `news-lag-trader.js` | propose-the-hour output; Tuesday post-waiver shift; deadline urgency (`tradeSettings.deadlineDate` never read); buy-low window graded on history | none (transactions in local copy) |
| B8 Three-team trades | not started | plan only (`FANTASY-ENGINE-MASTER-PLAN.md:661,1004`); engine is 2-team `trade-engine.js:1482` + 2-step `:2003` | need/surplus matrix, triangle constructor, per-side value + P(accept), UI | none |
| B9 Playoff probability engine | partial | `season-sim.js:173` `simulateSeason()` (playoff/title odds, expected wins, CIs `:336-351`); `tradeImpact()` `:361` paired seeds; routes `model.js:450,464`; shown `TradeCard.tsx:345-371`, `TradeLab.tsx:262-318`, `MyTeam.tsx:62-183`; drafts #40→#44→#58, #83, #42 | page calls default `fromWeek = 1` (`model.js:458,475`, `title-odds-trades.js:66`, `trades.js:1127`) → real record ignored (`season-sim.js:122`); playoff weeks hard-coded 15-17 (`:195`, `matchups.js:25`), not `leagueSchedule()`; one week per round (`:315`); K/DEF absent (`:32`); no playoff-odds delta on adds; calibration vs outcomes | none |
| B10 Weekly operating rhythm | not started | scheduler is staleness-driven (`maxAgeMinutes`, `scheduler.js:1299,1519,1598`; tiers `:2190-2212`); heavy tier runs only if `AUTO_HEAVY_SYNC=1` (`scheduler.js:2176`); 34 of 62 jobs never ran on a ~177 s restart cycle (`docs/scheduler-what-actually-fires.md`, measured before #95); `decision-inbox.js:95` has no reader route; `weekPostmortem()` `week-postmortem.js:44` no caller | NFL-week ops calendar (Tue/Wed/Thu/Sun/Mon) with jobs and outputs per day | none |
| B11 Push notifications / game-day mode | not started | `News.tsx:56-60` 60 s browser poll while a signal is `game_day`; static warnings `Lineup.tsx:187-198`; no service worker/manifest (`client/public` holds only `draft-capture.js`) | push channel, inactives watcher, pivot + tap-to-apply, latency metric | Nick's device/channel choice; applying a lineup to ESPN writes to his account → build Web Push + pivot suggestion; "apply" stays a deep link until he says |
### Phase C (12-20)

| # | Status | What exists | LEFT to meet the bar | NICK-ONLY → proceed without |
|---|---|---|---|---|
| C12 Beat-the-dumb-baseline gates | partial | projection-accuracy baselines only: `weekly-backtest.js:88` (`season_to_date`/`last3` arms `:105-106`); `backtest-significance.js:57`; one-shot `scripts/promote-weekly-ensemble.mjs:170,287` refuses promotion unless it beats baselines on held-out 2025; `startSitPairAccuracy` `scripts/promote-early-week-weights.mjs:153`; static `DECISION_CURVE` `lineup-brain.js:268` | no start/sit gate vs "start highest projection" (`lineup-posture.js:292,405` *defaults* to that rule); no trade gate vs "offer fair value"; no waiver gate vs "add highest projected FA"; nothing scheduled; heavy tier runs only if `AUTO_HEAVY_SYNC=1` (`scheduler.js:2176`) | none (production AUTO_HEAVY_SYNC value is a secrets-list read → N5) |
| C13 Decision post-mortem loop | partial | `week-postmortem.js:44` (decision_cost `:137`, verdicts `:151-158`, lineup only), route deleted in #91 e3e76025, no caller; grades with today's projection (`EXISTING-SYSTEMS-INVENTORY.md:100`); `decision_recommendations.resolved_at/outcome` exist (migration 020 `:81-82`), nothing resolves a row (`decision-inbox.js:141-160`); weekly learning job heavy tier (`scheduler.js:1455`) | weekly three-question teardown (approach / outcome / lesson) per significant lineup, waiver and trade decision, as-of projections, stored, scheduled, shown | none |
| C14 Luck decomposition | partial | `scripts/luck-panel.mjs` (all-play vs actual, manual CLI) → `manager-archetypes.js:515-530` → counterparty pricing only (`counterparty-pricing.js:639-660`) | expected vs actual wins for the user's team in product; decisions vs noise split; season-level "good or lucky" answer; playoff boundary `?? 14` feeds it (`league-history.js:116`) | none |
| C15 Causal news impact | not started (fantasy) | betting-only event study `nfl-news-event-impact.js:77,212` with negative controls `:265,284,304`; `nfl-news-market-latency.js:20-52`; fantasy `trackingVerdict` `news-fantasy-impact.js:45` is before/after, no control | diff-in-diff on fantasy usage/points with matched controls and negative controls | paid `scripts/run-news-event-impact.mjs` → use free usage data only |
| C16 Injury response latency | not started (fantasy) | `signal-latency.js:116,291` (betting-hub only); ingest cadence rss 15 min / espn 30 / signals 60 / injuries 6 h (`scheduler.js:1569-1600`) | news → model update → user notified, minutes, measured | needs B11 channel (N12) → measure news → model-update leg first |
| C17 Selection-bias fix for trade logging | not started | `trade-engine.js:1818` `considered` count and `:1830-1845` `edge_removed` returned, never persisted; only `trade_proposal_cache` insert (`trade-proposals.js:542`) | log considered-not-proposed; two-stage P(propose)×P(accept); counters as partial acceptance; bias named in every report; exploration budget | exploration offers are messages to league-mates on Nick's behalf (N13) → build logging + model; no offers sent |
| C18 Goodhart / accuracy-theater guards | partial | sealed holdout `server/modeling/walk-forward.js:35-55,112`; `audit-registry.js` preregistered audits; decision metric exists but static (`lineup-brain.js:268`); `weekly-ensemble.js:40` pair accuracy; governance manual rule 12 | live decision-win-rate metric; hidden fantasy decision holdout; random audits of claimed accuracy; R45(1) self-referential ceiling target (`ceiling-lineup.js:223` `effectiveTarget = target ?? r2(naiveScore.ceiling)`, ceiling `q(0.90)` `:161`) | none |
| C19 Uncertainty UI | partial | spec `docs/spec/projection-range.md` (80% band at 80.74%, serving contract `:144-175` unbuilt); `scripts/fit-weekly-coverage.mjs:27-29` 0.778 at 2,000 draws vs gate [0.78, 0.82] (`gate-verdicts.js:9`); #88 carries `projection-range.js` + coverage tests (unmerged); history-percentile floor/ceiling `EvidenceStrip.tsx:92-93`; `Confidence` prints "Calibrated" from fixed thresholds `DesignSystem.tsx:50`, imported nowhere | served, calibrated `range_lo/hi/coverage/n`; UI "N% chance of a–b"; coverage proven on held-out | none |
| C20 The "why" engine | partial | per-surface `why`: `lineup-brain.js:~622`, `waiver-wire.js:276`, `trade-tactics.js:198-205`, `trade-proposals.js:82` (+ `verifyProposals` `:233`); Coach #90 (`routes/coach.js:44`, `coach/verify.js:86` every number in a cited row), **no Coach UI** (only `coach.types.ts`); on-page assistant is betting-scoped (`nfl-page-explain.js:45`, 6 betting tools `page-explain-tools.js:22-96`) | one required, human-evaluable `why` on every recommendation built from measured inputs; Coach panel; fantasy page-explain with grounding; deep dive (UI step 3) | none |

### Phase D (21-25)

| # | Status | What exists | LEFT to meet the bar | NICK-ONLY → proceed without |
|---|---|---|---|---|
| D21 Pipeline fragility fix | partial | merged silent-failure fixes #86 #87 #89 #91 #111 #112 #113 #115 #119 #124 #130 #131; `data-freshness.js:149,242`; `platform/loop-watchdog.js:88,127`; backoff `scheduler.js:247`; alerts to a table only `nfl-model-watch.js:52-128` | outbound alerting; per-source fallback ordering (`platform/providers.js` `registerProvider` has zero callers); optional sources never trigger (`nfl-model-growth.js:84-98` required:false; #119 note promises a retry `:186`); `promoteWeeklyFitChecked` (`weekly-weight-store.js:174`; handoffs call it saveAndVerifyWeeklyFit) unused by scheduled path `weekly-learning.js:319`; two snap ingests unreconciled (`nfl-advanced.js:174` vs `nflverse.js:270`); ~20 hardening PRs open (§2) | none |
| D22 One-league overfitting fix | not started | pooling exists only locally: `contingency.js:421` (players), `counterparty-pricing.js:323-326` min(1,n/15); `NICK_PRIORS` hard-coded `manager-signals.js:336`; counterparty centred on league 4 `counterparty-pricing.js:1280` | hierarchical per-league models on global priors; nothing Nick-league-only ships as general | none |
| D23 Desktop + mobile | partial | Tailwind breakpoints (`sm:` 46 uses/21 files); mobile drawer `App.tsx:42,50-59`; viewport meta `client/index.html:5` | phone-first audit of Sunday flows; PWA manifest/service worker; viewport tests (no e2e framework) | none |
| D24 Competitive teardown | not started | FantasyPros used as data/reference only (`TARGET-SPEC.md:4,63`, `RESEARCH_UI_PATTERNS.md:20-22`) | teardown doc: pricing, strengths, verified wedge for FantasyPros, 4for4, ETR, FantasyPoints, ESPN/Sleeper | paid subscriptions (N7) → public pages only |
| D25 Kill list | partial | obituaries section `docs/board/pr-triage-2026-09-22.md:225-244` (cites a file not on main); tombstones `routes/model.js:8-25`, `edge.js:4-18`, `decision-inbox.js:141-163`, `trades.js:145-178`; 1694694 (nine tabs) | one kill list with one-line obituaries; orphans still standing: `Model.tsx`, `Edge.tsx`, `Confidence`/`Distribution`, `waiverUpgrades`/`sellHigh`, `roster-risk.js:77/147/223`, `denialValue` comment | deletions (N11) → write obituaries; delete nothing |
## 2. Open PRs (63 open after #118 merged 19:15:49Z as 35a61fe3) — read `gh pr list` at 19:1xZ

Legend: CI = check on the exact head (gh statusCheckRollup). Behind = commits on origin/main not in head (`git rev-list --count head..origin/main`, main 35a61fe3 → add 1 to figures read at b600afa1). Gate = body has merge-gate v2 §1-5 headings (skills/gridiron-merge-gate-v2). "v1 body" = old five questions, no "Merge gate" heading. Stale-40 = base 791b131f (2026-09-20), zero CI runs, false "CI cannot run" text corrected in body only (evidence-auditor handoff §3, feature-audit handoff).

**Merge-ready now: none.** Closest: #148 (docs-only, CI green; memory gridiron-merge-gate-rule "docs-only: CI green alone", but skill-strict it lacks §1-5 "not applicable" lines).

| PR | head | CI | behind | gate | serves | what it lacks (exactly) |
|---|---|---|---|---|---|---|
| #128 MLB removal | 5f9242d8 | green | 17 | §1-4, **no §5** | F2 (request thread 29→26), Nick 17:24Z | §5 Hard rules heading; merge main (17 behind, deletions) + CI once; Scheduler says do not re-run local guard (scheduler handoff 18:42Z) |
| #146 receiver ratchet | 5dfedb80 | green | 4 | §1-4, **no §5** | F5 / D21 | §5; gate-adding PR → merge main + `node scripts/wiring-map.mjs --check` exit 0 in the minute before merge (gridiron-gate-pr-merge-main-first-lesson) |
| #148 handoff package | fa3ddbba | green | 1 | "Merge gate" docs-only para | none (docs) | §1-5 "not applicable" lines if skill-strict; else merge-ready |
| #94 trade outcome ledger | 0dbc9976 | green | 6 | v1 body | **F4** | v2 body (replacement text was in dead container); one guard on merged main (last completed guard was 0074abe2, one rebase behind — trade-ledger addendum); migration 067 (confirm Nick's F4 GO covers it, skill §5) |
| #103 bare-catch sweep | 08c729e1 | green(old) | stacked on #94 branch, CONFLICTING | v1 | F4 stack / D21 | rebase after #94; delete false "CI is disabled" para (body line 95); guard; v2 body |
| #120 crashed read ≠ "send offer" | a1164dd5 | green(old) | stacked on #103 | v1 | F4 stack / B6 | rebase after #103; guard; v2 body |
| #100 "absent" vs "could not look" | 29c825cf | green(old) | 20 | v1 | F4 stack / D21 | rebase after #120; guard; v2 body |
| #116 symbol-reach namespace | 98129cbc | green | 6 | v1 | F5 | v2 body §1-5 only (opportunity handoff step 1); then squash |
| #135 reach-ladder command | 554e9b6a | green | 12 | v1 (Nick's five present, no gate heading) | F5 | test that kills call-site mutant at reach-ladder.mjs:266 (Auditor R62 HELD); v2 body; merge main; Auditor (inventory numbers) |
| #125 feature-store state | 737ae4e6 | green(old) | **CONFLICTING** | v1 (wrong five Qs) | D21 | docs/tdd evidence file (template manager-archetypes-history-state.tdd.md); v2 body; merge main (now conflicts after #131 squash); guard |
| #134 empty payload | a0bb4160 | green(old base) | 20 | v1 + WIP banner | D21 | merge main, guard, docs/tdd file, v2 body, drop WIP banner (chat-sync handoff) |
| #126 child never reported | 6b4d9ee2 | **red** (old main wiring) | 20 | v1 | D21 | merge main (was clean at ffecd797, container lost), guard, v2 body |
| #101 epoch fallback loud | 8d7312dc | **red** (old main wiring) | 29 | v1 | D21 | merge main, CI re-run, v2 body |
| #144 child flush | 47e01e72 | green(old) | 38 | v1 | D21 | merge main, guard, v2 body |
| #96 served-tables freshness | a24692d3 | none | 38 | v1 | F3 follow-up / D21 | rebase/merge main, CI, guard, v2 body (merge gate lifted per scheduler handoff) |
| #104 freshness evaluator | e3a86764 | none | stacked on #96 | v1 | F3 follow-up / D21 | after #96; remove false "CI is disabled" para; v2 body |
| #98 stall table | f318a175 | none | 38 | v1, false "CI is disabled" | **F2** | merge main; re-measure on post-#128 job list against a real-row DB copy (ran on an EMPTY 265-table copy = lower bound, body); v2 body |
| #97 watchdog names job | c5603079 | none | 38 | v1 | F2 / D21 | merge main, CI, v2 body |
| #77 main-thread holds | 3902ba78 | none | CONFLICTING (3 files) | v1 | F2 / D21 | resolve: take main on scheduler.js + abandoned-run-backoff test; decide health-route-single.test.js; merge main; guard (scheduler handoff) |
| #84 scheduled ingests | 8709ec66 | none | stacked on #77 | v1 | B10 / D21 | re-check after #77 |
| #107 archetype-build failure named | 3dd43340 | none | 38 | v1 | D21 | merge main, CI, v2 body |
| #93 league-ingest field contract | db4aa05c | none | 38 | v1 | **A1** | merge main (routes/leagues.js, espn-connect.js — owner thread RESOLVED; reassign), CI, guard, v2 body |
| #88 effk (Phase A bundle) | 4f8e63b1 | none | 41 | v1 | A1 + C19 + A2 harness | **split, don't merge whole**: carries league-config-verification.js (A1), projection-range.js (C19), ICC/reliability, migrations 063/064 (064 name-collides with main's 064_league_history_tables.js by number), #79's commits, and #106's recency fix (already on main) |
| #67 bye-risk not_modelled | a3fc5e7a | green(old base 6e72271) | 17 | v1 | B4 | merge main, CI, one guard, v2 body (feature-audit addendum) |
| #74 redraft contention window | 7a55f755 | green(old) | 17 | v1; guard EXIT=NONE | A1 (redraft vs dynasty valuation) | merge main, guard from scratch, v2 body; Auditor R67 cleared (trade valuation) |
| #139 trend usage blindspot | bc03222b | none | 38 | v1 | none (trend page) | guard; conflicts with #138 on trend-exploits.js; evidence file says "Not pushed" (false) |
| #138 draftboard health | 759f6cf7 | none | 41 | v1 | C18 (hand-set numbers named) | overlaps #79 (merge commit of preseason-layers-hold) — narrow #138 or close #79 (feature-audit handoff) |
| #79, #80, #83, #66 | stale-40 | none | 41 | v1 | #79 C18, #80 C20, #83 B9, #66 D21 | keep-or-close decision (fantasy-plan handoff step 2; START-HERE: Nick's call) |
| #40 → #44 → #58 sim stack | stale-40 | none | 41 | v1 | **B9** | merge main into #40, retarget #44/#58 (bases are feature branches), guard, v2 bodies; Auditor (season-sim odds) |
| #42 Team Outlook gate | d68a5f33 | none | 41 | v1 | B9 | same as stack; Auditor |
| #57 → #64, #60 fantasy week per league | stale-40 | #64 green(old) | 41 | #57 partial §1-4 | B7/B10 (league-true week) | merge main into #57; retarget #60/#64 (bases = #57 branch); guard; v2 |
| #43 chance to play everywhere | b7d88fcf | none | 41 | v1 | C20 | stale-40 treatment; UI thread |
| #53 projections computed from | 1f72e088 | none | 41 | v1 | F3 / C20 | stale-40 treatment |
| #46 hosted multi-user | c05b9400 | none | 41 | v1 | D22-adjacent (multi-user) | stale-40; product call (Nick) |
| #73 → #75 → #76 → #78 UI redesign steps 0-3 | stale-40 | none | 41 | v1 + false "CI cannot run" para | C19/C20/D23 | #73 merge main + CI; retarget chain as each lands; strip false para (ui handoff) |
| #41, #47 manager reads dated | stale-40 | none | 41 (#41 CONFLICTING) | v1 | B6 | rebase + fresh run before numbers are current (trade-ledger handoff) |
| #70 Trade Brain tested-on | 10daad70 | none | 41 | v1 | C12/C18 | re-measure (figures from 2026-09-20) |
| #48, #51, #71, #81 ESPN creds / admin grant / leak guards | stale-40 | #51 green(old) | 41 | v1 | A1 / D21 | Google sign-in thread RESOLVED; reassign owner; stale-40 treatment |
| #50 ESPN market timer | d01df31e | none | CONFLICTING | v1 | D21 (syncEspnMarket sole writer of espn_player_market, wiring-map finding 3) | rebase; Scheduler registers job |
| #45 ffopportunity half-ingested | c9ff6074 | none | CONFLICTING | v1 | D21 | rebase |
| #15 data/volume-fit checks | 31f841f5 | none | 41 | v1 | F5 / D21 | stale-40 |
| #38 availability term | af2d72a3 | none | 41 | v1 | A2 (practice participation) | likely superseded by #85/#106/#115 on main — keep-or-close |
| #39 migration-name enforcement | 7f36f8a8 | none | 41 | v1 | D21 | stale-40 |

**Never merge (close once read):** #136 (jev/4b snapshot — re-derive its 3-4 missing pieces as small PRs, trade-ledger handoff), #140, #141, #142, #143 (UI merge-proof snapshots), #145 (MLB offthread snapshot, superseded by #128), `archive/w45mur-*` branches (no PRs; 90,529 and 50,858 line deletions), `tdd/xiezr0-hosted` stray branch (ui handoff: delete — Nick's word, it is a delete).
## 3. Execution queue (one unit = one PR, ≤ ~1 day)

Order: Foundation close → A → B → C → D (PLAN-ITEMS order rule). **AUD** = Independent Auditor before merge (model / projection / trade / lineup / inventory numbers); **PRE** = pre-register with the Auditor before any number is run. Standard stats harness unless a row says otherwise: configuration B, fit ≤ 2024, held-out 2025 once, player-clustered paired bootstrap 90% CI, sign convention stated, incumbent = the app as served; ship rule `matchups.js:33-35` (MAE CI entirely < 0, Spearman ≥ −0.002, DNP-included MAE no worse). "Local copy" = a fresh `sqlite3 .backup` of `~/gridiron-local/data.sqlite`, never the original, results labelled "local, not production", **no league or manager names in the public repo**.

### Foundation close

| ID | Item | Goal | Files likely touched | Acceptance test | Deps | AUD |
|---|---|---|---|---|---|---|
| F-01 | F2 | Land #128 (MLB out, request thread 29→26) | PR body (§5), merge commit | CI green on the merged head; `check:wiring` 0 after merge; `test/mlb-removed.test.js` passes | — | no |
| F-02 | F2 | Re-measure #98's stall table on real rows, post-MLB job list | `scripts/measure-live-tier-stalls.mjs`, `docs/evidence/2026-09-22/live-tier-stall-table.md` | every live-tier job: max stall (histogram.max ns → ms) classed killer >60 s / suspect >10 s / ok, or a named no-verdict; known-nonzero control (busy-loop job reads ≥ its spin); data basis + sha256 of the copy stated | F-01 | no |
| F-03 | F2 | Land #97 (watchdog names the job) | `platform/loop-watchdog.js`, test | RED re-run fails on unfixed code; CI green | F-01 | no |
| F-04 | F2 | Resolve and land #77, then retarget #84 | `scheduler.js`, `test/health-route-single.test.js`, `test/abandoned-run-backoff.test.js` | health-route assertion side chosen from current wiring-map output (line numbers or not) and stated; guard exit 0; #84 base = main | F-01 | no |
| F-05 | F4 | Land #94 trade outcome ledger | PR body v2, merge main | one guard on merged tree; RED 92f31b7d fails on unfixed; sweep 34 rows 32 killed + both controls; body says first that no observed row exists; migration 067 confirmed under Nick's F4 GO | — | no |
| F-06 | F4 | Prove #94's observed-row derivation on real transactions (local) | `docs/evidence/…/trade-outcomes-local-derivation.md` (aggregates only) | on the local copy's 1,466 `league_transactions_raw` rows: count of derivable accept/decline/counter outcomes per league-season, a hand-checked sample of 5, zero rows written to any production table | F-05 | no |
| F-07 | F4 | Land #103 → #120 → #100 in order. **Integration intake 2026-09-22 (#94):** `gh pr view 103/120/100 --json baseRefName,headRefName` shows #103 still targets `claude/project-thread-3xqh5l-outcome-ledger` (#94's own branch, dead since #94 squash-merged) and #120 still targets `claude/project-thread-3xqh5l-tactics-absence` (#103's head branch, so it follows #103's retarget); #100 already targets `main`, no action needed. Retarget #103 to `main` first, merge `main` into it (never rebase — standing rule 6), merge; then retarget #120 to `main`, merge `main` into it, merge | `routes/trades.js`, `trade-tactics.js`, `counterparty-pricing.js`, PR bodies | each: rebased on the previous merge, false CI para gone (#103 line 95), guard 0, CI green, v2 body | F-05 | no |
| F-08 | F3 (licence) | Visible nflverse CC BY credit line that renders even when data is fresh or dismissed | `DataFreshnessBanner.tsx` or `App.tsx` (UI's one attribution line), test | verify `sources` on GET /api/data-freshness first; test renders the credit with `all_fresh=true` and `dismissed=true` (`DataFreshnessBanner.tsx:132` path) | — | no |
| F-09 | F5 | Land #116 (symbol-reach namespace imports) | PR body v2 | body §1-5; CI green on merged head | — | no |
| F-10 | F5 | Land #146 (receiver ratchet) | `scripts/wiring-map.mjs`, `docs/wiring/annotations.json` | merge main, `node scripts/wiring-map.mjs --check` exit 0 in the minute before merge; 18/18 ratchet tests | F-01 | no |
| F-11 | F5 | Fix R66: `buildImporterGraph` misses bare `import './x.js'` | `scripts/reach-grade.mjs:99` (Opportunity grant) | Auditor's RED: inline bare-import fixture + superset invariant (every request edge ⊆ full graph); `import './x.js'; // note` contradiction case; ladder cells unchanged on c90d2834 | F-09 | yes |
| F-12 | F5 | Finish #135 reach-ladder | `scripts/reach-ladder.mjs`, test | a test kills the call-site mutant at `reach-ladder.mjs:266` (R62 hold); 169-225 exact on c90d2834 only, bound elsewhere | F-11 | yes |
| F-13 | F5 | Fix the wiring map's foreign-handle collector (chatDb/corpus false findings) | `scripts/wiring-map.mjs` (`foreign` population) | RED fixture: second DB opened into `chatDb` resolves foreign; ratchet baseline drops the 13 Coach sites; gate 0 on merged main | F-10 | no |
| F-14 | F5 | `CONTRACT.md:126-135` §2b low-end correction per the ladder ruling | `docs/inventory/CONTRACT.md` | numbers printed with command + tree; 178-column total withdrawn | F-12 | yes |
| F-15 | F6 | Board hygiene: close never-merge snapshots with a comment | GitHub only (no PR) | #140-#143, #145 closed citing this file; #136 stays until its pieces are re-derived; stale-draft keep-or-close list sent to Nick (N10) | — | no |
| F-16 | F7 | Deploy-delta checklist for the current tip (prep only) | `docs/runbooks/deploy-<tip>.md` | lists every merge since c5ee3b54, migrations 063 + 070, DB + 2 GB free check, brake decision tree (#127 re-sets it each press), post-deploy probes (#115 `nfl_injuries`, trade-ledger SQL); nobody presses deploy (N2) | F-01…F-14 | no |

### Phase A

| ID | Item | Goal | Files likely touched | Acceptance test | Deps | AUD |
|---|---|---|---|---|---|---|
| A-01 | A1 | Revive #93 league-ingest field contract on main (owner reassigned from the resolved Google sign-in thread) | `routes/leagues.js`, `routes/espn-connect.js`, migration 068 | merge main (merge-tree clean); guard 0; RED re-run; on the 5 local payloads each of waiver_type / faab_budget / trade_deadline / playoff_teams / playoff_week_start is a value or NULL-with-reason; migration word (N9) | Foundation | no |
| A-02 | A1 | Split `verifyLeagueConfig` out of #88 and serve it | `services/league-config-verification.js`, `test/league-config-verification.test.js`, fixtures | all 8 settings Nick named report confirmed / defaulted / unavailable; run on 5 local leagues printed as counts; 13/13 mutants carried; an unconfirmable setting surfaces on the league settings view, loudly | A-01 | no |
| A-03 | A1 | Map every ESPN scoring stat the 5 leagues use; kill the silent fallback | `services/scoring.js:26-41,72-75` | 0 unmapped stat ids on the 5 payloads or each listed by id in verifyLeagueConfig; RED: payload with a bonus id fails before, passes after | A-02 | yes |
| A-04 | A1 | **The scoring proof**: recomputed league points = ESPN's applied points | `services/league-config-verification.js`, test | PRE tolerance; first confirm the applied-points field in `leagues.payload` (mRoster/mMatchup); on local rostered player-weeks, ≥ 99% within 0.1 pt per league (proposed, pre-registered), mismatches grouped by stat id; runs after each league sync | A-03 | yes |
| A-05 | A1 | ESPN ppr/superflex written; OP detected as superflex | `routes/leagues.js:161`, `services/format.js:52-54` | fixture with OP slot → superflex key; 5 local leagues' format keys match their settings | A-01 | yes |
| A-06 | A1 | Playoff boundary from settings, never `?? 14` written as measured | `services/league-history.js:116,134` (Chat sync) | missing mSettings → `playoff_start` unknown, `is_playoff` not written, state named; RED on the `?? 14` path | A-01 | no |
| A-07 | A1 | Trade surfaces price under league scoring, not PPR default | `routes/trades.js:1127`, `services/title-odds-trades.js:66` | both call `scoringFor(lg)`; RED with a non-PPR league fixture | A-03 | yes |
| A-08 | A1 | Land #74 (redraft contention window — keeper/dynasty valuation) | `trade-engine.js`, PR body | merge main, guard from scratch, v2 body; R67 clearance re-read on merged head | — | yes |
| A-09 | A2 | Additive `observed_diff` in `pairedBootstrapDiff` | `services/backtest-significance.js:114` (grant 18:10Z) | snapshot test of every pre-existing key unchanged; #121's figure reads +0.1269 | — | yes |
| A-10 | A2 | `production()` named configuration marker; fix `nfl-blind-audit.js:263` | `weekly-backtest.js`, `scripts/verify-qbr-integration.mjs:12-13`, `nfl-blind-audit.js` | silence throws; the 8 deliberately-off call sites carry explicit markers; RED on the blind-audit call | — | yes |
| A-11 | A2 | Level correction on the incumbent weekly ensemble (m0) | `services/weekly-ensemble.js` | PRE; standard harness; summing consumers' level bias shrinks with CI; sign convention stated | A-09, A-10 | yes |
| A-12 | A2 | Coupled grade: target-share prior × availability multiplier (practice participation) | per `coupled-prior-and-availability-preregistration.md` | three-support check → k wiring control (stop at K.share = 6) → 4 arms; realised SE ≤ 0.0281 or declared underpowered | A-10 | yes |
| A-13 | A2 | Officials + schedules (head coach, referee) ingest from nflverse-data | `services/nflverse.js`-adjacent ingest (Scheduler), credit line extended | licence quoted (CC BY 4.0, `master/LICENSE.md`); rows for 2015+ with known-nonzero check; F-08 credit names "officials and schedules" | F-08 | no |
| A-14 | A2 | Swap 4th-down consumers from the conversion rate to the go-rate (#92 already produces it) and re-derive team-week history | `football-context.js:220` swap point (owner check), consumers of `off_fourth_down_rate`, re-derive script | `off_fourth_down_go_rate` (`nfl-pbp.js:484`) non-null for 2018-2025 team-weeks on the local copy; per-team 2023 go-rate within 0.5 pp of a direct nflverse pbp count; conversion-rate readers relabelled | — | no |
| A-15 | A2 | Lift proof: coaching run/pass tendency + 4th-down aggression | study script + `docs/evidence/` | PRE; standard harness with `opp_adj_def_epa` in the baseline; ship or a recorded decline | A-10, A-13, A-14 | yes |
| A-16 | A2 | Lift proof: team pace / play volume (replace "dropped unrun") | study script + evidence | PRE; ship or recorded decline | A-10 | yes |
| A-17 | A2 | Charting persistence check (reopened OL-vs-DL arm, PREREG-070 rev 3) | study script + evidence | FTN charting licence quoted first; split-half `heavy_rush_rate`, n = 96 team-seasons, clustered bootstrap; proceed only if 90% lower bound > 0.20 | A-10 | yes |
| A-18 | A2 | Charting matchup arm at `dvpFor` behind a third switch, default OFF | `services/matchups.js:340` (Planner grant) | beta fit 2022-24, applied 2025 unchanged; joint points+volume ship rule; walk-forward z | A-17 passes | yes |
| A-19 | A2 | QBR signal re-run as a NEW pre-registered gate (old dismissal struck, UNJUDGED) | study script + evidence (never edit `projections.js:264-270`) | PRE; run in the configuration the app serves (production() marker) | A-10 | yes |
| A-20 | A2 | Split `yards_per: 34` (`projections.js:97` serves ypt, ypc and ypa from one constant) | `projections.js` (Model evidence audit) | PRE; fit per quantity against the served prior, never tuned on 2025 | A-12 | yes |
| A-21 | A2 | Phase A feature-verdict ledger on main (all 7 features, incl. depth-chart evidence lost with /mnt) | `docs/evidence/2026-09-22/phase-a-verdicts.md`, depth-rank script | each feature: verdict, CI, tree, command; depth-chart re-run reproduces the decline direction | A-15…A-20 | yes |
| A-22 | A3 | `locateGameAndPlayer` keys on the player, as-of team | `services/beat-reporter-accuracy.js:92-126` (Coach) | RED: traded-player claim resolves against his claim-time team; teammate game never used | — | no |
| A-23 | A3 | Schedule the resolvers off the request thread | `services/scheduler.js` (Scheduler) | job registered, fires on the live tier, writes `beat_reporter_claim_resolutions`; wiring gate sees a caller | A-22 | no |
| A-24 | A3 | Historical source scoring (predicted vs cried wolf) | `beat-reporter-accuracy.js`, evidence | backfill resolutions from already-ingested `news_items` (no paid reads); per source hit rate with Wilson 90% interval, min n; aggregators labelled in data; trusted/noise from scores | A-23 | yes |
| A-25 | A3 | The reader reads the best sources first | `routes/news.js:75-86`, `orderByTrust` `:517` | desk ranking uses trust score; unscored sources say "unscored"; RED: a high-trust source outranks a static-0.75 one | A-24 | no |
| A-26 | A3 | `transaction` claim type resolver | `beat-reporter-accuracy.js` | roster/ownership-change ground truth; RED fixture; known-nonzero case | A-22 | no |

### Phase B

| ID | Item | Goal | Files likely touched | Acceptance test | Deps | AUD |
|---|---|---|---|---|---|---|
| B-01 | B9 | Page-facing sims start from the current week and real record | `routes/model.js:458,475`, `title-odds-trades.js:66`, `routes/trades.js:1127`, `TradeCard.tsx` | RED: week-6 league with a 5-0 team → playoff odds reflect 5-0; `fromWeek` defaults to the league's current week | Phase A | yes |
| B-02 | B9 | Revive #40 → #44 → #58 and #83 (actual bracket, games played, no carried wins) | `season-sim.js`, PR bodies | merge main into #40, retarget #44/#58; guard; bracket weeks from `leagueSchedule()` not 15-17 (`season-sim.js:195`); Brier of playoff odds on history leagues reported | B-01 | yes |
| B-03 | B9 | Playoff-odds delta on every add and trade ("62% → 78%") | `waiver-wire.js`, `season-sim.js#tradeImpact`, `WaiverWire.tsx`, `TradeCard.tsx` | paired-seed delta with CI on each claim; weeks 15-17 schedules priced; UI step for two-sided sim depth | B-02 | yes |
| B-04 | B4 | K/DST projection + streaming optimizer (schedule-aware) | new file + `waiver-wire.js:43` | PRE; K/DST weekly MAE vs "last-3 average" dumb baseline on 2025; board shows K/DST with basis | Phase A | yes |
| B-05 | B4 | Waiver-priority strategy (FAAB moot: all 5 leagues traditional) | `waiver-wire.js` | claim order / hold-priority recommendation from league churn in local transactions; beats "claim highest projected" in replay | A-01 | yes |
| B-06 | B4 | Stash-vs-drop as EV with option value; handcuffs wired to the board | `waiver-wire.js:236-257`, `contingency.js:1111` | EV includes P(role change) from measured backup production; replay beats point-difference rule | B-05 | yes |
| B-07 | B4 | Land #67 (bye risk not_modelled) | `roster-risk.js`, PR body | merge main, guard, v2 body | — | no |
| B-08 | B4 | Simulated-season waiver test vs a sharp-human policy | study script + evidence | PRE; season sims on history leagues; our policy vs scripted sharp policy vs "add highest projected"; win rate with CI | B-04…B-06 | yes |
| B-09 | B5 | Denial value for rostering a DST/K the opponent would stream | new file, `waiver-wire.js` | value = opponent's expected gain from that streamer − next best, × P(facing them); shown separately from points value | B-04 | yes |
| B-10 | B6 | Acceptance: "experimental — N real outcomes" + source/n surfaced; `setManagerProfile` UI | `trade-acceptance.js`, `ManagerRead.tsx`, UI for `trades.js:233` | label shows n from data; which of 3 sources priced the manager; receptiveness centre 0.5 (`counterparty-pricing.js:317`) replaced by observed rate or labelled | F-07 | yes |
| B-11 | B6 | Per-manager two-stage P(accept) fit with calibration | `trade-acceptance.js`, `counterparty-pricing.js` | PRE; fit on local transactions, reliability curve + Brier vs "fair-tier default"; ships labelled experimental until ≥ 30 real outcomes | B-10, F-06 | yes |
| B-12 | B6 | Land #41, #47 (manager reads dated) | `manager-signals.js`, `manager-archetypes.js` | rebase, fresh run (figures from 2026-09-20), v2 | — | no |
| B-13 | B7 | Land #57 → #64, #60 (league-true fantasy week) | `trade-engine.js`, 7 week callers | merge main, retarget, guard, v2 | — | yes |
| B-14 | B7 | Deadline urgency + propose-the-hour | `trade-tactics.js:333`, `trade-horizon.js` | reads `tradeSettings.deadlineDate` (#93 column); `sendWindow` returns a timestamp; hour from `timingRead` with n shown | A-01, B-13 | yes |
| B-15 | B7 | Buy-low window graded on history | new study + `trade-engine.js:1257` | PRE; post-bad-game price vs ROS outcome, mean reversion measured; tag only fires where CI excludes 0 | B-13 | yes |
| B-16 | B8 | Need/surplus matrix + 3-team triangle constructor | new file `three-team.js` | every triangle: each side ROS value ≥ 0 and joint P(accept) shown; unit tests on 3-roster fixtures | B-11 | yes |
| B-17 | B10 | NFL-week ops calendar: jobs and outputs per day; heavy-tier gate resolved | `scheduler.js:2176`, `docs/scheduler-what-actually-fires.md` | Tue/Wed/Thu/Sun/Mon each map to named jobs that fire (weekly learning, gates, post-mortem); AUTO_HEAVY_SYNC dependency removed or stated; test pins the calendar | F-04 | no |
| B-18 | B11 | Web Push + game-day inactives watcher with pivot suggestion | service worker, manifest, new route, `lineup-brain.js` | a scheduled Sunday 11:30-13:00 ET poll; OUT player → pivot + push within the poll interval; "apply" is a deep link (N12) | B-17 | no |

### Phase C

| ID | Item | Goal | Files likely touched | Acceptance test | Deps | AUD |
|---|---|---|---|---|---|---|
| C-01 | C12 | Standing start/sit gate vs "start highest projection" | new gate file, scheduler job, Lineup panel | weekly as-of replay; decision win rate + points vs the dumb rule, CI; failing weeks shown | B-17 | yes |
| C-02 | C12 | Waiver gate vs "add highest projected FA" | gate file | ROS realised points of our claims vs dumb claims, per week | C-01, B-06 | yes |
| C-03 | C12 | Trade gate vs "offer fair value" | gate file | proposals-cache replay; n and bias label (C17) | C-01, B-11 | yes |
| C-04 | C13 | Weekly three-question post-mortem, as-of projections, stored in `decision_recommendations` | `week-postmortem.js`, `decision-inbox.js`, scheduler | cutoff honoured (RED: uses week-t projection); approach / outcome / lesson per significant decision; no new table | B-17 | yes |
| C-05 | C14 | Luck decomposition in product | new service from `scripts/luck-panel.mjs` | expected (all-play) vs actual wins; decisions (optimal − actual) vs noise; season "good or lucky" with CI | A-06 | yes |
| C-06 | C15 | Diff-in-diff on fantasy usage around news events | study + service | PRE; matched controls; negative controls (irrelevant team, time-shift); causal claim only where CI excludes 0 | A-24 | yes |
| C-07 | C16 | News → model → notify latency metric | ingest timestamps, B-18 | p50/p90 minutes per leg, measured weekly | B-18 | no |
| C-08 | C17 | Persist considered-not-proposed + counters; two-stage model; bias named | `trade-engine.js:1818,1830-1845`, `trade-outcomes.js` | rows for considered deals (migration word N9); every acceptance report prints the censoring line | F-05, B-11 | yes |
| C-09 | C18 | Fix R45(1) self-referential ceiling target | `ceiling-lineup.js:161,223` (UI) | target independent of the pool being scored; RED shows the old target moves with the pool | — | yes |
| C-10 | C18 | Live decision-win-rate + sealed fantasy holdout + random audits | `lineup-brain.js:268`, `modeling/walk-forward.js`, audit job | static curve replaced by tracked rate; holdout sealed by hash; N random recommendations re-derived weekly | C-01 | yes |
| C-11 | C18 | Land #138 or #79 (hand-set numbers named), resolve overlap; #70 re-measured | `trend-exploits.js`, preseason layers | one of the pair closed with reason; guard; v2 | — | yes |
| C-12 | C19 | UI step 0: land #73 design system | `index.css`, `client/index.html`, `docs/design/design-system.md` | merge main, CI, false CI para stripped; 8 token tests | — | no |
| C-13 | C19/C20 | UI step 1: land #75 basis chip + glossary (one stat vocabulary) | `lib/glossary.ts`, `BasisChip.tsx` | retarget to main after C-12; tests | C-12 | no |
| C-14 | C19 | Serve calibrated ranges (split `projection-range.js` from #88) | `projection-range.js`, `projections.js`, new migration (N9) | walk-forward 80% band covers within [0.78, 0.82] on held-out; conformal vs empirical decided per memory gridiron-conformal-beats-interval-layer (RNG noise ±0.008) | A-10 | yes |
| C-15 | C19 | UI step 2: #76 stat block renders "N% chance of a–b"; drop `Confidence` | `StatBlock.tsx`, `DesignSystem.tsx:48-55` | renders served range + coverage; no hard-coded "Calibrated" anywhere | C-13, C-14 | no |
| C-16 | C20 | UI step 3: #78 deep-dive drawer, incl. DvP history labelled "did not predict" | drawer on `Sheet`, `matchups.js:83-94` text | five layers; every number carries its basis chip | C-15 | no |
| C-17 | C20 | Coach panel on an existing tab | `client/src/components/coach/*` | value import of `resolveCite` (`coach.types.ts:151`); answers show cited rows | C-12 | no |
| C-18 | C20 | Required `why` on every recommendation, from measured inputs | `lineup-brain.js`, `waiver-wire.js`, `trade-engine.js` | contract test: every lineup/waiver/trade rec has `why` with ≥ 1 number traceable to a row; grounding verifier reused from `coach/verify.js:86` | C-16 | yes |
| C-19 | C20 | Fantasy page-explain (replace betting prompt/tools) with grounding | `nfl-page-explain.js:45`, `page-explain-tools.js` (Coach) | fantasy tools; ungrounded digit refused | C-18 | no |
| C-20 | C20 | Land #43, #80, #53; label teams-page seed as assumed + dated | client pages, `server/db/seed/teams.js` | stale-40 treatment each; 14 TBD lines labelled, not rewritten | C-12 | no |

### Phase D

| ID | Item | Goal | Files likely touched | Acceptance test | Deps | AUD |
|---|---|---|---|---|---|---|
| D-01 | D21 | Land #96 → #104 (served-tables freshness contract + evaluator) | `source-registry.js`, `data-freshness.js` | registry reads `servedTables()`; unrunnable rule = fault; guard; v2 | — | no |
| D-02 | D21 | Land #126, #144 (refresh children) and #101 (epoch fallback loud) | scheduler scripts | merge main, guard, v2 each | — | no |
| D-03 | D21 | Land #125, #134 (Chat sync) and #107 | `manager-archetypes.js`, `league-history.js` | #125 evidence file + v2 (conflict resolved); #134 WIP banner gone | — | no |
| D-04 | D21 | Fix #119's false retry note | `nfl-model-growth.js:186` | RED pins the optional-source case; note conditional on required | — | no |
| D-05 | D21 | Scheduled weekly fit uses `promoteWeeklyFitChecked` | `weekly-learning.js:319` | promoted fit failing re-read is demoted; five promotion gates untouched | — | yes |
| D-06 | D21 | Optional sources trigger their own sync (after a fantasy-route call-reach trace) | `nfl-model-growth.js:84-98` | trace first (R54.4); no source flipped to required | D-04 | no |
| D-07 | D21 | Outbound alerts + per-source fallback order | `platform/providers.js`, B-18 channel | a failing source alerts within one cycle; fallback order declared per source | B-18 | no |
| D-08 | D21 | Land #50 (ESPN market timer), #66, #45, #15, #39 | per PR | rebase, guard, v2 each | — | no |
| D-09 | D21 | Chat-sync findings: `picks_without_manager`, `priorSeasonFantasyCv`, `storeJevAnswers` basis | `manager-archetypes.js` | RED per finding, pre-registered to coordinator | D-03 | no |
| D-10 | D21 | Reconcile the two snap ingests | `nfl-advanced.js:174`, `nflverse.js:270` | one writer per table or a documented join; DEF/ST snap share reachable | D-06 | no |
| D-11 | D22 | Hierarchical per-league acceptance/manager priors on global priors | `counterparty-pricing.js:1280`, `manager-signals.js:336` | PRE; leave-one-league-out: a held-out league starts from the global prior and beats NICK_PRIORS | B-11 | yes |
| D-12 | D23 | Phone-first audit + fixes of Sunday flows (Lineup, News, MyTeam) | client pages, `index.css` | screenshots at 375 / 768 / 1280 in evidence; no horizontal scroll; manifest shared with B-18 | C-15 | no |
| D-13 | D24 | Competitive teardown doc | `docs/COMPETITIVE-TEARDOWN.md` | public pricing pages cited with date; wedge claim tested against each | — | no |
| D-14 | D25 | Kill list with one-line obituaries | `docs/KILL-LIST.md` | every orphan listed in item D25 has what / why / replaced-by; deletes only on Nick's word (N11) | — | no |
## 4. Standing rules for every builder (memory file = $H/memory/<name>.md unless noted)

| # | Rule | Source |
|---|---|---|
| 1 | One unit = one PR. Merge only when CI is green on the exact head **on current main** and the body carries merge-gate v2 §1-5; owning thread squash-merges and reports the sha. Docs-only: CI green (write "not applicable" in §2). | $H/skills/gridiron-merge-gate-v2/SKILL.md; gridiron-merge-gate-rule |
| 2 | Model / projection / trade-valuation / lineup / inventory-number changes go to the Independent Auditor before merge; statistical units are pre-registered with the Auditor **before** any number is run; state the sign convention of any signed error. | SKILL.md header; gridiron-auditor-charter-0714-2026-09-22; handoff/auditor §4 |
| 3 | Any replay grade runs configuration B: `roleRecency: WEEKLY_ROLE_RECENCY` explicit, no `kOverride`, k control that stops if it reads `K.share = 6`. Rig magnitudes and lineup rates never reach Nick; direction only. | gridiron-replay-rolerecency-trap; handoff/auditor §4-5 |
| 4 | One guard run per tree: `npm run check` (includes wiring since #129) on the branch merged with current origin/main; no ritual second run; output straight to a file, never through a filter. | gridiron-verify-once-and-model-by-weight; gridiron-local-gate-includes-wiring-rule; handoff/model-evidence-audit addendum |
| 5 | Gate-adding PRs (wiring map, reach grader, tree-scanning tests) merge current main and run that gate in the minute before merging. | gridiron-gate-pr-merge-main-first-lesson |
| 6 | Merge main, never rebase, on shared/foreign-authored branches (#85 rebase would delete CONTRACT.md); after any rebase the evidence file's RED/GREEN shas move in the same push. Check a stacked PR's base ref before merging (GitHub did not auto-retarget #67). | gridiron-rebase-moves-evidence-shas-lesson; handoff/opportunity §#85; handoff/feature-audit addendum |
| 7 | Cite RED/GREEN as #N + subject + sha with the failing assertion inline; one liveness proof per behaviour change; mutation sweeps include call-site mutants plus a designed survivor and a not-applied control. | gridiron-evidence-citation-rule; gridiron-predicate-injection-test-rule |
| 8 | Name the table AND the writer function with file:line (`nfl_snaps` ≠ `player_week_snaps`; `syncDepthCharts` ≠ `syncDepthChart`). A zero/empty/success from a bespoke check needs a known-nonzero case first. | gridiron-name-the-table-rule; gridiron-contradiction-test-rule |
| 9 | One editor per file; findings in another thread's file are reported, not edited. Unallocated files need a grant first. | gridiron-file-allocation |
| 10 | Licence check (LICENSE, LICENSE.md, LICENSE.txt, COPYING × master/main/gh-pages + README) before measuring any external data; nothing paid ever without Nick's word; CC BY data is usable only once attribution is visible. | gridiron-licence-before-measurement-rule; gridiron-nflverse-cc-by-attribution |
| 11 | Missing data: free source first, then a labelled, held-out-validated estimate, and always log the gap to the coordinator. | gridiron-missing-data-workaround-rule |
| 12 | No secrets in repo/chat/logs (presence only; `leagues.espn_s2`/`swid` columns are cookies — never select them). No migrations, table drops or data deletion without Nick's word; never delete `/data/data.sqlite.pre-migration-*.bak`. | coach-env-dump-key-exposure-2026-09-22; gridiron-scheduler-cleared-of-delete-2026-09-22; brake-not-in-fly-toml |
| 13 | Nobody presses Deploy (#127 button) until Nick answers the brake question and says deploy; do not put nflverse depth on a timer (51 MB CSV OOMs the 2 GB machine). | gridiron-deploy-step-2026-09-22; brake-not-in-fly-toml; handoff/scheduler findings |
| 14 | Nav is 8 tabs; never rebuild a deleted page; UI held to the three design rules (plain-language stats, one stat vocabulary, not AI-looking). | gridiron-ui-redesign-build-order; gridiron-ui-redesign-approval-2026-09-20 |
| 15 | Nick's five questions (well built / stats or made up / how we know / pointed elsewhere / how it unifies) in every PR body; say "guess" when it is one. Fantasy-only scope; NOT APPROVED: multi-platform league import, offseason product, monetization, banning narrative features. | gridiron-five-questions-rule; PLAN-ITEMS-1-25.md |
| 16 | Usage: hard cap 25% of the 5-hour meter per window, pause at 20%; one fresh session at a time; restart fresh from the handoff after each unit; no subagent for a single API call; kill guard runs by PID (pkill -f misses npm children); never edit a shared guard script in place. | gridiron-usage-priority-rule; gridiron-restart-fresh-from-handoff-rule; handoff/fantasy-plan addendum |

## 5. Structure fix units (from ~/gridiron-local/STRUCTURE-MAP.md, 2026-09-22 ~20:10Z; cites on d6d7bd5a)

| ID | Goal | Files | Acceptance test | Deps / overlaps | AUD |
|---|---|---|---|---|---|
| **S-01** | One "this week" function for every week surface (Start/Sit, League Hub card, waiver board, TradeCard pill) | waiver-wire.js:97-128,196,266,285; trade-engine.js:2649-2654 (delete the copy, import one function); TradeCard.tsx:79 | Contract test: for every asset in a fixture universe, waiver `projected_ppg` === `lineupDiff` `week_points` === `startSitWeekPoints().week_points`. On 5 local leagues, 0 mismatches. `grep` shows one construction | lands after S-03 so the lift decision applies everywhere | yes |
| **S-02** | Pre-registered 4-arm grade of served weekly construction: ensemble / +coordinator / +vegasLift / +both, 2025 weeks 2-4 and 5-17 reported apart | study script + `docs/evidence/…/weekly-construction-grade.md` | Standard harness (fit ≤2024, 2025 once, player-clustered 90% CI); MAE, DNP-included MAE, start/sit pair accuracy; ship rule matchups.js:33-35 | **before W5 (Oct 8)**; define m0 jointly with WQ A-11 | PRE, yes |
| **S-03** | Apply S-02: coordinator refit on the ensemble residual or switched off; serve only a promoted fit; lift kept, shrunk or removed; label on surface | trade-engine.js:350-359; fantasy-coordinator.js:378-382; waiver-brain.js:162-185 | RED: coordinator fit on structural target applied to ensemble base fails. `activeFantasyCoordinatorFit` returns only a promoted id. Served W5 numbers equal the winning S-02 arm | S-02 | yes |
| **S-04** | Serve the validated role availability model; re-pick k on ≤2024 | migration for both availability tables (N9); scheduled off-thread fit job (scheduler.js); scripts/fit-availability.mjs:49,173 | `availabilityBasis().basis === 'role'` on the copy after the job. Count of 0.92-defaulted rows printed before/after. 2025 Q-row calibration with k chosen on ≤2024 | N9; RA #85 | yes |
| **S-05** | Season sim on the served projection world: 2026 games, weekly recency, rookies priced | season-sim.js:180,217,380 | RED: rookie-only starter scores > 0. All 38 local no-history rostered players get samples. Paired title odds before/after printed per league (local) | same file as WQ B-01/B-02: land after B-01 | yes |
| **S-06** | Ceiling tab on the served basis: league scoring, chance to play, OUT and season-ending filtered | ceiling-lineup.js:110,203-204 | RED: an OUT non-IR player is never in the ceiling lineup. Non-PPR fixture changes the mean. `active_probability` is passed | same file as WQ C-09: land with or after it | yes |
| **S-07** | Real horizons: "over the season" and "Projected X pts" on remaining league weeks and `ros_ppg` | trade-engine.js:119,415,1128; TradeCard.tsx:109; TradeLab.tsx:878; trades.js:1029 prompt | At W3, `season_delta` = weekly gain × remaining weeks from `leagueSchedule`. `proj` = `ros_ppg` × remaining games (byes counted). Test per league calendar | — | yes |
| **S-08** | One measured "higher projection is right" curve for Start/Sit and the League Hub card; fix the `confidence_basis` contradiction | lineup-brain.js:268-340,635,674; trade-engine.js:2695-2699; new scripts/fit-swap-sigma.mjs | PRE: re-derived on production `week_points`, 2025 held out. Both pages print the same % for the same gap (test). `confidence_basis` never says calibrated when `measured_on` says otherwise | precedes WQ C-10 (live rate) | PRE, yes |
| **S-09** | Retired signals out of Start/Sit reasons | player-case.js:102-122,163-179; football-context.js:60-67 (teammate probability from `weeklyAvailability`); players.js:156,201 (SOS fact) | While `matchupSignalActive()` is false: 0 `opponent` factors. Teammate-out probability equals contingency's. No SOS fact in the analyze prompt | — | yes |
| **S-10** | One trade-value store with a live writer; decide `value` vs `redraft_value` | aggregates.js:88-153; leagues.js:221,255-262 (read `dynasty_values` by league `formatKey`, or call `syncFantasyCalc` in league sync); players.js:140,151 | After one league sync on the copy, the Leagues-tab analysis has `values_missing = false` for 5 leagues. Test: Leagues tab and trade engine read the same number for one player. The `redraft_value` choice is cited to FantasyCalc's docs | — | yes |
| **S-11** | One needs/surplus definition | routes/tradelab.js:13,98-135; trade-engine.js:151,2516 (leagues.js after S-10) | 3-roster fixture: the same need and surplus on all three surfaces | S-10 | yes |
| **S-12** | Grade the number Nick sees: store served `week_points` (league scoring) next to ensemble `ppg` | weekly-learning.js:49-86 + migration column (N9) | Snapshot row carries both. Scoreboard prints both MAEs. RED: served ≠ ensemble for a lifted player | N9; separate from WQ B-17 (gate) | yes |
| **S-13** | Runbook route builds the weekly-engine configuration | routes/model.js:425-446 | RED: with a promoted volume k fixture the response changes. On current code it does not | — | no |
| **S-14** | Surface model provenance per player: fallback chip, coordinator correction, `ros_basis` | lineup-brain.js (pass `model_mode`); Lineup.tsx; WaiverWire.tsx; TradeCard.tsx | Local count of rostered players on `season_projection_fallback` printed per league. Each renders a "not our model" chip. The TradeCard pill shows the ROS basis | after S-03 | no |
| **S-15** | ROS validity past week 10: extend the gate to weeks 11-17 or label | study + ros-projection.js:69,364 | PRE: weeks 11-17 of 2024/2025 vs the incumbent. Otherwise `ros_basis.validated_through_week = 10` is rendered | **before W11** | PRE, yes |
| **S-16** | Posture spread refit on the served basis | lineup-posture.js:136; scripts/fit-posture-calibration.mjs | PRE: refit on lifted `week_points` with the current availability basis. Pre-set tolerance 0.10 vs 1.63. Commit the dataset hash | after S-03, S-04 | PRE, yes |
| **S-17** | Scoring leftovers beyond WQ A-07's list: floor/ceiling drawn in PPR while `ppg` uses league scoring | trade-engine.js:399 (`playerWeekDistribution` without `scoring`) | Non-PPR fixture: `floor`/`ceiling` move with scoring. Fold into A-07 if A-07 has not started | WQ A-07 | yes |
| **S-18** | Hand-fed fantasy tables: schedule the writer or say "no data" on the reading surface | bluff-detector.js:83; trade-engine.js:200-235,319 (`trending_players`); routes/model.js:516 (`correlation_estimates`) | Each reader returns a named empty state when its table has 0 rows. Test with an empty table plus a known-nonzero control | — | no |

Time-bound: S-02 then S-03 before week 5 (2026-10-08); S-15 before week 11; week-3 prediction snapshot captured before Thursday 2026-09-24 kickoff (watched via data-census.sh).

## 6. Sleeper-data units (unblocked by Nick 2026-09-22 ~20:10Z: "ignore - do it"; polite rate, aggregates only in the public repo)

| ID | Goal | Acceptance |
|---|---|---|
| MS-03 | Human trade value model, first test: Sleeper draft-pick pull (~84 min at 1 req/s), check whether preseason draft cost explains the +0.15 higher-scorer lead, then score acceptance predictions on the ~75 resolved local proposals | pre-registered; held-out season; placebo; no usernames committed |
| MS-04 | Decision-focused projections test: bench-points regret on the Sleeper roster-weeks, 2024-25 | pre-registered; vs MAE-trained incumbent; decision win rate |
| MS-05 | Crowd-attention timing signal: add/claim volume term in the trade regression, controlling for teammate injuries | pre-registered; interval; placebo |
| H-01 | Review and revive the 6 Sleeper-corpus hold branches (Team Outlook, playoff calibration): merge main, re-verify, land through the gate | each branch: liveness, structure skeptic, gate-merge |

## 7. Integration follow-ups (INT-<pr>-<n>, from integration intake; see INTEGRATION-PROCEDURE.md)

| ID | From PR | Goal | Files | Acceptance |
|---|---|---|---|---|
| INT-116-1 | #116 | Fix the stale "namespace import" blind-spot claim for `importersOfSymbol` now that #116 resolves `import * as ns` / dynamic namespace imports | `docs/tdd/symbol-reach.tdd.md` (137-141) | "What this does NOT settle" lists only re-export chain and computed property as blind spots for `importersOfSymbol`; does not touch `docs/tdd/wiring-map-namespace-imports.tdd.md` (different tool, unaffected by #116) |
| INT-128-1 | #128 | Remove or explicitly annotate the 13 stale `'MLB'` seed rows in `model-governance.js` for markets (`nrfi`, `pitcher_strikeouts`, `batter_total_bases`) whose model code #128 deleted | `server/services/model-governance.js` (CONTRACTS 24-33, registry seed 86-88), `test/model-integrity.test.js:1159` | `grep -c "'MLB'" server/services/model-governance.js` returns 0, or every remaining line carries a dated "kept for audit trail, models removed 2026-09-22" comment; `test/model-integrity.test.js`'s `featureContracts('MLB')` assertion updated to match whichever choice is made |
| R-08 | (local evidence) | Opening the app can freeze the server: with the scheduler OFF a request path blocked the event loop 66s and the watchdog killed it (evidence file local-scheduler-stall-2026-09-22.txt) | time every GET the first page load makes against a real-row DB copy (with and without a concurrent refresh writer); move heavy compute (season sim 1,500 runs, lineup objectives) off the request thread or cache it; busy_timeout interaction measured | RED: a test that fails when any first-load endpoint blocks > 2s on the fixture; every first-load endpoint p95 stated before/after |
| INT-94-1 | #94 | Commit a local-copy end-to-end check for the proposals route + ledger, adapted from the uncommitted `scratchpad/f05-fix/e2e-proposer.test.mjs` (per §9a of `docs/tdd/2026-09-22-trade-outcomes-landing.tdd.md`) | new e2e test under `test/` | Runs the real `GET /api/trades/:leagueId/proposals` against a `.backup` local copy; asserts `proposer_team_id` equals `leagues.my_team_id` for every ledger row (regression for the direction bug fixed at `cd444d78`); skips cleanly (not fails) when no local DB path is configured, so CI needs no DB |
| INT-150-1 | #150 | Run `scripts/backfill-formations.mjs` by hand — confirmed wired into no scheduler job or npm script (`git grep backfill-formations -- server/services/scheduler.js` and `package.json` both empty) | none (script exists); dated evidence file with before/after `nfl_play_formations` row counts | Local copy: 2022-2024 seasons loaded now (2025 already done, `docs/tdd/2026-09-22-formations-404-skip.tdd.md` §5), row counts printed before/after. Production: run only after the deploy ships this tip AND F-08 lands the CC BY-SA "FTN Data via nflverse" / "NFL NextGenStats via nflverse" credit line — standing rule 10; the TDD doc itself names this as the blocking condition (§2, §8) |
| INT-150-2 | #150 | Team-vector re-freeze for formations: bump `WEEKLY_FEATURE_STORE_VERSION`, then re-freeze completed-season vectors only, per the exact 3-step command already written in `docs/tdd/2026-09-22-formations-404-skip.tdd.md` §6 | `server/services/nfl-weekly-feature-store.js:12`, PR body with Auditor sign-off | Pre-registered with the Independent Auditor first (standing rule 2 — a version bump changes model inputs for every reader); depends on INT-150-1 loading 2022-2024 first; re-freeze never touches the in-season year (the look-ahead bug already fixed at TDD §10.2); before/after `formation_`-key counts on newly frozen vectors printed and cited in the PR body |
| INT-149-1 | #149 | Wake the Fly app before ssh: the workflow fails whenever the machine has auto-stopped | `.github/workflows/fly-preflight.yml` | RED: run `35786657095` (2026-09-22T21:26:28Z) failed `Error: app gridiron-hq has no started VMs` with no wake step in the workflow; run `35788776774` (21:48:08Z) only passed because the coordinator manually hit the site first. GREEN: an HTTP GET retry loop against `https://gridiron-hq.fly.dev/api/health` runs before `flyctl ssh console`, and a preflight dispatched against a fully-stopped machine succeeds unattended |
| INT-154-1 | #154 | Backfill S-02's already-computed 2025 holdout looks into `HOLDOUT-LEDGER.md`, and point new statistical units (S-03, A-11, HX-01, RL-1-*, BLEND-01) at `STATS-METHOD.md`/`HOLDOUT-LEDGER.md` going forward — nothing on origin/main cites either file today | `docs/evidence/HOLDOUT-LEDGER.md`; `docs/evidence/2026-09-22/weekly-construction-grade.md` §10 (source rows to migrate) | `HOLDOUT-LEDGER.md` row count grows by S-02's looks (arms A-S3, both windows, m0); `git grep -rn "HOLDOUT-LEDGER.md" -- . \| grep -v docs/evidence/HOLDOUT-LEDGER.md` returns ≥1 hit (0 today; known-nonzero control: the same-style grep for `mass_test_harness` returns 3) |
| INT-155-1 | #155 | Correct S-03's acceptance test in WORK-QUEUE.md §5: it reads "Served W5 numbers equal the winning S-02 arm," but S-02's own report (`weekly-construction-grade.md` "Read this first"; amendment-1 §4) says the pre-availability MAE ranking can flip once availability × lift multiply in, and forbids shipping S1 on that basis alone | `WORK-QUEUE.md` §5 (S-03 row) | S-03's acceptance text reads "graded on the served (post-availability, post-lift) chain, run jointly with S-04 and A-11" in place of "equal the winning S-02 arm"; cites `weekly-construction-grade.md` |
| INT-156-1 | #156 | Surface `model_context.hand_fed` (trending_players / correlation_estimates named state, trade-engine.js:508) in the UI — served on 4 routes (trades.js:871, league-brain.js:302, trade-engine.js:1818/2220/2462) but read by no client file today, so an empty hand-fed table still renders like a measured football fact | `client/src/pages/TradeLab.tsx` or `client/src/components/TradeCard.tsx` | RED: TradeLab.tsx renders identically whether `model_context.hand_fed.trending_players.state` is `fresh` or `empty`; GREEN: a caveat chip distinguishes "nothing fetched" from "not trending" / default correlation when state is `empty` or `table_absent` |
| INT-157-1 | #157 | Add a CC BY-SA 3.0 credit for Wikipedia content already wired live (`server/routes/accolades.js` → `player_accolades` → `client/src/pages/TeamDetail.tsx:195`, `/teams/:abbr`) but absent from `DATA_CREDITS` and the freshness `sources` list; 0 `player_accolades` rows on the local copy today, so land before/when it starts populating | `client/src/components/DataFreshnessBanner.tsx` (`DATA_CREDITS`); `server/routes/accolades.js` (licence doc-comment) | A Wikipedia CC BY-SA 3.0 credit renders on `/teams/:abbr` when `player_accolades` has any `wikipedia+espn` row; test fixture with one such row |
| INT-158-1 | #158 | One producer owns `news_items.published_at` for ESPN stories (already named F-R07-1 in `docs/tdd/2026-09-22-news-published-at-timezone.tdd.md` §8.2a): `insertArticles` (espn.js:174) and the RSS writer both write it and cannot see each other's dedupe key; 7 duplicate story-pairs on the local copy, one listed twice on the news desk | `server/routes/espn.js`; `server/news/ingest.js` or `store.js` (shared dedupe key) | RED: the 7-pair local-copy fixture collapses to 0 duplicate desk entries after one producer's write wins by a documented rule |
| INT-158-2 | #158 | Fix the `fresh_24h` text-vs-time comparison bug (`routes/news.js:89`, `nfl-diagnostic.js:21`): ISO text compared against a space-separated `datetime('now','-24 hours')` string reads any same-calendar-day story as fresh regardless of time — 268 as served vs 146 by `julianday` on the local copy at 2026-09-22T20:21:58Z (already measured in the R-07 TDD doc §8.3) | `server/routes/news.js:89`; `server/services/nfl-diagnostic.js:21` | RED: a story 23h old on yesterday's calendar date (>24h by julianday) reads fresh under text compare, not-fresh after switching to julianday; served `fresh_24h` matches the julianday count (146) on the local copy |
| INT-158-3 | #158 | Nick's word + backfill the ~161-196 historical daylight-time ESPN RSS rows (`published_at − 60 min`, bounded rule already derived in the R-07 TDD doc §8.1), then re-check numbers spanning the contaminated window: `nfl-news-signal.js:215` copies `news_items.published_at` into `nfl_news_signals` verbatim, read by `signal-latency.js` (C16's betting basis) and `nfl-news-market-latency.js`; `news-fantasy-impact.js:75` keys `nextTeamGame` off it directly | none until Nick decides; then a one-off UPDATE script + a note wherever signal-latency / nfl-news-market-latency / news-fantasy-impact next cite pre-2026-09-22 daylight-period data | Nick's go/no-go recorded; if go, UPDATE applied only to `source='ESPN' AND source_type='publisher'` rows stamped in daylight time, row count before/after printed on a local copy; if no-go, the contaminated window is named wherever those three files' numbers are next reported |

## 8. Blocker-lab units (from BLOCKER-LAB.md, 2026-09-22 ~5:00 PM ET)

| ID | Goal | Size | Deps |
|---|---|---|---|
| BL-01 | `nfl_model_growth` budget 45 min (worker) + close killed runs; review `nfl_reports` | ~1 h | — |
| BL-02 | `nflverse_weekly_usage` + `nflverse_snap_counts` on the refresh loop list | ~45 min | — |
| BL-03 | Usage freshness rule "last completed week present", on #104's live rule (+ optional BL-03b fallback on main) | ~1 h | #96 → #104 |
| BL-05 | Settle played-no-stat as 0; DNP pending with a reason | ~1 h | — |
| BL-20 | Settle expired / countered / league review from the rows #94 reads. **Integration intake 2026-09-22 (#94):** `settleObservedOutcomes` still has zero production callers by design (`docs/tdd/2026-09-22-trade-outcomes-landing.tdd.md:187-196`) pending F-06 + N1. Nick's decision that the Mac collector (`scripts/collect-league-transactions.mjs`, already running every 15 min in the Mac refresh loop, `BLOCKER-LAB.md:82`) is the system of record for trade outcomes was **not previously captured here** — it means this unit's caller belongs in the Mac-side refresh loop, not Fly/production, and that N1 is effectively closed for the local path. F-06's derivation was already proven informally on 62 real rows in Blocker-Lab §2.1; still needs a committed evidence file (F-06 unchanged) | ~2-3 h | F-05 (#94) |
| BL-40 | Coach 4th-down GOE as a display-only "why" trait | ~4-6 h | A-14 |
| BL-50 | Resolve rule-extracted availability claims vs next-game snaps, weekly | ~4 h | — |
| BL-51 | Permutation guard in the person-profile grader | ~1-2 h | before N6 |
| R-09 | (refresh loop) | The refresh loop's first tick races its own startup migration: at 21:14:23Z six jobs threw "sync_log has no column named consecutive_failures" while migrations 062-070 finished at 21:14:29Z (backup data.sqlite.pre-migration-2026-09-22T21-14-23-987Z.bak) | scripts/refresh-live-data.mjs, server/db/index.js | RED: first tick on a DB missing a migration waits for migrations before running jobs; no job throws on a column added by a pending migration |

## 10. Cloud vs local split (for parallel cloud builds)

Skipped (already merged/done/in flight, per WORKLOG.jsonl + coordinator note): **F-01, F-05, F-09, F-10, F-15, R-02, INT-116-1, INT-149-1**. Everything below is every remaining row in §3 and §5-8, one row per unit ID.

CLOUD = fresh clone + fixtures + free nflverse downloads only, nothing on this Mac. CLOUD-DATA = a statistical/lift-proof unit that only needs nflverse data (downloadable in the cloud), so it's cloud-buildable but slower. LOCAL = acceptance test or build needs the local `data.sqlite` copy, Nick's 5 real ESPN league payloads, real league/Sleeper transactions or chat corpus, or production timing.


### Foundation close

| ID | Class | Reason | Overlaps |
|---|---|---|---|
| F-02 | LOCAL | stall re-measure needs timing on a real-row local DB copy | — |
| F-03 | CLOUD | watchdog naming fix, RED/GREEN on fixture job | — |
| F-04 | CLOUD | scheduler merge-conflict resolution, fixture tests only | services/scheduler.js w/ A-23,B-17 |
| F-06 | LOCAL | derives outcomes from local copy's 1,466 real transactions | — |
| F-07 | CLOUD | rebase/land PR stack; CI+guard, no data dependency | counterparty-pricing.js w/ B-10,B-11,D-11; routes/trades.js w/ A-07,B-01,B-10; trade-tactics.js w/ B-14 |
| F-08 | CLOUD | credit-line banner, tested via freshness API fixture | — |
| F-11 | CLOUD | inline bare-import fixture on the public repo tree | — |
| F-12 | CLOUD | mutant-killing test against repo's own committed tree | — |
| F-13 | CLOUD | wiring-map fixture DB (second sqlite handle), no real data | — |
| F-14 | CLOUD | doc correction from command output on public tree | — |
| F-16 | CLOUD | runbook doc compiled from known merges/migrations | — |

### Phase A

| ID | Class | Reason | Overlaps |
|---|---|---|---|
| A-01 | LOCAL | needs the 5 real ESPN league payloads (leagues.payload) | routes/leagues.js w/ A-05 |
| A-02 | LOCAL | run on 5 local leagues, printed as counts | services/league-config-verification.js w/ A-04 |
| A-03 | LOCAL | 0 unmapped stat ids checked on the 5 local payloads | — |
| A-04 | LOCAL | recomputed points vs ESPN's on local rostered player-weeks | services/league-config-verification.js w/ A-02 |
| A-05 | LOCAL | 5 local leagues' format keys checked against settings | routes/leagues.js w/ A-01 |
| A-06 | CLOUD | RED via fixture missing mSettings, no real league needed | services/league-history.js w/ D-03 |
| A-07 | CLOUD | RED via non-PPR league fixture | routes/trades.js w/ B-01,B-10,F-07; services/title-odds-trades.js w/ B-01 |
| A-08 | CLOUD | land PR #74, merge/guard/v2 body only | trade-engine.js w/ B-13,B-15,C-08,C-18 |
| A-09 | CLOUD | snapshot test of existing keys + known figure | — |
| A-10 | CLOUD | config marker fix, fixture RED on blind-audit call | — |
| A-11 | CLOUD-DATA | ensemble refit vs held-out 2025, nflverse player-week stats | — |
| A-12 | CLOUD-DATA | target-share x practice-participation study, nflverse data | — |
| A-13 | CLOUD-DATA | officials/schedules ingest, public nflverse-data release | services/nflverse.js w/ D-10 |
| A-14 | LOCAL | go-rate non-null check explicitly run on the local copy | — |
| A-15 | CLOUD-DATA | lift-proof study, nflverse pbp + opp-adj-def-epa | — |
| A-16 | CLOUD-DATA | pace/play-volume lift proof, nflverse pbp | — |
| A-17 | CLOUD-DATA | FTN charting persistence, public via nflverse release | — |
| A-18 | CLOUD-DATA | charting matchup arm, same public charting data as A-17 | services/matchups.js w/ C-16 |
| A-19 | CLOUD-DATA | ESPN QBR re-run, public via nflverse | projections.js w/ A-20,C-14 |
| A-20 | CLOUD-DATA | yards-per split fit vs served prior, nflverse stats | projections.js w/ A-19,C-14 |
| A-21 | CLOUD-DATA | verdict ledger compiling A-15..A-20 + public depth-chart re-run | — |
| A-22 | CLOUD | fixture RED: traded-player claim vs claim-time team | services/beat-reporter-accuracy.js w/ A-24,A-26 |
| A-23 | CLOUD | scheduler job registration/wiring | services/scheduler.js w/ B-17,F-04 |
| A-24 | LOCAL | backfills from already-ingested local news_items corpus | services/beat-reporter-accuracy.js w/ A-22,A-26 |
| A-25 | CLOUD | ranking fixture RED (real trust scores come from A-24, local) | — |
| A-26 | CLOUD | fixture RED for transaction-claim resolver | services/beat-reporter-accuracy.js w/ A-22,A-24 |

### Phase B

| ID | Class | Reason | Overlaps |
|---|---|---|---|
| B-01 | CLOUD | RED via week-6/5-0-team fixture league | TradeCard.tsx w/ B-03; routes/trades.js w/ A-07,B-10,F-07; services/title-odds-trades.js w/ A-07 |
| B-02 | LOCAL | Brier of playoff odds measured on real league history | — |
| B-03 | CLOUD | paired-seed delta UI/code (needs B-02's local sim engine) | TradeCard.tsx w/ B-01; waiver-wire.js w/ B-04,B-05,B-06,B-09,C-18 |
| B-04 | CLOUD-DATA | K/DST MAE vs baseline, nflverse weekly stats | waiver-wire.js w/ B-03,B-05,B-06,B-09,C-18 |
| B-05 | LOCAL | claim-priority ranking from real league churn/local transactions | waiver-wire.js w/ B-03,B-04,B-06,B-09,C-18 |
| B-06 | CLOUD-DATA | EV from measured backup production (nflverse usage) + replay | waiver-wire.js w/ B-03,B-04,B-05,B-09,C-18 |
| B-07 | CLOUD | land PR #67, merge/guard/v2 body only | — |
| B-08 | LOCAL | season sims vs sharp policy run on real league history | — |
| B-09 | CLOUD-DATA | denial value from opponent projections, nflverse-derived | waiver-wire.js w/ B-03,B-04,B-05,B-06,C-18 |
| B-10 | LOCAL | real n / source count from Nick's manager profiles | counterparty-pricing.js w/ B-11,D-11,F-07; routes/trades.js w/ A-07,B-01,F-07; trade-acceptance.js w/ B-11 |
| B-11 | LOCAL | fit on local transactions; needs real outcomes | counterparty-pricing.js w/ B-10,D-11,F-07; trade-acceptance.js w/ B-10 |
| B-12 | LOCAL | fresh run of manager reads needs real league chat/signal data | manager-archetypes.js w/ D-03,D-09; manager-signals.js w/ D-11 |
| B-13 | CLOUD | land PR stack (#57->#64,#60), merge/guard/v2 only | trade-engine.js w/ A-08,B-15,C-08,C-18 |
| B-14 | LOCAL | timingRead needs real trade-timing history (n shown) | trade-tactics.js w/ F-07 |
| B-15 | CLOUD-DATA | buy-low mean-reversion study on nflverse player performance | trade-engine.js w/ A-08,B-13,C-08,C-18 |
| B-16 | CLOUD | 3-roster fixture unit tests | — |
| B-17 | CLOUD | scheduler calendar wiring, mocked job list | services/scheduler.js w/ A-23,F-04 |
| B-18 | CLOUD | web push/pivot logic, fixture player status | lineup-brain.js w/ C-10,C-18 |

### Phase C

| ID | Class | Reason | Overlaps |
|---|---|---|---|
| C-01 | CLOUD-DATA | as-of replay vs dumb rule, nflverse weekly stats | — |
| C-02 | LOCAL | 'our claims' = real waiver-claim history | — |
| C-03 | LOCAL | replays local trade_proposal_cache (real proposals) | — |
| C-04 | CLOUD | fixture RED on projection-cutoff bug (live tracking is a caveat) | — |
| C-05 | LOCAL | expected vs actual wins for Nick's actual league standings | — |
| C-06 | LOCAL | needs local news_items event corpus for matched controls | — |
| C-07 | LOCAL | measures live/local pipeline ingest-to-notify latency | — |
| C-08 | LOCAL | persists real considered-vs-proposed trade rows | trade-engine.js w/ A-08,B-13,B-15,C-18 |
| C-09 | CLOUD | fixture RED: ceiling target moves with the pool | — |
| C-10 | LOCAL | live decision-win-rate needs real tracked usage | lineup-brain.js w/ B-18,C-18 |
| C-11 | CLOUD | PR close/keep decision + guard/v2 | — |
| C-12 | CLOUD | UI: land design-system PR, token tests | index.css w/ D-12 |
| C-13 | CLOUD | UI: basis chip + glossary, fixture tests | — |
| C-14 | CLOUD-DATA | calibration walk-forward on held-out weekly stats | projections.js w/ A-19,A-20 |
| C-15 | CLOUD | UI: stat block renders served range | — |
| C-16 | CLOUD | UI: deep-dive drawer, basis chips | services/matchups.js w/ A-18 |
| C-17 | CLOUD | Coach panel UI wiring to existing API | — |
| C-18 | CLOUD | contract/fixture test: every rec has a traceable why | lineup-brain.js w/ B-18,C-10; trade-engine.js w/ A-08,B-13,B-15,C-08; waiver-wire.js w/ B-03,B-04,B-05,B-06,B-09 |
| C-19 | CLOUD | fantasy page-explain tool swap, mocked tools | — |
| C-20 | CLOUD | land PRs + label seed data (docs/code) | — |

### Phase D

| ID | Class | Reason | Overlaps |
|---|---|---|---|
| D-01 | CLOUD | land #96->#104, guard/v2 | — |
| D-02 | CLOUD | land scheduler PRs, guard/v2 each | — |
| D-03 | CLOUD | land manager-archetypes/league-history PRs + evidence doc | manager-archetypes.js w/ B-12,D-09; services/league-history.js w/ A-06 |
| D-04 | CLOUD | fixture RED: optional-source retry note | nfl-model-growth.js w/ D-06 |
| D-05 | CLOUD | fixture RED: failing weekly-fit re-read demoted | — |
| D-06 | CLOUD | static call-reach trace via wiring-map tooling | nfl-model-growth.js w/ D-04 |
| D-07 | CLOUD | fixture RED: failing source alerts within one cycle | — |
| D-08 | CLOUD | land PR batch (#50,#66,#45,#15,#39), guard/v2 each | — |
| D-09 | LOCAL | chat-sync data-quality findings on Nick's real leagues | manager-archetypes.js w/ B-12,D-03 |
| D-10 | CLOUD-DATA | reconcile two nflverse-derived snap-count ingests | services/nflverse.js w/ A-13 |
| D-11 | LOCAL | leave-one-league-out needs Nick's multiple real leagues | counterparty-pricing.js w/ B-10,B-11,F-07; manager-signals.js w/ B-12 |
| D-12 | CLOUD | phone-first UI audit/fixes with fixture data | index.css w/ C-12 |
| D-13 | CLOUD | competitive teardown doc from public pricing pages | — |
| D-14 | CLOUD | kill-list doc from code inspection | — |

### Structure fixes (S-xx)

| ID | Class | Reason | Overlaps |
|---|---|---|---|
| S-01 | LOCAL | 0 mismatches required across the 5 local leagues | — |
| S-02 | LOCAL | Nick: week-5-deadline weekly-construction grade is LOCAL | — |
| S-03 | LOCAL | Nick: applies S-02's LOCAL result; served W5 numbers | — |
| S-04 | LOCAL | checked 'on the copy'; k re-pick needs real availability rows | — |
| S-05 | LOCAL | '38 local no-history rostered players'; paired odds per local league | — |
| S-06 | CLOUD | fixture RED: OUT/non-PPR player filtering | — |
| S-07 | CLOUD | per-league-calendar fixture test (byes counted) | — |
| S-08 | CLOUD-DATA | refit on production week_points vs held-out 2025 (as-served stats) | — |
| S-09 | CLOUD | contract/fixture test on retired signals | — |
| S-10 | LOCAL | 'after one league sync on the copy... 5 leagues' | — |
| S-11 | CLOUD | 3-roster fixture test (needs S-10's local store for full use) | — |
| S-12 | CLOUD | fixture RED: served != ensemble for a lifted player | — |
| S-13 | CLOUD | fixture RED: promoted volume-k changes response | — |
| S-14 | LOCAL | 'local count of rostered players... per league' | — |
| S-15 | CLOUD-DATA | ROS-validity study on 2024/2025 nflverse outcomes | — |
| S-16 | CLOUD-DATA | posture refit vs lifted week_points, nflverse-derived | — |
| S-17 | CLOUD | non-PPR fixture: floor/ceiling move with scoring | — |
| S-18 | CLOUD | empty-table named-state fixture test | — |

### Sleeper-data

| ID | Class | Reason | Overlaps |
|---|---|---|---|
| MS-03 | LOCAL | Sleeper draft-pick pull + ~75 resolved local proposals | — |
| MS-04 | LOCAL | operates on Sleeper roster-weeks corpus (local, not public) | — |
| MS-05 | LOCAL | Sleeper add/claim-volume corpus (local) | — |
| H-01 | LOCAL | revives 6 Sleeper-corpus hold branches | — |

### Integration follow-ups

| ID | Class | Reason | Overlaps |
|---|---|---|---|
| INT-128-1 | CLOUD | grep-based MLB seed-row cleanup + test, public repo only | — |
| R-08 | LOCAL | times real GETs against a real-row local DB copy | — |
| INT-94-1 | LOCAL | full e2e run needs a .backup local copy (skips cleanly w/o it) | docs/tdd/2026-09-22-trade-outcomes-landing.tdd.md w/ BL-20 |
| INT-150-1 | LOCAL | loads 2022-2024 into the local copy, prints row counts | docs/tdd/2026-09-22-formations-404-skip.tdd.md w/ INT-150-2 |
| INT-150-2 | LOCAL | re-freezes vectors built from INT-150-1's local load | docs/tdd/2026-09-22-formations-404-skip.tdd.md w/ INT-150-1 |

### Blocker-lab

| ID | Class | Reason | Overlaps |
|---|---|---|---|
| BL-01 | CLOUD | job-budget + close-killed-run logic, mockable long-running job | — |
| BL-02 | CLOUD-DATA | adds nflverse weekly-usage/snap sources to refresh loop | — |
| BL-03 | CLOUD | freshness-rule fixture: last completed week present | — |
| BL-05 | CLOUD | played-no-stat=0 fixture fix | — |
| BL-20 | LOCAL | settles real observed outcomes from local transactions | docs/tdd/2026-09-22-trade-outcomes-landing.tdd.md w/ INT-94-1 |
| BL-40 | CLOUD | display-only trait wired from precomputed go-rate value | — |
| BL-50 | LOCAL | resolves claims from local news_items corpus vs snaps | — |
| BL-51 | CLOUD | permutation-guard code, testable with synthetic fixtures pre-N6 | — |
| R-09 | CLOUD | migration-race fix, testable on a fresh temp DB | — |
### Suggested cloud batch order (3 disjoint units per batch, most valuable first)

Foundation close first, then Phase A, then structure fixes S-xx, then UI (Phase C UI steps + D-12), then the rest. Each batch's 3 units touch no common file, so 3 cloud agents can run them at once. S-02/S-03 and all other LOCAL units are not in this list — they run on the Mac. Batches are sequential; only within-batch file overlap was checked.

| Batch | Units |
|---|---|
| 1 | F-03, F-04, F-07 |
| 2 | F-08, F-11, F-12 |
| 3 | F-13, F-14, F-16 |
| 4 | A-06, A-07, A-08 |
| 5 | A-09, A-10, A-11 |
| 6 | A-12, A-13, A-15 |
| 7 | A-16, A-17, A-18 |
| 8 | A-19, A-21, A-22 |
| 9 | A-20, A-23, A-25 |
| 10 | A-26, S-06, S-07 |
| 11 | S-08, S-09, S-11 |
| 12 | S-12, S-13, S-15 |
| 13 | S-16, S-17, S-18 |
| 14 | C-12, C-13, C-15 |
| 15 | C-16, C-17, C-18 |
| 16 | C-19, C-20, D-12 |
| 17 | B-01, B-04, B-07 |
| 18 | B-03, B-13, B-16 |
| 19 | B-06, B-15, B-17 |
| 20 | B-09, B-18, C-01 |
| 21 | C-04, C-09, C-11 |
| 22 | C-14, D-01, D-02 |
| 23 | D-03, D-04, D-05 |
| 24 | D-06, D-07, D-08 |
| 25 | D-10, D-13, D-14 |
| 26 | BL-01, BL-02, BL-03 |
| 27 | BL-05, BL-40, BL-51 |
| 28 | R-09, INT-128-1 |

## 11. Synergy review units (2026-09-22 ~6:30 PM ET, across #118 #146 #128 #116 #149 #94 #150; verified; full JSON ~/gridiron-local/synergy-2026-09-22.json)

| ID | Priority | Goal | Files | Acceptance |
|---|---|---|---|---|
| SY-01 | soon | One accept/decline rule for every reader: export the answer-matching rule from trade-outcomes.js; manager-signals txSignals uses it and stops double-counting proposer-side TRADE_ACCEPT rows (L4 roster 10 credited with 2 accepts it never made: served 45% of 11) | trade-outcomes.js, manager-signals.js:183-236 (selfRead/timingRead call the helper; catches left to #100) | fixture with an unmatched answer and a proposer-side accept gives the same n everywhere; local 6-manager table printed; NICK DECIDED (2026-09-22 6:32 PM ET, "no"): answers to proposals the collector never saw do NOT count; only answers linked to a known offer; rate withheld under 5 offers |
| SY-02 | soon | Rams stored as both LA and LAR in the team-week table (33 teams/season) that Start/Sit coaching traits read | nfl-pbp.js writer (canonicalTeamCode), reconcile at nfl-advanced.js:463 | RED: an 'LA' pbp row lands as LAR; 32 teams per season after re-ingest on a copy |
| SY-03 | later | Link an app-suggested trade to the ESPN offer Nick actually sent (the ledger can't score a prediction today) and label predictions with the acceptance model's version | trade-outcomes.js, trade-acceptance.js | fixture: suggested then sent then declined yields one scored row with model_p_accept |
| SY-04 | later | Fix formation features before any re-freeze: empty/singleback shares read 0 after 2022; shotgun share divides by special-teams rows (17 pts off PBP) | nfl-formations.js (~160), feature builder | features match PBP-derived shares within 1 pt on 2023-2025; BLOCKS INT-150-2 |
| SY-05 | later | Study copy of the feature store (v2) lacks #150's look-ahead fix (0 affected rows today) | nfl-weekly-feature-store-v2.js:624-639 | note in v2 or port the bound; no served change |
| SY-06 | later | Finish MLB removal leftovers: 4 dead MLB exports in odds-api.js, decision inbox still accepts 'MLB', MLB prop routes mounted with no page | odds-api.js, decision-inbox, routes | grep shows no live MLB path; tests updated |
| SY-07 | soon | Queue and deploy facts #94 changed: C-04/C-08/C17/N9 rows describe the pre-#94 world; deploy checklist must list 067 | WORK-QUEUE.md, docs/runbooks | rows updated (docs) |

### 10b. Cloud vs local for section 11 (SY units), classified 2026-09-22 6:35 PM ET

| ID | Class | Reason | Overlaps |
|---|---|---|---|
| SY-01 | CLOUD + local check | code + fixture tests (trade-outcomes.js, manager-signals.js); the 6-manager table on the local copy is printed at intake, locally | B-10, B-11, BL-20, F-07 (#100 touches counterparty-pricing selfRead): land after F-07 |
| SY-02 | CLOUD + local check | writer fix in nfl-pbp.js with a fixture; the re-ingest (32 teams per season) is verified on the local copy at intake | A-14 (football-context.js reads the team-week table) |
| SY-03 | CLOUD | fixture-tested ledger linking in trade-outcomes.js / trade-acceptance.js | SY-01 (same file): land after it |
| SY-04 | CLOUD-DATA | needs nflverse participation CSVs (free download) to check shares against play-by-play | INT-150-2 (blocked by this), A-17, A-18 |
| SY-05 | CLOUD | note or port in nfl-weekly-feature-store-v2.js; no served change | none |
| SY-06 | CLOUD | dead-export removal + decision-inbox validation + route unmount, fixture tests | INT-128-1 (model governance, cloud pilot running): disjoint files |
| SY-07 | LOCAL | edits the queue and runbook on the handoff branch (the coordinator does it) | none |

Suggested cloud batch for these: SY-02 + SY-05 + SY-06 (disjoint). SY-01 then SY-03 after F-07 lands. SY-04 in a data-capable cloud batch.

## 9. R&D loop units

| RL-id | plan item | goal | files | acceptance | validity verdict |
|---|---|---|---|---|---|
| RL-1-1 | C12 (C-01), C18 (C-10), S-02/S-03 (before W5 2026-10-08), D24; the plan's own never-run Phase-2 consensus gate (FANTASY-ENGINE-MASTER-PLAN.md:847-851) | Record ESPN's weekly projection at the same cutoff as our snapshot, and grade our start/sit order against it on /lineup. Benchmark only; no blending. | server/migrations/071_weekly_snapshot_espn_projection.js; server/services/espn-weekly-projection.js; server/services/weekly-learning.js; server/services/start-sit-pairs.js; server/services/consensus-gate.js; server/routes/trades.js:215-221; client/src/pages/Lineup.tsx; test/consensus-gate.test.js | RED tests a-f: capture writes espn_proj on skill rows only; disagreeing leagues null out; blocked capture writes nothing; gate verdict logic (espn_ahead/ours_ahead/not_distinguishable/insufficient); /lineup carries consensus_gate; existing early-week-blend test stays green | fixable |
| RL-1-2 | S-15 / M10 (ROS validity past week 10, due before W11 2026-11-19), S-07, B-06, B-15 | Test a weekly consensus (FantasyPros) prior for rest-of-season values as a new candidate (c_live), and serve it only if a pre-registered forward gate on 2025 passes; keep it a study-only candidate if Nick declines serving FantasyPros-derived numbers | server/services/historical-adp.js; server/services/historical-adp-scrapes.js; server/services/ros-projection.js; server/services/preseason-model.js:361; scripts/fit-ros-live-prior.mjs; scripts/fit-ros-projection.mjs; test/ros-live-prior.test.js | RED tests T1-T6 (priorFor fallback chain, cutoff join, source filter, prior_source label, default structures unchanged, HALF_PPR exclusion); statistical gate PASS requires weeks 6-14 CI excludes 0 and weeks 1-4/11-14 not worse with significance | fixable |
| RL-1-3 | S-08 (one start/sit confidence curve) / C-10; page /lineup | Make the Start/Sit "higher projection has won about X%" line print the win rate for that gap's own band, not the rate for that gap and every bigger gap (a tail rate mislabeled as a band rate) | server/services/lineup-brain.js:251-340,583-679; test/start-sit-decision-curve.test.js; docs/tdd/sweeps/start-sit-decision-curve.mutations.json; docs/evidence/2026-09-22/start-sit-decision-curve.md | RED tests a-d: decisionWinRate returns band rates not tail rates at 8 sample gaps; existing margin fixture matches new band wording; full band table matches evidence file at all points; CLEAR_THRESHOLD moves to 9.0; mutation M14 (reverting to tail values) must fail the tests | fixable |
| RL-1-4 | S-15 (rest-of-season prior) / B-06; also corrects BLOCKER-LAB 2.3 and WQ D-08 (#50) | Label, floor at zero, and freeze this season's ESPN market-based player ranking now (766 of 910 skill players share a near-identical placeholder rank today), then decide later via a pre-registered forward grade whether to reorder that block using ESPN's own unused rank field | server/services/preseason-model.js:328-357,675-686; server/services/ros-projection.js:321-386; server/services/trade-engine.js:459-462; server/services/espn-market.js:45-50; test/preseason-model.test.js; test/ros-projection.test.js; scripts/grade-espn-board-order.mjs; docs/evidence/2026-09-2x/espn-board-order-preregistration.md | RED tests a-f: placeholder rows labeled distinctly; alternate ordering option available and matches on drafted players; curve values never go negative; prior_rank_basis passed through; a rewritten market snapshot after kickoff keeps the original ranks; ties break consistently | fixable |

## 12. Coordinator grants and rulings log

| When (ET) | Unit | Grant / ruling | Why |
|---|---|---|---|
| 2026-09-22 7:12 PM | C-01 | GRANT: C-01 may edit `scripts/refresh-live-data.mjs` (add the `start_sit_gate` job at :71) and `test/refresh-loop-steps.test.js` (G7 at :307-315), commits ad66dae7 and 05ceb070 | the gate job must run where the fantasy jobs actually run (the refresh loop), and the file has no other editor today; R-09 (same file) lands after C-01 |
| 2026-09-22 7:12 PM | C-01 | Independent Auditor ruling requested on the gating rule: the season-average stand-in says "beats", while the plan's literal rule ("start highest projection", ESPN's projection) says "dumb ahead" in 2026 W2 (win rate 0.378, n 286, -3.42 pts/decision, CI [-6.52, -0.36]) | the pre-registration forbids swapping the gating rule after the fact, so only an independent ruling can settle it |
| INT-153-1 | #153 | Stale seed-count comments after #153: test/wiring-map-deferred-edges.test.js:11-12 says 32/11 rows and ~59 says 43; now 22/8 and 30 | test/wiring-map-deferred-edges.test.js | comments match the seed (docs-only; CI) |

## 13. Historical head-to-head (Nick 2026-09-22 7:20 PM ET: "we should've been testing on historical data")

| ID | Item | Goal | Files | Acceptance |
|---|---|---|---|---|
| HX-01 | C12 / C18 / S-03 | Historical head-to-head: our SERVED weekly model (as-of replay, walk-forward: each graded season uses fits that end before it, configuration B) vs public consensus projections (FantasyPros ECR archive 2021-2024 already pulled by the R&D loop; Sleeper/RotoWire weekly projections by season if retrievable; ESPN past-season projections for Nick's leagues only through the app's own ESPN client) and vs the dumb rules (season average, last-3) | study script + reusable "consensus arm" function the C-01 gate and S-03 call; docs/evidence | pre-registered; same-position start/sit pair accuracy, decision win rate, points per decision, player-clustered 90% CI; by position and week band (2-4, 5-8, 9-13, 14-18); 2025 NOT used (used-up holdout, S-00 ledger); 2026 weeks played reported as forward; MDE stated; headline answers "did our model ever beat consensus, where, by how much" |
| 2026-09-22 7:32 PM | C-01 | GRANT: C-01 may add its route mount to `server/index.js` (+4 lines, owned by Scheduler per gridiron-file-allocation.md:14; no other edit) | Independent Auditor ruling (d), audits/2026-09-22-C-01-ruling.md |
| 2026-09-22 7:32 PM | C-01 | RULING filed (Independent Auditor): C12 gates on the plan rule (served vs ESPN weekly projection); green headline replaced by amber "Not shown to beat ESPN's projection"; average verdict kept as average_check; addendum 2 pre-registration due before 2026-09-25 00:15Z (week-3 kickoff); acceptance A1-A9 | audits/2026-09-22-C-01-ruling.md |

## 14. Queued behind HX-01 (Nick 2026-09-22 ~7:55 PM ET: "okay, go")

| ID | Starts when | Goal | Acceptance |
|---|---|---|---|
| HX-02 | HX-01 verified | Gap attribution: every pair where consensus was right and we were wrong (2022-2024 replay rows from HX-01), sliced by position, player situation (injury return, role change, rookie, new team, backup-to-starter, QB change), season phase, game context, call closeness; plus the reverse (where we beat consensus) | pre-registered slices; FDR across slices (BH q=0.10); per-slice gap with clustered CI and MDE; each big slice labelled "free data could fix" vs "human news/judgement": it feeds per-situation blend weights |
| NEWS-01 | HX-01 verified (design can start now) | Wire news into the served weekly number: injury news into chance-to-play faster, role-change news into usage; one producer, every page reads it | forward test on 2026 weeks only (no historical news archive exists); pre-registered; decision win rate vs the served number without news and vs ESPN; archive every news input with fetched_at so later tests are possible |

## 15. Blend tournament (Nick 2026-09-22 ~7:55 PM ET: "make that blend really, really strong... do a bunch of different options at once")

| ID | Starts | Goal | Acceptance |
|---|---|---|---|
| BLEND-01 | next free local build slot (needs local data: ESPN weekly projections are stored only locally, league_roster_snapshots.projected_points) | One producer for the served weekly number with a blend chosen by a pre-registered tournament: ours only; ESPN only; 50/50; weight fit on history, shrunk toward 50/50; weights by position and season phase; ESPN as the base plus our correction only where proven; late-news switch (ESPN's latest when inactives/injury news land) | candidate set pre-registered before any number; graded on 2026 weeks already played (pair accuracy, decision win rate, points per decision, clustered CIs) and, for weights only, on 2022-2024 with FantasyPros ranks as an ESPN proxy (HX-01 rows once merged); complexity penalty: a more complex blend must beat the simplest good one by more than its MDE; ships ON only if it beats ours alone forward; ESPN used as a model input only (never shown as betting); every page reads the one producer |
| C-01b | C12 (deadline ~2026-09-29, before week 3 is graded) | C-01 addendum 2 promises a separate sub-window report whenever the served model changes; week 3 snapshots use weight set fit-2 while week 2 used frozen-2023, so the gate must report the two sub-windows apart | the C-01 gate service + panel | (Auditor fresh-session ruling) sub-windows are DESCRIPTIVE grades, not verdicts; a week is graded only once fully played; due before the gate stores any week-3 result (possibly 9/25, certainly ~9/29-30), else the coordinator holds the gate job | RED: a two-model window produces two descriptive sub-window grades and no verdict per sub-window; a partly played week is refused |

## 9. R&D loop units (round 2)

| RL-id | plan item | goal | files | acceptance | validity verdict |
|---|---|---|---|---|---|
| RL-2-1 | C-01 / RL-1-1 consensus arm; S-02/S-03 weekly construction grade (due before W5, 2026-10-08); master-plan Phase 2 consensus gate (FANTASY-ENGINE-MASTER-PLAN.md:847-851) | Store ESPN's weekly PPR projection (already fetched and discarded today) keyed by season/week/player/capture; retained rows for 2021-2024 and completed 2026 weeks, live rows before each week's snapshot. Benchmark/gate input only -- serves no number itself. | server/migrations/071_espn_weekly_projections.js (NEW); server/services/espn-weekly-projections.js (NEW); server/routes/stats.js:55; server/services/scheduler.js; scripts/refresh-live-data.mjs; scripts/backfill-espn-weekly-projections.mjs (NEW); test/espn-weekly-projections.test.js (NEW) | RED a-g: weekly rows stored per player/week; 2025 refused; time-based reads (asOf/maxLag); retained-vs-live by week; conflicting ESPN ids dropped not averaged; job runs before nfl_weekly_learning; no fetch when a recent capture exists. Data checks: >=97% mapped coverage 2021-24, matches saved snapshots within 0.01. | fixable |
| RL-2-2 | B-04 (K/DST projection and streaming, waiver-wire.js:43); B-09 denial value; D24 wedge | Make ESPN's own weekly K/DST projection the real bar for B-04 (last-3 average is a much weaker straw-man); add a D/ST 50/50 ESPN+market blend, default OFF until a 2026 forward check clears. Kickers shown as a tie, never claimed to beat ESPN. | server/routes/stats.js:55 (shared ESPN weekly store); scripts/grade-kdst-vs-espn.mjs (NEW); test/espn-weekly-kdst-capture.test.js, test/grade-kdst-vs-espn.test.js (NEW); inside B-04: server/services/kdst-projection.js (NEW), trade-engine.js, WaiverWire.tsx | RED a-e (capture/store correctness, waiver-day row frozen, failed fetch writes nothing, season pairing correct, 2025 refused without ledger id); RED f-i inside B-04 (blend math, non-default scoring disables blend, missing ESPN row falls back to market, basis label never overclaims). Ships ON only after both a once-only 2025 grade and a 2026 forward check pass. | fixable |
| RL-2-3 | S-09 (retired/unvalidated signals out of Start/Sit reasons); not currently listed there | Join Start/Sit's touchdown-luck note by permanent player id, not name (name join currently matches 0 real players and a looser fallback can hand one player's flag to a different player). Show the note once, context only; zero weight in the verdict until a forward 2026 test clears it. | server/services/td-regression.js (new id-based join helper); server/services/lineup-brain.js:533-545,586,609-621; server/services/player-case.js (delete broken name-matched touchdown-luck block); test/start-sit-td-luck-join.test.js (NEW) | RED a-f: no player ever shows another player's touchdown-luck numbers; a flagged player's verdict matches an unflagged baseline (zero weight); flag text appears at most once per player; candidates always pulled through the prior week only; mutation sweep on the name-join and on restoring any verdict weight. | fixable |
| RL-2-4 | C0 wording now, then WQ B-08 re-test (WQ B4 gap lists the code comment, with no unit) | Remove the specific replay win-rate number from the Waiver panel header on /lineup (already flagged for re-test, not currently reproducible); show a plain 're-testing' status sourced from one server field so only a real re-test can put a number back. | client/src/components/lineup/WaiverWire.tsx:36-46,94-98; server/services/waiver-wire.js:4-24,79,343; server/routes/trades.js:665-668; test/waiver-edge-withdrawn.test.js (NEW); docs/evidence/HOLDOUT-LEDGER.md, docs/NUMBER-PROVENANCE.md | RED T1-T4: no percentage-point or 'replayed seasons' wording anywhere in the waiver page or its server code; page renders status from one policy_edge field, defaulting to basis 'retest' / value null; mutation sweep M1-M5; live check confirms the API returns the retest status. | fixable |

## 16. The stack, with ranges (Nick 2026-09-22 ~8:40 PM ET: "sure sure... not expecting exact numbers but within a small number consistently, like our range is pretty good")

| ID | Starts | Goal | Acceptance |
|---|---|---|---|
| BLEND-02 | when BLEND-01 lands (C-14 feeds it) | The full stack: blend diverse sources (our stats ensemble, a tree model once MS-01 proves it, ESPN's projection, betting-market team totals, the news layer once NEWS-01 exists), weights learned on history by position and season phase, and output a RANGE per player-week (quantiles), not just a number | pre-registered; graded walk-forward on 2022-2024 (consensus as the proxy where ESPN history is missing) plus the 2026 weeks played: (1) calibration: the 80% range contains the outcome 78-82% of the time, by position and week band; (2) sharpness: median width; (3) pinball loss / CRPS vs a plain point projection with generic error bars and vs ESPN's point number; (4) start/sit decision win rate; ships ON only if it's honest AND tighter than the incumbent |
| C-14 (priority raised) | now, as BLEND-02's input | Serve calibrated ranges (split projection-range.js out of #88) | the existing acceptance (80% band within [0.78, 0.82] on held-out) |

## 7. Integration follow-ups (cont.): #159 SY-06 intake, 2026-09-23 01:45Z (cites on origin/main b6c83d51)
| INT-159-1 | F (paid-call hygiene) | Remove `eventOdds` (server/services/odds-api.js:149): zero production callers, an any-sport door into the paid Odds API | odds-api.js, test/mlb-removed.test.js:222 comment | git grep -w eventOdds server scripts client/src = 0; wiring gate passes; a test pins no export | cloud, low |
| INT-159-2 | docs accuracy | Fix server/index.js:139-142 comment ("never called" is historically false; say "since the UI teardown 1694694c, 2026-09-19"); fix test/decision-inbox.test.js:7 cite of a deleted test | 2 files, comments only | grep shows no "ever called"; cite points at an existing file | cloud, docs |
| INT-159-3 | scope (fantasy-only) | Drop betting/MLB leftovers: nfl-page-explain.js:45 prompt text; App.tsx:61 and PageExplainAssistant.tsx:59 /props checks | 3 files | page-explain prompt names the fantasy app; no /props path test in client/src; nav stays 8 tabs | cloud, low |
| INT-159-4 | provenance lists | Remove deleted files from scripts/schema-files.txt:7, core-and-fantasy.js:34/:367, core-and-fantasy.manifest.json:97, plus #128's 8 stale entries; regenerate wiring maps (with F-10) | schema lists | schema-snapshot finds no missing file; check:wiring passes | local, low |

## 12. Coordinator grants and rulings log (cont.)
| 2026-09-23 01:48Z | Coordinator | New cloud builds paused; lean builder runs locally (targeted tests, CI as full check). Open cloud PRs verified and landed locally. Reversible on Nick's "keep cloud". See CLOUD-PIPELINE.md. |

## 17. Trade analyzer track + ESPN-based stack (Nick 2026-09-22 ~9:55 PM ET: "make our app, specifically trade analyzer, actually insane... get me a really good team at real trades"; "if we can't beat ESPN why use our own model, rather stack it with Vegas, situational analysis")
Evidence it rests on: BLEND-01 (ESPN beats ours 0.683 vs 0.636 pair accuracy, 2023-24; no Vegas candidate was in C1-C7, prereg lines 58-64) and the skill-split study's early read (14,882 real trade sides, 2,398 public leagues; ~84% of a trade's result is luck after it, ~15% value visible at the trade; skeptics still checking, rnd/skill/).
| ID | Goal | Files / basis | Acceptance | Deps | AUD |
|---|---|---|---|---|---|
| BLEND-02 (redefined) | ESPN is the base; stack layers one at a time: Vegas implied team total + spread (as of lock), teammate-out vacated volume, weather, fixed chance-to-play, opponent vs position; calibrated range per player | nflverse line history (local), ESPN projection history BLEND-01 used, lineup-brain.js:356-363 vegasLift moves onto ESPN's number | PRE; each layer ships only if it beats ESPN alone beyond its MDE on 2023-24 walk-forward and holds in direction on 2026 weeks; ranges pass a coverage check (80% range covers 80% ±3) | BLEND-01 merged | yes |
| TR-01 | Chance-to-play check: BLEND-01's history test found healthy startable players rated 0.69 on average (they played 94.9%); confirm whether the live chain does it and fix | BLEND-01 output .history.availability_diagnostic; trade-engine.js:340-362 active_probability | RED: a healthy, undesignated starter's served P(play) within 0.03 of the measured played share; values move on trade/lineup surfaces | — | yes |
| TR-02 | Backtest the trade analyzer on the 14,882 real trade sides: as of each trade date, does our verdict pick the side that gained more rest-of-season lineup points, better than ESPN-value and season-to-date baselines? | rnd/skill/team_seasons.sqlite trade_sides + nflverse weekly; trade-engine.js evaluate/lineupDiff | PRE; decision win rate vs both baselines with 90% CI and MDE; aggregates only | TR-03 | yes |
| TR-03 | Trade values on the best number: ESPN base (then BLEND-02 layers once proven), league scoring (A-07), real remaining weeks (S-07), current week + real record (B-01), one value store (S-10) | trade-engine.js, ros-projection.js, routes/trades.js:1127, title-odds-trades.js:66 | contract test: the trade page, TradeCard and title-odds show the same per-player value from one producer | A-07, S-07, B-01, S-10 | yes |
| TR-04 | Rank offers by title-odds gain × chance they accept: B-03 delta on every idea + acceptance fitted on real accepted trades (price, lineup fit, partner activity) and the league's own transactions (B-11) | season-sim.js:361 tradeImpact, trade-acceptance.js, counterparty-pricing.js | PRE; acceptance calibration (reliability curve, Brier vs fair-tier default); each idea shows "title odds X% -> Y%, accept ~Z% (n=...)" | B-03, B-11, TR-02 | yes |
| TR-05 | Volume and timing: daily scan of all rosters, news/injury windows before the other manager reacts, deadline urgency | trade-engine.js findTrades/findTradeSequences, news-lag-trader.js, B-14 | ideas refresh daily; each carries its window reason with the news timestamp | TR-04, B-14 | no |

## 18. Skill levers into product (Nick 2026-09-22 ~10:05 PM ET: "yes" to the start/sit guard; "which features are the levers"). Source: skill-split study analyst results, rnd/skill/ (waivers skeptic: holds with corrections; start/sit, trades, luck skeptics still running). CORRECTION to §17 TR-05: the study says trade less, better (at 5+ trades a season per-trade lineup gain drops to +0.9, paper value leaks -3.6 per trade), so TR-05 is no longer "volume".
| ID | Goal | Evidence (study) | Acceptance | Deps | AUD |
|---|---|---|---|---|---|
| SS-01 | Dead-starter guard: before each kickoff window, flag any starter who is Out, Doubtful, IR, on bye or on the gameday inactive list (~90 min before kickoff), with a one-tap best healthy replacement | blunders cost 2.80 pts/week and are all of the repeatable lineup loss (110% [91,133]); 1.98 pts/week to known-out starters; 39.6% of regular starters on the inactive list were still started | RED: a fixture lineup with an Out starter and a bye starter raises both alerts with the replacement; graded on 2026 weeks as blunder points avoided | TR-01 | yes |
| WV-01 | Streaming board: DEF (then QB/TE) ranked by the opponent's Vegas implied total, with the implied-point edge shown | +1.94 pts per swap-week [1.88, 2.01]; kicker streaming only +0.35 | ranked list reads the line as of lock; history check reproduces the per-swap gain within its CI | — | yes |
| WV-02 | Injury replacement alert within the first waiver run: same team, same position, ranked by current snap share, plus a claim reminder before processing | each day late costs 0.17 PAR, a week late 0.5; contested claims +1.7 PAR vs +0.2 | alert fires on a fixture injury with the snap-share-ranked replacement and the waiver deadline | — | no |
| WV-03 | Add list shows snap share and flags one-week jumps as likely to fade | rank pickups by snap share, not last week's points | contract test on the waiver board payload | — | no |
| TR-05 (redefined) | Quality checks on every trade idea: lineup gain vs paper value side by side with a flag when they disagree; "you are giving up the best player"; regression-risk tag (hot start vs draft pedigree); IR/availability discount; "trade less, better" note past 5 trades | lineup gain returns 0.62 per point vs paper 0.115, disagree in 80%; best player +11.8 (2025: +5.5); pedigree slope -0.15 (2025: -0.12); IR player ~-30 pts | each flag has a RED fixture; the pedigree shrinkage is re-fit before shipping (study's k 5-6 is an inference) | TR-03 | yes |
| SK-01 | 5-league weekly command center (on an existing tab, nav stays 8): one list per week across all leagues, sorted by deadline: dead starters (SS-01), gameday inactives, streaming swap (WV-01), injury replacements + claims before the waiver run (WV-02), trade ideas only if they pass TR-05. In-app now; push and "tap to apply" wait on Nick's N12 (B-18) | study: the in-season edge is diligence (dead starters, moves, streams, fast injury response); Nick's leagues 1 and 5 had 0 adds in weeks 1-2 (19th percentile) while leagues 2-4 were 81st-93rd; his draft process is above average but points/week were below league average in all 6 seasons 2023-25, putting the gap in-season (descriptive, n=6) | one payload lists every league's to-dos with deadlines; a fixture league with an Out starter, a free streaming DEF and an injured starter produces all three items | SS-01, WV-01, WV-02 | no |

## 19. Trade Machine (Nick 2026-09-22 ~10:20 PM ET: "make my trade analyzer insane... fair trades that look fair, but two weeks later they're like why did I do that"; "map out how we get this lineup in five weeks, 0-2 to winning this league through trades"). TOP PRIORITY after midnight, ahead of SS-01/WV (which run alongside).
Data it rests on (counted 2026-09-23 02:25Z, local only, never committed): data/derived/league_chat.sqlite = 16,626 messages, 535,887 AI-read chat signals (jev_chat_signals: msg x question x probability), manager_chat_profile (10: p_open_to_trade, p_reacting_to_loss, p_own_complaining, p_own_untouchable, night_share...), negotiation_profiles (10), manager_player_sentiment (132); local copy: manager_archetypes 6,575, manager_signals 1,274, league_transactions_raw 1,498. Study mechanisms: paper value vs lineup gain disagree in 80% of trades; hot starts regress (pedigree slope -0.15); injured players overpriced (~-30 pts); best player in the deal +11.8.
Design rule: every fact in a pitch is true and cited (Coach's verifier, coach/verify.js:86); the edge is information the other manager is not using. No manager names in anything committed; chat-derived fields stay in the local DBs.
| ID | Goal | Files / basis | Acceptance | Deps | AUD |
|---|---|---|---|---|---|
| TM-01 | "Fair on paper, wins for you" finder: every 1-for-1, 2-for-1, 2-for-2 with each league-mate scored twice: their-eyes value (ESPN's value/rank they see, shifted by their own player sentiment and biases) and real value to Nick (rest-of-season lineup gain + title-odds change, weeks remaining + playoffs). Rank where their-eyes >= fair and real value favors Nick | trade-engine.js findTrades/evaluate/lineupDiff, perceptionFactorFor (today a +/-10% multiplier, :1420), league_chat.sqlite sentiment, season-sim.js:361 | each idea shows both numbers; a fixture where ESPN calls it even but the lineup gain is +20 ranks first | TR-01, TR-03 | yes |
| TM-02 | "Why it ages well" tags with their number: schedule swing over the next 2-5 weeks from Vegas implied totals + byes + weeks 15-17; regression (points above expected, hot start vs pedigree); role trend (snap/route/target share); injury and teammate-return risk | nflverse lines + schedules (local), ffopportunity xFP, ros-projection.js | each tag cites its inputs; history check: tagged sells lose value over the next 2 weeks more than untagged (PRE) | TM-01 | yes |
| TM-03 | Target board per league-mate: tilt (just lost, complaining, falling playoff odds), players they are down on (buy low) and players of Nick's they rate high (sell high), roster hole, openness vs untouchables, active hours, observed accept rate | league_chat.sqlite manager_chat_profile / manager_player_sentiment / negotiation_profiles, manager_signals, trade-tactics.js timingRead | board payload per manager with n behind each read; reads under n=5 say "thin" | TM-01 | no |
| TM-04 | Pitch + counter ladder: opening offer that leaves room, fallback, walk-away; message draft in Nick's voice built on what that manager wants; every number verified | coach/verify.js:86, trade-proposals.js | an ungrounded digit or false claim in a draft is refused (RED) | TM-01, TM-03 | no |
| TM-05 | Roadmap "0-2 to contender": target lineup in 5 weeks, sequenced trades (who, which week, why then), title odds after each step, fallback if a step fails | findTradeSequences (2-step today) extended to N steps, season-sim | a fixture league produces a 3-step path with odds rising each step; odds from B-01 (current week + real record) | TM-01, TM-02, B-01 | yes |
| TM-06 | Proof + ledger: backtest the paper-fair/real-edge signal on the 14,882 real trade sides and the league's own 1,498 transactions (did the favored side gain over +2 and +5 weeks?); log every sent offer, reply and realized value at +2/+5 weeks to learn each manager's yes/no | rnd/skill trade_sides, trade_outcomes (#94), B-11 | PRE; decision win rate vs ESPN-value baseline with 90% CI and MDE; ledger rows for offers | TR-03 | yes |
Folded in: TR-02 -> TM-06, TR-04 -> TM-01/TM-03, TR-05 -> TM-02/TM-04 (its quality flags stay). TR-01 and TR-03 remain prerequisites.
| TM-07 | Analyst layer ("the model needs to think", Nick 10:30 PM ET): an LLM analyst reads everything we hold on a player (usage trend, xFP vs points, schedule by Vegas, injuries and depth chart, ESPN + our numbers and ranges, the news feed, the research feed TM-08) and writes a 5-week outlook: expected role, catalysts, risks, floor/median/ceiling by week, "what would change my mind"; for a candidate trade it reasons both sides 2-5 weeks out, the backfire risk, and the 3 strongest TRUE talking points, using the counterparty dossier | Jev gateway or Anthropic key (server-side), structured JSON output + narrative; coach/verify.js grounding on every number; the adjustment it applies to the served number is capped (±15%) until graded | PRE; every forecast logged with its timestamp; graded weekly vs outcomes (calibration curve, decision win rate vs ESPN base alone); FORWARD-ONLY grading (2026 weeks) because history leaks into an LLM's memory; ships as an explanation first, as a number only after 4 graded weeks beat the base | TM-01, TM-03, NICK spend cap | yes |
| TM-08 | Research feed: licence-first sources only (official injury reports, team depth charts, beat-reporter feeds already mapped in A3, weather, ESPN/NFL news, cheap web search via Jev), refreshed daily and before each kickoff window, each item stamped as-of and stored with its source | server/news ingest + a research table; scheduler job; cost meter | every item has source, timestamp, licence note; the analyst cites only items dated before its forecast; spend per day shown and capped | NICK spend cap (Jev balance first; ≤$1/run without asking) | no |

See TRADE-MACHINE-PLAN.md (v2, 02:40Z) for the corrected design, new data pulls TM-09..15, the negotiation playbook and research units RS-01..06.

MASTER: TRADE-MACHINE-MASTER.md (compiled 1:20 AM ET: have vs need, routing to existing files/routes/pages, runtime, UI, build order). Detail history: TRADE-MACHINE-PLAN.md v2-v8. New units from chat: LS-01, DD-01, GT-01, LL-01.

REORG: PLAN-REORG-2026-09-23.md maps every unit from tonight to one of the 32 plan items, merges duplicates, and gives the build order by item. Programs: Trade Machine, Championship Engine (B9), Grading (C12/C13/C14/C17/C18).
| 2026-09-23 02:00Z | Nick | "ok with 4: stay here until ready and done, statistically insane" -> the coordinator stays on Trade Machine v1 (PHASE-DELIVERABLES.md phase 3/4) until its exit criteria hold; deliverables, UI, researchers and models per stage recorded there. |
| 2026-09-23 02:35Z | Nick | Verification rules (VERIFICATION-RULES.md: reuse step before build, micro wired-elsewhere list, skeptics by lens incl. a UI lens with screenshots, synergy review every 8 merges, structure scout every 2 days, 7-day re-audit) and the UI standard (UI-STANDARD.md) bind every workflow. |

UI REVAMP: UI-REVAMP.md (UX-01..07) runs alongside the Trade Machine; UX-01/02 start now.
| 2026-09-23 07:15Z | Nick | At 95% of the 5-hour meter stop all workflows (resume state saved); meter checked every 5 min by bin/meter-watch.sh (log: METER-LOG.md); always log in the handoff docs. |
| 2026-09-23 07:25Z | Nick | "Switch models as the plan says": build-unit-v2.js / verify-pr-v2.js pin claims skeptics to fable, builders/skeptics/fixers to opus, gate and ready steps to sonnet; all new launches use v2. Running phase-0 jobs inherit Opus 5.5 (correct for builders; their claims rechecks run on Opus). 20-min 0pdates in chat (cron :07/:27/:47). |

## 7. Integration follow-ups (cont.): C-01 #160 verify (2026-09-23 07:40Z), nonblocking, queued
| INT-160-1 | C-01b sub-window grades | URGENT: week-3 snapshot uses weight_fit fit-2 (week 2 frozen-2023); land before the gate stores a week-3 result (outcomes from ~2026-09-25) | — | — |
| INT-160-2 | plan_rule.same_cutoff field + tie RL-1-1/S-12 to start-sit-gate.js:528 | named absence in payload, not prose | — | — |
| INT-160-3 | served arm filters as_of < kickoff (start-sit-gate.js:371-374) | guard against manual rows | — | — |
| INT-160-4 | run timestamp in gate evidence (recordGateAudit ON CONFLICT keeps stale created_at) | panel 'Measured' date true | — | — |
| INT-160-5 | import startSitPairAccuracy instead of the copy (start-sit-gate.js:206-244) | one producer | — | — |
| INT-160-6 | Coach sync_log detail carries plan_rule.direction/source | no drift once same-cutoff exists | — | — |
