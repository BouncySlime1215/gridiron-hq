# Verification notes: G02-migrations-late claims #4, #5

## Claim #4 (server/migrations/032_quote_receipt_clock.js:46) — P1

### Files read in full
- server/migrations/032_quote_receipt_clock.js (131 lines, read whole)
- server/services/nfl-quote-tape.js (234 lines, read 1-200 directly; rest is unrelated helper fns)
- server/services/book-feeds.js (lines 380-425 read; ingestQuoteSnapshot call site at 417-418)
- server/services/line-shopping.js (lines 30-80 read; call site at 66)
- server/services/nfl-t60-packet.js (lines 160-250 read; the receivedByCutoff filter)
- server/services/scheduler.js (relevant registration lines 230-345, 742-960, 1094)
- server/services/nfl-prospective-collection.js (lines 1-50 — explicit "DELIBERATELY NOT A SCHEDULED JOB" doc comment)
- server/routes/nfl-betting.js:1434-1438 (`/t60/packet` route mount)
- server/index.js:46,106 (nfl-betting router mounted at `/api/nfl-betting`)

### Reachability
- `captureBookFeeds` (book-feeds.js) is registered as TWO live scheduler jobs: `nfl_book_feeds_fast` (server/services/scheduler.js:755, maxAgeMinutes 5, tier 'live') and `nfl_book_feeds_slow` (:757, maxAgeMinutes 60). Confirmed live, reachable, actually running (the task brief says server PID 56651 is capturing T-60 packets right now).
- `snapshotLines` (line-shopping.js) is registered as `nfl_line_snapshots` (scheduler.js:742, maxAgeMinutes 12*60).
- Both call `ingestQuoteSnapshot(...)` WITHOUT `receivedAt` or `receiptClockSource`:
  - book-feeds.js:417-418: `ingestQuoteSnapshot(payload, { provider: 'free-book-feeds', requestedAt: at, markets: 'spreads,totals,h2h', sourceRef: 'book_feeds' })`
  - line-shopping.js:66: `ingestQuoteSnapshot(data, { requestedAt: at, markets, sourceRef: 'snapshot_lines' })`
- nfl-quote-tape.js:65 default logic: `const clockSource = receiptClockSource ?? (receivedAt ? 'response_completion' : 'legacy_request_time_only')`. Since neither live producer passes `receivedAt`, every batch they write gets `legacy_request_time_only`.
- The ONLY code paths that pass `receiptClockSource: 'response_completion'` are `captureCurrentQuoteTape` (nfl-quote-tape.js:136-137) and `backfillHistoricalQuoteTape` (:164-165). Both are called exclusively from `nfl-prospective-collection.js`, whose own header comment (lines 14-31) states in so many words: "DELIBERATELY NOT A SCHEDULED JOB ... a button press, not a cron entry ... This module never calls itself; nothing in this codebase invokes it from a timer." Confirmed by grep: `nfl-prospective-collection.js` is imported only by `server/routes/nfl-market.js` (a manual on-demand route, gated behind `requireModelPermission`), never by scheduler.js.
- The T-60 packet consumer (nfl-t60-packet.js:214-216) filters `realClock = scopedQuotes.filter(q => q.receipt_clock_source === 'response_completion')` and only rows in `realClock` can land in `receivedByCutoff`. This function is reachable both as a scheduled job (`nfl_t60_runner`, scheduler.js:785-788, wired to `betting/nfl/strategy/t60-runner.js`) and as a mounted HTTP route (`GET /t60/packet` in nfl-betting.js:1434, mounted at `/api/nfl-betting` in server/index.js:106).

### Live-database verification (read-only, node:sqlite)
```
total batches: 1388
receipt_clock_source='legacy_request_time_only': 1388
receipt_clock_source='response_completion': 0
```
i.e. **zero** rows anywhere in the live database have ever recorded a real observed receipt clock, despite migration 032 having shipped and despite `captureCurrentQuoteTape`/`backfillHistoricalQuoteTape` supporting it.

Migration 032 was applied at `2026-09-10 19:58:50` (schema_migrations table). Batches created strictly after that timestamp: **413**, all still `legacy_request_time_only` (0 `response_completion`). So every single batch captured since the fix shipped is legacy-labelled, exactly as the claim states (the claim's own numbers, 346 of 1321, are simply a slightly earlier snapshot of the same continuously-growing, monotonically-confirming count — the live server is still capturing T-60 packets as I write this, so the totals have grown from 346/1321 to 413/1388, but the *fraction* — 100% legacy since 032 — is identical and unchanged).

### Verdict
CONFIRMED, not refuted. Both cited producers are registered scheduler jobs (live, "tier: live" for book-feeds), both omit the parameters needed to earn `response_completion`, and the only code path that would supply them is explicitly documented as never scheduled and gated behind a paid/manual route. Direct query of the live database independently confirms 0/1388 batches ever recorded a real receipt clock, and 0/413 batches written since migration 032 shipped did either. The T-60 packet's `receivedByCutoff` computation is therefore provably empty for any post-032 evidence, exactly as claimed. P1 severity is appropriate: this defeats the stated purpose of the C11 fix and leaves the prospective experiment structurally unable to produce the one signal (received_by_cutoff) it exists to measure.

---

## Claim #5 (scripts/rollback-migration.mjs:6) — P2

### Files read in full
- scripts/rollback-migration.mjs (10 lines, read whole)
- server/db/migrate.js (81 lines, read whole)
- server/migrations/018_saved_prop_tickets.js (down() at 36-41)
- server/migrations/019_nfl_news_events.js (down() at 66-71)
- server/migrations/020_decision_recommendations.js (down() at 93-100)
- server/migrations/021_quote_tape_batch_index.js (down() at 16-18)
- server/migrations/022_scottfree_game_features.js (down() at 64-68)
- server/migrations/023_execution_lifecycle_ledger.js (down() at 110-123)
- server/migrations/024_candidate_findings.js (down() at 70-77)
- server/migrations/025_candidate_finding_discovery_note.js (down() at 19-22)
- server/migrations/026_execution_opportunity_forecast.js (down() at 34-42)
- server/migrations/027_decision_tape.js (down() at 262-292+, guard logic)
- server/migrations/028_settlement_corrections.js (down() at 84-115, guard logic)
- server/migrations/029_quote_tape_commence_index.js (down() at 32-34)
- server/migrations/031_decision_identity.js (down() at 233-261, guard logic)
- server/migrations/032_quote_receipt_clock.js (down() at 117-131, guard logic)
- server/migrations/033_opportunity_push_probability.js (down() at 46-58, guard logic)
- server/migrations/034_t60_runner_ledger.js (down() at 90-105, guard logic)
- server/migrations/035_alt_spread_capture.js (down() at 222-244, guard logic)
- package.json:34 (`"db:rollback": "node scripts/rollback-migration.mjs"`)

### Reachability
`npm run db:rollback` is a real, wired script (package.json:34) that calls `rollbackMigration` (server/db/migrate.js:59-81), reachable and executable exactly as described.

### Core defect confirmed
- `runMigrations` (migrate.js:33-57) calls `backupBeforeMigration(...)` at lines 42-45 before applying anything.
- `rollbackMigration` (migrate.js:59-81) has **no** call to `backupBeforeMigration` anywhere in its body. Confirmed by reading the full 81-line file — the only backup call in the file is inside `runMigrations`.
- `rollbackMigration` only ever rolls back the single most-recently-applied migration (`ORDER BY rowid DESC LIMIT 1`, migrate.js:61) and returns; it does not loop through multiple migrations in one call. So "npm run db:rollback" undoes exactly one step per invocation — reaching migration 018's down() from the current latest (035) requires ~10-17 *separate* successful invocations in descending order, not literally one command.
- Migrations 018, 019, 020, 022, 023, 024 do unconditionally `DROP TABLE` populated data tables in `down()` with **no row-count check, no guard, no refusal** — confirmed by reading each file's down(). (021, 025, 026 are index/column-only and drop nothing destructive.)
- Migrations 027, 028, 031, 032, 033, 034, 035 (i.e., everything *above* 018-024 in migration order) DO carry `throw new Error('...refusing to downgrade...Restore the pre-migration snapshot instead.')` guards, gated on row counts in their own tables — confirmed by reading each down().

### Adversarial check: is the 018-024 data actually reachable via repeated rollback TODAY?
I queried the live (read-only) database for every guard condition, in order from 035 down to 027:
```
035: alt_spread_captures=0, alt_spread_quotes=0        -> guard does NOT trip (down() succeeds, drops empty tables)
034: t60_observations=1,   capacity_events=0           -> guard DOES trip (1 truthy)  -> throws, rollback refused HERE
033: push_treatment IS NOT NULL count = 0               -> would not trip (not reached)
032: receipt_clock_source='response_completion' count=0 -> would not trip (not reached)
031: decision_runs non-legacy=0, invalidations=0        -> would not trip (not reached)
028: settlement_correction count = 0 (lifecycle_events_total=0 anyway) -> would not trip (not reached)
027: lifecycle_events_total=0, so both stranded counts=0 -> would not trip (not reached)
```
Populated-table counts confirmed live: news_events=30, decision_recommendations=5, nfl_scottfree_game_features=285, nfl_candidate_findings=1 — matching the claim's cited numbers exactly.

**Important nuance the claim glosses over**: as the live database stands right now, a second `npm run db:rollback` invocation (after the first pops the already-empty 035 tables) would hit migration 034's guard (`nfl_t60_observations` has exactly 1 row — the very Week-1 T-60 capture this system is running right now) and throw `034_t60_runner_ledger: refusing to downgrade — 1 prospective observation(s)...`. The rollback chain would stop there, and none of 033/032/031/029/028/027/026/025/024/023/022/021/020/019/018 would be reached in the database's current state. So the exact scenario as narrated ("npm run db:rollback can delete 30 news events...") is **not executable right now** without the operator first clearing/losing that single t60 observation row (which is itself either app-driven or a further manual action).

That said, this block is incidental, not structural: it depends on there being at least one row in `nfl_t60_observations` at the moment the operator reaches migration 034 in the chain. Every other guard between 035 and 024 (033, 032, 031, 028, 027) is currently unguarded-in-practice (their tracked counts are 0), and none of them protects the 018-024 tables at all regardless of data state — 018-024 have no guard of any kind, ever, no matter what data they hold. So in any operating window without a live t60 observation recorded (e.g., before this specific in-progress capture started, or after a season in which nobody has an open T-60 capture), a determined-but-careless sequence of `npm run db:rollback` invocations would sail straight through to 018-024 and drop populated tables with zero backup and zero warning, because `rollbackMigration` truly never snapshots.

### Verdict
Confirmed as a real, reachable, currently-live gap in the codebase (npm script, no backup call, unconditional early-migration drops), but the claim's framing overstates immediacy: (a) "a single mistyped command sequence" undersells that it requires roughly a dozen sequential correct invocations in descending migration order, not one command, and (b) as the live database sits right now, the chain would be interrupted (refused, not silently drained) at migration 034 by the one real `nfl_t60_observations` row currently being written by the live T-60 capture — so the exact scenario described cannot fire today without an intervening change of state. The underlying architectural defect (no pre-rollback snapshot; 018-024 unconditionally destructive) is real and worth a finding, but I'd soften the certainty of "can delete ... with no recovery point" to "would be able to, once/if the newer migrations' guards are not tripped by live data" — a real but conditionally-blocked P2, not an unconditionally-live P2 today.
