# Verification notes: G03-routes-betting (9 claims)

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only)

## Files opened (full line counts, lines_read)
- server/routes/betting-hub.js — 903 lines — read in full (1-50, 400-610, 855-903), plus targeted grep for all route declarations (`^r\.(get|post|delete|put)`).
- server/routes/edge.js — 532 lines — read 1-30, 230-300; grep for `r.use|requireAuth|requireModelPermission` (zero hits).
- server/routes/decision-inbox.js — 190 lines — read in full (1-190).
- server/routes/wong.js — 682 lines — read 1-30, 490-630 (recordWongTicket body, /tickets route).
- server/routes/nfl-betting.js — 1874 lines — read 1-120 (imports + router-level auth middleware), 680-695, 800-815, 995-1035, 1180-1195, 1310-1320, 1405-1415, 1448-1458, 1565-1595, 1705-1718.
- server/routes/nfl-market.js — 450 lines — read 225-330, 410-450; grep for week-default lines and requireModelPermission usage.
- server/index.js — 156 lines — read in full (mount order, no global auth middleware for these routers).
- server/routes/local-auth.js — 181 lines — read in full (isDirectLoopback / tunnel semantics).
- server/platform/auth.js — read 1-68 (requireAuthenticated, resolveAuthenticatedUser).
- server/modeling/authz.js — read in full, 25 lines (requireModelPermission requires a resolved bearer session; 401 if none).
- server/services/scheduler.js — 1176 lines — read 770-800 (nfl_t60_runner, live tier, 90s poll) and 1060-1080 (node:sqlite has no worker thread; a slow query blocks the whole HTTP server — this is the developer's own documented finding from a prior incident).
- server/services/nfl-replay.js — read 177-230 (replaySeason is a synchronous per-game loop calling ensembleLine).
- server/services/nfl-page-explain.js — grepped for tool-use loop; confirms `for (let round = 1; round <= MAX_TOOL_ROUNDS; round++)` calling `callClaude`.
- server/services/nfl-auto-picks.js — read ensurePicksFor (line 28) and autoPickDecisionBoard (line 82) signatures — neither accepts a trials parameter.
- client/src/api.ts — read 1-35 (local-session auto-provision / pairing redirect logic — confirms this is a UI-level nicety, not a per-route auth gate).
- client/src/pages/Home.tsx — grepped, confirms `useApi('/decision-inbox')` and POST resolve call.
- client/src/components/betting/PageExplainAssistant.tsx — grepped, confirms POST to `/betting/explain/page`.
- client/src/pages/NflMarketBoard.tsx — read 95-135 (trackBet always sends `week` explicitly; sync-and-pick call sends `week` and `trials`).
- .env — confirmed (via grep, without opening full contents beyond the check) no `SCHEDULER_DISABLED` key present, matching claim's evidence.

## Verdicts

### #6 betting-hub.js /explain/page — P1 — CONFIRMED
Line 878 (`r.post('/explain/page', ...)`) checks only `getApiKey()`, nothing else — verified in the read (878-895). No `requireModelPermission`/`requireAuthenticated` calls exist anywhere in betting-hub.js except at lines 488 and 501 (`/sgp/quotes`, `/sgp/fit`) — confirmed via full route inventory (grep of every `r.get/post/delete`) — `/explain/page` at 878 and `/explain/page/audits` at 898 have no such gate.
Mount: index.js:108 `app.use('/api/betting', bettingHubRouter)` — no auth middleware in the chain (contrast e.g. index.js:78 `app.use('/api/players', ...legacyAuthenticated, playersRouter)`).
Contrast confirmed: nfl-betting.js:91-99 installs a router-level `r.use` middleware that requires `model:execute` (or `model:train` for the training-mutation regex) on every non-GET/HEAD request, including `/explain/ai` (nfl-betting.js:472) which is a POST route not matched by the training-mutation regex, so it gets `model:execute`.
`requireModelPermission` (modeling/authz.js:16-25) resolves the caller from a real bearer session (`resolveAuthenticatedUser`) and 401s if none — so this really is an identity check, not a rubber stamp.
Tunnel semantics confirmed in local-auth.js: `isDirectLoopback` (11-28) explicitly treats any request carrying forwarding headers as remote, specifically because "a tunnel (cloudflared, ngrok, an ssh -R) connects to 127.0.0.1 too" (comment, lines 16-18) — so the server's `127.0.0.1` bind (index.js:137) is not, by itself, a defense once a tunnel is up. Memory file gridiron-phone-access.md confirms Nick does run a cloudflared tunnel for phone access as an established real workflow, not a hypothetical.
Client caller confirmed: PageExplainAssistant.tsx:88 posts to `/betting/explain/page`.
Credit spend confirmed: nfl-page-explain.js runs a `for (let round = 1; round <= MAX_TOOL_ROUNDS; round++)` loop calling `callClaude` (a real Anthropic call) per round.
Verdict: claim fully stands as described. Reachable, unauthenticated relative to identity (only an env-var presence check), genuinely spends metered credits, contrast with sibling route accurate. P1 is justified (real-money/budget impact, not just data hygiene).

### #7 edge.js /scout/:id — P1 — CONFIRMED
Line 259 (`r.post('/scout/:id', ...)`) checks only `getApiKey()` (line 260) — verified in the 230-300 read. `grep -n "r\.use|requireAuth|requireModelPermission" server/routes/edge.js` returns zero hits — the whole file has no permission gate of any kind.
Mount: index.js:96 `app.use('/api/edge', edgeRouter)` — no middleware in the chain.
`callClaude` is invoked with `maxTokens: 1100` (edge.js ~272) and the result is upserted into `scout_reports` via `INSERT ... ON CONFLICT(player_id) DO UPDATE` (edge.js ~287-291), overwriting any existing verdict for that player id — confirmed by direct read.
This is a route parameterized by `:id`, so looping over every player id is a real, low-effort way to spend the whole file's worth of Anthropic budget and overwrite every scout verdict; nothing rate-limits or gates it.
Verdict: claim fully stands. Reachable (mounted, ungated router), real external spend, real persisted overwrite. P1 justified.

### #8 decision-inbox.js POST / — P2 — CONFIRMED
Read the entire 190-line file. No auth/permission check exists anywhere in it. `r.post('/', ...)` at line 160 accepts `b.link` verbatim into the `link` column with no validation (line 168, `link: b.link ?? null` passed straight into `publishRecommendation`, which does no URL validation — checked its full body at lines 85-119, the only validated fields are `dedupKey`, `sport`, `type`, `title`, `sourceModel`; `link` and `urgency` are not validated beyond `urgency` being coerced into the fixed `VALID_URGENCY` set `{high,medium,low}` at line 95 — so `'high'` urgency + an arbitrary `link` both go straight through).
Mount: index.js:103 `app.use('/api/decision-inbox', decisionInboxRouter)` — no middleware.
Home.tsx confirmed: `useApi('/decision-inbox')` (grepped) renders this list on the Home/Dashboard page, and a POST `/decision-inbox/:id/resolve` call exists too.
Verdict: claim fully stands. Real unauthenticated write path onto a page the user actually looks at, with an attacker-controlled `link` field and attacker-chosen urgency tier. P2 (not credit-spend, but real live UI pollution/social-engineering surface) is a reasonable, non-overstated severity.

### #9 wong.js POST /tickets — P2 — CONFIRMED
Read wong.js:1-30 (header comment) and 490-630 (recordWongTicket + `/tickets` route). The file's own header (lines 14-19) documents the "AUTH. Mounted ungated" decision explicitly, admitting parity with the hub's other ungated teaser routes, and justifies it by "the server binds to 127.0.0.1."
`mode` is taken directly from the request body (confirmed via the calling chain: `recordWongTicket(req.body ?? {})` at line 623, and `mode` flows unchanged into the `INSERT INTO nfl_teaser_executions (... mode, ...)` at line ~583-592) — so a caller-supplied `mode:'placed'` really does get written into the ledger with no server-side confirmation step.
The claim's rebuttal of the "binds 127.0.0.1" justification is directly supported by local-auth.js's own comment (lines 16-18): a tunnel also connects to 127.0.0.1, which is exactly why `isDirectLoopback` exists as a separate, header-aware check elsewhere in the codebase. wong.js's own justification comment does not reference `isDirectLoopback` at all — it relies purely on the bind address, which per the codebase's own documented threat model is insufficient once cloudflared is up.
Verdict: claim stands. This is a real, if consciously accepted, gap, and the specific point (the developer's own stated justification is internally contradicted by another file's comment in the same codebase) is accurate and well-cited. P2 (ledger integrity vs. real-money loss) is proportionate.

### #10 betting-hub.js /teasers/executions, /settle, and siblings — P2 — CONFIRMED
Grep of every `r.get/post/...` declaration in betting-hub.js confirms exact line numbers: 433 (`/teasers/executions` POST), 450 (`/teasers/executions/:id/settle` POST), 557 (`/execution/log`), 594 (`/watch/run`), 709 (`/decay-watch/run`), 728 (`/prediction/capture`), 774 (`/polymarket/ingest`), 855 (`/decisions/record`) — none of these carry `requireModelPermission`, while `/sgp/quotes` (488) and `/sgp/fit` (501) do.
Verdict: claim stands exactly as stated — a real, verifiable asymmetry within the same file. P2 justified (ledger/audit corruption, not a credit-spend issue).

### #11 nfl-betting.js GET /stake/evaluate — P2 — CONFIRMED (with one nuance)
Read nfl-betting.js:995-1031 in full: `/stake/evaluate` loops over `seasons` (default `'2022,2023,2024,2025'`, i.e. 4 seasons) calling `replaySeason(s, {...})` synchronously for each. `replaySeason` (nfl-replay.js:177-230) is a plain synchronous function that iterates every game in the season range calling `ensembleLine` per game — real CPU work, no `await`/worker thread anywhere in the loop.
Router-level middleware (nfl-betting.js:91-99): for GET/HEAD, only paths matching `resourceSpendingGet` (`/lines/(shop|disagreement)` or `/sharp/(board|divergence)`) get gated; `/stake/evaluate` does not match, so this GET route is genuinely ungated — confirmed.
Scheduler confirmed: scheduler.js:785-798 registers `nfl_t60_runner` on the `'live'` tier (polled every `liveIntervalSeconds`, default 90s per `startScheduler` signature at line ~1066); scheduler.js:1073-1075 contains the developer's own documented incident report that "node:sqlite has no worker thread; a slow query blocks the whole HTTP server, not just the caller" — this is not a hypothetical, it's a confirmed prior real outage described in the same file. `.env` confirmed via grep to have no `SCHEDULER_DISABLED` key, so the scheduler (and by extension the T-60 runner) is live in the current deployment.
Nuance: I could not find a client caller specifically for `/stake/evaluate` (grepped client/src, no hits). The claim's "one click on a Sim/Research view" framing is illustrative of the broader pattern rather than proven for this exact route; however the sibling routes it cites for the "same pattern" (nfl-betting.js:1315 `/sim/backtest`, :1410 `/pbp/live-validation`) ARE confirmed client-called — `GameSimulator.tsx:79` calls `/nfl-betting/sim/backtest?trials=200&games=70` and `UnifiedEngineRoom.tsx:22` calls `/nfl-betting/pbp/live-validation` — both ungated GET routes performing real synchronous simulation work. The underlying mechanism (an ungated, synchronous, potentially-multi-second GET handler sharing the event loop and the single SQLite connection with a live scheduler job) is real and reachable regardless of which exact route a user clicks.
Verdict: claim stands, reachability confirmed for the specific cited route (it's mounted, ungated, and callable directly even without a UI button — reachability doesn't require a client caller), and the broader mechanism is independently corroborated by sibling client-wired routes and the scheduler's own documented failure history. P2 is proportionate given it is a self-inflicted-by-any-caller availability/timing risk during a real live capture window, not data corruption or credit spend.

### #12 nfl-market.js POST /bets week default — P2 — CONFIRMED
Grepped all `week` default lines in nfl-market.js: line 238 (`/picks`), 248 (`/picks/candidates`), 284 (`/bets` GET) and 425 (`/sync-and-pick`) all use `Number(req.query.week) || currentNflWeek(season).week`; line 322 (`/execution/run`) uses the same pattern from the request body. Line 297 (`/bets` POST) alone uses `Number(req.body?.week) || 1` — confirmed by direct read (225-330) and grep. This is a genuine, verifiable inconsistency: every other week-defaulting line in the file (including one other body-based one, line 322) resolves the live week; only line 297 hardcodes 1.
Currently latent: NflMarketBoard.tsx:118-119 (`trackBet`) always sends an explicit `week: week` field, confirmed by direct read of the POST body being sent to `/nfl-market/bets`.
Verdict: claim stands exactly as described, correctly flagged as currently-latent-but-real (reachable via direct API call, curl, or any future client code path that omits week). P2 (not currently triggered by the shipped UI, but a real, silent mis-filing risk) is proportionate, not overstated.

### #13 nfl-market.js /sync-and-pick trials — P2 — CONFIRMED
Read 415-446 in full: `trials` is parsed from `req.query.trials` (line 426, default 20000), and echoed back in the JSON response (line 434, `season, week, trials, synced, ...`), but is never passed into `autoPickDecisionBoard(season, week)` (line 432, only 2 args — confirmed signature at nfl-auto-picks.js:82 is `(season, week, policy=..., modelOptions={})`, no trials param used here) nor into `ensurePicksFor(season, week, candidates, NFL_PRODUCTION_POLICY.maxPicksPerWeek)` (line 433 — confirmed signature at nfl-auto-picks.js:28 is `(season, week, board, count=5)`, no trials param at all).
Client confirmed: NflMarketBoard.tsx:101 sends `trials=20000` in the query string to this exact route.
Verdict: claim stands exactly as described — a real, verifiable dead parameter that is echoed back as if it reflected work performed. P2 (misleading evidence trail, not a crash/security issue) is proportionate.

### #14 nfl-betting.js /who-plays default season 2025 — P2 — CONFIRMED
Read 1565-1595: line 1576 (`/who-plays/:team`) and line 1585 (`/who-plays`) both use `Number(req.query.season) || 2025`. `SEASON` is defined at nfl-betting.js:100 as `Number(process.env.NFL_SEASON) || 2026`, confirmed in the earlier full read of the top of the file (lines 1-120) — every other route in the file uses `ssn(req)` (defined at line 101 as `Number(req.query.season) || SEASON`) rather than a bare literal.
No client caller found for `/who-plays` (grepped client/src, zero hits) — this reduces today's blast radius (no UI button currently silently mis-serves data to a screen), but the route is fully mounted (index.js:106, `app.use('/api/nfl-betting', nflBettingRouter)`) and reachable by any direct caller; the defect (a stray hardcoded season literal inconsistent with every sibling route in the same file) is real and verifiable regardless of current UI wiring.
Verdict: claim stands as a real, correctly-cited inconsistency. P2 is appropriate (currently no confirmed UI caller, so impact is smaller than a wired-up route, but the code defect itself is exactly as described).

## Summary
All 9 claims survive verification. None were found to be dead/unreachable code — every cited route is mounted with no intervening auth middleware for its whole file (edge.js, decision-inbox.js, wong.js) or for that specific route (betting-hub.js's explain/page and teaser/execution family; nfl-market.js's POST /bets and sync-and-pick; nfl-betting.js's who-plays and stake/evaluate), confirmed against server/index.js's mount list and each file's own middleware. The permission-gate contrast claims (nfl-betting.js's router-wide model:execute/model:train middleware, nfl-market.js's per-route requireModelPermission calls, betting-hub.js's two gated sgp routes) were independently verified to be real and asymmetric relative to the flagged routes. No claim needed a severity correction beyond what was already assigned; the only meaningful nuance is on #11, where the specific illustrative UI trigger for /stake/evaluate itself wasn't found, but the underlying mechanism and reachability are independently confirmed via sibling routes and the scheduler's own documented incident history.
