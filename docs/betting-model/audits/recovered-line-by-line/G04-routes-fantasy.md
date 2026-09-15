# G04-routes-fantasy — line-by-line audit of 18 fantasy/NFL-data route files

Reader: G04-routes-fantasy. Date: 2026-09-11. Repo: `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` (read-only).
Files read in full (6,158 lines, every line via `cat -n` / `sed -n`): accolades 311, aggregates 301, analysis 203, drafts 1190, draft-capture 80, espn 269, espn-connect 366, leagues 339, local-auth 181, news 349, nfldata 590, players 204, rankings 74, stats 216, teams 112, tradelab 367, trades 900, dev 106.
Supporting reads: `server/index.js` (156, full), `server/platform/legacy-access.js` (33, full), `server/platform/auth.js` (68, full), `server/platform/cors.js` (29), `client/src/api.ts` (1-80), `test/legacy-route-security.test.js` (1-80), `scripts/tunnel.mjs` (grep), `client/src/pages/Drafts.tsx` (10-35, 103), schema greps in `server/db/schema/core-and-fantasy.js`, one read-only `node:sqlite {readOnly:true}` snapshot of `server/data.sqlite` (counts/metadata only, no secret values printed).

## 0. Mount table and auth policy (server/index.js:71-104)

| Mount | Router | Auth at mount | Router-internal auth |
|---|---|---|---|
| `/api/auth` | local-auth.js | none | per-route `requireDirectLoopback` / `requireAuthenticated` |
| `/api/teams` | teams.js | none | none |
| `/api/players` | players.js | `legacyAuthenticated` | none |
| `/api/rankings` | rankings.js | none | none |
| `/api/drafts` | draft-capture.js then drafts.js | none | draft-capture: `requireAuthenticated` on its one route; drafts: `/:id/capture` (ingest-key auth) then `r.use(requireAuthenticated)` at drafts.js:285 |
| `/draft-capture.js` | `serveCaptureScript` | none | none (static JS) |
| `/api/espn` | espn.js | none | none |
| `/api/news` | news.js | `legacyAuthenticated` | also per-route `requireAuthenticated` (redundant) |
| `/api/aggregates` | aggregates.js | none | none |
| `/api/analysis` | analysis.js | none | none |
| `/api/leagues` | leagues.js | `legacyAuthenticated` | per-league `assertLeagueMember`/`assertCommissioner` |
| `/api/nfl` | nfldata.js | none | none |
| `/api/stats` | stats.js | none | none |
| `/api/dev` | dev.js | `legacyAdmin` | none |
| `/api/accolades` | accolades.js | none | none |
| `/api/tradelab` | tradelab.js | `legacyAuthenticated` | none (no per-league check) |
| `/api/trades` | trades.js | `legacyAuthenticated` | none (no per-league check) |
| `/api/espn-connect` | espn-connect.js | none | none (by design: bookmarklet from espn.com carries no bearer) |

`legacyAuthenticated = [requireAuthenticated, legacyRateLimit()]` (legacy-access.js:22); `legacyAdmin` adds `model:*` permission check (legacy-access.js:24-33). The server binds `127.0.0.1` only (index.js:135). The set of protected families is exactly the set the test `test/legacy-route-security.test.js:24-29` pins (leagues, news, players, tradelab, trades, dev), and index.js:70-71 says "all protected route families remain bearer-authenticated" — i.e. the split is **deliberate but not principled**: it protects "families that touch league/roster data" and leaves every sync/AI/admin-ish endpoint in the other families open. That is fine on loopback; it stops being fine the moment `scripts/tunnel.mjs:42` (`cloudflared tunnel --url http://127.0.0.1:5177`, a quick tunnel with no Cloudflare Access) is up for phone pairing — see defect D1.

**Is it deliberate?** Partially. The comments prove the five+dev families were retrofitted (leagues.js:12-22 "Authentication ... is applied by the mount site"), and the "public on loopback" provisioning was designed around them. Nothing in docs/CLAUDE-NEXT-STEPS.md mentions the split; nothing documents that `/api/analysis/refresh`, `/api/accolades/weakness/:abbr` (both spend Anthropic credits) or `DELETE /api/espn-connect/cookies` are intentionally anonymous. Treat as an accident of history.

**ESPN submission check (Nick rule: the app never submits ESPN picks):** PASS for this group. Every ESPN request in these files is a `fetch(url, { headers })` GET: espn.js:50, 81(accolades), 166(accolades), 237, 249; espn-connect.js:267; leagues.js:125; nfldata.js:50, 133, 226; stats.js:30, 187; accolades.js:81, 166. The only `method: 'POST'` string in any ESPN context is the bookmarklet source at espn-connect.js:113-117, which posts *from* the ESPN tab *to this app's own origin*. A repo-wide grep for non-GET `method:` found no request to any espn.com host. `services/espn-draft.js` (the live-draft mirror the drafts router calls) has two fetches (lines 59, 110), both GET.

## 1. Endpoint inventory (method path — auth — client caller)

Legend: **C** = called from `client/src` (grep of path strings), **S** = called from `scripts/` or `chrome-extension/`, **X** = no caller found outside test/ (dead from the UI), **sched** = the exported function is invoked by `server/services/scheduler.js`.

### accolades.js (`/api/accolades`, unauth)
- `POST /sync` (143) — X. `syncAccolades` is not scheduled (scheduler.js does not import accolades.js). DB: `player_accolades` 839 rows, only 8 with `source='wikipedia+espn'`, last fetched 2026-07-29.
- `GET /:abbr` (152) — X (TeamDetail gets accolade badges through `/teams/:abbr` → `unitGrades`).
- `POST /weakness/:abbr` (185) — X. Spends Anthropic credits. DB `slot_weakness` = **0 rows**: the "only path that can mark a slot weak" (162) has never been run, so `unitGrades()` (nfldata.js:534-541) can never produce `grade:'weakness'`.
- `POST /top100/sync` (298) — S via dev.js:95 `refresh-all`. DB nfl_top100 2026 = 100 rows (complete).
- `GET /top100/list` (302) — X.

### aggregates.js (`/api/aggregates`, unauth)
- `POST /sync` (184) — C. `GET /` (258) — C. `POST /create-board` (261) — C (unauth write into ranking_sets). `POST /refresh-all` (275) — C + S (bootstrap-data.mjs:95).
- Exports `syncDynastyValues` (leagues.js:205), `computeConsensus` (drafts.js, draft-assist.js), `trendPct` (players.js).

### analysis.js (`/api/analysis`, unauth)
- `POST /refresh` (130) — C. Spends Anthropic credits (up to 32 Haiku calls with `force:true`). `refreshStaleAnalyses` is also sched (scheduler.js:201).
- `GET /validate` (191) — C (TeamDetail).

### drafts.js (`/api/drafts`)
- `OPTIONS|POST /:id/capture` (260-283) — ingest-key auth, ESPN-origin CORS; caller is `client/public/draft-capture.js` running in the ESPN tab.
- everything below `r.use(requireAuthenticated)` (285):
- `POST /:id/ingest-key` (288) — X in client/src (only tests). `GET /:id/ingest-status` (297) — C.
- `GET /active` (311) — S (chrome-extension/background.js).
- `GET /` (325) — C (Drafts, Home, SidePanel). **Hides every mock draft — D3.**
- `POST /` (333) — C. `DELETE /:id` (398) — C. `GET /:id` (405) — C + S.
- `POST /:id/picks` (483) — C. `POST /:id/cpu-pick` (497) — C. `POST /:id/simulate` (533) — X (client uses cpu-pick loop and sim-to-end). `POST /:id/sim-to-end` (566) — C. `GET /:id/recommendation` (598) — C.
- `DELETE /:id/picks/last` (653) — C. `POST /:id/picks/redo` (662) — X. `POST /:id/picks/correct` (671) — X. `POST /:id/pause` (682) — C.
- `GET /:id/queue` (691) — X (client only PUTs). `PUT /:id/queue` (708) — C.
- `GET /:id/roster/:teamSlot` (724) — X. `GET|POST /:id/grade` (736/750) — C.
- `POST /live/link` (811) — C. `POST /:id/confirm-slot` (844) — X (the "Phase 3A" client ask-the-user flow was never wired; all 15 drafts in the DB have `my_slot_confirmed=1` anyway).
- `POST /:id/sync` (865) — C. `GET /:id/assist` (880) — C. `GET /:id/lookahead` (899) — C. `GET /:id/advice` (937) — C.
- `startDraftClockJob` (1174) — index.js:82.

### draft-capture.js (`/api/drafts`, mounted first)
- `GET /:id/capture-bookmarklet` (54, requireAuthenticated + actorForDraft) — C. `serveCaptureScript` → `GET /draft-capture.js` (index.js:87).

### espn.js (`/api/espn`, unauth)
- `GET /team-changes` (149) — X. `POST /sync-players` (153) — C + S; `syncPlayersFromESPN` sched (scheduler.js:139). `POST /sync-news` (260) — C; `syncGeneralNews`/`syncTeamNewsFeed` sched (scheduler.js:512-521). `backfillNewsEntities` (210) — exported, no importer anywhere (dead export; DB shows 0 news rows with null entities/published_at, so the one-time backfill has already run).
- Client MyTeam.tsx:14 still *mentions* `/espn/settings` and `/espn/league` in a comment only; no live call. Those routes are gone (espn.js:19-26).

### espn-connect.js (`/api/espn-connect`, unauth by design)
- `GET /bookmarklet` (143) — C. `OPTIONS|POST /cookies` (193-194) — C (paste box) + bookmarklet. `GET /status` (238) — C. `DELETE /cookies` (249) — C. `GET /discover` (322) — C. `POST /add` (333) — C.

### leagues.js (`/api/leagues`, legacyAuthenticated + per-league checks)
- `GET /` (24) — C. `POST /` (32) — X in client (EspnConnect uses `/espn-connect/add`); tests only. `PUT /:id` (47) — C (MyTeam sets my_team_id). `GET /:id/removal-impact` (69) — C. `DELETE /:id` (90) — C. `POST /:id/sync` (181) — C; `syncEspnLeague`/`syncSleeperLeague` sched (scheduler.js:171-179). `GET /:id/data` (228) — C (MyTeam). `GET /:id/analysis` (289) — C (Leagues page `/leagues/${sel}/analysis`).

### local-auth.js (`/api/auth`)
- `POST /local-session` (57) — C (api.ts) + S (start.mjs, bootstrap-data.mjs, chrome-extension). `POST /tunnel-url` (98) — S (tunnel.mjs:47). `GET /tunnel-url` (107) — S (launcher.mjs:63). `GET /pairing-info` (109) — C. `POST /pairing-code` (122) — C. `POST /pair` (156) — C (pair page).

### news.js (`/api/news`, legacyAuthenticated; every route re-wraps `requireAuthenticated`)
- `POST /ingest` (26) — C. `GET /desk` (57) — C. `GET /` (104) — C. `GET /dates` (117) — C. `POST /` (122) — C. `DELETE /:id` (137) — C. `POST /analyze` (144) — C. `GET /my-players` (207) — C. `GET /signals` (222) — C. `GET /twitter-status` (260) — C. `POST /:id/explain` (269) — C. `POST /roundup` (314) — C.

### nfldata.js (`/api/nfl`, unauth)
- `POST /sync-depth` (265) — X. `POST /sync-rosters` (269) — X (`syncRosters` sched scheduler.js:154 and dev refresh-all). `POST /sync-schedules` (272) — X. `POST /sync-cap` (275) — X. `POST /sync-all` (279) — S (bootstrap-data.mjs:90). `GET /sos` (324) — X. `GET /offseason/:abbr` (327) — C. `GET /:abbr/schedule` (387) — C. `GET /roster/:abbr` (463) — X. `GET /grades/:abbr` (584) — X (TeamDetail reads grades from `/teams/:abbr`).
- Exports used elsewhere: `unitRoster`, `computeSOS` (analysis.js, players.js), `unitGrades` (teams.js), `syncDepthChart/syncSchedules/syncCap` (dev.js), `OL_SLOTS`, `SEASON`.

### players.js (`/api/players`, legacyAuthenticated)
- `GET /` (38) — C. `GET /:id` (50) — C. `GET /:id/gamelog` (100) — C (PlayerCard, no `?season`). `POST /:id/analyze` (160) — C.

### rankings.js (`/api/rankings`, unauth)
- `GET /` (7) — C. `POST /` (13) — C. `DELETE /:id` (25) — C? (no DELETE caller found in client/src grep; the Rankings page creates/copies sets; treat as X). `GET /:id/entries` (30) — C. `PUT /:id/entries` (47) — C. `POST /:id/entries` (65) — C.

### stats.js (`/api/stats`, unauth)
- `POST /sync` (77) — S (bootstrap-data.mjs:94; dev refresh-all). `GET /projections` (135) — X. `GET /teams` (164) — X.
- Exports `statsFor`, `statsMap`, `fetchGameLog`, `syncStats` — used by players.js, rankings.js, drafts.js, draft-assist.js, dev.js. The router itself is nearly dead from the UI; the module is a live library.

### teams.js (`/api/teams`, unauth)
- `GET /` (13) — C + S (health probe in start.mjs, tunnel.mjs, start-smoke.mjs, chrome-extension). `GET /:abbr` (53) — C. `GET /:abbr/tendencies` (94) — C. `PUT /:abbr` (100) — X (unauthenticated write to nfl_teams that nothing calls).

### tradelab.js (`/api/tradelab`, legacyAuthenticated, **no per-league authorization**)
- `GET /:leagueId/analysis` (200) — X. `GET /:leagueId/partners` (212) — X. `POST /:leagueId/pitch` (263) — X (spends credits). `POST /trending/sync` (336) — S (bootstrap-data.mjs:99). `GET /trending` (357) — X. DB `trending_players` last fetched 2026-08-03.
- The string `tradelab` does not occur in client/src at all. The module survives because `analyzeLeague` is imported by `services/trade-engine.js` and `routes/decision-inbox.js`.

### trades.js (`/api/trades`, legacyAuthenticated, **no per-league authorization** — `league()` at 61-66 only checks existence)
- C: `scout`, `post-draft-plan`, `brain/plan`, `brain/managers` (GET+POST), `trends` (`/:leagueId/trends`), `trends/scan`, `trends/watch`, `regression` (`/:leagueId/regression`), `lineup`, `news-edge`, `ceiling-lineup`, `title-trades`, `inbox`, `lineup-diff`, `find`, `find/sequences`, `offer`, `offer-many`, `evaluate`, `rosters`, `player/:id`, `dvp` (+S bootstrap-data.mjs:112), `sense-check`, `explain`.
- X: `brain/state` (124), `brain/waivers` (154), `brain/sell-high` (165), `brain/free-agents` (176), `brain/bye-risk` (185), `brain/fragility` (193), `brain/liquidity` (201), `trends/team/:team` (228), `trends/player/:playerId` (240), `regression/board` (298), `regression/rates` (309), `postmortem` (405), `splits/:playerId` (633).

### dev.js (`/api/dev`, legacyAdmin)
- C: `GET /status`, `PUT|DELETE /key`, `PUT|DELETE /workspace-id`, `GET /player-identity/repair-plan`, `GET /sources`, `POST /refresh-all`. X: `GET /usage` (58), `GET /player-identity/gsis-conflicts` (60), `GET /player-identity/team-position-duplicates` (61).

## 2. Per-file sections

### server/routes/accolades.js (311 lines) — verdict: acceptable code, dead feature
Purpose: Wikipedia infobox accolade scraper + ESPN draft pedigree per depth-chart starter; Claude "weakness review"; NFL Top 100 scrape. Reads `roster_players`, `player_accolades`, `nfl_teams`, `nfl_top100`; writes `player_accolades`, `slot_weakness`, `nfl_top100`; external: en.wikipedia.org, sports.core.api.espn.com, site.web.api.espn.com, Anthropic (via services/claude.js).
Wiring: default export mounted unauth at index.js:93; `syncTop100` imported by dev.js:80; `top100Map` (308) has no importer (dead export; nfldata.js:476 re-implements the same map inline).
Defects:
- P2 D2 — `POST /weakness/:abbr` (185-242) is the only writer of `slot_weakness`, is never called by the client, and DB has 0 rows; therefore the `weakness` grade branch in nfldata.js:534-541 is unreachable. Product claim "AI weakness review" is dead.
- P3 — `export default r;` at line 160 precedes route registrations at 185, 298, 302 (works because registration happens at module eval, but reads as if those routes are unexported).
- P3 — `run` imported at line 2, never used.
- P3 — unauthenticated paid-API trigger (`/weakness/:abbr` 185) — folded into D1.

### server/routes/aggregates.js (301) — verdict: good
Purpose: FFC ADP, Sleeper rank/injury, FantasyCalc redraft + format-keyed dynasty values, consensus board, "refresh-all". Reads `players`, `leagues`, `nfl_teams`, `player_metrics`, `espn_player_market`; writes `player_metrics`, `players.sleeper_id`, `dynasty_values`, `pick_values`, `ranking_sets/entries`. External: fantasyfootballcalculator.com, api.sleeper.app, api.fantasycalc.com.
Wiring: mounted unauth (index.js:89); `syncDynastyValues` ← leagues.js:205; `computeConsensus` ← drafts.js:3, draft-assist.js; `trendPct` ← players.js:3. `syncFantasyCalc` (85) reads the *first* league's format (`ORDER BY id LIMIT 1`, line 87) for the flat `fc_value` metric — every consumer of `player_metrics.fc_value` (players.js, rankings.js, nfldata.js computeSOS/unitGrades, leagues.js analysis) is therefore priced for league 1 (10-team 1-QB PPR) regardless of which league is being viewed; the format-correct `dynasty_values` table exists for tradelab/trade-engine only. Documented by the comment at 121-126, so P3, not P2.
Defects:
- P3 — `/create-board` (261) and `/sync`/`/refresh-all` unauthenticated writes/fetch-fanout (D1).
- P3 — `syncFFC` season = `NFL_SEASON || getFullYear()` (186) while accolades/stats/nfldata default `|| 2026` — harmless today (both 2026) but three different defaults exist across the group.

### server/routes/analysis.js (203) — verdict: acceptable
Purpose: Claude rewrite of the 8 free-text team analysis fields + guarded HC/OC/DC correction; stale-name validator. Reads `nfl_teams`, `players`, `news_items`, `team_cap`, `roster_players`; writes `nfl_teams.*_analysis`, `head_coach/oc_name/dc_name`, `analysis_updated_at`.
Wiring: mounted unauth (index.js:90); `refreshStaleAnalyses` ← scheduler.js:201 (timer-driven Claude spend, self-limited to teams with newer news; DB shows analysis_updated_at between 2026-09-09 and 2026-09-11, so it is running).
Defects:
- P2 D5 — `POST /refresh` (130-136) is anonymous and `force:true` (105-106) rewrites all 32 teams in one call (≈32 Haiku calls with 3000 max output tokens each) — the cheapest way for anyone reaching the port to spend Nick's credits. Part of D1.
- P3 — STAFF_FIELDS (16, 78-82): the model may overwrite `head_coach` even though nfldata.js:94-98 now syncs head_coach from ESPN; a hallucinated hire would be re-corrected on the next roster sync, oc/dc would not. Prompt-gated only (71-73).
- P3 — `refreshTeam(_client, …)` (31) and `const client = null` (99): vestigial parameter.

### server/routes/drafts.js (1190) — verdict: acceptable, one real listing bug
Purpose: mock-draft CPU brain, draft room CRUD/picks/queue/clock, in-page ESPN capture ingest, deterministic assist + Monte Carlo lookahead + verified Claude advice, live-draft link/sync, draft grade. Reads/writes `drafts`, `draft_picks`, `draft_team_ownership`, `draft_advice`, `draft_team_grades`, `ranking_*`, `players`; delegates to `draft/store.js`, `services/draft-ingest.js`, `services/espn-draft.js`, `services/draft-assist.js`, `services/draft-lookahead.js`.
Auth: `/:id/capture` is key-authenticated (268) with a per-source failure limiter (243-258); everything after 285 requires a session; per-draft authorization via `draftAccess` (41-53) and `ownedSlot` (55-59).
Defects:
- **P2 D3 — mock drafts are invisible in `GET /api/drafts`.** Line 328: `FROM drafts d JOIN league_memberships lm ON lm.league_id = d.league_row_id AND lm.user_id = ?` is an INNER JOIN; a mock draft has `league_row_id IS NULL` by design (comments 44-49, 338-342; client `Drafts.tsx:10` never sends one). DB confirms 11 of 15 drafts are mocks with NULL league_row_id (ids 4,5,6,10,11,12,13,14,15,16,21) and none can appear on the Drafts page, Home "Continue draft" (Home.tsx:54) or SidePanel. The user only ever reaches a mock through the post-create `nav()` (Drafts.tsx:22). `GET /:id` works because `draftAccess` special-cases NULL (49-51), so the room opens by URL but the list denies it exists.
- P3 D3b — `POST /` line 382 binds `Number(league_row_id)`: `Number(undefined)`→NaN→NULL only because SQLite coerces NaN to NULL; an explicit `league_row_id: null` becomes **0**, and `draftAccess` then calls `assertLeagueMember(userId, 0)` → 403 on every subsequent request to that draft. Should be `league_row_id ?? null`.
- P3 — `handleDraftError(e, res, () => {})` (345, 399, 407, 499, 501, 535, 537, 568, 570, 600, 602, 726, 738, 740): any error without a 400/401/403/404/409 status (a DB error, a thrown TypeError) is swallowed by the no-op `next`, leaving the request with no response until the client times out.
- P3 — `POST /` accepts `type` ∈ `['mock','live_tracking']` (350) but `services/espn-draft.js:203/227/245` create and require `type='live'`; a `live_tracking` draft created here can never `syncLiveDraft` (`draft.type !== 'live'` at espn-draft.js:245). DB shows all real live drafts are `'live'`. Also `status` values `complete` vs `completed` coexist (draft 21 `completed`, 17/18/22 `complete`).
- P3 — `/:id/queue` GET (691) and `/:id/roster/:teamSlot` (724), `/picks/redo`, `/picks/correct`, `/confirm-slot`, `/:id/simulate` have no client caller.
- P3 — `lookaheadCache` (898) is process-global, unbounded until 64 then cleared; fine.

### server/routes/draft-capture.js (80) — verdict: good
Purpose: bookmarklet builder for the ESPN-tab WebSocket capture; serves `client/public/draft-capture.js`. Reads `getTunnelUrl()` from local-auth.js. Correctly refuses to mint an ingest key itself (33-43). Mounted before drafts.js so `/:id/capture-bookmarklet` wins (index.js:80-84). No defects. Note that `LOCAL_ORIGIN` (17) is `http://localhost:…`, so without a tunnel the ESPN https page blocks the loader — the route says so in `warnings` (68-70).

### server/routes/espn.js (269) — verdict: acceptable
Purpose: ESPN fantasy player-universe sync (source of truth for `players`, offensive depth chart rebuild, team-change audit trail), ESPN public news → `news_items` with entity extraction. Reads/writes `players`, `player_team_changes`, `news_items`. Cookies from `espnCookies()` are sent to a *public* default-league endpoint (44-49) — read only.
Wiring: mounted unauth (index.js:86); `syncPlayersFromESPN` ← scheduler.js:139, aggregates.js:3, dev.js:78; news syncs ← scheduler.js:512.
Defects:
- **P2 D4 — `_playerIdentityCache` (157-162) is never invalidated.** The comment says "cached per process-tick" but it is a module-level `let` with no reset; after the first news ingest the entity resolver never sees players added/renamed by later `syncPlayersFromESPN` runs (which mutate `players` at 101-114) until the server restarts. The live server has been up through Week 1 capture; any rookie promoted to `fantasy_relevant` after the first news pull is invisible to `extractEntities` here, and therefore to `nfl_news_signals` — the exact failure mode lines 164-172 describe fixing.
- P3 — `insertArticles` dedups on `headline` equality only (179): two different stories with the same headline (weekly "Injury report" style) collapse; acceptable.
- P3 — `backfillNewsEntities` (210) exported, no importer, its work is done (0 null rows in DB) — delete.

### server/routes/espn-connect.js (366) — verdict: acceptable (by-design anonymous), one leak-ish path
Purpose: bookmarklet + paste-box capture of `espn_s2`/`SWID`, validation against ESPN's fan API before persisting, league discovery, add-league. Reads/writes `app_settings` (`espn_s2`,`swid`), `leagues.espn_s2/swid/...`, `league_memberships`. External: fan.api.espn.com (GET).
Defects:
- P2 D6 — `DELETE /cookies` (249-253) is anonymous and wipes credentials from `app_settings` and every ESPN league row. Through a tunnel this is one curl away from breaking every ESPN sync; on loopback it is only reachable by Nick. `POST /cookies` (194) is anonymous by necessity but validates against ESPN first, so a stranger can only *replace* Nick's connection with their own valid cookies (app_settings 223-226 overwritten; league rows guarded by `swid = ?` at 231). Part of D1.
- P3 — `POST /add` (333-364) grants membership only when a bearer token happens to be present (357-361); an anonymous add produces a memberless league that leagues.js:190-194 later self-heals to whoever syncs first. Works for single-user; documented.
- P3 — `GET /status` (238) anonymous, exposes masked previews + league ids. Low.

### server/routes/leagues.js (339) — verdict: good
Purpose: league CRUD, ESPN/Sleeper payload sync, disconnect-vs-purge, roster needs/surplus analysis. Per-league authorization added (12-22). Purge transaction (102-114) deletes draft_picks then drafts — FK cascade would handle the other draft_* tables (schema lines 128,187,533,555,569,584 all `ON DELETE CASCADE`).
Defects:
- P2 D7 — `GET /:id/data` (228-233) returns `...lg` including raw `espn_s2` and `swid` to any league *member* (not commissioner) — MyTeam.tsx:27 loads this on every visit, so the ESPN session cookie travels to the browser (and over the tunnel to the phone) each time. The client only uses `payload`; strip the two columns.
- P3 — `POST /` (33) defaults `season = new Date().getFullYear()` (not `NFL_SEASON`); same value today.
- P3 — `POST /:id/sync` (190-194) grants commissioner to any authenticated caller for a memberless league; acceptable on a single-owner install, documented.

### server/routes/local-auth.js (181) — verdict: good
Purpose: loopback auto-provisioning of the single local owner (commissioner of every league + `model:*`), tunnel URL registry, phone pairing codes, redeem with per-source limiter. The forwarded-header check (22-28) is what keeps a tunnel from counting as loopback — correct and load-bearing.
Defects:
- P3 — `issueSession` (37-45) never caps live sessions; `api.ts` re-provisions on any 401, and the DB holds **112 live 90-day sessions** for user 1. Hygiene, not security (tokens are hashed).
- P3 — `redeemSource` (143-145) trusts `x-forwarded-for` when `cf-connecting-ip` is absent; a direct-LAN scanner could rotate the header to dodge the 10/15-min limit. Server is loopback-bound, so only relevant behind a non-Cloudflare proxy.

### server/routes/news.js (349) — verdict: good
Purpose: RSS ingest trigger with 60s global cooldown, ranked news desk, CRUD, Claude analyze/explain/roundup, typed signal feed, Twitter spend status. Roster scoping via `league_memberships` (178-204). Audit records on mutations.
Defects:
- P3 — `POST /roundup` prompt (331) and `/analyze` (156) still say "training-camp" — in Week 1 the copy is stale; output quality only.
- P3 — `DELETE /:id` (137) has no ownership check on the news item (single user).

### server/routes/nfldata.js (590) — verdict: good
Purpose: ESPN 90-man rosters (+head coach), schedules (regular season only), OverTheCap cap table, ESPN core depth charts, SOS, offseason overview, week schedule with lines+DvP, unit rosters and deterministic unit grades. Reads/writes `roster_players`, `schedule_games`, `team_cap`, `nfl_teams.head_coach`, reads `game_lines`, `player_metrics`, `player_accolades`, `slot_weakness`, `nfl_top100`, `player_season_stats`.
Defects:
- P3 — `syncSchedules` marks any partial result `'error'` (156) while `syncRosters` distinguishes `'partial'` (108-110); the source-registry confidence floor the roster fix was made for still bites schedules and depth charts (261).
- P3 — `unitGrades` join `LEFT JOIN player_season_stats ps ON ps.player_id = p.id AND ps.kind='projected'` (490-491) has no season filter; with one projected season in the DB it is fine, but next year it will double rows per starter.
- P3 — all four `/sync-*` routes and `/sos`, `/roster/:abbr`, `/grades/:abbr` are uncalled from the UI (library exports are what matter).

### server/routes/players.js (204) — verdict: good
Purpose: player list/detail (with depth chart, metrics, ranks, news, stats, weekly projection), ESPN game log proxy, evidence-grounded BUY/SELL/HOLD verdict where Claude only picks evidence ids (145-157 — a genuinely good anti-hallucination design).
Defects:
- P3 — `/:id/gamelog` defaults to `NFL_SEASON - 1` (114) and PlayerCard.tsx:27 never passes `?season`, so the "Game log" tab shows 2025 all through the 2026 season; the response carries `season` so the client *could* label it.
- P3 — `newsFor` LIKE matching (26-36) on `%name%` is fine; the last-name branch is team-scoped, as the comment claims.

### server/routes/rankings.js (74) — verdict: acceptable
Purpose: ranking sets and entries CRUD, unauthenticated.
Defects:
- P3 — `DELETE /:id` (25-28) on a set referenced by `drafts.ranking_set_id` (schema core-and-fantasy.js:121, `REFERENCES ranking_sets(id)` with no ON DELETE) throws `FOREIGN KEY constraint failed` → 500 via the error handler. DB: both sets (ids 1,2) are referenced by drafts.
- P3 — unauthenticated writes (D1). No id validation (`req.params.id` passed raw; bound as text, harmless).

### server/routes/stats.js (216) — verdict: good
Purpose: ESPN season projections (statSourceId 1, season) + prior-season actuals (statSourceId 0, season-1) for top 800; `statsFor`/`statsMap` helpers; live game-log proxy. DB: 649 projected 2026, 851 actual 2025.
Defects:
- P3 — `fetchGameLog` (185) declared after `export default` (182); style only.
- P3 — `/projections` and `/teams` have no caller.

### server/routes/teams.js (112) — verdict: acceptable
Purpose: team list, team detail with season-ending-aware depth chart (`depth` and `depth_multi` both patched — 79-84), tendencies, editable scheme/staff fields.
Defects:
- P3 D8 — `PUT /:abbr` (100-110) is an unauthenticated write to `nfl_teams` (14 columns incl. head_coach) with no caller in client/src; dead and open. Part of D1.

### server/routes/tradelab.js (367) — verdict: messy (dead router, live library)
Purpose: Andrew-model needs/surplus/contention window (`analyzeLeague`), partner matchmaking, Claude offer ladder, Sleeper trending adds/drops.
Wiring: router mounted behind `legacyAuthenticated` (index.js:95) but **no route here is called by the client**; `analyzeLeague` is consumed by `services/trade-engine.js` and `routes/decision-inbox.js`; `trending/sync` is hit by `scripts/bootstrap-data.mjs:99` only (DB last fetch 2026-08-03 — stale by 5+ weeks, and nothing schedules it).
Defects:
- P3 — no per-league authorization on `/:leagueId/*` (200, 212, 263) — same gap leagues.js closed; single-user so P3.
- P3 — `trending_players` is never refreshed after bootstrap; `GET /trending` (357) would serve 5-week-old data if anything read it.

### server/routes/trades.js (900) — verdict: good
Purpose: the trade-engine API surface — self scout, post-draft plan, league brain, waivers, trends, regression, lineup calls, inbox, finder/sequences/offers/evaluate, rosters, DvP/splits, verified sense-check (propose→simulate→retry-once), negotiation copy. All deterministic except `/sense-check` and `/explain`; both re-derive evidence and ownership server-side (669-671, 820-844) rather than trusting the client body — good.
Defects:
- P3 — `league()` (61-66) does not check `league_memberships`; every `/:leagueId/*` route serves any authenticated user any league. Same as tradelab; single-user.
- P3 — 13 routes have no client caller (listed in §1): brain/state, waivers, sell-high, free-agents, bye-risk, fragility, liquidity, trends/team, trends/player, regression/board, regression/rates, postmortem, splits. They wrap real services; the UI simply never surfaced them.
- P3 — `POST /:leagueId/brain/managers/:rosterId` (337) writes with no per-league check (single user).

### server/routes/dev.js (106) — verdict: good
Purpose: API key / workspace-id management, usage, data freshness, identity-repair diagnostics, source registry, one-button refresh-all. Correctly behind `legacyAdmin`.
Defects:
- P3 — `rows` imported (3), unused.
- P3 — `/usage`, `/player-identity/gsis-conflicts`, `/player-identity/team-position-duplicates` have no client caller.

## 3. Cross-cutting defects (numbered, with severity)

**D1 (P1, conditional on the tunnel) — unauthenticated money/credential/write endpoints are exposed by the phone tunnel.**
- Money: `POST /api/analysis/refresh` (analysis.js:130; `force:true` → 32 Haiku calls), `POST /api/accolades/weakness/:abbr` (accolades.js:185).
- Credentials: `DELETE /api/espn-connect/cookies` (espn-connect.js:249) wipes `app_settings` + every league's cookies; `POST /api/espn-connect/cookies` (194) lets a stranger swap in their own valid cookies.
- Data writes: `PUT /api/teams/:abbr` (teams.js:100), `POST/PUT/DELETE /api/rankings…` (rankings.js:13,25,47,65), `POST /api/aggregates/create-board` (aggregates.js:261), all `/api/nfl/sync-*`, `/api/espn/sync-*`, `/api/stats/sync`, `/api/aggregates/refresh-all` (external fan-out DoS).
- Precondition: `scripts/tunnel.mjs:42` runs a Cloudflare *quick* tunnel (`cloudflared tunnel --url http://127.0.0.1:5177`) with no Access policy; `isDirectLoopback` (local-auth.js:22-28) correctly treats tunnel traffic as remote for the auth family, but the mount table (index.js:73-104) leaves these families with no auth at all. On plain loopback (no tunnel) the exposure is nil.
- Fix: put `...legacyAuthenticated` in front of `/api/analysis`, `/api/accolades`, `/api/rankings`, `/api/aggregates`, `/api/nfl`, `/api/stats`, `/api/espn`, `/api/teams` mutations (or a router-level `r.use(requireAuthenticated)` after the GETs the launcher/extension probe: `GET /api/teams` is the health probe at start.mjs:18, tunnel.mjs:32, start-smoke.mjs:27, chrome-extension). For espn-connect, gate `DELETE /cookies` and `/add` on `requireAuthenticated` (the UI always has a token there) and leave only the bookmarklet `POST /cookies` open.

**D2 (P2) — weakness review unreachable → `grade:'weakness'` can never render.** accolades.js:185 has no caller; `slot_weakness` has 0 rows; nfldata.js:534-541 depends on it.

**D3 (P2) — `GET /api/drafts` hides all mock drafts.** drafts.js:328 INNER JOIN on `league_memberships` vs NULL `league_row_id`; 11 mock drafts in DB invisible. Fix: `LEFT JOIN … WHERE (d.league_row_id IS NULL AND EXISTS(SELECT 1 FROM draft_team_ownership o WHERE o.draft_id=d.id AND o.user_id=?)) OR lm.user_id=?`. D3b (P3): drafts.js:382 `Number(league_row_id)` turns an explicit `null` into `0`.

**D4 (P2) — ESPN news entity cache never invalidated.** espn.js:157-162; players added by later syncs are never resolved into `entities_json` until restart.

**D5 (P2, folded in D1) — anonymous Claude spend.** analysis.js:130-136, accolades.js:185.

**D6 (P2, folded in D1) — anonymous credential wipe/replace.** espn-connect.js:249, 194-226.

**D7 (P2) — raw ESPN cookies returned to the browser.** leagues.js:228-233 (`res.json({ ...lg, … })`), consumed by MyTeam.tsx:27 which only needs `payload`.

**D8 (P3) — dead unauthenticated write.** teams.js:100 `PUT /:abbr`.

Other P3s are listed per file above (handleDraftError swallow, live_tracking vs live, FK on ranking_sets delete, session accumulation, stale training-camp prompt wording, gamelog season default, unused imports, dead exports `top100Map`/`backfillNewsEntities`, partial-vs-error sync status, dead client-facing routes in tradelab/trades/nfldata/stats/dev).

## 4. Data flows (as read)
- ESPN player universe → `players` (espn.js:38-146) → consensus (aggregates.js:215) → draft pools (drafts.js:77-113) and boards; scheduler.js:139 runs it.
- ESPN rosters/depth/schedule + OverTheCap → `roster_players`, `schedule_games`, `team_cap` (nfldata.js) → team detail depth chart (teams.js:61-87), unit grades (nfldata.js:475), SOS (293) → player verdict evidence (players.js:129-143), analysis prompt (analysis.js:31-57).
- ESPN cookies: bookmarklet/paste → `app_settings` + `leagues` (espn-connect.js:223-231) → `espnCookies()` (services/espn-draft.js:27) → player sync header (espn.js:48-49), league sync (leagues.js:124), live draft mirror; leaked back out via leagues.js:232 (D7).
- League payload (leagues.js:146-150/170-177, scheduler.js:171) → tradelab `analyzeLeague` → trade-engine/decision-inbox; trades.js routes read `leagues.payload` through `services/trade-engine.js`.
- News: ESPN API (espn.js:174-203, scheduler.js:512) + RSS ingest (news.js:26) → `news_items` with `entities_json` → `nfl_news_signals` (services) → news.js `/signals`, `/desk`; analysis.js refresh gate (108-110); teams.js season-ending override (33-51).
- Drafts: ESPN tab → `/draft-capture.js` loader (draft-capture.js) → `POST /api/drafts/:id/capture` (drafts.js:261, ingest key) → `services/draft-ingest.js`; room state `GET /:id` → assist/lookahead/advice (`draft_advice` cache, drafts.js:943-946, 1159-1162).
- Auth: `POST /api/auth/local-session` (loopback only) → token in localStorage (api.ts:36-40) → `Authorization: Bearer` → `requireAuthenticated` on the six protected families; phone: pairing code (local-auth.js:122) → `/pair` (156) → 30-day token.

## 5. Open questions
- Is leaving `/api/analysis`, `/api/accolades`, `/api/rankings`, `/api/aggregates`, `/api/nfl`, `/api/stats`, `/api/espn`, `/api/teams` unauthenticated a conscious "public data" decision, or just the families the 2026-09 auth retrofit did not reach? Nothing in docs/ says.
- Should mock drafts be listed at all now that the 2026 drafts are done (D3 affects practice tooling only)?
- `trending_players` last synced 2026-08-03 and nothing schedules `/tradelab/trending/sync` — is Sleeper trending meant to feed waivers in-season, or is it a dead bootstrap-only artefact?
- `player_accolades` are 5+ weeks old and only 8/839 rows are Wikipedia-verified — is the accolade layer (which drives `unitGrades` badges on every team page) worth keeping if `syncAccolades` is never scheduled?
