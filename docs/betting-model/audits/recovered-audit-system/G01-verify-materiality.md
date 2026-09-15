# G01 adversarial verification — lens: materiality

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only). Live server PID 56651 started
2026-09-11 00:55:49; every file below has mtime 2026-09-10 or earlier, so the live process runs the code cited.

## Verdict

**Factual claim: CONFIRMED. Materiality: REFUTED (downgrade P1 -> P2, "precondition for a not-yet-existing consumer").**
Closing G01 alone changes no number Nick reads, no decision, no historical record, and no *recoverable* forward
record. The packet content it would improve is never persisted; only an irreproducible sha256 survives.

## What the gap says, verified line by line

1. `server/services/book-feeds.js:417-418` — `ingestQuoteSnapshot(payload, { provider: 'free-book-feeds', requestedAt: at, markets, sourceRef: 'book_feeds' })` — no `receivedAt`, no `receiptClockSource`.
2. `server/services/line-shopping.js:66` — `ingestQuoteSnapshot(data, { requestedAt: at, markets, sourceRef: 'snapshot_lines' })` — same.
3. `server/services/nfl-quote-tape.js:64-65` — `const receipt = receivedAt ?? requestedAt; const clockSource = receiptClockSource ?? (receivedAt ? 'response_completion' : 'legacy_request_time_only');`
4. `server/services/nfl-t60-packet.js:214-216` — `realClock = ... === 'response_completion'`; `receivedByCutoff = realClock.filter(...)`; legacy rows never enter.
5. `nfl-t60-packet.js:225-228` — `receivedAt` passed to `sourceEntry` is `null` when `realClock` is empty; `:112-121` then falls through to `claim: 'availability_unknown'` with `rows: 0` and `values: []`.

Live DB (node:sqlite readOnly, 2026-09-12):
- `nfl_quote_batches`: 1,336 rows, **1,336 `legacy_request_time_only`** (1,168 `free-book-feeds`, 168 `the-odds-api` historical backfills from 2026-09-09, pre-dating the 09-10 code). `received_at = requested_at` on all 1,336. 144 batches since 09-11, all `book_feeds`, all legacy — i.e. the live process is producing legacy rows right now.
- SF@LAR (cutoff 2026-09-10T23:35:00Z): 18,692 `spreads/full_game` tape rows from 12 books with `received_at <= cutoff` — every one rejected by the gate. With the fix they would all have been `received_by_cutoff`.
- The only `response_completion` producer, `captureCurrentQuoteTape` (`nfl-quote-tape.js:127-138`), is reachable only through `runProspectiveCollection` (`nfl-market.js:35`, documented at `:402` as "NOT a scheduled" job) and needs the Odds API, which is at 2 credits (`sync_log.nfl_line_snapshots`: "holding 2 API credits in reserve"). So on the running config no batch can ever be admitted. The gap's "can never be admitted" is accurate.

## Why it is nonetheless immaterial on its own

### 1. No number Nick reads changes
- `grep -rn -i "t60|/packet|receipt_clock|availability_unknown|received_by_cutoff" client/src` -> **zero hits**. No UI surface renders the packet or the observation ledger.
- The only read surface is `GET /t60/packet` (`server/routes/nfl-betting.js:1434-1450`), which recomputes on demand and is not called by the client.
- Every board Nick does read is clock-blind: shopping/sharp/steam/pick-watch read `nfl_line_snapshots` (`book-feeds.js:27-31`); CLV grading reads `nfl_quote_tape` by `snapshot_at` with no join on `nfl_quote_batches` (`nfl-execution-clv.js:126-131`); `closingQuotes`/`bestExecutableQuote` filter on `snapshot_at` (`nfl-quote-tape.js:197-199, 214`). None consult `receipt_clock_source`.

### 2. No decision changes
- `t60-runner.js:22-25`: "It does not place bets, and it does not grant a forecast authority."
- `nfl_decision_runs` = 0 rows, `nfl_decision_events` = 0, `nfl_capacity_events` = 0, `nfl_t60_observations.decision_run_id` = NULL on the only row.
- `sealForecastPacket`/`validateForecastPacket` (`contracts/forecast-packet.js:89,206`) have **no production caller** — only tests. The gate that would reject a legacy-clock prospective packet (`forecast-packet.js:127-129`) is never invoked.

### 3. The historical record is untouched either way
- Batches are immutable (`nfl-n-to-z.js:807-813` triggers); migration 032 explicitly refuses to backfill legacy rows (`032_quote_receipt_clock.js:24-46`). The fix is forward-only by design.

### 4. The forward record it would "fix" is not retained
- `t60-runner.js:127-129` persists **only** `packet_hash`; the packet object is returned in `captured` (`:130`) and dropped.
- `packetHash` (`:141-143`) hashes the whole packet, which carries `computation_started_at` (`nfl-t60-packet.js:332`, set from `startedAt` at `t60-runner.js:112,118`) — so the hash is **not reproducible** even in principle.
- The runner's return value goes to `sync_log.last_detail`, which `record()` overwrites on every run (`scheduler.js:78-85`, `ON CONFLICT(job) DO UPDATE ... last_detail=excluded.last_detail`). One row per job (verified: `COUNT(*)=1` for `nfl_t60_runner`, `runs=148`); the SF@LAR detail is already gone (current detail has `captured` = 0).
- No table holds packet content: the only `%packet%` columns are `nfl_t60_observations.packet_hash` and `nfl_ai_replay_reviews.packet_json` (unrelated).
- `forecast-packet.js:8-9` states the project's own standard: "A hash without retained content cannot reconstruct a decision." By that standard the frozen SF@LAR observation is equally empty with or without G01.

So: stamp `receivedAt` tonight and the 15 remaining Week 1 observations freeze with `received_by_cutoff` and thousands of `values` — for the ~1 second the packet exists in memory before it collapses to an irreproducible hash. Nothing Nick can open, query, or evaluate differs.

### 5. The fix is label-only, and the "dangerous direction" argument does not apply to the live producers
- `book-feeds.js:380-390`: `at` is stamped at `:390` **after** `await Promise.all(...)` of every provider fetch (`:380-388`). `line-shopping.js:42`: `at` is stamped after `await gameOdds(...)` at `:39`. In both live producers `requested_at` is already the response-completion instant (or later). The stored clock is conservative, not early; C11's look-ahead direction (`nfl-quote-tape.js:47-55`) cannot occur through these two paths. The correct fix is to pass the same `at` as `receivedAt` with `receiptClockSource: 'response_completion'` — zero timestamp values change, only the label.

## What would make G01 material
It becomes load-bearing the moment either (a) `nfl_t60_observations` (or a sibling table) retains packet content, or (b) a decision consumer calls `sealForecastPacket` on a prospective packet. Until then it is a precondition, and it must ship **no later than** those — every observation frozen before it is permanently price-blind because the ledger forbids reconstruction (`t60-runner.js:14-20`). 15 Week 1 games (16 on schedule, 1 already frozen) open within 24h of Sat/Sun cutoffs; they will freeze price-blind — and content-less regardless.

## Corrected statement
G01 (P2, precondition): the two live tape producers (`book-feeds.js:417`, `line-shopping.js:66`) label a response-completion timestamp as `legacy_request_time_only`, so `freezeT60Packet` can never admit a quote in prospective mode. Immaterial today: no UI, decision, or persisted record consumes the packet, and the runner retains only an irreproducible hash. Bundle with "persist the frozen packet" (and a decision consumer) and land it first; the fix is passing the existing `at` as `receivedAt` + `receiptClockSource: 'response_completion'` in both producers.
