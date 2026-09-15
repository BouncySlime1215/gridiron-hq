# G01-platform-db — boot, platform, DB core, schema fragments, migrations 000–017, modeling

Reader: G01-platform-db. Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only). Date: 2026-09-11.
Files read: 48. Lines read: 7,143 (every line of every file; wc -l verified per file in the table below).
Live DB inspected read-only via `node:sqlite { readOnly: true }` (schema_migrations, sqlite_master, db_health_checks, auth/identity tables, blind-audit journal). No .bak opened.

## 0. Headline answers to the focus questions

**Boot order** (`server/index.js`): port guard (L4-12) → dynamic import of express and `db/migrate.js` (L17-18; importing migrate.js imports `db/index.js`, which opens the DB, sets PRAGMAs, creates `schema_migrations`, applies `000_legacy_schema` if unrecorded, runs the daily quick_check, and copies the legacy `espn_settings` row) → `await runMigrations()` (L21; preflight repairs, one snapshot, then 001…035 in filename order) → route/service imports (L22-53; these prepare statements against migrated tables) → `seedIfEmpty()` (L58, every boot, writes) → scheduler + draft clock (L67, L72) → mounts (L76-109) → error handler (L111) → static client (L125-135) → `app.listen(PORT,'127.0.0.1')` (L137) → evidence warm-up (L143-155). Order is sound and the reasoning comments are accurate.

**Migration runner** (`server/db/migrate.js`): filename-ordered (`/^\d+_.+\.js$/`, L35), one `BEGIN IMMEDIATE` per migration via `migrate()` (`db/index.js:46-57`), preflight before any transaction (L40-46), one `VACUUM INTO` snapshot before the first pending change (L42-45), rollback of the latest non-baseline only (L59-81). Correct. Directory has a gap (029 → 031; no 030) which the runner tolerates.

**Schema split into 4 fragments**: `000_legacy_schema.js` runs `tables → alters → indexesAndTriggers → seeds` across all four fragments (L43-50). I diffed each fragment's `CREATE TABLE/INDEX/TRIGGER` names against its `<batch>.manifest.json`: core-and-fantasy 54/54 tables, mlb-model-misc 65/65, nfl-a-to-m 45/45, nfl-n-to-z 51/51, all indexes and named triggers match, all `sources` arrays match the manifest keys. Two exceptions: (a) `nfl-a-to-m` blind-audit triggers are templated (`${prefix}_insert`) in code and described in prose in the manifest — consistent by design; (b) **`nfl-n-to-z.js` carries two indexes the manifest does not (`idx_nfl_roster_event_key`, guarded alters path, and `idx_nfl_quote_commence`)** — the second is an after-the-fact edit to a fragment the README declares FROZEN (details in §DEF-05).

**Protected-table trigger pattern**: `BEFORE UPDATE/DELETE … RAISE(ABORT)` pairs on evidence tables (feature revisions, verified events, expert examples/predictions/settlements, live ledger, quote tape/batches, team cards, feature vectors, postgame truth, sim/orthogonal artifacts, player identity repairs, model_audit_log). Migrations that must backfill a protected table drop and re-create the update guard inside their own transaction (008:34-42). The pattern is consistent; it is also why `preflight.js` exists (027's rebuild would cascade into an append-only child).

**Auth / legacy access**: bearer → sha256 → `auth_sessions` join `users` (auth.js:16-27). Mount-level `legacyAuthenticated = [requireAuthenticated, legacyRateLimit()]` is applied to only 5 families (players, news, leagues, tradelab, trades) and `legacyAdmin` to /api/dev (index.js:78-98). Everything else is either self-authenticating inside the router (drafts, espn-connect, model, mlb, nfl-market, nfl-betting, betting-hub, execution-slate) or **has no auth at all** (teams, rankings, espn, aggregates, analysis, nfldata, stats, accolades, edge, props, props-tickets, decision-inbox, wong — zero references to any auth helper by grep). See DEF-02.

**Port guard**: reserve-and-release probe before any DB-opening import (port-guard.js:39-59; index.js:4-16). Correct and the comment about static imports is accurate. Probe binds all interfaces while the app binds 127.0.0.1 — fine on macOS (EADDRINUSE either way), tiny TOCTOU window between `probe.close` and `app.listen` (P3, not listed as a defect).

**Paths**: `platform/paths.js` is the single sanctioned root derivation, but `db/index.js:10` and `db/migrate.js:8` still derive their own paths (`__dirname, '..'`) instead of importing it (P3, DEF-11).

**Does `000_legacy_schema` being recorded AFTER 017 mean anything is wrong? No.** Evidence: `schema_migrations` rowid 18 = `000_legacy_schema` applied 2026-09-08 20:08:39, between 017 (09-06) and 018 (09-08 21:14). That is exactly the designed path: `db/index.js:161-164` applies it at open when unrecorded, after taking a snapshot (`backupBeforeMigration` counts prior migrations excluding 000, L96-98, so an upgraded DB gets a backup; a fresh test DB does not). On an existing DB every statement is `IF NOT EXISTS` / `PRAGMA table_info`-guarded, so the only observable change was the 12 blind-audit triggers on `nfl_play_by_play`, `nfl_play_formations`, `nfl_play_charting`, `nfl_quote_tape` that the legacy import order would have added on the next boot anyway (manifest FINDING, nfl-a-to-m.manifest.json → nfl-blind-audit.js notes) — live DB now has 31 tables × 3 = 93 such triggers. `rollbackMigration` explicitly skips 000 (migrate.js:61-62). Ordering by rowid matters nowhere else. On a **fresh** DB the order is 000 → 001…, which is what later ALTERs need; and the one interesting interaction — 000's alters add `drafts.league_row_id` WITHOUT `REFERENCES` (core-and-fantasy.js:797) so 006's guarded ALTER (006:5) never declares the FK — yields the same end state as every upgraded DB (live: `drafts` CREATE text has no REFERENCES for league_row_id; 011's triggers enforce it instead, as 011's comment says). Consistent, documented, not wrong.

## 1. Per-file sections

### server/index.js (156 lines, read 156) — entry point
- Purpose: boot sequence, mounts, static client, warm-up.
- Wiring: imports port-guard, migrate, seed, 30 routers, scheduler, legacy-access. Imported by scripts/start.mjs:85, launcher.mjs:75, bootstrap-data.mjs:38, start-smoke.mjs:14, package.json dev:server.
- Data written: none directly (seed/scheduler do).
- Notes: L148 warm-up query `status = 'active'` — live `drafts.status` vocabulary is inconsistent (`complete` ×3, `completed` ×1, `active` ×11), not this file's bug but worth a route-reader look. L137 binds loopback only; the tunnel (`scripts/tunnel.mjs`, memory: gridiron-phone-access) forwards internet traffic to this loopback socket.
- Defects: DEF-02 (mount-level auth gaps reachable through the tunnel).
- Verdict: active, structurally good.

### server/platform/audit.js (21) — audit_log writer/reader. Imported by routes/news.js:6, routes/drafts.js:24. Never throws (L5-13). Fine.
### server/platform/auth.js (68) — bearer resolution + league/draft authorization helpers. Imported by draft/store.js, modeling/authz.js, routes/{espn-connect,news,model,local-auth,draft-capture,leagues,drafts}.js, services/draft-ingest.js, 11 tests. L22 compares `expires_at > datetime('now')` (TEXT, same format as writers). Fine.
### server/platform/code-identity.js (174) — hashes the spread-decision module closure. Imported by services/nfl-replay.js:36, services/nfl-decision-tape.js:60, test. Verified live: closure = 191 files, `complete:false` (3 computed dynamic imports: itself, draft-assist.js, nfl-execution-edge.js — carried into the hash, as documented). Defect DEF-09: `STATIC_IMPORT` (L62) requires `from`, so bare side-effect imports (`import './line-shopping.js'`, 10 occurrences in server/services) are neither followed nor reported in `unresolved`; today every such target is reached by another path so the live manifest is complete, but the contract "reported rather than silently ignored" (L57-60) is not met for this form.
### server/platform/cors.js (29) — ESPN-origin CORS for the capture route. Imported by routes/drafts.js:8, test. Fine.
### server/platform/jobs.js (60) — interval job registry with unref. Imported by routes/drafts.js:25. Fine.
### server/platform/legacy-access.js (33) — authenticated + rate-limited mount arrays; `requirePlatformAdmin` reads `model_permissions` (`model:*`). Imported by index.js:53, 4 tests. Note: `legacyRateLimit()` is instantiated once (L22) so one 120/min bucket is shared across all five families for the single user; News polls at 60 s (client/src/pages/News.tsx:58) so today it is far from the limit. `windows` Map never prunes (single user → harmless). P3 note only.
### server/platform/paths.js (89) — canonical roots. Imported by 4 services + test. Fine. See DEF-11.
### server/platform/port-guard.js (60) — see §0. Imported by index.js:4, test. Fine.
### server/platform/providers.js (45) — provider adapter registry. **Zero importers** (only a prose mention in modeling/candidates.js:30). `registerProvider` is never called anywhere in server/scripts/test. Orphaned / aspirational. Keep or delete — see dead_or_duplicate.
### server/platform/provision-auth.js (59) — CLI entry point (shebang), zero importers by design. Runs migrations then provisions user/membership/permissions/session. Fine (P3: L16 arg parser assumes every flag has a value).
### server/db/index.js (225) — DB open, PRAGMAs, migrate(), snapshot-with-disk-guard, 000 application, daily integrity check, legacy espn_settings copy, rows/row/run. Imported by ~259 files. Defects DEF-03 (quick_check stall), DEF-04 (snapshot size trajectory), DEF-11.
### server/db/migrate.js (81) — see §0. Imported by index.js:18, provision-auth.js:11, scripts/{migrate,rollback-migration,import-alt-spreads,run-news-event-impact}.mjs, ~25 tests. Fine.
### server/db/preflight.js (282) — the 027 cascade repair. Imported by migrate.js:5, test/migration-027-populated-upgrade.test.js. Live DB has no `schema_preflight` table → the repair never fired here (027 applied 2026-09-10 15:46 with no lifecycle rows to cascade). Logic reviewed line by line: FK suspension read-back (L225-234), copy verification by count + two-way EXCEPT (L166-176), replay of carried indexes/triggers (L180), scoped `foreign_key_check` (L186). Correct.
### server/db/schema/README.md (70) — fragment contract; states the directory is FROZEN (L8-12). Violated twice (DEF-05).
### server/db/schema/core-and-fantasy.js (910) — 54 tables, 7 indexes, 0 triggers, guarded alters for nfl_teams/players/draft_picks/drafts/leagues/roster_players/audit_registry/game_lines/nfl_line_snapshots. Manifest-consistent. Imported only by 000_legacy_schema.js:27.
### server/db/schema/mlb-model-misc.js (975) — 65 tables, indexes, 2 triggers (player_identity_repairs). Manifest-consistent. Imported only by 000:28.
### server/db/schema/nfl-a-to-m.js (762) — 45 tables, blind-audit trigger fan-out over 31 tables (L599-668). Deliberately omits `nfl_capture_triggers`/`nfl_sgp_quotes` because 014 creates them unguarded (L183-187) — correct, verified 014:6,23 use plain `CREATE TABLE`. Manifest-consistent. Imported only by 000:29.
### server/db/schema/nfl-n-to-z.js (875) — 51 tables. Edited after freeze: L367-377 (`received_at`, `receipt_clock_source`, commit 1bbe43d 2026-09-10) and L805-806 (`idx_nfl_quote_commence`, commit bbcdae2 2026-09-10). Both are harmless on fresh (032:57-61 guards, 029:29 IF NOT EXISTS) and upgraded DBs (fragment never re-runs), but the manifest (mtime 09-08) was not updated and the snapshot proof no longer holds. DEF-05.
### server/db/seed/index.js (142) — runs on EVERY boot (index.js:58), inside BEGIN IMMEDIATE. Imported by index.js:22, scripts/install.mjs:107, 12 tests. **DEF-01 (P1)**: overwrites runtime edits to `nfl_teams` and `ranking_entries` on each restart.
### server/db/seed/players.js (98) — static DEPTH + DEFAULT_BOARD (July 2026). Imported by seed/index.js:3 only. Data only.
### server/db/seed/teams.js (516) — static 32-team editorial content. Imported by seed/index.js:2 only. Data only.
### server/migrations/000_legacy_schema.js (55) — assembler; `down()` throws. Imported by db/index.js:5 and the 027 test. Fine.
### 001_baseline_marker.js (11) — no-op marker. Fine.
### 002_platform_audit_log.js (21) — audit_log. Fine.
### 003_draft_state_machine.js (68) — guarded ALTERs + draft_queue/draft_events. Fine.
### 004_model_lab.js (37) — model_experiments/predictions/production_pointer. Fine.
### 005_model_registry_integrity.js (93) — registry tables with CHECKs and FKs. Fine.
### 006_identity_and_draft_authorization.js (87) — users/auth_sessions/league_memberships/draft_team_ownership + triggers. Comment L51-53 ("runner does not yet enable PRAGMA foreign_keys") is stale: db/index.js:16 enables it. P3 stale comment (folded into DEF-11).
### 007_model_permissions_and_upgrade_guard.js (40) — model_permissions, legacy_draft_quarantine (live: 10 quarantined mock drafts), draft_team_grades, append-only model_audit_log. Fine.
### 008_model_actor_foreign_keys.js (54) — adds *_user_id FKs; correctly lifts/restores the append-only guard for its backfill (L34-42). Fine.
### 009_authoritative_actor_and_ownership_guards.js (118) — provenance triggers + ownership guards. **DEF-07**: `validate_draft_ownership_parent_update` (L91-103) still requires league membership when `league_row_id IS NULL`; 016 fixed only the two `draft_team_ownership` triggers. Live DB confirms (`instr(sql,'IS NULL OR EXISTS')` = 0 for this trigger, 1 for the other two). A mock draft with an owner row (live draft 21: league_row_id NULL, owner slot 1) cannot have `team_count` updated.
### 010_news_provenance_and_dedup.js (32) — guarded news columns + partial unique index. Fine.
### 011_league_connection_integrity.js (42) — trigger-enforced drafts→leagues FK. Fine; explains why the FK is not physical.
### 012_teaser_execution_ledger.js (64) — unguarded CREATE (fine: not in fragments). Fine.
### 013_news_read_path_indexes.js (21) — Fine.
### 014_profit_execution_triggers.js (49) — unguarded CREATE; fragments deliberately omit these tables. Fine.
### 015_manager_profiles.js (35) — rename-and-rebuild with legacy copy. Live: only `manager_profiles` exists (legacy dropped). Fine.
### 016_mock_draft_ownership_exemption.js (62) — see DEF-07 (incomplete). Otherwise fine.
### 017_auth_pairing_codes.js (26) — Fine. Live: 1 used pairing code.
### server/modeling/ARCHITECTURE.md (39) — stale: says the modules are "additive and currently unmounted" (L30) but routes/model.js mounts them (index.js:100) and imports every module. DEF-12 (P3 doc drift).
### server/modeling/authz.js (25) — `requireModelPermission`. Imported by 6 routers + test. **DEF-08 (P3)**: L20 `principal.role !== 'admin'` — `modelPrincipal` never sets `role`, dead branch that reads as a bypass.
### server/modeling/candidates.js (95) — feature contract + two candidates. Imported by routes/model.js:31. `meanBaseline` on empty training → NaN → caught by walk-forward as a failed prediction (acceptable).
### server/modeling/contracts.js (61) — stable hash + leakage assertions. Imported by routes/model.js:30, registry.js:1, walk-forward.js:1, test. Fine.
### server/modeling/league-context.js (12) — `requireLeagueId`. Imported by routes/model.js:28, test. Fine.
### server/modeling/registry.js (74) — gates on promote/rollback. Imported by routes/model.js:32, 2 tests. P3: `MemoryModelStore.insert` throws a friendly message on duplicate id while `SqliteModelStore.insert` surfaces a raw PK constraint error (inconsistent contract, noted in DEF-11).
### server/modeling/sqlite-store.js (101) — store + audit + persistAudit. Imported by routes/{model,nfl-market,mlb}.js, test. `atomicPromote` writes pointer, experiment, history, audit in one transaction with both text and *_user_id actor columns (satisfies 009 triggers). Fine. Live: 0 experiments.
### server/modeling/walk-forward.js (91) — splits/holdout/run. Imported by routes/model.js:35, test. Fine; strips outcome before predict (L38-41).

## 2. Defects (path:line + snippet)

### DEF-01 — P1 — every boot overwrites user/AI edits to `nfl_teams` and the "My 2026 Board" ranking set
- `server/db/seed/index.js:22-34`
  ```
  const insertTeam = db.prepare(`INSERT INTO nfl_teams ... ON CONFLICT(abbr) DO UPDATE SET name=excluded.name, ... head_coach=excluded.head_coach, ... ol_analysis=excluded.ol_analysis, ... coach_analysis=excluded.coach_analysis, ...`);
  ```
  and `server/db/seed/index.js:42-47` runs it for all 32 teams on every call; `server/index.js:58` calls `seedIfEmpty()` unconditionally on every boot (the function name is a misnomer — L21 logs "Reconciling seed data" and never checks emptiness).
- Runtime writers that get clobbered: `server/routes/analysis.js:81` (`UPDATE nfl_teams SET ${updates...}, analysis_updated_at = datetime('now')` — AI-generated team analyses), `server/routes/teams.js:108` (`UPDATE nfl_teams SET ${sets.join(', ')}` — user edits), `server/routes/nfldata.js:97` (`UPDATE nfl_teams SET head_coach = ?` from ESPN roster sync). `analysis_updated_at` is not in the ON CONFLICT list, so after a restart the timestamp says "fresh" while the text is the July editorial seed — `analysis.js:110` then treats it as current.
- Same pattern for rankings: `server/db/seed/index.js:117-118` `INSERT INTO ranking_entries ... ON CONFLICT(set_id, player_id) DO UPDATE SET rank=excluded.rank,tier=excluded.tier` and L120-135 re-apply all 100 DEFAULT_BOARD ranks to set "My 2026 Board" (live set id 1, 110 entries — 100 seeded + 10 user-added). `server/routes/rankings.js:19,53-54` let the user reorder/rewrite this set; every restart resets the 100 seeded players' ranks/tiers and leaves the user's own 10 with now-colliding rank numbers.
- Also: each boot fires `nfl_blind_input_nfl_teams_update` 32× and `nfl_blind_input_players_update` (seed L94-95) into the blind-audit journal (live: 120,018 `players update` rows; 6,628 today) — noise for the freeze check that reads that journal.
- Impact: fantasy-first priority — the draft board and team intel silently revert on restart; AI spend on team analyses is wasted after the next restart.
- Fix: make `seedIfEmpty` actually seed only when `nfl_teams` is empty / the ranking set does not exist (INSERT OR IGNORE for teams; create the board only if absent; never `DO UPDATE` editorial or rank columns), or gate the reconcile behind an explicit `--reseed` flag.

### DEF-02 — P1 (conditional on the tunnel being up) — unauthenticated route families are reachable from the internet through the phone tunnel, including a paid-API trigger and writers
- `server/index.js:77` `app.use('/api/teams', teamsRouter);`, `:79` `/api/rankings`, `:87` `/api/espn`, `:89` `/api/aggregates`, `:90` `app.use('/api/analysis', analysisRouter);`, `:92` `/api/nfl`, `:93` `/api/stats`, `:95` `/api/accolades`, `:96` `/api/edge`, `:101` `/api/props`, `:102` `/api/props-tickets`, `:103` `/api/decision-inbox`, `:107` `/api/betting/wong` — none carry `legacyAuthenticated`, and grep of each router for `requireAuthenticated|requireModelPermission|resolveAuthenticatedUser|legacyAuthenticated` returns 0 hits (teams, rankings, espn, aggregates, analysis, nfldata, stats, accolades, edge, props, props-tickets, decision-inbox, wong).
- `server/routes/analysis.js:41` `const msg = await callClaude({` behind that unauthenticated mount → anyone with the trycloudflare URL can burn Anthropic credit and overwrite `nfl_teams` (analysis.js:81). `routes/teams.js:108` and `routes/rankings.js:53` are writers under unauthenticated mounts too.
- The tunnel design (memory gridiron-phone-access; `server/routes/local-auth.js` `isDirectLoopback`) only closed the *auto-provisioning* hole; it did not add a global gate for tunnel-origin requests to these families.
- Impact: money + data integrity, only while `npm run tunnel` is running (ephemeral URL, but printed/registered in the app).
- Fix: a global middleware in `index.js` that requires a session for any request carrying `x-forwarded-for`/`cf-*` headers (the same predicate local-auth uses), or move the writer/paid endpoints under `legacyAuthenticated`. Route readers should confirm which of these 13 routers have writers/paid calls.

### DEF-03 — P2 — daily `quick_check` blocks boot for ~3 minutes on the 11 GB database
- `server/db/index.js:181-202`
  ```
  if (integrityMode !== 'off') { ... if (due) { ... db.prepare('PRAGMA quick_check(1)').get()?.quick_check ...
  ```
  runs synchronously at import of `db/index.js`, i.e. before `runMigrations()` and before any router or the scheduler is loaded (index.js:18-21).
- Live evidence: `db_health_checks` = `{quick_check, checked_at 2026-09-11 12:43:26, result ok, duration_ms 168489}`; `data.sqlite` = 11,170,512,896 bytes.
- The T-60 capture runner is in-process (`server/services/scheduler.js:788` `import('../betting/nfl/strategy/t60-runner.js')`), so a restart on a game day when the check is due delays every capture window by ~3 minutes; any `scripts/*.mjs` that imports `db/index.js` also pays it if it is the first process of the day.
- Fix: run the check off the boot path (scheduler job, or `setImmediate` after `listen`), or default `GRIDIRON_DB_INTEGRITY_CHECK=off` for the server process and keep it for a maintenance script.

### DEF-04 — P2 — every migration now costs an 11 GB `VACUUM INTO`; the disk guard will refuse to boot the server once headroom is gone
- `server/db/index.js:100-107` `assertRoomForSnapshot(databasePath); ... database.prepare(`VACUUM INTO '...'`).run();` and `:121` `SNAPSHOT_HEADROOM_BYTES = 2 * 1024 ** 3` → needs ≈13.2 GB free per migration today; `:140-147` throws (and `runMigrations` → `index.js:21` rejects → process exits) when it is not there.
- Live: 74.5 GB free on the volume, one 9.79 GB `.bak` already beside the DB (`server/data.sqlite.pre-migration-2026-09-11T00-21-58-169Z.bak`), migrations land roughly daily (024–035 between 09-09 and 09-11). Five more migrations at current size exhaust the headroom, and the refusal fires at boot — on a game day that is an outage until someone deletes snapshots by hand (L91-93 says pruning is deliberately manual).
- Fix: snapshot only tables the pending migration touches, or make the snapshot opt-out per migration (an index-only migration like 029 does not need 11 GB of insurance), and/or `.gitignore`-style retention (keep N).

### DEF-05 — P3 — the "FROZEN" schema fragment was edited twice after the freeze; manifest and snapshot proof are stale
- `server/db/schema/README.md:8-12` "This directory is frozen ... Do not add a table or column here"; `server/migrations/000_legacy_schema.js:23-26` "FROZEN. Do not add to the fragments".
- `server/db/schema/nfl-n-to-z.js:372` `received_at TEXT,` and `:377` `receipt_clock_source TEXT,` (commit 1bbe43d, 2026-09-10) and `:805-806` `CREATE INDEX IF NOT EXISTS idx_nfl_quote_commence ON nfl_quote_tape(commence_time);` (commit bbcdae2, 2026-09-10). `nfl-n-to-z.manifest.json` (mtime 09-08) does not list `idx_nfl_quote_commence`.
- Harmless today because 032:57-61 guards its ALTERs and 029:29 uses IF NOT EXISTS, but `scripts/schema-snapshot.mjs --mode legacy` vs `baseline` can no longer be byte-identical, and the next person to "fix" a column here will ship a no-op to every real database.
- Fix: revert the two fragment edits (032/029 already own them) or, if the intent is "fresh DBs get it from the fragment", document that and regenerate the manifest.

### DEF-07 — P3 (latent) — 016's mock-draft exemption did not reach 009's parent-update guard
- `server/migrations/009_authoritative_actor_and_ownership_guards.js:91-103`
  ```
  CREATE TRIGGER IF NOT EXISTS validate_draft_ownership_parent_update
  BEFORE UPDATE OF team_count, league_row_id ON drafts
  WHEN EXISTS ( SELECT 1 FROM draft_team_ownership dto WHERE dto.draft_id = OLD.id AND (
        dto.team_slot > NEW.team_count OR NOT EXISTS (
          SELECT 1 FROM league_memberships lm WHERE lm.league_id = NEW.league_row_id AND lm.user_id = dto.user_id )))
  ```
  With `NEW.league_row_id IS NULL` the inner `NOT EXISTS` is always true → any `UPDATE drafts SET team_count=…` on a mock draft that has an ownership row aborts with "draft update would invalidate team ownership". 016 rewrote only `validate_draft_team_owner_insert/_update` (016:14-37). Live DB: this trigger's SQL has no `IS NULL OR EXISTS` clause; draft 21 (mock, owner in slot 1) is the concrete case.
- Fix: migration 036 re-creating the trigger with `(NEW.league_row_id IS NULL OR EXISTS (...))`.

### DEF-08 — P3 — dead admin bypass condition in model authz
- `server/modeling/authz.js:20` `if (!permissions.includes(permission) && !permissions.includes('model:*') && principal.role !== 'admin') {` — `modelPrincipal` (L7-14) returns `{id, subject, permissions}`; `role` is never set, so the clause is dead but reads as a header-driven bypass to a reviewer. Remove it.

### DEF-09 — P3 — code-identity walker silently ignores bare side-effect imports
- `server/platform/code-identity.js:62` `const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]/g;` requires `from`, so `import './line-shopping.js';` (e.g. `server/services/nfl-clv.js:20`, `nfl-expert-council.js:22`, `nfl-teaser-execution.js:12`, `prop-feeds.js:35`) is neither followed nor added to `unresolved` (contract at L57-60). Verified live: the spread-decision closure (191 files) currently reaches every such target by another edge, so no identity is wrong today — but a future side-effect-only dependency would be hashed out silently. Add `/^\s*import\s*['"](\.[^'"]+)['"]/mg`.

### DEF-11 — P3 — hygiene bundle
- `server/db/index.js:10` and `server/db/migrate.js:8` re-derive roots (`path.join(__dirname, '..', ...)`) instead of importing `MIGRATIONS_ROOT`/`SERVER_ROOT` from `server/platform/paths.js:35,64` (the module whose whole purpose is to be the one place this walk is written, paths.js:22-26).
- `server/migrations/006_identity_and_draft_authorization.js:51` comment "The legacy database runner does not yet enable PRAGMA foreign_keys" is false (`db/index.js:16` `PRAGMA foreign_keys = ON`).
- `server/db/seed/index.js:20` `seedIfEmpty` name vs. behaviour (see DEF-01).
- `server/modeling/registry.js:69` vs `sqlite-store.js:22-27`: duplicate-insert error contract differs between the two stores.
- `server/platform/provision-auth.js:16` `for (let i = 2; i < process.argv.length; i += 2)` — a valueless flag shifts every later pair.

### DEF-12 — P3 — stale architecture doc
- `server/modeling/ARCHITECTURE.md:30` "The new modules are additive and currently unmounted." — `server/index.js:100` mounts `/api/model`, and `server/routes/model.js:28-35` imports every modeling module. L11 ("vite: command not found") describes a worktree state, not the repo. Archive or rewrite.

## 3. Wiring map (from → to → mechanism)
- server/index.js → platform/port-guard.js: static import, first thing evaluated.
- server/index.js → db/migrate.js → db/index.js: dynamic import after the guard; db/index.js opens `server/data.sqlite` (or `GRIDIRON_DB_PATH`), applies 000 via `migrations/000_legacy_schema.js` → 4 fragments.
- db/migrate.js → db/preflight.js: `planPreflightRepairs`/`applyPreflightRepairs` before the first transaction.
- server/index.js → db/seed/index.js: `seedIfEmpty()` every boot (writes nfl_teams, players, ranking_sets, ranking_entries).
- server/index.js → platform/legacy-access.js → platform/auth.js: mount arrays for 5 families + /api/dev.
- routes/model.js → modeling/*: all seven modules; modeling/sqlite-store.js → db/index.js.
- services/nfl-decision-tape.js, services/nfl-replay.js → platform/code-identity.js.
- services/{nfl-research-lab,nfl-evidence-dataset,nfl-news-event-impact,role-scenario-lab}.js → platform/paths.js.
- routes/drafts.js → platform/{cors,jobs,audit,auth}.js.
- platform/providers.js → nothing (no registrations anywhere).

## 4. Data flows observed
- Boot: open DB → PRAGMAs → schema_migrations → 000 (if unrecorded, with snapshot) → quick_check (daily, blocking) → espn_settings→leagues copy → preflight → snapshot (if pending) → 001…035 → seed reconcile (writes) → scheduler/draft clock → listen.
- Auth: `Authorization: Bearer` → sha256 → auth_sessions ⋈ users → req.auth; league/draft rights from league_memberships / draft_team_ownership; model rights from model_permissions.
- Evidence identity: source bytes of the spread-decision closure → sha256 manifest → decision tape.
- Live DB facts: 262 tables / 130 indexes / 169 triggers; 1 user (`gridiron-local-owner`, `model:*`, commissioner of 7 leagues), 112 sessions none revoked (accumulating; local-auth's concern), 10 quarantined legacy mock drafts, 5 ownership rows, 79 duplicate (name,position,team) player groups still present.

## 5. Open questions for other readers
1. Which of the 13 unauthenticated routers (DEF-02) have writers or paid calls? (analysis: confirmed; teams/rankings: writers confirmed.)
2. Does anything depend on `drafts.status` being exactly `'complete'` vs `'completed'` (both exist live; index.js:148 only looks for `'active'`)?
3. Is the blind-audit freeze check (`services/nfl-blind-audit.js`) sensitive to the seed-driven `nfl_teams`/`players` journal rows every boot (DEF-01 side effect)?
4. Where do 112 never-revoked sessions come from — does `routes/local-auth.js` mint a new one per page load over loopback?
5. Client polling cadence for the five `legacyAuthenticated` families during a live draft (shared 120/min bucket, legacy-access.js:22).

## 6. Line-count ledger (wc -l = lines_read)
index.js 156; platform/audit 21, auth 68, code-identity 174, cors 29, jobs 60, legacy-access 33, paths 89, port-guard 60, providers 45, provision-auth 59; db/index 225, migrate 81, preflight 282; schema/core-and-fantasy 910, mlb-model-misc 975, nfl-a-to-m 762, nfl-n-to-z 875, README 70; seed/index 142, players 98, teams 516; migrations 000 55, 001 11, 002 21, 003 68, 004 37, 005 93, 006 87, 007 40, 008 54, 009 118, 010 32, 011 42, 012 64, 013 21, 014 49, 015 35, 016 62, 017 26; modeling/ARCHITECTURE 39, authz 25, candidates 95, contracts 61, league-context 12, registry 74, sqlite-store 101, walk-forward 91. Total 7,143 across 48 files.
