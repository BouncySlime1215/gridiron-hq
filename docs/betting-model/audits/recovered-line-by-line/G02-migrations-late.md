# G02-migrations-late — migrations 018–035, migration scripts, migration tests

Reader: G02-migrations-late. Date: 2026-09-11. Repo: `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` (read-only).
Every assigned file was read in full (`cat -n` / `sed -n`); lines_read equals `wc -l` for each. Supporting reads (not in my assignment, cited for wiring): `server/db/migrate.js` (81 lines, full), `server/db/preflight.js` (282, full), `server/db/index.js` 40–160, `server/services/nfl-quote-tape.js` 40–170, `server/services/book-feeds.js` 395–425, `server/services/line-shopping.js` 55–70, `server/db/schema/nfl-n-to-z.js` 355–382 and 804–812, `server/services/scheduler.js` 1065–1100, `server/betting/nfl/strategy/t60-runner.js` (grep only), `docs/evidence/2026-09-11/RETURN-TO-CODEX.md` 1–80, `docs/evidence/2026-09-10/CODEX-6-HANDOFF.md` 140–175, `test/model-registry-persistence.test.js` 455–490.

Live DB (`server/data.sqlite`, opened once with `node:sqlite { readOnly: true }`, no `.bak` touched):
- `schema_migrations` = **35 rows**: `000_legacy_schema`, `001`…`029`, `031`…`035`. No `030`. Matches the brief.
- Row counts: `nfl_decision_runs` 0, `nfl_decision_events` 0, `nfl_decision_run_invalidations` 0, `nfl_execution_opportunities` 0, `nfl_execution_lifecycle_events` 0, `nfl_quote_batches` **1321** (all `receipt_clock_source='legacy_request_time_only'`, including the **346 written after 032 was applied**, newest `2026-09-12T02:32:43Z`, all `source_ref='book_feeds'`), `nfl_t60_observations` 1 (SF@LAR, `state='frozen'`, `decision_run_id=NULL`), `nfl_capacity_events` 0, `nfl_alt_spread_captures` 0, `nfl_alt_spread_quotes` 0, `nfl_teaser_price_ledger` 1, `saved_prop_tickets` 0, `nfl_news_events` 30, `decision_recommendations` 5, `nfl_scottfree_game_features` 285, `nfl_candidate_findings` 1, `nfl_candidate_finding_seasons` 5.
- `schema_preflight` table does **not** exist → the C03 preflight repair has never run on the real DB (it never needed to: 0 lifecycle events).
- Triggers installed by my migrations are all present on the live DB (023/027/028/031/034/035 sets, plus `nfl_teaser_price_ledger_no_alt_spread`). `PRAGMA foreign_keys` = 1.
- `nfl_execution_opportunities` live SQL carries the widened CHECK (`'passed','expired','cancelled'`), `decision_event_id`, `push_probability`, `push_treatment` — 027/033 landed as designed.

## Runner contract (context for every file below)

`server/db/migrate.js:33-57` `runMigrations(database, databasePath)`: lists `server/migrations/*.js` matching `/^\d+_.+\.js$/`, **sorted by filename** (`:35`), plans preflight repairs (`:40`), takes one `VACUUM INTO` snapshot if anything is pending (`:42-45`), applies repairs outside any transaction (`:46`), then `migrate(name, () => mod.up(database), database)` per file (`:53`). `server/db/index.js:46-57` `migrate()` = skip if recorded, `BEGIN IMMEDIATE` → `fn()` → `INSERT schema_migrations` → `COMMIT`, `ROLLBACK` on throw. So every `up()` runs inside a write transaction with `PRAGMA foreign_keys = ON` (`index.js:16`) and cannot toggle it. `rollbackMigration` (`migrate.js:59-81`) pops the newest non-000 row by rowid, refuses a name mismatch, runs `down()` in its own transaction, **takes no snapshot**.

---

## server/migrations/018_saved_prop_tickets.js (41 lines)

- Purpose: `saved_prop_tickets` (id, saved_at, legs_json, total odds) + `idx_saved_prop_tickets_saved_at` (`:25-32`). Moves MLB saved slips from localStorage to the server (`:3-21`).
- Triggers: none. Protected-table writes: none. Rollback: `down()` drops index+table (`:36-41`) — **destructive if populated, no refusal**; live count is 0 today.
- Wiring: `server/routes/props-tickets.js:5`, `client/src/pages/props/lib.ts:18` reference it; table used by `server/routes/props-tickets.js`. Tests: `test/props-saved-tickets.test.js:28-29`, `test/model-registry-persistence.test.js:486,551`.
- Verdict: clean.

## server/migrations/019_nfl_news_events.js (71 lines)

- Purpose: `nfl_news_events` typed-claim evidence table (`:21-50`) with 4 indexes (`:51-54`) and `nfl_news_event_extraction_cache` keyed by content hash (`:56-62`). Self-FK `superseded_event_id REFERENCES nfl_news_events(event_id)` (`:43`).
- Triggers: none. Protected writes: none. Rollback: drops both tables (`:66-71`) — destructive, no refusal; **live holds 30 events**.
- Wiring: used by `server/services/nfl-news-events.js`, `nfl-news-event-impact.js`, `nfl-t60-packet.js`, `scripts/run-news-event-impact.mjs`. No file imports the migration by name (expected; runner loads by directory).
- Note: `verification_state`/`verification_reason` default to quarantined (`:47-48`) — good default for a claim table.
- Verdict: clean.

## server/migrations/020_decision_recommendations.js (100 lines)

- Purpose: universal Decision Inbox table `decision_recommendations` (`:63-83`), CHECK'd `sport`, `urgency`, `status`; `league_id REFERENCES leagues(id) ON DELETE CASCADE` (`:65`); `dedup_key NOT NULL` (`:79`) with a plain (non-unique) index (`:86-87`) — upsert-by-dedup_key-while-open is application logic, not a constraint (documented `:51-56`).
- Triggers: none. Protected writes: none. Rollback: drops 3 indexes + table (`:93-100`) — destructive; **live holds 5 rows**.
- Wiring: `server/routes/decision-inbox.js:7`, writers `server/services/waiver-brain.js`, `server/services/trade-engine.js`. Tests `test/decision-inbox.test.js:40-41`.
- Verdict: clean. (P3 observation: the "open row per dedup_key" invariant is not enforced by a partial unique index `WHERE status='open'`, which SQLite supports; the comment at `:51-56` promises the behaviour, the schema does not.)

## server/migrations/021_quote_tape_batch_index.js (18 lines)

- Purpose: `idx_nfl_quote_tape_batch ON nfl_quote_tape(batch_id)` (`:13`). Motivated by a 470M-row-scan dataset build (`:4-10`).
- Reversible (`:17`). Live DB has the index. Not defined in the baseline schema module (contrast 029 below).
- Verdict: clean.

## server/migrations/022_scottfree_game_features.js (68 lines)

- Purpose: `nfl_scottfree_game_features` vendor research panel (`:39-58`), keyed by `source_game_key`, outcome columns explicitly labelled as labels (`:51-54`), two indexes (`:59-60`). Header correctly flags it as RECONSTRUCTED, not point-in-time safe (`:14-28`).
- Triggers: none. Rollback drops (`:64-68`) — destructive; **live holds 285 rows**.
- Wiring: only writer/reader `scripts/import-scottfree.mjs:4`. No service reads it → the table is import-only research data.
- Verdict: clean.

## server/migrations/023_execution_lifecycle_ledger.js (123 lines)

- Purpose: `nfl_execution_opportunities` header (`:47-61`, status CHECK of 6 states) and `nfl_execution_lifecycle_events` event log (`:69-88`) with `fill_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(fill_confirmed = 0)` (`:83`) — pins "never a book fill" at schema level. Partial unique index `idx_lifecycle_single_state … WHERE state <> 'refreshed'` (`:92-94`).
- Triggers installed: `nfl_execution_lifecycle_events_no_update`, `_no_delete` (`:101-106`).
- FK: child `ON DELETE CASCADE` to parent (`:71`) — this is the cascade that made 027's rebuild abort (see 027).
- Rollback: drops triggers, indexes, both tables (`:110-123`) — destructive, no refusal (0 live rows).
- Wiring: `server/services/nfl-execution-lifecycle.js:20` (writer), `nfl-execution-clv.js` (reader).
- Verdict: clean; the design decision that later cost 027/preflight is documented honestly in 027.

## server/migrations/024_candidate_findings.js (77 lines)

- Purpose: `nfl_candidate_findings` (segment-bias findings, state machine CHECK `:36-37`) and `nfl_candidate_finding_seasons` with `UNIQUE(finding_id, season)` (`:64`) enforcing "a season never changes role".
- Triggers: none. Rollback drops both (`:70-77`) — destructive; **live 1 finding, 5 season rows**.
- Wiring: `server/services/nfl-candidate-findings.js`.
- Verdict: clean.

## server/migrations/025_candidate_finding_discovery_note.js (22 lines)

- Additive nullable column `discovery_note` guarded by `PRAGMA table_info` (`:13-16`); `down()` uses `ALTER TABLE … DROP COLUMN` (`:21`) — fine on the bundled SQLite (≥3.35).
- Verdict: clean.

## server/migrations/026_execution_opportunity_forecast.js (42 lines)

- Additive nullable `model_line`, `model_probability`, `market_line_at_decision` on the opportunity header (`:28-31`), each guarded. `down()` drops in reverse (`:38-41`). No trigger, no protected write.
- Verdict: clean.

## server/migrations/027_decision_tape.js (370 lines)

- Purpose: append-only decision tape `nfl_decision_runs` (`:72-90`, `board_hash UNIQUE`) + `nfl_decision_events` (`:94-114`, every candidate incl. abstentions `:108-111`); widens the execution ledger's status/state vocabulary with `passed/expired/cancelled` by table rebuild.
- Triggers installed: `nfl_decision_events_no_update`, `_no_delete`, `nfl_decision_runs_no_update` (`:118-126`) — note **no `nfl_decision_runs_no_delete`** here (added by 031:227-229). Lifecycle triggers are re-created after the child rebuild (`:231-236`).
- Protected-table writes: the parent rebuild (`:155-189`) `DROP TABLE nfl_execution_opportunities` (`:184`) which with FKs on cascades into the append-only child — the C03 defect. Fix verified: (a) guard at `:138-154` reads the stored SQL, and if the parent is un-widened AND `lifecycleEventCount()` (`:60-65`) > 0 it **throws with a named instruction** instead of aborting inside SQLite; (b) `server/db/preflight.js:125-134` detects the same condition from live schema, `:151-196` rebuilds the parent outside any transaction with FKs suspended (`:225-234` read-back refuses if inside a txn), verifies row set equality both directions (`:168-176`), replays carried indexes/triggers (`:160-161,180`), scoped `foreign_key_check` (`:186`), records to `schema_preflight` (`:268-269`). `runMigrations` calls it before the first file (`migrate.js:40,46`). Then 027 finds `'passed'` already present and skips the parent rebuild, still ALTERs `decision_event_id` (`:132-136`) and rebuilds the child (`:192-238`), which cascades into nothing. Fresh DB does both rebuilds itself. Verified by `test/migration-027-populated-upgrade.test.js` (see below).
- Rollback: `down()` refuses if any terminal state exists (`:263-278`) or if any lifecycle events exist at all (`:279-283`, cannot suspend FKs); otherwise narrows both tables (`:286-357`) and drops the tape (`:359-369`). Refusals point at the pre-migration snapshot. Correct.
- Wiring: `server/services/nfl-decision-tape.js` (runs/events/invalidations), `server/db/preflight.js:5`.
- P3 note: the narrowing rebuild in `down()` at `:336-350` drops `decision_event_id`, `push_probability`, `push_treatment` silently — acceptable only because 033's `down()` refuses when `push_treatment` is set and 027's own guard refuses when any event exists; with 0 events but N opportunities holding `push_probability` values but NULL `push_treatment`, the values are dropped without a message. Edge case, low value.
- Verdict: correct after C03; heavy but honest.

## server/migrations/028_settlement_corrections.js (134 lines)

- Purpose: adds `settlement_correction` state to the lifecycle CHECK by child rebuild (`:27-67`); the recurring-state exclusion in the partial unique index becomes `WHERE state NOT IN ('refreshed','settlement_correction')` (`:56-58`). Guard `:25-26` makes it idempotent. Triggers re-created (`:61-66`). Dropping the child cascades into nothing — safe inside the txn.
- Rollback: refuses if any correction exists (`:87-93`), else narrows (`:94-133`). Correct.
- Verdict: clean.

## server/migrations/029_quote_tape_commence_index.js (34 lines)

- `idx_nfl_quote_commence ON nfl_quote_tape(commence_time)` (`:29`); reversible (`:33`). Header (`:19-24`) says the packet predicate was fixed to a 1-second range alongside.
- **Also defined in the baseline schema module** `server/db/schema/nfl-n-to-z.js:805-806`, unlike 021's and 032's tape indexes. See D5.
- Wiring: consumed by `nfl-t60-packet.js` queries (and 032 says a kickoff-only lookup is the cross-game bug it supersedes with `idx_nfl_quote_event_scope`; both exist on the live DB).
- Verdict: clean, minor ownership inconsistency.

## (030 — absent)

- `docs/evidence/2026-09-10/CODEX-6-HANDOFF.md:157-158`: number **030** was reserved for the C03 parallel worker, 031 for C01/C02 "so the two could not collide". The worker "died before writing any tests" (`:161-162`); its repair shipped as `server/db/preflight.js` (not a numbered migration, because a migration cannot suspend FKs — `preflight.js:24-38`). So 030 was never written. Not a gap in *applied* history: the runner has no notion of contiguity (`migrate.js:35` sorts filenames; `:36-39` counts unrecorded names). `preflight.js:34-35` even speaks of "030 never gets to run" as a hypothetical.
- Hazard (D3): if someone later "fills" 030, the runner would apply it **after 035** on every existing install but **between 029 and 031** on a fresh install — two schema histories. The number should be retired explicitly (a README note or a no-op `030_reserved_c03_preflight.js` marker).

## server/migrations/031_decision_identity.js (261 lines)

- Purpose: adds observation identity to the tape: 15 columns on `nfl_decision_runs` (`:69-95`), 14 forecast columns on `nfl_decision_events` (`:98-113`), backfills legacy runs (`:150-163`), creates append-only `nfl_decision_run_invalidations` (`:178-195`) and appends an invalidation for any run whose event count ≠ header count (`:197-208`), unique index on `observation_key` (`:216-217`), plus the missing `nfl_decision_runs_no_delete` (`:227-229`).
- Protected-table write: `UPDATE nfl_decision_runs` (`:150-162`) against 027's `nfl_decision_runs_no_update`. Fix verified: `DROP TRIGGER IF EXISTS nfl_decision_runs_no_update` (`:148`) → UPDATE → `CREATE TRIGGER IF NOT EXISTS …` with 027's exact body (`:167-171`), all inside the runner's transaction (a throw rolls back both). RETURN-TO-CODEX.md:21 confirms the live DB had 0 runs, so the original bug was latent there; the fixture now seeds a run (`test/migration-027-populated-upgrade.test.js:104-134`) and `:445-475` asserts the backfill + restored trigger.
- Rollback: refuses if any non-legacy observation or any invalidation exists (`:245-254`); otherwise drops only the delete trigger and 3 indexes (`:255-260`). **Leaves `nfl_decision_run_invalidations` and its two triggers in place** (D4) though the comment (`:240-241`) only claims added *columns* are left. After `031 down` → `027 down` (which drops `nfl_decision_runs`, `:368`), the invalidations table survives with a dangling FK. Harmless on re-upgrade (`CREATE TABLE IF NOT EXISTS`, `:178`) but untidy and the walk in `test/model-registry-persistence.test.js:459-463` exercises exactly that path without asserting the table is gone.
- Verdict: correct after dd13278; P3 rollback hygiene.

## server/migrations/032_quote_receipt_clock.js (131 lines)

- Purpose: `received_at`, `receipt_clock_source` on `nfl_quote_batches` (`:57-62`), backfill legacy batches as `legacy_request_time_only` with `received_at = requested_at` as a lower bound (`:94-98`), and `idx_nfl_quote_event_scope(commence_time, home_team, away_team, market, period)` (`:112-113`).
- Protected-table write: `UPDATE nfl_quote_batches` vs `nfl_quote_batches_no_update` (baseline `nfl-n-to-z.js:807`). Fix verified: trigger dropped `:92`, restored `:99-103` with the identical body `'quote batches are immutable'`. RETURN-TO-CODEX.md:22,49 records the live upgrade (1,154 batches labelled; my read-only count today: 1321, all legacy). Fixture seeds two batches (`test/…:136-160`) and `:477-510` asserts.
- Fresh-install path: `:54-55` returns early only if the table is absent; the baseline module now creates the table **with** both columns (`nfl-n-to-z.js:372,377`) so the ALTERs are skipped and the UPDATE matches nothing. That dependency on a retro-edited baseline is D5.
- Rollback: refuses if any `response_completion` batch exists (`:122-129`); else drops only the index (`:130`), keeps the columns — deliberate.
- **D1 (P1) — the clock this migration introduces is never stamped by the live producers.** `:46` promises "New captures record the true clock from the moment this ships." Only `captureCurrentQuoteTape` (`nfl-quote-tape.js:128-137`, paid Odds API) and `backfillHistoricalQuoteTape` (`:164-166`) pass `receivedAt`. The two producers that actually run — `server/services/book-feeds.js:417-418` (`ingestQuoteSnapshot(payload, { provider: 'free-book-feeds', requestedAt: at, …, sourceRef: 'book_feeds' })`) and `server/services/line-shopping.js:66` (`ingestQuoteSnapshot(data, { requestedAt: at, markets, sourceRef: 'snapshot_lines' })`) — pass no `receivedAt`, so `ingestQuoteSnapshot`'s default (`nfl-quote-tape.js:64-65`: `clockSource = receiptClockSource ?? (receivedAt ? 'response_completion' : 'legacy_request_time_only')`) labels every one of them legacy. Live evidence: 346 batches created after 032 was applied (2026-09-10 19:58) through 2026-09-12 02:32, **100 % `legacy_request_time_only`, all `source_ref='book_feeds'`**. `nfl-t60-packet.js:214-216` grants `received_by_cutoff` only to `receipt_clock_source === 'response_completion'`, so the frozen SF@LAR packet (`nfl_t60_observations` row, `state='frozen'`) and every Week-1 Sunday packet can contain zero knowable quotes — the prospective T-60 experiment (the only prospective evidence path in the plan, C11 / slice 7) is structurally empty, and nothing reports it as a producer bug rather than "legacy data". Fix (one line each): in `book-feeds.js:417` and `line-shopping.js:66` pass `receivedAt: new Date().toISOString(), receiptClockSource: 'response_completion'` at the ingest call (ingest runs after all fetches complete, so that instant is an honest upper bound of receipt), and add a startup/packet assertion that the newest batch's clock source is `response_completion`.
- Verdict: migration correct; its purpose is defeated one layer up.

## server/migrations/033_opportunity_push_probability.js (58 lines)

- Additive nullable `push_probability`, `push_treatment` on the opportunity header (`:33-43`); NULL deliberately not backfilled to 0 (`:26-30`). `down()` refuses if any `push_treatment` recorded, otherwise does nothing (columns kept) (`:46-58`). No protected write.
- Verdict: clean.

## server/migrations/034_t60_runner_ledger.js (105 lines)

- Purpose: `nfl_t60_observations` (one row per game per cutoff, `UNIQUE(experiment_id, event_key, cutoff_at)` `:57`, state CHECK `:49-50`) — mutable by design (runner updates state); `nfl_capacity_events` append-only (`:62-78`) with `_no_update`/`_no_delete` triggers (`:81-86`).
- Rollback refuses if either table has rows (`:91-98`), else drops (`:99-104`). No protected write.
- Wiring: only writer/reader is `server/betting/nfl/strategy/t60-runner.js` (`:82-132` observation lifecycle, `:188-215` capacity inserts). Live: 1 observation (`frozen`, `decision_run_id NULL`), 0 capacity events — the capacity ledger has never been written to; a runner that "reserves" nothing is either not using it or the week had no contention. Open question for the runner's reader.
- Verdict: clean.

## server/migrations/035_alt_spread_capture.js (244 lines)

- Purpose: `nfl_alt_spread_captures` (`:70-96`, `provenance CHECK IN ('direct_book_scrape')` `:86`) and `nfl_alt_spread_quotes` (`:104-163`, both `event_key` and `contract_event_key` stored because they legitimately differ after 8pm ET `:116-125`, `UNIQUE(capture_id, event_key, side, market, requested_move)` `:162`). Four append-only triggers (`:169-180`).
- Fence trigger `nfl_teaser_price_ledger_no_alt_spread BEFORE INSERT ON nfl_teaser_price_ledger` (`:209-219`) aborts when notes/push_rule contain `alt_spread_six_point_quote` or book name contains "alt_spread"/"alt spread". Columns referenced (`notes`, `push_rule`, `book`) exist (`nfl-n-to-z.js:277,282,284`). Sole ledger writer `server/services/nfl-profitability.js:74` is unaffected; the live ledger's one row (DraftKings +100, notes free-text) passes. This is the "execution edge" guard: it stops an alt-parlay comparison from being laundered into the teaser price the Wong scan prices with.
- No UPDATE anywhere (`:43-57` states the pre-check was done). Rollback refuses if populated (`:223-231`), else drops everything (`:232-243`).
- Wiring: `server/services/alt-spread-import.js`, `scripts/import-alt-spreads.mjs` (`altParlayEquivalent` lives there). Live: 0 captures — the Python scraper output has not been imported yet, so the teaser price is still the single hand-typed row.
- Verdict: clean.

## scripts/migrate.mjs (11 lines)

- `npm run db:migrate` (`package.json:33`). Imports `db` (which at import applies 000 and snapshots, `index.js:161-163`), awaits `runMigrations()`, then `PRAGMA foreign_key_check` on the **whole** database (`:6`) and throws if any violation.
- D6 (P3): the check runs after every migration has already COMMITted, so a non-zero exit reports "foreign-key violations" for an upgrade that succeeded, and `preflight.js:182-185` explicitly notes whole-DB checks surface long-standing unrelated violations. On the 9.8 GB live DB this is also a full scan of every FK-bearing table. Either scope it to the tables touched by the applied migrations or make it advisory.
- Verdict: fine as an entry point; the post-check is misleading.

## scripts/rollback-migration.mjs (10 lines)

- `npm run db:rollback [name]` (`package.json:34`) → `rollbackMigration(expected)`.
- D2 (P2): **no snapshot before a rollback.** `runMigrations` snapshots (`migrate.js:42-45`) but `rollbackMigration` (`migrate.js:59-81`) does not, and this script adds none. 018/019/020/022/023/024 `down()` are plain `DROP TABLE`s with no populated-refusal; today those tables hold 30 news events, 5 recommendations, 285 Scottfree rows, 1 finding + 5 season rows. One `npm run db:rollback` typed six times at the wrong moment deletes them with no recovery point, while 027–035 all say "restore the pre-migration snapshot" — which for those tables would be the *upgrade-time* snapshot, possibly days stale. Fix: call `backupBeforeMigration('rollback of <name>')` in `rollbackMigration` before `BEGIN`, or add row-count refusals to the 018–024 `down()`s like 031–035 have.
- Verdict: works; unsafe by omission.

## scripts/schema-snapshot.mjs (106 lines)

- Purpose: proves the centralized baseline equals the old import-time DDL: `--mode legacy|baseline|full` (`:14-24`), throwaway DB via `GRIDIRON_DB_PATH` (`:45-47`), imports modules from `server/index.js` dynamic imports + `scripts/schema-files.txt` (`:50-58`), dumps normalized `sqlite_master` + `table_info` + migration names (`:73-87`). Referenced by `server/db/index.js:156`, `server/db/schema/README.md:46`, `000_legacy_schema.js:16`.
- Safety check: it does not set `SCHEDULER_DISABLED`, and `schema-files.txt:114` lists `scheduler.js`; verified `startScheduler` is an explicit function (`scheduler.js:1066`), not import-time, so importing does not fire paid jobs. OK.
- D7 (P3): `--mode legacy` no longer measures what its header says. Zero files in `schema-files.txt` still contain `CREATE TABLE` (verified with grep across all 122 entries; all exist on disk), because phase 2 deleted import-time DDL (`index.js:150-159`). "legacy" and "full" are now the same experiment; the useful invariant is `baseline == full` (as `index.js:156-159` says). The header (`:19-20`) and the file list are historical.
- Verdict: works; documentation drift.

## scripts/schema-files.txt (122 lines)

- Data file consumed only by `schema-snapshot.mjs:53-54` (and named in `server/db/schema/core-and-fantasy.js:11`). All 122 paths exist. None carry DDL any more (see above). Keep as the "full-import" list; its original meaning ("DDL-bearing files") is stale.

## test/migration-027-populated-upgrade.test.js (575 lines)

- 14 tests against real fixture DBs built by loading every migration file ≤ N (`:52-61`, `:190-201`) and populating (`:69-188`): 7 opportunities across all 023 states with 21 lifecycle events, one childless opportunity, a legacy decision run (+ optional incomplete run), two legacy quote batches. Drives `runMigrations(database, file)` and `rollbackMigration(name, database)` with the injectable DB (commit 445c878).
- Coverage verified line by line: C03 reproduction (`:231-246`, asserts 027 direct throws and the txn protects data), populated upgrade with byte-identical row snapshots (`:249-290`), past-027 no-op (`:293-308`), fresh DB (`:310-324`), idempotent repair (`:326-342`), failed repair rolls back on an unknown column (`:344-366`), restart after obstruction (`:368-380`), backup is a real pre-state (`:382-403`), 028 and 027 refuse destructive downgrade (`:407-441`), 031 backfill + restored triggers (`:445-475`), 032 backfill + restored triggers (`:477-510`), **generalised scan** (`:512-543`), incomplete legacy run invalidated not rewritten (`:545-575`).
- D8 (P3): the scan (`:522-535`) matches only `\b(UPDATE|DELETE FROM)\s+([a-z_]+)`; it cannot see the C03 class itself (`DROP TABLE` of a parent whose children `ON DELETE CASCADE` into a no-delete trigger), nor `INSERT … ON CONFLICT DO UPDATE`, nor `REPLACE INTO`, nor quoted/mixed-case table names. It also strips `--.*$` before scanning, which would remove any SQL line containing `--` inside a string. Worth widening now that it is the named guard against "the third one".
- Note on `:71-73` fixture: `nfl_execution_lifecycle_events.id` values are inserted explicitly, so the idempotence tests compare ids — good.
- Verdict: strong; the best-written test in my slice.

## test/db-snapshot-headroom.test.js (79 lines)

- Four tests on `assertRoomForSnapshot`/`backupBeforeMigration` (`index.js:95-149`): normal disk passes (`:31-36`), a sparse file the size of the volume is refused with the actionable message (`:38-59`; message strings verified at `index.js:141-148`: "Refusing to migrate", "GB free", `pre-migration-*.bak`, "never deleted automatically"), unmeasurable path returns `{checked:false}` (`:61-67`; `index.js:129-133`), and a fresh DB takes no snapshot (`:69-79`; `index.js:96-98`).
- Verdict: clean. Minor: `:45` `fs.ftruncateSync(fd, volume.blocks * volume.bsize)` creates a sparse file equal to the whole volume — on filesystems that pre-allocate this would actually fill the disk; APFS is sparse so fine here.

---

## Cross-cutting

### Trigger inventory installed by 018–035 (all present on live DB)
- 023/027/028: `nfl_execution_lifecycle_events_no_update/_no_delete`
- 027: `nfl_decision_events_no_update/_no_delete`, `nfl_decision_runs_no_update`
- 031: `nfl_decision_runs_no_delete`, `nfl_decision_run_invalidations_no_update/_no_delete`, (re-creates `nfl_decision_runs_no_update`)
- 032: (re-creates `nfl_quote_batches_no_update`)
- 034: `nfl_capacity_events_no_update/_no_delete`
- 035: `nfl_alt_spread_captures_no_update/_no_delete`, `nfl_alt_spread_quotes_no_update/_no_delete`, `nfl_teaser_price_ledger_no_alt_spread` (BEFORE INSERT fence)

### Protected-table writes (all guarded)
- 027 up: parent `DROP TABLE` cascade → refused in-txn (`027:148-154`), performed by preflight when populated.
- 031 up: `UPDATE nfl_decision_runs` → trigger lifted/restored (`031:148,167-171`).
- 032 up: `UPDATE nfl_quote_batches` → trigger lifted/restored (`032:92,99-103`).
- The scan test enforces the pattern for future files (with the blind spots in D8).

### Rollback existence
- All 17 migrations export `down()`. 018–026, 029 are unconditional drops (data-destroying if populated). 027, 028, 031–035 refuse when evidence would be lost. No rollback snapshot exists (D2).

### Baseline drift (D5)
`000_legacy_schema` → `server/db/schema/nfl-n-to-z.js` already contains 029's index (`:805`) and 032's columns (`:372,377`) but not 021's or 032's indexes, and none of the 018–035 tables. So a fresh install builds `nfl_quote_batches` from the baseline with C11 columns while `nfl_quote_tape`'s batch/scope indexes come from migrations. The "frozen" baseline is being edited to absorb later migrations piecemeal. `schema-snapshot --mode baseline` vs `full` still agree (both use the same baseline), so the proof cannot detect this drift. Pick one rule: baseline is frozen at 017 and every later object lives only in its migration, or baseline is "current" and every migration is idempotent against it — today it is neither.

### Open questions (outside my files, for the orchestrator)
1. Why does the free book-feeds producer not stamp the receipt clock (D1)? Was the omission deliberate ("cannot observe completion instant", `nfl-quote-tape.js:56-59`) or an oversight? The book-feeds ingest runs after every provider fetch has resolved, so a completion instant *is* observable.
2. `nfl_t60_observations` SF@LAR row is `frozen` with `decision_run_id = NULL` and `nfl_decision_runs` is empty: no decision was recorded for TNF. Plan §0 (C11 "no forecast consumes it yet", slice 7) says this is expected — confirm the runner is not supposed to advance to `decided` yet.
3. `nfl_capacity_events` has 0 rows after a live T-60 run: does the runner reserve capacity at all, or only under contention?
4. `schema_preflight` does not exist on the live DB: the C03 repair path is test-only in practice. Fine, but anyone restoring a `.bak` from before 027 that *did* hold lifecycle events would be the first real exercise.
