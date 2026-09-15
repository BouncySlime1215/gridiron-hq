# Adversarial verification — reader G09-market-data (17 claims)

Repo root: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only).
DB verification done via `node:sqlite` `DatabaseSync(..., { readOnly: true })` one-liners against `server/data.sqlite`.

Files fully read (lines_read == wc -l), confirmed via `sed -n` passes covering every line:
- server/services/book-feeds.js (442/442)
- server/services/nfl-t60-packet.js (459/459)
- server/services/live-edge.js (245/245)
- server/services/polymarket.js (442/442)
- server/services/prediction-markets.js (387/387)
- server/services/beat-the-close.js (449/449)
- server/services/line-move-study.js (447/447, spot-read the model-fitting internals in full)
- server/services/nfl-opening-lines.js (347/347)
- server/services/signal-latency.js (277/277)
- server/services/sharp-lag.js (250/250)
- server/services/nfl-quote-tape.js (234/234)
- server/services/odds-archive.js (199/199)

Plus targeted reads of callers/callees for reachability: server/index.js, server/services/scheduler.js (relevant job blocks), server/routes/betting-hub.js, server/routes/nfl-betting.js, server/routes/nfl-market.js, server/betting/nfl/strategy/t60-runner.js, server/migrations/034_t60_runner_ledger.js, server/services/nfl-market.js, server/services/nfl-sharp.js, server/services/market-movement.js, server/services/book-feeds-extra.js, server/services/nfl-advanced.js (syncInjuries), server/services/nfl-clv.js.

## Summary of verdicts

All 17 claims survive as genuine, reachable defects. None were dead code except claim #68's specific anchor function (`closingQuotes`/`bestExecutableQuote` in nfl-quote-tape.js), which turned out to be test-only — but the identical architectural defect (two never-overlapping event-id namespaces) is independently confirmed live and reachable through `nfl-clv.js`'s `closingConsensus`/`gradeClosingLineValue`, which IS wired into the scheduler and a mounted route. Two claims (#66 and #55) had a materially wrong line-number citation but a verbatim-correct code snippet and mechanism; I corrected the line numbers rather than refuting.

### #52 book-feeds.js:417 — quote tape stamped legacy_request_time_only — CONFIRMED, P1
- `book-feeds.js:417` `ingestQuoteSnapshot(payload, { provider: 'free-book-feeds', requestedAt: at, markets: ..., sourceRef: 'book_feeds' })` — no `receivedAt` passed.
- `nfl-quote-tape.js:65`: `const clockSource = receiptClockSource ?? (receivedAt ? 'response_completion' : 'legacy_request_time_only');` — confirms omission -> legacy.
- `nfl-t60-packet.js:213-217`: `const realClock = scopedQuotes.filter(q => q.receipt_clock_source === 'response_completion'); ... const receivedByCutoff = realClock.filter(...)` — only response_completion rows can ever satisfy `received_by_cutoff`.
- Reachable: `captureBookFeeds` is called by scheduler jobs `nfl_book_feeds_fast` (5 min) and `nfl_book_feeds_slow` (60 min) (scheduler.js:755,757), the only running quote-tape producer since `captureCurrentQuoteTape` (the-odds-api path) requires `ODDS_API_KEY`/credits that are exhausted per repo history. `freezeT60Packet` is invoked by the `nfl_t60_runner` scheduler job (scheduler.js:785) and a mounted route (`server/routes/nfl-betting.js:1439`, `server/index.js:106`).
- Verdict: refuted=false, confirmed P1 as claimed.

### #53 nfl-t60-packet.js:258 — injuries admitted on nflverse's own modified_at, not a receipt clock — CONFIRMED, P1
- Exact line 258: `receivedAt: injuries?.received_by_cutoff ?? injuries?.received_ever ?? null, cutoffAt,` inside the `nfl_injuries` sourceEntry push, fed from `modified_at` (query at lines 251-255).
- `nfl-advanced.js:306-323` `syncInjuries`: `modified_at` column is populated straight from `r.date_modified` in the nflverse CSV — a source-published stamp, not this system's ingestion/receipt time. `syncInjuries` is a bulk multi-season CSV re-read (per season), so "modified_at <= cutoff" says nothing about when *this system* actually held the row.
- This is exactly the C11 trap the file's own header (lines 34-37) warns about for weather ("every pre-2026 weather row... fetched 2026-09-02... counting it as knowable would be the single largest look-ahead available here") — except injuries get the trap's exact failure mode (publish-clock treated as receipt-clock) live, un-guarded, while weather is explicitly guarded (see `nfl_game_weather_forecast_history` block using `fetched_at`, a genuine receipt column).
- Reachable: same freezeT60Packet path as #52 (scheduler job + mounted route).
- Verdict: refuted=false, confirmed P1.

### #54 live-edge.js:204 — home-team substring match across ALL Polymarket markets, incl. futures/awards — CONFIRMED, P1, strengthened by DB
- Line 204 matches verbatim: `const book = books.find(b => (b.question ?? '').toUpperCase().includes(String(g.name ?? '').split(' at ')[1]?.toUpperCase() ?? ' '));`
- `books` query (lines 193-196 area) is `SELECT m.question, q.best_bid, q.best_ask, q.bid_size, q.ask_size FROM polymarket_quotes q JOIN polymarket_markets m ON m.condition_id=q.condition_id WHERE q.best_bid IS NOT NULL` — no `kind`/`event_title` filter, confirmed by reading the code (no such filter anywhere in `liveBoard`).
- DB proof: `polymarket_markets` holds 345 award + 67 futures + 982 leader_prop + 1392 threshold_prop markets alongside 14,469 'other'. Querying for Rams-named futures/award markets with a live order book returns real quoted rows, e.g. `"Will the Los Angeles Rams win the 2027 NFL league championship?"` bid 0.15/ask 0.16, `"Will Los Angeles Rams win the 2026 NFC West?"` bid 0.48/ask 0.49 — exactly the kind of market `.includes("LOS ANGELES RAMS")` would match ahead of (or instead of) any actual live moneyline market.
- Reachable: mounted route `GET /api/betting/live/board` (betting-hub.js:808-813, index.js:108).
- Verdict: refuted=false, confirmed P1, DB evidence makes it stronger than the raw claim.

### #55 polymarket.js:119 — every scheduler tick inserts a midpoint row for ~14k markets, no pruning — CONFIRMED, P2 (one evidence citation was wrong, mechanism is right)
- Line 119 matches verbatim (`INSERT INTO polymarket_quotes ...`), reachable via scheduler job `polymarket` (scheduler.js:830, `maxAgeMinutes: 3`) which calls `ingestPolymarketNfl({maxPages:4})` every 3 minutes with no filter on whether the price changed since the last capture (`ON CONFLICT(captured_at, condition_id) DO NOTHING` only dedups an exact-timestamp collision, and `captured_at` is always `now` — a fresh instant every run).
- `grep -rn "DELETE FROM polymarket_quotes" server/` returns nothing — confirmed no pruning path exists anywhere.
- DB check: `SELECT COUNT(*) FROM polymarket_quotes` = 13,661,418 rows; only 57,590 (0.42%) carry a real order-book (`best_bid IS NOT NULL`); 1,733 distinct `captured_at` values. Same order of magnitude and same ~0.4%-with-book ratio the claim cites (12,639,418 / 54,683 — the DB has simply grown further since the claim was written, consistent with an ongoing 3-minute unbounded-insert job).
- One inaccuracy in the claim's evidence: "the header at polymarket.js:7-8 still says 30" is FALSE — lines 7-8 of polymarket.js are about the never-priced props gap, not cadence, and contain no "30". The actual "30 -> 3 minutes" migration note lives in **scheduler.js** (lines 828-830: "this also moved from 30 minutes to 3"), which is *consistent* with — not contradicting — the 3-minute cadence. This is a misattributed citation, not a wrong mechanism; the core defect (unbounded per-tick insert, no dedup-by-value, no pruning) stands fully confirmed independent of that one line.
- Verdict: refuted=false, confirmed P2; flagged evidence inaccuracy but did not change severity since the substantive claim and impact hold.

### #56 book-feeds.js:191 — Kambi's per-outcome changedDate misapplied as freshness clock — CONFIRMED, P2
- Line 191 matches verbatim: `const updated = o.changedDate ?? null;` inside `parseKambi`.
- `STALE_BOOK_HOURS=72` / `isFreshQuote` (lines ~51-78) documents its 72h threshold was measured on the OddsTrader **aggregator's** caching behavior, and explicitly exempts only Pinnacle/Bovada's **null** stamps because those are "captured directly." Kambi (BetRivers) is also captured directly (own `eu-offering-api.kambicdn.com` endpoint, not through oddstrader) but its `changedDate` is real and non-null, so it does NOT get the direct-capture exemption — a genuinely stable BetRivers price (unchanged >72h, plausible early in a game week) gets marked stale and dropped.
- Reachable: `isFreshQuote` used by `beat-the-close.js:111` (`bestReachable`, scheduler job `beat_the_close`), `nfl-clv.js:104` (`closingConsensus`, scheduler `nfl_forward_settle` grading path), `sharp-lag.js:87` (mounted route `/nfl-market/sharp-lag`).
- Verdict: refuted=false, confirmed P2.

### #57 book-feeds.js:89 — provider-priority dedup is per-call only; cross-job series mix aggregator/direct copies — CONFIRMED, P2
- Line 89 matches verbatim (`PROVIDER_PRIORITY` object). `mergeQuotes` (lines ~355-368) dedups only within one `captureBookFeeds` call's `byProvider` map.
- Scheduler wiring confirmed: `nfl_book_feeds_fast` (oddstrader+pinnacle, 5 min), `nfl_book_feeds_slow` (kambi/bovada/fanduel, 60 min), `nfl_book_feeds_extra` (Rotowire+SBR, 60 min, separate file `book-feeds-extra.js`) are three independent scheduler jobs/calls, never merged against each other.
- `book-feeds-extra.js` confirmed: Rotowire feed writes book keys `fanduel`, `betrivers`, `draftkings`, etc. under `provider='free:rotowire'`; SBR under `provider='free:sbr'` — both alongside `book-feeds.js`'s own direct `provider='free:fanduel'` and `provider='free:kambi'`(->book 'betrivers') rows in the same `nfl_line_snapshots` table, same `book` column value, different `provider`/timestamps.
- Downstream readers confirmed keyed by `book` alone, ignoring `provider`: `sharp-lag.js:87-91` (`g.books.get(q.book).push(...)`), `nfl-sharp.js:229` (`const k = \`${s.event_id}|${s.market}|${s.side}|${s.book}\`;`).
- Verdict: refuted=false, confirmed P2.

### #58 odds-archive.js:124 — archive phase baked into event_id splits one game into two events — CONFIRMED, P2
- Line 124 matches verbatim: `` const s = snapshotStmt.run(capturedAt, `archive:${q.eid}:${q.phase}`, ... ``.
- `market-movement.js:8-11` `nflMarketMovement()`: `GROUP BY event_id,market,side HAVING COUNT(DISTINCT captured_at) >= 2` — since `archive:<eid>:open` and `archive:<eid>:close` are different `event_id` values, each typically has only ONE `captured_at`, so neither group clears the `>=2` bar; the pairing that would show movement never forms.
- Reachable: `backfillOddsArchive`/`storeArchiveQuotes` reachable via mounted route `POST /api/nfl-market/odds-archive/backfill` (nfl-market.js:174-181, gated by `requireModelPermission('model:train')`), and `oddsArchiveStatus` via `GET /api/nfl-market/odds-archive`. Given the claim's DB citation of 135,930 archive rows, the backfill has already been run in this environment.
- Verdict: refuted=false, confirmed P2.

### #59 prediction-markets.js:48 — Kalshi raw ticker codes never resolved (JAC vs JAX) — CONFIRMED w/ DB proof, P2
- Line 48 (`event_key: \`${away}@${home}\`` inside `parseKalshiNflTicker`) confirmed to use raw regex-captured ticker codes with no team-code resolver, unlike `book-feeds.js` (`teamResolver()`) and even this same repo's own `nfl-opening-lines.js` `ALIAS`/`normForSeason` machinery which explicitly maps `JAC -> JAX`.
- DB proof: `SELECT DISTINCT team FROM prediction_market_quotes WHERE venue='kalshi'` returns `'JAC'`; `SELECT DISTINCT home_team FROM espn_line_moves` (the table `exchangeVsBook`'s `bookByGame` is built from) returns `'JAX'`; `nfl_teams.abbr` also uses `'JAX'`. The two never match on any Jacksonville game.
- Reachable: `exchangeVsBook` mounted at `betting-hub.js:749-750`; `captureKalshi`/`captureKalshiFlow` run every 3 minutes via scheduler job `prediction_markets` (scheduler.js:822-824).
- Verdict: refuted=false, confirmed P2.

### #60 prediction-markets.js:98 — scheduled Kalshi trade capture is unfiltered (not NFL-only) — CONFIRMED, P2
- Line 98 area (`const url = ticker ? ... : \`${KALSHI}/markets/trades?limit=${limit}\`;`) confirmed: `captureKalshiFlow` with no `ticker` hits the all-markets trades endpoint.
- `scheduler.js:822-824`: `prediction_markets` job calls `m.captureKalshiFlow({})` — no ticker — every 3 minutes.
- `whaleFlow` (lines ~238-262) and `predictionMarketStatus` (lines ~266-277) both read `prediction_market_flow` with no ticker/series filter (e.g. `ready_for_lead_lag_test: (f.n ?? 0) > 500` counts ALL trades, any Kalshi market).
- Reachable: `whaleFlow`/`predictionMarketStatus` mounted at betting-hub.js:741-758.
- Verdict: refuted=false, confirmed P2.

### #61 nfl-t60-packet.js:264 — news-events source completely unscoped (no team/season/week filter) — CONFIRMED, P2 (arguably understates severity)
- Line 264 matches verbatim: `const news = rows(\`SELECT ... FROM nfl_news_events\`, cutoffAt, cutoffAt, cutoffAt)[0];` — genuinely has ZERO WHERE clause of any kind (not even season), confirmed by reading the full query (lines 264-273).
- This means ANY row anywhere in `nfl_news_events` with `first_seen_time <= cutoffAt` makes the news source `received_by_cutoff`-eligible for literally every game's packet ever frozen, historical or prospective, any team, any season. This is a stronger defect than the claim's own framing ("any news row anywhere") suggests, since even the `nfl_team_week_features` block right below it (lines 305-311) is at least scoped to `season`.
- Reachable: same freezeT60Packet path as #52/#53.
- Verdict: refuted=false, confirmed (if anything, this could reasonably be argued up to P1 given it can inflate `summary.eligible` for every single packet ever produced — noting as a possible severity correction, but leaving the reader's P2 as not wrong).

### #62 nfl-t60-packet.js:142 / t60-runner.js:127-129 — frozen packet never persisted, only an unverifiable hash — CONFIRMED, P2
- `t60-runner.js:127-129`: `run(\`UPDATE nfl_t60_observations SET state='frozen', packet_hash=?, ...\`, packetHash(packet), ...)` — confirmed only `packet_hash` (sha256 of `JSON.stringify(packet)`) is stored.
- `server/migrations/034_t60_runner_ledger.js` schema for `nfl_t60_observations`: columns are `id, ..., decision_run_id, packet_hash, capture_started_at, capture_finished_at, last_error, note` — no packet-body/JSON column anywhere. Confirmed no other table stores the packet body (grepped for any write of a serialized packet; none found beyond the hash).
- `nfl-t60-packet.js:95`: `const base = { source, rows: rowsByCutoff, rows_now: rowsTotal, ... }` — `rows_now` is embedded in every source entry and reflects the CURRENT (not frozen) row count of tables that keep growing (`nfl_quote_tape`, `nfl_injuries`, `nfl_news_events`, etc.), so re-running `freezeT60Packet` with the same args later will almost certainly produce a different JSON blob (different `rows_now`) and therefore a different sha256 — the stored hash cannot be reproduced/verified against a later recomputation even when the *decision-relevant* fields (received-by-cutoff evidence) are unchanged.
- Reachable: `captureDueObservations` is the freeze step of `nfl_t60_runner`, a live-tier scheduler job (scheduler.js:785-798, `maxAgeMinutes: 5`).
- Verdict: refuted=false, confirmed P2.

### #63 beat-the-close.js:106 — bestReachable only ever sees the fastest job's snapshot, so direct Fanduel/Bovada/Kambi/Rotowire are unreachable — CONFIRMED w/ DB proof, P2
- Line 106 matches verbatim: `const latest = row(\`SELECT MAX(captured_at) at FROM nfl_line_snapshots WHERE provider LIKE 'free:%' AND market=? AND home_team=? AND away_team=?\`, ...)`.
- DB proof (2026-09-10 to now window): `free:oddstrader`/`free:pinnacle` share `captured_at` values up to `2026-09-12T13:08:40.467Z` (363/361 distinct captures); `free:bovada`/`free:fanduel`/`free:kambi` last captured at `2026-09-12T12:53:54.722Z` (54/33/61 captures); `free:rotowire`/`free:sbr` at `2026-09-12T12:53:51.609Z`. `SELECT DISTINCT provider FROM nfl_line_snapshots WHERE captured_at = (SELECT MAX(captured_at) FROM nfl_line_snapshots WHERE provider LIKE 'free:%')` returns ONLY `free:oddstrader` and `free:pinnacle` — direct FanDuel/Bovada/Kambi/Rotowire/SBR rows never share the exact instant `bestReachable` filters on, so `allQuotes` (line 108) is empty for them and they are structurally excluded from `bestReachable`'s result on every call, exactly as claimed.
- Reachable: `bestReachable` is called from `decideBeatTheClose` (line ~247), part of the `beat_the_close` scheduler job (scheduler.js:761, hourly).
- Verdict: refuted=false, confirmed P2 (this is a strong, DB-verified finding).

### #64 line-move-study.js:132 — production report's ratings hyperparameters are selected including the "held-out" 2024 season — CONFIRMED w/ DB proof, P2
- Line 132 matches verbatim: `const market = includeModels ? (selectionThrough == null ? fitModel() : fitRatings({ selectionThrough })) : null;`
- `report-cache.js:56-60` (`line_move_study` report): `args: [{}]` — calls `lineMoveStudy({})`, so `selectionThrough` stays `null` -> `fitModel()`.
- `nfl-market.js:98-101,108-112,129-131`: `fitModel()` calls `fitRatings({})`; inside, `selectionCap = selectionThrough == null ? lastSeason - 1 : ...`; `lastSeason` is the newest season with completed games in `historicalGames()`.
- DB proof: `game_lines` has completed (`team_score`/`opp_score` not null) rows through `season=2026` (2 games — Week 1 2026 already played per today's date 2026-09-12), and full 285-game seasons for 2023/2024/2025. So `lastSeason=2026`, `selectionCap=2025` — the grid search's selection window (`season <= 2025`) fully includes all of 2024 (and 2025), which `line-move-study.js`'s own `HOLDOUT_FROM = 2024` (line 39) treats as the held-out seasons for its headline CLV numbers.
- Verdict: refuted=false, confirmed P2 (contamination is real and DB-verified, not just plausible).

### #65 nfl-opening-lines.js:137 — ingestOpeningLines unconditionally overwrites openers, can null open_total — CONFIRMED, P2
- Lines 136-138 match: `` run(`UPDATE game_lines SET open_spread = ?, open_total = ? WHERE season = ? AND week = ? AND team = ? AND opponent = ? AND home = 1`, g.open_spread, g.open_total, ...) `` — no `COALESCE`, unconditional. `g.open_total` defaults to `null` (line 105) unless the CSV has a matching TOTAL row for that game.
- Contrast confirmed: `odds-archive.js` (lines 138-141 approx) uses `SET open_spread=COALESCE(open_spread, ?), open_total=COALESCE(open_total, ?)`; `ingestSuperContestLines` (same file, line ~314) explicitly does `if (existing.open_spread != null) { skippedExisting++; continue; }` before ever writing.
- Reachable: `ingestOpeningLines` mounted at `server/routes/nfl-betting.js:1296-1297`.
- Verdict: refuted=false, confirmed P2.

### #66 signal-latency.js — bookLagDistribution loads all spreads rows since window start into memory — CONFIRMED, P2, but line number is wrong (204, not 251)
- The claim cites line 251; the actual `rows(...)` call for `snapshots` is at **line 204**: `` const snapshots = rows(`SELECT captured_at,event_id,home_team,away_team,book,side,line FROM nfl_line_snapshots WHERE market='spreads' AND captured_at>=datetime(?,'-24 hours') ORDER BY captured_at`, since); `` (function `bookLagDistribution` starts at line 199). Line 251 in the actual file is inside the same function's later loop body (`observations.push(...)`), not this query — a ~47-line citation error, though the quoted snippet is otherwise verbatim-correct and belongs to this exact function.
- Confirmed no `captured_at` index exists on `nfl_line_snapshots`: schema (`core-and-fantasy.js:901`) shows only `CREATE INDEX IF NOT EXISTS idx_lines_event ON nfl_line_snapshots(event_id, market);` — no captured_at index, confirming the claim's DB evidence.
- Reachable: `bookLagDistribution` mounted at `betting-hub.js:385-390` (a hub/dashboard route).
- Verdict: refuted=false (mechanism and DB evidence both confirmed), but corrected_claim / line should read nfl-services/signal-latency.js:204, not 251.

### #67 sharp-lag.js:74 — sharpLag loads 14 days of ALL free spreads rows into JS per request — CONFIRMED, P2
- Line 74 matches verbatim: `` const all = rows(`SELECT captured_at, event_id, commence_time, home_team, away_team, book, side, line, provider, book_updated_at FROM nfl_line_snapshots WHERE provider LIKE 'free:%' AND market = ? AND line IS NOT NULL AND captured_at >= ? AND captured_at <= ? ORDER BY captured_at`, ...) ``.
- Same missing-index confirmation as #66 (`idx_lines_event(event_id, market)` is the only index; no `captured_at` index).
- Reachable: mounted at `server/routes/nfl-market.js:114` (`sharpLag` route).
- Verdict: refuted=false, confirmed P2.

### #68 nfl-quote-tape.js:192 — closingQuotes/bestExecutableQuote keyed by a two-namespace provider_event_id — PARTIALLY DEAD CODE at the cited line, but the identical defect is CONFIRMED live via nfl-clv.js
- Line 192 (`export function closingQuotes(providerEventId, ...)`) confirmed verbatim. HOWEVER: `grep -rn "closingQuotes\|bestExecutableQuote" --include="*.js" .` (excluding node_modules) shows both functions are called ONLY from `test/nfl-weekly-state.test.js` and `test/nfl-execution-integration.test.js` — no production route, service, or scheduler job calls either function. Per the reachability lens, the specific code path cited (nfl-quote-tape.js:192/208) is **not reachable in the running app**.
- BUT: the claim's own evidence explicitly extends the identical defect to "nfl-clv closingConsensus (94-99) has the same exposure" — and `closingConsensus` (nfl-clv.js:94) IS reachable: it is called from `gradeClosingLineValue` (nfl-clv.js:221), which is wired into a scheduler job (`nfl_forward_settle`/CLV grading, scheduler.js:275-278) and a mounted route (`nfl-betting.js:930`). DB proof: `nfl_line_snapshots.event_id` has the exact same two-namespace split as `nfl_quote_tape.provider_event_id` — hex strings (e.g. `000fc688beb4fc004ecdad115d9adb1c`) for the null-provider (the-odds-api) rows, vs `nfl:<date>:<AWAY>@<HOME>` composite keys for `free:*`-provider rows — confirmed by direct query. So `closingConsensus`, keyed on `event_id`, cannot join a the-odds-api-sourced bet in `nfl_bet_log` against free-feed quotes for the same game, or vice versa — the practical harm the claim describes is real and reachable, just through a parallel mechanism (event_id in nfl_line_snapshots) rather than the specific dead function cited at line 192.
- Verdict: refuted=false (the underlying defect is genuine and reachable), but the citation should be corrected: the practically-reachable instance is nfl-clv.js:94-99 (closingConsensus) / nfl-clv.js:221 (gradeClosingLineValue), not nfl-quote-tape.js:192, which is test-only dead code in the current wiring.
