# Adversarial verification: G09-market-data (17 claims)

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only)
DB accessed read-only via `node:sqlite` `{ readOnly: true }` one-liners only.

## Files read in full (lines_read == wc -l)
- server/services/book-feeds.js (442/442)
- server/services/nfl-t60-packet.js (459/459)
- server/services/live-edge.js (245/245)
- server/services/polymarket.js (140/442 read directly around claim + scheduler cross-check; DB-verified counts for the rest of the claim's numeric evidence)
- server/services/odds-archive.js (199/199)
- server/services/prediction-markets.js (~140/387 read directly around both claims + DB cross-check)
- server/services/beat-the-close.js (~140/449 read directly around claim)
- server/services/line-move-study.js (~150/447 read directly around claim) + server/services/nfl-market.js (~140/456 read directly around claim)
- server/services/nfl-opening-lines.js (~150/347 read directly, incl. both ingestOpeningLines and ingestSuperContestLines)
- server/services/signal-latency.js (~90/277 read directly around claim + the actual cited line)
- server/services/sharp-lag.js (~100/250 read directly around claim)
- server/services/nfl-quote-tape.js (234/234)
- server/betting/nfl/strategy/t60-runner.js (298/298)
- server/services/scheduler.js (spot-checked relevant job registrations: ~260-340, ~790-835, ~1090-1095)
- server/services/market-movement.js (47/47)
- server/services/line-shopping.js (~100/248 read directly)
- server/services/nfl-sharp.js (~90/302 read directly around claim)
- server/db/schema/core-and-fantasy.js (index definitions grepped, line 901 confirmed)
- server/services/nfl-advanced.js (syncInjuries, ~70 lines around ingestion)

---

## #52 book-feeds.js:417 — P1 — CONFIRMED
`ingestQuoteSnapshot(payload, { provider: 'free-book-feeds', requestedAt: at, ... })` at book-feeds.js:417 passes no `receivedAt`. In nfl-quote-tape.js:65-66, `clockSource = receiptClockSource ?? (receivedAt ? 'response_completion' : 'legacy_request_time_only')` — confirmed defaults to legacy.
nfl-t60-packet.js:213-217 (`realClock = scopedQuotes.filter(q => q.receipt_clock_source === 'response_completion')`, `receivedByCutoff = realClock.filter(...)`) confirms only `response_completion` rows can earn `received_by_cutoff`.
DB check (`nfl_quote_batches GROUP BY provider, receipt_clock_source`):
```
free-book-feeds / legacy_request_time_only: 1225
the-odds-api    / legacy_request_time_only: 168
```
Zero `response_completion` rows exist in the live DB. The 168 "the-odds-api" legacy batches come from line-shopping.js:66 (`ingestQuoteSnapshot(data, { requestedAt: at, ... })`, also no receivedAt) — a second producer with the same defect, not a contradiction of the claim's "only running producer" framing since the Odds-API path is credit-gated and effectively idle (module header: "the account has one [credit] left"). Verdict: claim's mechanism and DB evidence are accurate (counts differ slightly from a live-growing table, immaterial).

## #53 nfl-t60-packet.js:258 — P1 — CONFIRMED
Line 258 exact match: `receivedAt: injuries?.received_by_cutoff ?? injuries?.received_ever ?? null, cutoffAt,` where `injuries.received_by_cutoff` is `MAX(CASE WHEN modified_at <= ? THEN modified_at END)` (lines 251-254). Traced `modified_at` to nfl-advanced.js:306-320 `syncInjuries`: it is `r.date_modified` straight from nflverse's injuries CSV — an externally-published/source-modification timestamp, not any receipt/ingestion timestamp this system records. No separate fetched_at/ingested_at column exists on nfl_injuries. `sourceEntry`'s `beforeOrAt(receivedAt, cutoffAt)` (line 112) then grants `received_by_cutoff` off this externally-controlled clock. This is exactly the PUBLISHED-vs-RECEIVED conflation the file's own header (lines 14-21) says the whole module exists to prevent, applied here to the second-most-important source. Confirmed real defect.

## #54 live-edge.js:204 (+193-196) — P1 — CONFIRMED
Lines 193-196 exact match: `books = rows(\`SELECT m.question, q.best_bid, q.best_ask, q.bid_size, q.ask_size FROM polymarket_quotes q JOIN polymarket_markets m ON m.condition_id = q.condition_id WHERE q.best_bid IS NOT NULL\`)` — no `kind`/`event_title` filter. Line 204 exact match: `.find(b => (b.question ?? '').toUpperCase().includes(...split(' at ')[1]...))`.
DB: `polymarket_markets` kind breakdown — `other:14469, threshold_prop:1392, leader_prop:982, award:345, futures:67`, total 17,255 (claim's exact number). `award` and `futures` markets legitimately contain team names in their question text (e.g. Super-Bowl / MVP markets), so `.find()` can return a non-moneyline market as `book`, feeding `marketProb` into `liveEdge()` as if it were the game's price. Confirmed real defect, matches evidence precisely.

## #55 polymarket.js:119 — P2 — CONFIRMED (one immaterial evidence slip)
Line 119 exact match (the `polymarket_quotes` INSERT...ON CONFLICT DO NOTHING inside `ingestPolymarketNfl`). scheduler.js:830 registers `polymarket` job at `maxAgeMinutes: 3` (confirmed, "moved from 30 minutes to 3" per its own comment) — i.e. every 3 minutes, not 30. `grep -rn "DELETE FROM polymarket_quotes"` across server/ returns nothing (only an unrelated `DELETE FROM polymarket_line_moves` in polymarket-lines.js:182). DB re-check (table is live/growing):
- total rows: 13,647,418 (claim said 12,639,418 — grew since claim was written, consistent with "unbounded growth")
- distinct captured_at: 1,732
- 2026-09-10: 2,295,813 rows across 281 captures (claim's exact numbers)
- rows with a book (best_bid IS NOT NULL): 57,551 (claim said 54,683 — again just table growth)
One inaccuracy in the claim's own evidence text: "header at polymarket.js:7-8 still says 30" is not true — polymarket.js's header (lines 1-26) says nothing about a 30-minute cadence; that "every thirty minutes" line actually lives in market-movement.js:22 (a different file) describing Polymarket's *movement* signal, not this ingestion cadence. This is a citation error in the reader's evidence, but the core defect (3-minute unconditional re-insert of every open market's midpoint, unbounded, unpruned) is fully verified independently.

## #56 book-feeds.js:191 — P2 — CONFIRMED
Line 191 exact match: `const updated = o.changedDate ?? null;` inside `parseKambi`. `isFreshQuote` (lines 74-78) applies `STALE_BOOK_HOURS=72` to any non-null `book_updated_at`; the file's own header comment (lines 51-71) documents the 72h rule as tuned against OddsTrader-*aggregator* caching artifacts and explicitly exempts null-stamped direct feeds (Pinnacle, Bovada) from the penalty — "captured_at itself is the freshness signal there." Kambi is a **direct** feed (not aggregator-routed) but supplies a real non-null `changedDate`, so it does NOT get the exemption and is penalized by a rule designed for a different failure mode (aggregator staleness, not "book genuinely hasn't moved"). Confirmed `isFreshQuote` is used broadly: beat-the-close.js:111, nfl-clv.js:104, line-shopping.js:99, nfl-shopping-board.js:99, sharp-lag.js:87, nfl-expert-council.js:344. Real, confirmed inconsistency.

## #57 book-feeds.js:89 (+ scheduler cross-refs) — P2 — CONFIRMED
`PROVIDER_PRIORITY` (line 89) confirmed. `mergeQuotes` (dedup) only operates within one `captureBookFeeds()` call's `byProvider` map. scheduler.js confirms `refreshBookFeedsFast` = `['oddstrader','pinnacle']` every 5 min, `refreshBookFeedsSlow` = `['kambi','bovada','fanduel']` hourly — two *separate* calls at different cadences/instants, so cross-call dedup never happens. `ODDSTRADER_BOOKS` (lines 80-86) includes `84: 'bovada'`, `78: 'fanduel'`, confirming the same book name is written from both jobs. Confirmed both readers key by `book` alone (not provider): sharp-lag.js:97-98 (`g.books.get(q.book).push(...)`) and nfl-sharp.js:229 (`k = \`${s.event_id}|${s.market}|${s.side}|${s.book}\``). Real, confirmed cross-contamination of book-keyed series.

## #58 odds-archive.js:124 — P2 — CONFIRMED
Line 124 exact match: `` `archive:${q.eid}:${q.phase}` `` used as `event_id` in the `nfl_line_snapshots` INSERT. Since `phase` is `'open'` or `'close'` (line 55: `for (const [phase, lines] of [['open', e.openingLines], ['close', e.currentLines]])`), the same game produces two distinct `event_id`s. Confirmed all three named consumers group strictly by `event_id`: market-movement.js:9 (`GROUP BY event_id,market,side`), nfl-sharp.js:216-217 (steamMoves query `ORDER BY event_id, market, side, book, captured_at`), line-shopping.js:244-245 (`GROUP BY event_id, market, side`). DB has 135,930 rows with `event_id LIKE 'archive:%'` — not independently re-verified via a fresh count, but the mechanism is airtight from the code alone. Confirmed real defect.

## #59 prediction-markets.js:48 — P2 — CONFIRMED
Line 48 exact match: `event_key: \`${away}@${home}\`` built from `parseKalshiNflTicker`'s raw regex captures, no team-code resolver applied. DB: actual Kalshi tickers use `JAC` (`KXNFLGAME-26SEP13CLEJAC-CLE`, `KXNFLGAME-26SEP20JACDEN-DEN`, etc. — confirmed live), while `espn_line_moves.home_team` for Jacksonville is `JAX` (confirmed, only value present). `exchangeVsBook` (lines ~184-203) builds `bookByGame` keyed by `${away_team}@${home_team}` from `espn_line_moves` (i.e., JAX-keyed) and looks it up via `bookByGame.get(q.event_key)` (JAC-keyed) — guaranteed miss for every Jacksonville game. Confirmed real, and DB-verified end to end.

## #60 prediction-markets.js:98 — P2 — CONFIRMED
Lines 97-99 exact match (ticker-conditional Kalshi trades URL). scheduler.js:822-824 confirmed: `prediction_markets` job calls `captureKalshiFlow({})` (no ticker) every 3 minutes. `whaleFlow` (lines ~238-252) queries `prediction_market_flow` with no ticker filter; `predictionMarketStatus` (lines ~263-280) computes `ready_for_lead_lag_test: (f.n ?? 0) > 500` from an unfiltered `COUNT(*) FROM prediction_market_flow`. DB: total flow rows 308,037; `ticker LIKE 'KXNFLGAME%'` rows only 2,478 (0.8%) — the single most-traded ticker overall is `KXPRESNOMD-28-ZMAM` (a presidential-nomination market) with 1,624 trades, more than most individual NFL games. Confirmed strongly — the "NFL whale tape" is overwhelmingly non-NFL.

## #61 nfl-t60-packet.js:264 — P2 — CONFIRMED
Line 264 is the exact start of the `nfl_news_events` query (`const news = rows(\`SELECT ... FROM nfl_news_events\`, cutoffAt, cutoffAt, cutoffAt)[0];`), and it carries no WHERE clause scoping to team/season/week/game — confirmed by reading the full query text. `nfl_team_week_features` query at line 308 similarly has no team scoping (`WHERE season=? AND week < ?` only). Confirmed: any news event anywhere in the whole table before cutoff makes `nfl_news_events` eligible in `summary.eligible` for every game's packet, regardless of relevance.

## #62 nfl-t60-packet.js:142 (+ t60-runner.js) — P2 — CONFIRMED
`freezeT60Packet` (line 142) recomputes everything live from current DB state each call — no packet-body persistence anywhere in the codebase (`grep` of `ingestQuoteSnapshot`/packet writers shows no such table). t60-runner.js:127-129 confirmed: `run(\`UPDATE nfl_t60_observations SET state='frozen', packet_hash=?, ...\`, packetHash(packet), ...)` — only `packetHash(packet)` (sha256 of `JSON.stringify(packet)`) is stored; `captureDueObservations`'s in-memory `captured` array (which holds full packets) is discarded by the caller (`runT60Pass` returns only `captured: captured.captured.length`). `sourceEntry`'s `rows_now: rowsTotal` (nfl-t60-packet.js ~line 95-99) is embedded in every source entry inside the hashed packet, and `rowsTotal` for e.g. the quote-tape source is `scopedQuotes.length` — a live re-query of ALL rows for that game regardless of when they arrived, which keeps growing as long as book-feeds/etc. keep writing quotes for that game (including post-kickoff). DB confirms: one `frozen` row, `packet_hash` populated, `decision_run_id` NULL, and the `nfl_t60_observations` schema has no packet-body column at all. Re-running `freezeT60Packet` later for "verification" would embed a different current `rows_now` and hash differently even with no tampering — the stored hash is unauditable/non-reproducible exactly as claimed.

## #63 beat-the-close.js:106ff — P2 — CONFIRMED
Lines 105-108 exact match for the `MAX(captured_at) ... WHERE provider LIKE 'free:%'` query, used at line ~110 to select `allQuotes WHERE captured_at=?` (the single latest timestamp across ALL free providers combined). scheduler.js confirms: fast job (oddstrader+pinnacle) every 5 min, slow job (kambi/bovada/fanduel) hourly, extra job (rotowire/sbr) hourly. DB check for 2026-09-10 distinct `captured_at` per provider: `oddstrader:190, pinnacle:190, kambi:28, bovada:25, rotowire:26, sbr:26, fanduel:1`. Since the global MAX(captured_at) will almost always land on one of the 190 oddstrader/pinnacle timestamps (vastly more frequent), the slow-job books' rows essentially never coincide with `latest` and are excluded from `bestReachable`'s consideration set. Confirmed strongly.

## #64 line-move-study.js:132 (+nfl-market.js) — P2 — CONFIRMED
Line 132 exact match: `const market = includeModels ? (selectionThrough == null ? fitModel() : fitRatings({ selectionThrough })) : null;`. report-cache.js:61 confirmed: `{ module: './line-move-study.js', fn: 'lineMoveStudy', args: [{}], ... }` — no `selectionThrough` passed, so `market = fitModel()` (uncached path aside, `fitModel()` → `fitRatings({})`). nfl-market.js:108-112 docstring confirms the intended discipline ("a study holding out 2024–2025 can select on ≤2023 and keep its holdout clean"). nfl-market.js:127-129: `lastSeason = games[games.length-1].season; selectionCap = selectionThrough==null ? lastSeason-1 : ...`. DB confirms `historicalGames()` (season>=LEAGUE_MIN_SEASON, scored games) currently includes completed 2026 games, so `lastSeason=2026` and `selectionCap=2025` — the hyperparameter grid search selects on all seasons ≤2025, which includes 2024, the study's own `HOLDOUT_FROM` (line 39) season. Confirmed exactly as claimed, evidence text matches almost verbatim ("2025 -> includes 2024").

## #65 nfl-opening-lines.js:137ish — P2 — CONFIRMED
The unconditional `UPDATE game_lines SET open_spread = ?, open_total = ? WHERE ... AND home = 1` (matches claim's snippet, located ~line 133-136 in the read file — trivial offset, content identical) always writes `g.open_total`, which is `null` whenever the source CSV row for that game lacked a TOTAL entry (entry initialized `{ open_spread: null, open_total: null }` at line 106, only overwritten if a matching TOTAL/Over row is found in the file). Contrast confirmed: odds-archive.js:139-141 uses `COALESCE(open_spread, ?), COALESCE(open_total, ?)` (fill-only), and `ingestSuperContestLines` (nfl-opening-lines.js, function starting ~line 285) explicitly skips existing openers (`if (existing.open_spread != null) { skippedExisting++; continue; }`, ~line 323). `initial_lines.csv` is documented in the file's own header (lines 14-17) as "one book, one season" — i.e., a single-book source, not a cross-book median. A re-run of `ingestOpeningLines` after a prior odds-archive-derived (multi-book median) opener exists would silently replace it with the weaker single-book number and can null out a previously-filled `open_total`. Confirmed real defect exactly as described.

## #66 signal-latency.js — P2 — CONFIRMED substance, LINE NUMBER WRONG (251 -> actual ~199-206)
The quoted snippet (`const snapshots = rows(...FROM nfl_line_snapshots WHERE market='spreads' AND captured_at>=datetime(?,'-24 hours')...)`) is a verbatim, exact match of the file — but it sits at lines 204-206 inside `bookLagDistribution` (declared at line 199, `sinceDays=60` default), NOT at line 251. Line 251 is actually the declaration of `export function pipelineHealth() {`, an unrelated function with no such query. core-and-fantasy.js:901 confirmed: `CREATE INDEX IF NOT EXISTS idx_lines_event ON nfl_line_snapshots(event_id, market);` is the only index — no index covers `captured_at` alone, so the range-scan-plus-market-filter in this query cannot use an index efficiently. The underlying performance/scale claim is real and well-supported; the citation itself is off by about 46 lines, which is a real accuracy defect in the report even though the finding is genuine.

## #67 sharp-lag.js:74 — P2 — CONFIRMED
Line 74 exact match: `const all = rows(\`SELECT captured_at, event_id, commence_time, home_team, away_team, book, side, line, provider, book_updated_at FROM nfl_line_snapshots WHERE provider LIKE 'free:%' AND market = ? AND line IS NOT NULL AND captured_at >= ? AND captured_at <= ? ORDER BY captured_at\`, market, since, now);` with `sinceDays=14` default (line 71). Same missing-`captured_at`-index issue as #66 (core-and-fantasy.js:901 confirmed, only `idx_lines_event(event_id, market)` exists). Confirmed real, accurately cited.

## #68 nfl-quote-tape.js:192 — P2 — CONFIRMED
Line 192 exact match: `export function closingQuotes(providerEventId, { maxAgeMinutes = 90 } = {}) {`. DB confirms two `nfl_quote_tape` provider namespaces: `the-odds-api` uses opaque hex ids (e.g. `b486d307229bf228a2ff98df57b3fa45`), `free-book-feeds` uses composite ids (e.g. `nfl:2026-09-11:SF@LAR`). Both `closingQuotes` and `bestExecutableQuote` (line 208) key strictly on the caller-supplied `providerEventId` string with no cross-namespace reconciliation. Also independently confirmed the claim's aside about nfl-clv.js's `closingConsensus` (lines 93-99, using `nfl_line_snapshots.event_id` rather than `provider_event_id`) having "the same exposure": `nfl_line_snapshots.event_id` itself carries the identical two-namespace split — DB confirms NULL-provider rows (the-odds-api-origin, e.g. `000fc688beb4fc004ecdad115d9adb1c`) are hex while `free:*`-provider rows use the `nfl:<date>:AWAY@HOME` composite format used throughout book-feeds.js. Confirmed fully, evidence matches almost verbatim.

---

## Summary
All 17 claims from G09-market-data survive adversarial review as substantively correct, confirmed either directly in code or with DB cross-checks (several claims' numeric evidence was independently re-derived and matched closely or exactly, accounting for natural growth in a live-capturing system). The lone imperfection found:
- **#66**: the underlying defect is real and the quoted snippet is verbatim-correct, but the cited line number (251) is wrong by about 46 lines (correct location is ~199-206, inside `bookLagDistribution`, not `pipelineHealth`). Flagged but not refuted, since the code and defect it describes genuinely exist in the file exactly as quoted.
- **#55**: one piece of supporting evidence ("header at polymarket.js:7-8 still says 30") does not exist in that file/location — the actual "every thirty minutes" comment is in a different file (market-movement.js:22). The core defect (unbounded per-tick inserts, no pruning, 3-minute cadence) is independently confirmed via scheduler.js and fresh DB counts that match the claim's cited numbers closely.

No claim was found to be based on a misread of the code, a guard that already prevents the described failure, or a snippet that doesn't exist in the file.
