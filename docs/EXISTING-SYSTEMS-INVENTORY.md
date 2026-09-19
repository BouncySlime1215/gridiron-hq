# Existing systems inventory — 2026-09-18, 04:40

> **Correction (checked 04:45):** `league_transactions_raw` *is* refreshed automatically — `scripts/refresh-live-data.mjs` runs `collect-league-transactions.mjs` and the chat extract/rollup on every 15-minute tick (last tick 08:11 UTC: transactions ok, 1,349 rows; chat rollup ok). What nothing rebuilds is the **main-DB** copy the trade finder reads (`manager_signals`, `manager_player_view`, via `buildManagerSignals`) — that finding stands.

Read-only inventory of every system that overlaps the Trade Brain, Coach, action plan and dashboard (section 00 of FANTASY-ENGINE-MASTER-PLAN.md). Produced by a read-only agent; no files were changed. Every build from WA on reads this before writing code (Discover → Audit → Decide).

I made no changes: no files edited, no server or node scripts run. The chat DB and `server/data.sqlite` were only read with `sqlite3 -readonly`.

All paths below are under `/Users/nick_matta/Documents/GitHub/gridiron-hq`.

**Uncommitted work in the tree.** Eight files have edits in progress from the week-2 fixes ("decision-leftovers") workflow: `server/services/{waiver-wire,lineup-brain,lineup-posture,ceiling-lineup,season-sim}.js` and `client/src/{pages/Lineup.tsx,components/lineup/WaiverWire.tsx,components/lineup/MatchupPosture.tsx}`. I read the working-tree versions. For example, `chooseClaimCut` in `waiver-wire.js` is not committed yet.

**Git context that matters:**
- Commit `60f5f5d` (2026-09-17 20:42, "UI teardown") deleted `Home.tsx` (the old dashboard, which used `/trades/:id/inbox` and `/decision-inbox`), `LeagueBrain.tsx` (used `/brain/plan` and `/brain/managers`), `Trends.tsx` and the whole betting UI. The backends were all kept.
- `/` now redirects to `/league`.

**LLM defaults:**
- Every server call goes through `server/services/claude.js`. `callClaude` defaults to `claude-haiku-4-5-20251001` (line 99) and uses `GROUNDING_SYSTEM` as the system prompt (line 87).
- `PRICING` (lines 10-13) knows only Haiku. The Sonnet 5 negotiation-profile runs are therefore costed at Haiku rates, so reported spend is too low.
- The `ai_usage` table only has rows from 2026-09-17 on. It shows `negotiation_profile` (Sonnet 5, 35 calls), `nfl-news-typed-extraction` (9) and `player-verdict` (1). None of the trade, explain or pitch features show any calls.
- Jev / the Vercel AI gateway (`jev.ts`, `index.ts`, `scripts/news-line/jev_*.mts`) is used only by offline scripts, for example to label the chat. No server code uses it.

---

## A. Coach / chat / assistant

| System | Files | Route | Client caller | What it does | LLM | Last commit | Quality |
|---|---|---|---|---|---|---|---|
| Floating "What am I looking at" assistant | `client/src/components/PageExplainAssistant.tsx`, `PageExplainContext.tsx`; `server/services/nfl-page-explain.js`, `page-explain-tools.js`, `nfl-page-explain-audit.js` | POST `/api/betting/explain/page` (`server/routes/betting-hub.js:886`); GET `/explain/page/audits` (:906) | Mounted once in `App.tsx:144` on every page. Only `LiveDraft.tsx:372`, `Lineup.tsx:61` and `TradeLab.tsx:65` send it a page summary | Tool-use loop capped at 4 rounds (`nfl-page-explain.js:23,86`). Every answer is written to `nfl_page_explain_audits` | Haiku 4.5, 700 tokens | client 09-17; service 09-04; tools 09-16 | **Broken for fantasy.** The system prompt calls it a "betting research desk" and loads a glossary from `client/src/pages/betting/TERMINOLOGY.md` (line 26), which the teardown deleted, so it falls back to a placeholder. All 6 tools are betting tools (`game_projection_breakdown`, `pick_watch_detail`, …). There are no fantasy tools |
| Trade negotiation copy | `server/routes/trades.js:894` | POST `/trades/:leagueId/explain` | `client/src/components/TradeCard.tsx:193` | Writes a pitch, likely counter, walk-away line and risk for a deal the engine has already scored. Passes in the user's untouchables | Haiku, 900 | 09-18 | Live, but it knows nothing about the other manager: no sentiment, profile or tactic |
| AI second opinion ("sense check") | `trades.js:705-887`, `server/services/trade-verify.js` (09-07), `season-sim.js#tradeImpact` | POST `/trades/:leagueId/sense-check` | `TradeCard.tsx:166` | Claude gives a verdict. A paired season simulation then checks it, and Claude gets one retry if the numbers contradict it | Haiku, 1100 + 700 | 09-18 | Live and well built. The propose → verify → retry-once pattern is worth reusing for the Coach's accuracy check |
| AI offer ladder | `server/routes/tradelab.js:263` | POST `/tradelab/:leagueId/pitch` | **none** | Anchor/fair ladder, pitch and read, built from `analyzeLeague` needs/surplus | Haiku, 1500 | 09-08 | **Orphaned.** Duplicates `/explain` |
| Template pitch | `server/services/league-brain.js:871` `pitchFor` | inside `/brain/plan` | none | Canned sentence | none | 09-07 | Orphaned |
| News "what it means" | `server/routes/news.js:269` | POST `/news/:id/explain` | `News.tsx:239`, `TeamDetail.tsx:394` | Team impact plus impact on "my roster". Writes the `ai_analysis` and `fantasy_impact` columns on `news_items` | Haiku, 900 | 09-15 | Live, but on demand only. 0 of 914 stories have `fantasy_impact` filled in |
| Player verdict / scout report | `server/routes/players.js:160`; `server/routes/edge.js:293` | POST `/players/:id/analyze`; POST+GET `/edge/scout/:id` | `PlayerCard.tsx:96`, `:76-81` | BUY/SELL/HOLD chosen from evidence IDs; draft-style scout report | Haiku | 09-03; 09-17 | Live. The scout prompt still hands Claude a playoff schedule-strength number, which has no validated signal |
| Team scouting text | `server/routes/analysis.js:130,191` | POST `/analysis/refresh`, GET `/analysis/validate` | `TeamDetail.tsx:76,83`; scheduler | NFL scheme/unit write-ups | Haiku, 3000 | 09-04 | Live. NFL context only, not a coach |
| Betting pick explainer | `server/routes/nfl-betting.js:472` | POST `/nfl-betting/explain/ai` | none (betting UI deleted) | — | Haiku | 09-13 | Orphaned |
| "Ask" capability router | `server/routes/model.js:722` → `server/services/gridiron-model.js:483` | GET `/model/ask/:capability` | none (`TheModel.tsx` deleted) | Deterministic: which model is allowed to answer a question. Not a chat | none | 09-04 | Orphaned. Could become the Coach's refusal gate |
| Coach spec | `docs/COACH-PLAYBOOK.md` (09-18) | — | — | Rules for `{message, anchor, send_at, dont_say[], predicted_response, p_accept}` | — | — | Spec only. `grep dont_say\|send_at` finds nothing in the code |

## B. Action plan / to-do / inbox

| System | Files | Route | Client | What it does | Last commit | Quality |
|---|---|---|---|---|---|---|
| Ephemeral inbox | `trades.js:466-521` | GET `/trades/:leagueId/inbox` | **none** (was `Home.tsx`) | Top 3 `selfScout.fixes`, up to 3 news items with `importance = 3` on my NFL teams, and 1 mutual `findTrades` deal. Links to `/my-team` and `/trade-lab` | 09-18 | **Orphaned, and the news branch is dead:** all 914 `news_items` have importance 2 |
| Persistent Decision Inbox | `server/routes/decision-inbox.js` (09-12), `server/migrations/020_decision_recommendations.js` | GET `/decision-inbox`, GET `/summary`, POST `/`, POST `/:id/resolve` | **none** (was `Home.tsx`) | Stores recommendations with urgency, expiry, deduplication and resolve/outcome. `publishRecommendation` (line 91) is called by `trade-engine.js:2183` (`lineupDiff`, fired when MyTeam loads `/lineup-diff`) and `waiver-brain.js:303` | 09-12 | Right design (lifecycle plus outcome tracking) with no reader. DB: 5 open `lineup` rows, and 1 `waiver` row whose `link: '/brain'` points to a deleted route (`waiver-brain.js:315`) |
| League Brain plan | `server/services/league-brain.js` (892 lines) | GET `/brain/state` (`trades.js:127`), `/brain/plan` (:140) | **none** (was `LeagueBrain.tsx`) | `brainPlan` (line 426) ranks trades (its own `enumerateDeals` at :791 and tier-based `acceptProbability` at :202, plus Nash product and rival tax) together with waivers (`waiverUpgrades`), sell-high, bye patches, fragility, TD regression and trends into one expected-value list. Includes near-misses, a confluence multiplier and an assumptions list | **09-07** | Orphaned and stale. It predates the chat-based manager reads, the timing weighting and the rest-of-season model, all added 09-17/18. It uses `manager_profiles` tiers (0 rows, so everyone is "fair") and none of the chat reads |
| Post-draft plan | `trades.js:86` | GET `/trades/:leagueId/post-draft-plan` | `client/src/components/PostDraftPlan.tsx` (09-03), shown in `MyTeam.tsx:211` | `selfScout` + `findTrades` (limit 5) + lineup. Composition only | 09-18 | Live, but the post-draft framing is out of date by week 2 |
| Self-scout fixes | `server/services/trade-engine.js:1766` `selfScout` | GET `/trades/:leagueId/scout` | `MyTeam.tsx:54` → `TeamScout.tsx` | Position strength vs the league, injury drop-off, bye clusters, playoff-week byes, prioritised `fixes[]` | 09-18 | Live. The best existing "roster to-do" source |
| Lineup-gap recommendation | `trade-engine.js:2078` `lineupDiff` | GET `/trades/:leagueId/lineup-diff` | `MyTeam.tsx:56` | Submitted vs optimal lineup for this week, swaps with a chance of being right, IR/flagged starters. Publishes to the Decision Inbox | 09-18 | Live |

## C. Trade generation and trade intelligence

| System | Files | Route | Client | What it computes | LLM | Last commit | Quality |
|---|---|---|---|---|---|---|---|
| Trade finder | `trade-engine.js:1167` `findTrades`, `:1449` `findTradeSequences`, `:925` `evaluate` | GET `/find` (`trades.js:532`), `/find/sequences` (:555), POST `/evaluate` (:596) | `TradeLab.tsx:408,592,1014` | Every 2-for-2 combination. Score = `managerFactor × fairnessFactor × perceptionFactor × (timing-weighted gain + 0.2·joint) − valueCost` (lines 1387-1390). Tables: `players`, `dynasty_values`, `player_week_usage`, `manager_profiles`, the chat reads, … | none | 09-18 | **Live core.** Chat-based reads wired in at `:1234-1374` |
| Counterparty layer | `server/services/counterparty-pricing.js` | inside `findTrades` | — | `counterpartyLayer` (:48): receptiveness 0.7-1.3 from chat ranks, accept rate and Nick's hardcoded priors. `perceivedValue` (:115): chat moves a package's value by at most ±15%. `readDeal` (:158): `perception_delta` | none | 09-17 | Live, but works for **league 4 only** (the only league with identity and sentiment rows) |
| Manager signals | `server/services/manager-signals.js` | none | — | `buildManagerSignals` (:160) writes `manager_signals` and `manager_player_view` from the chat DB, ESPN transactions and the roster. `NICK_PRIORS` is hardcoded (:148). `managerSignalsFor` (:210) reads them back | none | 09-17 | **Nothing in the repo calls the builder.** No route, scheduler job or script runs it. It was last built ad hoc for league 4 on 2026-09-17 22:04 (247 + 117 rows) |
| Talk vs model | `server/services/talk-vs-model.js` | inside the counterparty layer | — | `readTalk` (:77) labels each player read: sales_pitch, attachment, buy_low, genuine_sour or wants_him. Crosses `manager_player_view` with the expected-vs-actual points gap from `nfl_ffopportunity_weekly`. `priceAdjustment` (:132) | none | 09-17 | Live (league 4). No committed tests |
| Bluff detector | `server/services/bluff-detector.js` | inside the counterparty layer | — | `declarationCredibility` (:85) opens the chat DB on every uncached `findTrades` call and reads `jev_chat_signals` + `messages`. `untouchableStance` (:163): respect / probe / ignore | none | 09-17 | Live (league 4). Returns an empty `Map` when the chat DB is missing but `{byManager, events}` otherwise |
| Manager identity | `server/services/manager-identity.js` | none | — | `league_member_identity`: ESPN member ↔ chat name | none | 09-17 | `matchIdentities` has no caller. Only league 4 has rows (10, all confirmed) |
| Manager archetypes | `server/services/manager-archetypes.js`, `scripts/build-manager-archetypes.mjs` | none | — | Draft revealed preference plus outcome metrics, including `luck_wins`, `all_play` and `h2h_pct` (153 rows each). `archetypesFor` (:829) | Jev (script) | 09-17 | **No server importer.** Luck data exists but isn't read |
| Timing weighting | `server/services/trade-horizon.js` | inside `findTrades` | — | Playoff weight = f(weeks left, importance 4, P(make playoffs)) | none | 09-18 | Live, but **nothing ever passes `playoffOdds`**, so it always uses 0.5 |
| Title-odds trades | `server/services/title-odds-trades.js` | GET `/title-trades` (`trades.js:393`) | `TradeLab.tsx:256` | `findTrades` shortlist → paired `tradeImpact` season simulations | none | 08-28 | Live |
| Target offers | `trade-engine.js:1521` `offerFor`, `:1653` `offerForMany` | GET `/offer`, `/offer-many` | `TradeLab.tsx:629,747` | Packages to land a named target | none | 09-18 | Live, but **ignores the chat reads and timing weighting**. Inconsistent with `findTrades` |
| Trade Lab analysis / partners | `tradelab.js:103` `analyzeLeague`, `:200`, `:212` | GET `/tradelab/:id/analysis`, `/partners` | **none** | Needs/surplus, contention window, two-way partner matching | none | 09-08 | Routes orphaned. `analyzeLeague` itself is **live** through `trade-engine.js:93` `rosterContext` |
| Brain trade endpoints | `trades.js:168,204,333,340` → `waiver-brain.js:356` `sellHigh`, `position-liquidity.js:94`, `league-brain.js:135,165` | GET `/brain/sell-high`, `/brain/liquidity`, GET+POST `/brain/managers` | **none** | Market-price-vs-production curve sell-high; what other rosters can spare; the manual tier writer (the only writer of `manager_profiles`) | none | 09-07 → 09-18 | Orphaned. `manager_profiles` has 0 rows because no UI can set tiers any more |
| News edge | `server/services/news-lag-trader.js:113` | GET `/news-edge` (`trades.js:360`) | `TradeLab.tsx:173` (News edge tab) | Verified signals → who inherits the touches → act before the league does | none | 09-15 | Live |
| VOR trade analyzer | `edge.js:271` | POST `/edge/trade` | none | VOR sum difference | none | 09-17 | Orphaned. Duplicates `/evaluate` |
| Negotiation profiles | `scripts/build-negotiation-profiles.mjs` | none | — | Per manager: `says_no`, `praise_means`, techniques, calibration, `roster_read` (`really_untouchable`, `overvalues`, …), `best_bait`, `how_to_approach` | **Sonnet 5**, 8000 tokens (:403) | 09-18 | **Written, never read.** The script header claims the counterparty layer "prefers a model read"; no server code reads the table |

Trade-engine defects found:
- **Stale cache after a signals rebuild.** The `findTrades` cache fingerprint (`trade-engine.js:1181-1190`) leaves out `manager_signals`, `manager_player_view`, `league_member_identity` and the chat DB, so rebuilding signals does not invalidate cached rankings.
- **"Hard" tier discounted twice.** The 0.55 factor is applied in `counterparty-pricing.js:89` and again in `trade-engine.js:1314`. Latent for now, because no tiers are set.
- **Counterparty data never reaches the UI.** `grep counterparty|perception|receptiveness client/src` finds nothing.
- **Dead code.** `counterparty-pricing.js:183` `untouchablesFor` has no caller.

## D. Dashboard / home / league overview

- **`client/src/pages/LeagueHub.tsx`** (23 lines, 09-08) is `/league`. It is only a tab switch between `MyTeam` and `Leagues`.
- **`client/src/pages/MyTeam.tsx`** (09-18) calls:
  - `/leagues/:id/data`
  - `/trades/:id/scout`, rendered by `TeamScout.tsx` (09-04)
  - `/trades/:id/lineup-diff` (`LineupDiffCard`)
  - `/model/:id/simulate?runs=1500` (`server/routes/model.js:520`, title/playoff odds "twin")
  - `/trades/:id/ceiling-lineup`
  - `PostDraftPlan`
  - PUT `/leagues/:id`, POST `/leagues/:id/sync`
- **`client/src/pages/Leagues.tsx`** (08-26) calls `/leagues/:id/analysis` (`server/routes/leagues.js:298`). That is a third copy of the needs/surplus logic, with the same 0.80/1.15 thresholds as `analyzeLeague` but priced on FantasyCalc value. It also calls sync and removal-impact.
- **No home page exists.** `Home.tsx` was deleted in `60f5f5d`; it combined `/trades/:id/inbox`, `/decision-inbox`, `/news` and `/model/accuracy`.
- **Pages not reachable from any route:** `Edge.tsx`, `Model.tsx`, `Projections.tsx`, `Rankings.tsx`. `navigation.ts` still lists `/edge` in `DEEP_DESTINATIONS`, which goes to NotFound.

## E. Matchup and opponent intelligence

| System | File (last commit) | Route | Client | Computes |
|---|---|---|---|---|
| Matchup posture | `server/services/lineup-posture.js:206` (09-18, uncommitted edits) | GET `/posture` (`trades.js:450`) | `Lineup.tsx:40` → `MatchupPosture.tsx` | Opponent from `payload.schedule` (`opponentFor` :176), my and opponent projection and spread, win probability, stance above `MATERIAL_EDGE` 23 points, variance swaps. **The only existing "this week vs opponent" source** |
| Start/Sit | `server/services/lineup-brain.js:337` `lineupCall` (09-17, uncommitted) | GET `/lineup` (`trades.js:323`) | `Lineup.tsx:35` | Margins, confidence, the football case (`player-case.js`), Vegas lift, IR, user-chosen objective mean/ceiling/floor |
| Ceiling lineup | `server/services/ceiling-lineup.js:144` (09-12, uncommitted) | GET `/ceiling-lineup` | `MyTeam.tsx:435` | Monte Carlo chance of beating a target score using player correlation |
| Week post-mortem | `server/services/week-postmortem.js:44` (09-17) | GET `/postmortem` (`trades.js:408`) | **none** | Decision cost, projection error and variance for a finished week. Orphaned. The plan (Q1) says it grades with today's projection instead of the projection as of that week |
| Season sim | `server/services/season-sim.js` | GET `/model/:id/simulate`, POST `/model/:id/trade-impact` | `MyTeam.tsx:62`, `TradeCard.tsx:178` | Playoff and title odds |

**No manager-level read on the opponent exists anywhere.** Nothing joins this week's opponent to the chat reads, negotiation profile, archetype/luck data or `selfScout`. `nfl-opponent.js` is about NFL teams, for betting. `Lineup.tsx:43` fetches all rosters only to show the opponent's name.

The lineup objective is decided in three places: the objective you pick in `lineupCall`, the stance `lineupPosture` computes, and `ceilingLineup`. The current week is also defined twice: `trade-engine.js:114` `tradeWeekContext` (from `game_lines`) and `server/services/league-week.js` `leagueCurrentWeek` (from ESPN).

## F. News and "what it changes"

- **`server/routes/news.js`** (09-15) serves the `/news` page (`News.tsx`, tabs `signals`/`feed`/`log`, 09-08) and `features/news/NewsHub.tsx` + `useNewsFeed.ts` (08-29):
  - GET `/desk` (:57): priority score from roster names, a "material news" regex, freshness and source.
  - GET `/signals` (:222): `nfl_news_signals_current` with verified claims, joined to `newsFantasyTracker`.
  - GET `/`, `/dates`, `/my-players`, `/twitter-status`.
  - POST `/ingest`, `/`, `/:id/explain`, `/analyze`, `/roundup` (the last three call Haiku). DELETE `/:id`.
- **`server/services/news-fantasy-impact.js:70`** `newsFantasyTracker` (08-29) grades each signal against the next game's actual usage. Live via `/signals`.
- **`news-lag-trader.js`** (the `/news-edge` route above) turns news into actions (who inherits the touches). Live in Trade Lab.
- **`nfl_news_signals`** is filled on a schedule by `nfl-news-signal.js` (Haiku typed extraction; 59 current rows, latest 2026-09-18). It is also read by `teams.js`, `who-plays.js`, `player-availability`, `news-lag-trader` and various betting services.
- **Dead path:** the `/inbox` news branch filters on `importance = 3` and reads `fantasy_impact`, and neither is ever set.

## G. Waivers: which one does the UI use?

**The UI uses `server/services/waiver-wire.js#waiverBoard`** (:145) via GET `/trades/:leagueId/waivers` (`trades.js:429`), in `Lineup.tsx:39` → `components/lineup/WaiverWire.tsx`. It is last committed 09-17 with large uncommitted edits:
- Values players on `current_week_ppg` plus `ros_ppg`.
- Picks the drop with `chooseClaimCut` (:88): it never cuts a player worth more over the rest of the season.
- Aware of IR; excludes free agents with no NFL team; keeps a stash list and a held-back list.
- Covered by `test/decision-leftovers-waivers.test.js`.

**`server/services/waiver-brain.js`** (09-18) is a duplicate:
- `waiverUpgrades` (:198) sits behind GET `/brain/waivers` (`trades.js:157`), which no client calls. It values players on a timing-weighted blend of `adj_ppg` and `playoff_ppg` plus a Vegas lift. Its drop candidate is simply the worst bench player (:240-245) — **the exact rule `waiver-wire` replaced to fix the Waddle cut**. It does not check IR.
- It still feeds `brainPlan` and publishes to the Decision Inbox (:303) with a dead `/brain` link.
- `freeAgents` (:170) sits behind `/brain/free-agents`, with no client caller.
- Helpers in this file are genuinely live: `vegasLift` is used by `trade-engine.js:43` and `lineup-brain`, and `sellHigh` and `playoffWeight`/`horizonValue` are also still used.

Related: `server/services/roster-risk.js` `byePatches` (bye-week pickups from the wire) sits behind `/brain/bye-risk` and is orphaned. `trending_players` (Sleeper adds/drops) has **0 rows** and is not scheduled; only `scripts/bootstrap-data.mjs` calls `/tradelab/trending/sync`.

## H. Private chat DB (`data/derived/league_chat.sqlite`): who reads what

| Table (rows) | Server readers | Script readers/writers |
|---|---|---|
| `negotiation_profiles` (10, Sonnet 5, built 09-18 05:21-05:54, including `ME`) | **None** | Written by `scripts/build-negotiation-profiles.mjs:54,363,434` |
| `manager_chat_profile` (10) | `manager-signals.js:71` (`chatSignals`, only reached through `buildManagerSignals`, which has no caller) | Built by `scripts/chat/extract_league_chat.py:153`; read at `build-negotiation-profiles.mjs:342` |
| `manager_player_sentiment` (119) | `manager-signals.js:178` (same uncalled builder), which copies into main-DB `manager_player_view` (117 rows, league 4) | Built by `extract_league_chat.py:181` |
| ↳ `manager_player_view` (main DB) | **Live:** `talk-vs-model.js:163`, `bluff-detector.js:167`, `manager-signals.js:217`, plus the dead `counterparty-pricing.js:184` | — |
| `jev_chat_signals` + `messages` | **Live:** `bluff-detector.js:58-72` opens the chat DB directly | Written by `scripts/news-line/jev_league_chat.mts` |
| `manager_notes`, `entity_map`, `participants` | none | — |

The live path therefore depends on a one-off snapshot for league 4 that nothing rebuilds. The richest artifact, `negotiation_profiles`, is not read by anything.

---

## 1. Duplicates and overlaps

| Capability | System X | System Y (and more) |
|---|---|---|
| Trade generation | `findTrades` (chat reads, timing weighting, value cost) | `league-brain` `enumerateDeals` + `acceptProbability` (tiers, Nash, rival tax); `offerFor`/`offerForMany` (no chat reads or timing); `tradelab` `/partners`; `edge` POST `/trade`; `/post-draft-plan` and `/inbox` both re-call `findTrades` |
| Acceptance model | trade-engine factor product plus `receptiveness` | `league-brain.acceptProbability` logistic; `negotiation_profiles` (unread); `NICK_PRIORS` hardcoded; `manager_profiles` tiers |
| Needs/surplus | `tradelab.analyzeLeague` (VOR) | `leagues.js /:id/analysis` (FantasyCalc, copied thresholds); `selfScout.positions` (0.88/1.12); `league-brain.needProfile` |
| Negotiation copy (LLM) | `trades.js /explain` | `tradelab /pitch`; `league-brain.pitchFor`; `COACH-PLAYBOOK.md` (spec) |
| Action plan | `decision-inbox.js` (persistent) | `trades.js /inbox` (ephemeral); `brainPlan`; `/post-draft-plan`; `selfScout.fixes` |
| Waivers | `waiver-wire.waiverBoard` (UI) | `waiver-brain.waiverUpgrades` (old cut rule, feeds plan and inbox); `/brain/free-agents`; `byePatches` |
| Sell-high | `waiver-brain.sellHigh` (price curve) | talk-vs-model `sales_pitch`/hot gap; `td-regression` sell bucket; `trend-exploits` |
| Lineup objective | `lineupCall` objective | `lineupPosture` stance; `ceilingLineup` |
| Current week | `tradeWeekContext` | `leagueCurrentWeek` |
| "Explain" LLM calls | `PageExplainAssistant` (betting tools) | `/explain`, `/sense-check`, `/pitch`, `/news/:id/explain`, `/players/:id/analyze`, `/edge/scout/:id`, `/nfl-betting/explain/ai` — each a separate one-shot Haiku call with its own prompt |
| Untouchables | client localStorage (Nick's own) | `bluff-detector` stance (live); `untouchablesFor` (dead); `negotiation_profiles.roster_read.really_untouchable` (unread) |

## 2. Orphaned code

**Routes no client calls:**
- `trades.js`: all 8 `/brain/*` routes plus POST `/brain/managers/:rosterId`; `/trends`, `/trends/team/:team`, `/trends/player/:id`, POST `/trends/scan`, `/trends/watch`; `/regression`, `/regression/board`, `/regression/rates`; `/postmortem`; `/inbox`; `/splits/:playerId`.
- `tradelab.js`: `/analysis`, `/partners`, `/pitch`, GET `/trending`. POST `/trending/sync` is called only by a script.
- `decision-inbox.js`: all 4 routes.
- `edge.js`: POST `/trade`, `/movers`, `/volatility`, `/schedule-edge`, `/efficiency`, `/board`, `/sparklines`, POST `/simulate` (`Edge.tsx` is unrouted).
- `model.js`: `/ask/:capability`, `/map`, `/state`, `/heads`.
- `/nfl-betting/explain/ai` and `/betting/explain/page/audits`.

**Services and functions with no live consumer:**
- `manager-archetypes.js`
- `manager-signals.buildManagerSignals`
- `manager-identity.matchIdentities`
- `counterparty-pricing.untouchablesFor`
- `league-brain.js` as a whole (only orphaned routes use it)
- `trend-exploits.js`, `position-liquidity.js`, `roster-risk.js` (only through brain routes)
- Untracked files: `coach-qb-context.js`, `efficiency-features.js`, `td-features.js`

**Data nobody reads or refreshes:**
- `negotiation_profiles`
- `trending_players` (empty)
- `league_transactions_raw`: only the manual `scripts/collect-league-transactions.mjs` fills it
- `manager_signals` and `manager_player_view`: built once, by hand
- `manager_profiles`: 0 rows, and no UI can write it

**Client files never used:** `Edge.tsx`, `Model.tsx`, `Projections.tsx`, `Rankings.tsx`, `features/model-lab/ModelRegistryPanel.tsx`, `components/StaleBanner.tsx`, and the `/edge` entry in `navigation.ts` `DEEP_DESTINATIONS`.

## 3. Recommendation per capability

- **A. Coach: re-engineer the floating assistant; don't build a second chat.**
  - Keep: the app-root mount, `usePageExplain`, the capped tool loop in `nfl-page-explain.js`, and the audit table.
  - Replace: the betting system prompt, the missing glossary and the 6 betting tools with fantasy tools that call the real services (plan, Trade Brain, `lineupCall`, `lineupPosture`, `waiverBoard`, `/news/signals`, manager read).
  - Reuse the `/sense-check` propose → verify → retry-once shape for the "every number must appear in a tool result" check.
  - Fold `/explain` in as a tool. Retire `tradelab /pitch`.
  - Fix `claude.js` `PRICING` (add Sonnet 5) before building the cost guard.
- **B. Action plan: build the deterministic plan service new, using the Decision Inbox for storage.**
  - `decision_recommendations` already handles deduplication, expiry and resolve/outcome.
  - Carry over `brainPlan`'s good ideas (rank by expected value, confluence, near-misses), but feed it from `waiver-wire` and the Trade Brain, not its own enumerator or `waiver-brain`.
  - Retire `trades.js /inbox` (dead news branch) and the post-draft framing. Fix the `/brain` link.
- **C. Trade Brain: extend `findTrades` and `counterparty-pricing`.** The per-manager "their value vs our value" layer is already there, so the valuation map is an extension, not a new build.
  - Wire in `negotiation_profiles` (`roster_read`, `best_bait`, `says_no`) and the `manager_archetypes` luck data.
  - Put `buildManagerSignals` and `matchIdentities` on the sync or scheduler for all 5 leagues.
  - Add the chat-read tables to the `findTrades` cache fingerprint. Remove the double 0.55. Pass `playoffOdds` from `season-sim`.
  - Apply the chat reads and timing weighting to `offerFor` and `offerForMany`.
  - Retire `league-brain`'s deal enumerator and acceptance curve, `/partners`, and `edge /trade`. Keep `sellHigh` as the input for the "hype window" tactic, reconciled with talk-vs-model's hot gap.
- **D. Dashboard: build the `/` page new.** The only precedent (`Home.tsx`) was deleted.
  - Compose from existing components: `MatchupPosture`, the waiver teaser, `TradeCard`, `TeamScout` pieces.
  - Take data only from the plan service, Trade Brain and Coach contracts. `LeagueHub` stays as the deep dive.
- **E. Matchup and opponent: extend `lineupPosture`** as the single matchup source (opponent id, projections, win chance).
  - **Build new** the opponent read: `selfScout(opponent)` plus manager signals, negotiation profile and archetype luck. Nothing does this today.
  - Settle the three-way lineup-objective overlap.
  - Revive `week-postmortem` for "last week" only after it grades with the projection as of that week.
- **F. News: extend `/news/signals` + `newsFantasyTracker` + `news-lag-trader`.** Together they already answer "what it changes" and "act before the league".
  - Scope to rosters and targets using the `/desk` priority logic.
  - Drop the `importance = 3` / `fantasy_impact` path.
- **G. Waivers: `waiver-wire.waiverBoard` is the single source.**
  - Re-engineer `waiver-brain` down to its shared helpers (`vegasLift`, `playoffWeight`, `sellHigh`).
  - Point `waiverUpgrades` and its inbox publishing at `waiverBoard`'s result.
  - Retire `/brain/waivers` and `/brain/free-agents`.
- **H. Chat DB: extend the existing path rather than re-reading it elsewhere.**
  - Add a server reader for `negotiation_profiles` inside `counterparty-pricing` (one loader).
  - Schedule the snapshot rebuild of `manager_player_view` and `manager_signals` (league 4 only today).
  - Cache `declarationCredibility` instead of opening the chat DB on every search.
