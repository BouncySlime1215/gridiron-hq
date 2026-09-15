# H06 — Data Layer Audit (Gridiron HQ)
Repo: `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` (read-only throughout — no writes, no process touched, no `.bak` files opened)
DB opened only via `node:sqlite` `DatabaseSync(path, {readOnly:true})`, one-liners, per hard rules.
Snapshot time: 2026-09-12, mid-morning, while the live capture server (PID 56651, port 5177) was actively running.

---

## 0. Top-line numbers (measured, not estimated)

| Metric | Value | How measured |
|---|---|---|
| `server/data.sqlite` | 11,658,522,624 bytes (11.66 GB, growing) | `ls -la server/`, confirmed via `lsof` that PID 56651 has it open at the same size |
| `server/data.sqlite-wal` | 3,346,807,872 bytes (3.35 GB) | same |
| `server/data.sqlite-shm` | 851,968 bytes | same |
| `server/data.sqlite.pre-migration-2026-09-11T00-21-58-169Z.bak` | 9,788,506,112 bytes (9.79 GB) | same |
| `server/data.sqlite.pre-migration-2026-09-11T00-19-06-457Z.bak-journal` | 1,024 bytes, **tracked in git** | `git ls-files`, `git cat-file -e HEAD:...` |
| Total in `server/` for the DB family | ~24.8 GB | sum of above |
| `server/data/` (lab + log dirs) | 587 MB, gitignored except 2 small JSON files | `du -sh`, `git ls-files server/data/` |
| Disk free on the volume | 68 GB avail / 460 GB, container free space 73.3 GB | `df -h /`, `diskutil info /` |
| Tables (excl. `sqlite_sequence`) | 261 (262 incl. `sqlite_sequence`) | `sqlite_master` |
| Indexes | 340 | `sqlite_master` |
| Triggers | 169 | `sqlite_master` |
| Views | 0 | `sqlite_master` |
| Total rows across all tables | 25,249,004 | `SELECT COUNT(*)` per table, 68 s total |
| Sum of table b-tree bytes (`dbstat`) | 7.33 GB | `dbstat` GROUP BY name, 2m49s |
| Sum of index/other b-tree bytes | 4.34 GB | same |
| Applied migrations | 35 (`000_legacy_schema` .. `035_alt_spread_capture`) | `schema_migrations` table, matches `server/migrations/` (35 files) |

Row counts for the four tables the task briefing already knew are **higher than the briefing's numbers**, because ingestion is live and running right now:

| Table | Briefing's number | Measured just now | Δ |
|---|---|---|---|
| `polymarket_quotes` | 12.4M | **13,507,418** (peaked at 13,521,418 seconds later) | +~1.1M, growing ~1.27M rows/hour during this capture window |
| `nfl_blind_input_mutations` | 5M | **5,250,130** | +250K |
| `nfl_line_snapshots` | 1.76M | **1,857,213** | +97K |
| `nfl_quote_tape` | 1.58M | **1,670,333** | +90K |

This growth is not noise — it is the mechanism behind essentially every risk finding below.

---

## 1. Inventory by domain

Classification method: prefix + manual overrides for tables that share infra across domains (see notes). Full per-table breakdown is in `domain_breakdown.json` next to this file.

| Domain | Tables | Rows | MB (table data only, no indexes) |
|---|---:|---:|---:|
| nfl-market | 24 | 17,679,010 | 3,226.1 |
| nfl-model | 73 | 6,455,079 | 2,182.3 |
| mlb | 11 | 424,518 | 41.7 |
| nfl-audit | 29 | 235,721 | 1,776.0 |
| fantasy | 54 | 234,535 | 29.6 |
| props | 7 | 202,954 | 52.4 |
| platform | 30 | 10,168 | 3.9 |
| news | 7 | 6,015 | 4.3 |
| nfl-execution | 27 | 1,004 | 10.1 |
| **Total** | **262** | **25,249,004** | **7,326.3** |

Notes on classification:
- `model_*` (un-prefixed, e.g. `model_experiments`, `model_registry`, `model_production_pointer`) is shared model-governance infrastructure used by **both** `server/services/nfl-experiments.js` and `server/services/mlb-experiments.js` (confirmed by grep) — filed under **platform**, not nfl-model.
- `off_*` and `player_*` are fantasy-side roster/contract/usage tables (used by draft/trade/ranking code) — filed under **fantasy**, not nfl-model, even though several also feed the betting model's features.
- `nfl_qbr_weekly` and `nfl_scottfree_game_features` are filed under nfl-model (feature-building), see §4 for a live data-quality problem in the former.

**Striking shape of the data:** `nfl-execution` — the actual bet-placement/tracking layer (`nfl_bet_log`, `nfl_execution_log`, `nfl_replay_bets`, `nfl_total_picks`, `parlay_cache`, `pick_values`, …) — has 27 tables holding a combined **1,004 rows**, 25 of those 27 tables at 0 or single-digit rows. This is consistent with memory's "fantasy over betting… betting engine is secondary" and "app never submits ESPN picks": the execution layer is built but essentially unused. It is not dead code exactly (routes/services reference it), it is simply idle.

---

## 2. Table-level bloat: JSON-blob columns dominate size, independent of row count

`dbstat` bytes per table, cross-referenced with row counts, show storage is **not** proportional to rows. The top space consumers all store one or more `*_json` TEXT blob columns:

| Table | Rows | Bytes (table data) | Bytes/row | Blob column(s) (from `CREATE TABLE`) |
|---|---:|---:|---:|---|
| `nfl_team_cards` | 4,298 | 725.6 MB | **169 KB** | `card_json` |
| `nfl_blind_audit_weeks` | 356 | 690.7 MB | **1.94 MB** | `result_json`, `fault_json` |
| `nfl_weekly_expert_examples` | 100,483 | 636.1 MB | 6.3 KB | `payload_json` |
| `nfl_player_feature_vectors` | 16,173 | 494.0 MB | **30.5 KB** | `vector_json`, `missing_json` |
| `polymarket_quotes` | 13,507,418 | 1,773.9 MB | 131 B | (no blob — plain numeric columns, this size is legitimately row-count-driven) |
| `nfl_quote_tape` | 1,670,333 | 979.1 MB | 586 B | `raw_json` |
| `nfl_postgame_truth_packets` | 5,780 | 338.1 MB | **58.5 KB** | `payload_json` |
| `nfl_blind_input_mutations` | 5,250,130 | 272.9 MB | 52 B | (no blob — genuinely an append-only audit log, this is expected) |
| `nfl_rebuild_checkpoints` | 30 | 191.5 MB | **6.4 MB** | `result_json` |
| `nfl_team_feature_vectors` | 1,662 | 165.5 MB | **99.6 KB** | `vector_json`, `missing_json` |
| `leagues` | 7 | 11.7 MB | **1.67 MB** | `payload` (cached full ESPN league JSON, 1.4–2.1 MB per league — legitimate, this is a deliberate cache) |

Schemas confirmed directly (`sqlite_master.sql`), e.g. `nfl_rebuild_checkpoints`:
```sql
CREATE TABLE nfl_rebuild_checkpoints (
  run_key TEXT NOT NULL,phase TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,
  finished_at TEXT,result_json TEXT,error TEXT,PRIMARY KEY(run_key,phase)
)
```
30 rows averaging 6.4 MB each in `result_json` is the single most disproportionate table in the database. `nfl_blind_audit_weeks` at 1.94 MB/row is the second. These are healthy, intentional design (full audit/checkpoint payloads for a system whose entire premise is tamper-evident, reproducible history — see §5's trigger inventory), not corruption — but they are the tables to watch first if disk pressure returns, because a small number of *new* rows there moves the needle far more than any of the 13M-row tables.

---

## 3. Zero-row and dead tables

**58 of 261 tables have zero rows.** Most are legitimate scaffolding for features not yet exercised (the nfl-execution layer, `model_*` governance infra never triggered, `nfl_ai_replay_*`, etc. — full list in `rowcounts.json`).

Cross-referencing all 261 table names against `grep -rlw <name> server/ --include=*.js --exclude-dir=migrations` found **only 5 tables with zero live code references outside migration files** (i.e., genuinely orphaned schema):

| Table | Rows | Status |
|---|---:|---|
| `auction_sales` | 0 | **Not in any migration file, not in any script, not in any current source file — anywhere in the repo.** |
| `auction_settings` | 0 | Same. |
| `model_actor_provenance_quarantine` | 0 | Created by `server/migrations/009_authoritative_actor_and_ownership_guards.js`; referenced only there and in `test/model-registry-persistence.test.js`. |
| `nfl_scottfree_game_features` | 285 | Created by `server/migrations/022_scottfree_game_features.js`, populated by `scripts/import-scottfree.mjs`, referenced only in that script + `test/model-registry-persistence.test.js` — **no route or service reads it.** |
| `sqlite_sequence` | 66 | SQLite-internal, ignore. |

**`auction_sales`/`auction_settings` traced to origin:**
- `git log --all -S"auction_sales"` shows exactly two hits: commit `10105b1` "Add auction-draft dollar values, best-ball-aware draft assistant scoring, and CFBD rookie signal" (created the migration + tables), then commit `603d6b4`, 2026-09-04 16:29:07 -0400, **"Remove mobile nav drawer and auction-draft dollar values (not wanted)"**.
- `git show --stat 603d6b4` touches only `client/src/App.tsx`, `server/routes/edge.js`, `server/services/auction-values.js` (deleted), `test/auction-values.test.js` (deleted) — **it never touched the migration that created the tables.** No down-migration ever ran.
- Net effect: two fully dead tables have sat in the live 11.6 GB database, unreferenced by any code path, since 2026-09-04, because the feature removal deleted the application layer but not the schema layer. Safe to drop (0 rows, zero references anywhere in the tree, confirmed reverted "not wanted" by Nick himself).

`nfl_scottfree_game_features` (285 rows, ~1.17 MB) is a live judgment call rather than dead schema — it has a populated import script and a test, it's just not wired into any serving path yet. Flag for Nick to say whether it's WIP or abandoned; do not drop without asking.

---

## 4. Live data-quality defect found in the audit itself: `nfl_qbr_weekly` still carries fabricated season-2026 data, mid–Week 1

This was **not** in the task briefing; found by inspecting `server/services/nfl-qbr.js` against the table's actual contents.

`server/services/nfl-qbr.js:12-42` (`syncQbr()`) is the only ingestion path for this table. It pulls `qbr_week_level.csv` from the public `nflverse-data` GitHub release, filters to `season_type === 'Regular'`, and does `INSERT OR REPLACE` keyed by `(season, week, team, player_id)` using **only values read from that CSV** — there is no code path in this function (or anywhere else `grep`-found) that could synthesize a future week's stats.

Querying the live table directly:
```
season=2026 present for ALL 18 weeks, 541 rows total, every row fetched_at = '2026-09-10 03:51:00'
```
That is impossible for real data — as of 2026-09-10, no 2026 regular-season game beyond (at most) Week 1 had been played, since this very audit is running during Week 1's T-60 capture window on 2026-09-12. Direct comparison confirms these are copy-forward placeholders, not independently-derived projections:

```
season=2026 week=1 Kyler Murray: qbr_total 49.4, pts_added -0.5, qb_plays 46, epa_total 3.9, qbr_raw 46.5, sack -2.1  (fetched_at 2026-09-10 03:51:00)
season=2025 week=1 Kyler Murray: qbr_total 49.4, pts_added -0.5, qb_plays 46, epa_total 3.9, qbr_raw 46.5, sack -2.1  (fetched_at 2026-09-12 04:17:13)
```
Every numeric column matches to the decimal, across 6 independent metrics — this is 2025's real week-1 row copied forward under `season=2026` by some one-off seeding step outside `syncQbr()` (no such script was found by grep in `scripts/`; origin unattributed). The `2025` row's `fetched_at` being *today* (04:17 AM, hours before this audit ran) shows the real `syncQbr()` job is still running normally against genuine historical data — it just hasn't (as of this morning) received real 2026 Week 1 CSV rows from nflverse yet, so the placeholder for `season=2026, week=1` has not been overwritten.

**Why this matters right now, not hypothetically:** `qbrTrailingForPlayer()` (`server/services/nfl-qbr.js:82-95`) and `teamQbrProfile()` (`:50-70`) both query `nfl_qbr_weekly` with no is-placeholder filter, and both are consumed by `server/services/projections.js` for the QB signal feeding fantasy projections and the betting model's `qb_state` role. A prior Claude session (`56bcd279…jsonl`, see §7) had already flagged this exact table as fabricated for 2026 and said it "doesn't leak into week 1, but from week 2 onward it silently double-counts" — that assessment is now stale and slightly too optimistic: it **is** live for Week 1 too, right now, because the real CSV hasn't landed yet. This is a live, unresolved, previously-known-but-apparently-unfixed data-integrity defect. Recommend: either purge `season=2026` rows entirely until `syncQbr()` actually populates them from real data, or add a `is_placeholder` flag so consuming code can refuse to trust them — the current silent copy-forward is the worse of the two options.

---

## 5. Triggers: 169, mostly a deliberate append-only audit spine

169 triggers, concentrated 3–5 per table on `nfl_player_feature_vectors`, `nfl_quote_tape`, `nfl_team_cards`, `nfl_team_feature_vectors`, `nfl_verified_events`, `game_lines`, `drafts`, `model_audit_log`, `model_experiments`, and others — an `nfl_blind_input_<table>_{insert,update,delete}` pattern that logs every mutation on a set of "protected" tables into `nfl_blind_input_mutations` (5.25M rows, growing ~29K/hour during this capture window; breakdown by source table confirms `nfl_line_snapshots` and `nfl_quote_tape` account for most of it). This is the audit mechanism referenced in commit `889dcf1` ("Return to Codex: C03's caveat was a blind spot...") — intentional tamper-evidence for a blind-backtesting system, not accidental bloat. It is also **why** two migrations (031, 032) broke in that commit: both tried to `UPDATE` a table carrying one of these append-only `BEFORE UPDATE ... RAISE(ABORT)` guards, and a generalized scan (added in that same commit) now checks every migration for this before it can ship. This is a known, already-fixed class of bug; no action needed, just noting it's why the trigger count is what it is.

---

## 6. The .gitignore gap that let a `.bak-journal` file into git — still open today

`server/data.sqlite.pre-migration-2026-09-11T00-19-06-457Z.bak-journal` (1,024 bytes) **is currently tracked in git**, committed in `889dcf12716f0f5423d83ee75a81aa80893c6aaa` ("Return to Codex: C03's caveat was a blind spot...", 2026-09-10 20:30:14 -0400), and `git cat-file -e HEAD:<path>` confirms it is **still present at HEAD today.**

This file is an orphan: there is no `.bak` at the `00-19-06` timestamp (only at `00-21-58`, ~2m52s later) — the first `VACUUM INTO` attempt at 00:19:06 evidently didn't complete cleanly (left its rollback journal behind), and a second attempt 2m52s later at 00:21:58 succeeded and produced the `.bak` file that still exists today. The stray journal from the failed first attempt got swept up by a `git add -A` at the same session.

**Why it isn't caught by `.gitignore`, and still wouldn't be if it happened again:**
```
git check-ignore -v server/data.sqlite.pre-migration-2026-09-11T00-21-58-169Z.bak       -> MATCHES .gitignore:53 (*.pre-migration-*.bak)
git check-ignore -v server/data.sqlite.pre-migration-2026-09-11T00-21-58-169Z.bak-journal -> NO MATCH (exit 1)
git check-ignore -v server/data.sqlite.pre-migration-2026-09-11T00-21-58-169Z.bak-wal      -> NO MATCH (exit 1)
git check-ignore -v server/data.sqlite.pre-migration-2026-09-11T00-21-58-169Z.bak-shm      -> NO MATCH (exit 1)
```
`.gitignore` lines 25-27 cover `-shm`/`-wal` sidecars only for the **older** `pre-reset-*` naming scheme, and lines 47-53 (added the same day, as the "seatbelt" against the `undefined`-file incident) cover `*.pre-migration-*.bak` but never a `-journal`, `-wal`, or `-shm` sidecar of that newer `pre-migration-*` name. The file is tiny (1 KB) so this isn't a disk-space problem — it's that the exact failure mode the `.gitignore` comment says it exists to prevent ("must never make an audit look code-dirty or be committed to GitHub") happened anyway, through a gap in the same patch that added the guard, and the gap is still there.

**Fix (one line, not applied — repo is read-only for this audit):** add `*.pre-migration-*.bak-journal`, `*.pre-migration-*.bak-wal`, `*.pre-migration-*.bak-shm` to `.gitignore`, and `git rm --cached` the currently-tracked journal file.

Separately: the `.gitignore` comment (lines 47-51) describes a **9.3 GB file literally named `undefined`** that a shell-quoting bug in `VACUUM INTO` once wrote, saying "`git add -A` committed it." I could not find any trace of a file named `undefined` anywhere in `git log --all --diff-filter=A` or the reflog — either it was caught and un-staged/amended away before it was ever truly committed, or the commit object was later pruned. Either way, no forensic trace remains today and the `undefined`/`*.sqlite.bak` guard lines are dead-simple insurance regardless of exactly what happened; no action needed there.

---

## 7. Backup strategy: real, documented, deliberately un-automated pruning — and a disk-exhaustion clock a prior session already calculated

`server/db/index.js:62-148` (`backupBeforeMigration` / `assertRoomForSnapshot`) is well-designed and heavily commented with its own incident history:
- Every migration run (when schema history already exists) takes a `VACUUM INTO` snapshot first — not a raw file copy, specifically because a raw copy of `data.sqlite` alone can miss pages still sitting in `-wal` under WAL mode (`:66-70`).
- **2026-09-10 incident, documented in the code itself (`:78-89`):** the DB was 9.0 GB, eight accumulated snapshots totaled 57.3 GB, the volume was at 97% with 15 GB free, and the next migration would have attempted a 9 GB `VACUUM INTO` into 15 GB of headroom. A disk guard (`assertRoomForSnapshot`, requiring `dbSize + 2GB` free) was added the same day to **refuse** rather than risk a half-written backup next to a stalled migration.
- **Snapshots are explicitly never pruned automatically** — the code comment states this is deliberate: "Deleting a recovery point is a judgement about what history is worth keeping, and that belongs to a person who knows what is in it."

This matches, in the actual live chat history (`~/.claude/projects/-Users-nick-matta-Claude-Artifacts/56bcd279-faac-49bd-bb5e-5c81df4657f1.jsonl`, verbatim assistant text, lines 2467/2502), the session that lived through this incident:
> "Your disk is at 97% — 15 GiB free of 460 GiB. 57.3 GB of that is old pre-migration backups... The backups aren't from my session (they're timestamped before it) — they're the accumulated cost of `backupBeforeMigration` firing on every migration run, 8 times since Sep 1."
> "Deleted 7 superseded snapshots (kept the newest complete pre-031 one): 15 GiB → 56 GiB free. Added a headroom guard that refuses to snapshot rather than filling the disk..."

Today, exactly **one** `.bak` remains (9.79 GB, from the successful `00-21-58` `VACUUM INTO` two days later), consistent with that cleanup.

**The disk-exhaustion risk is real and was already quantified once, before this audit, by a different Claude session** (same file, later in the same session, after fixing the 97%-full incident):
> "Your disk gives out in about 50 days. Polymarket quotes alone write ~460 MB/day; total growth is ~0.5 GB/day against a migration guard that needs `dbSize + 2 GB` free. At current rates that crosses over in late October, mid-season... There is no retention policy anywhere in the codebase. The guard is behaving correctly; the growth is the problem."

That estimate is now two days stale and, based on what this audit just measured (polymarket_quotes alone ingesting ~1.27M rows/hour = ~46 MB/hour = **>1 GB/day** during this specific live-capture window, well above the quoted "~460 MB/day" average), the true growth rate is bursty and game-day-dependent — heavier during active capture windows, presumably near-zero between weeks. The qualitative conclusion stands and is worth restating plainly: **there is no retention or archival policy anywhere in this codebase for any of the market/quote-tape tables**, the disk guard only prevents a *failed* migration, it does nothing about gradual fill, and every future schema migration will need `current_db_size + 2 GB` free just to run at all. With ~68-73 GB free today and an 11.6 GB live DB, there's headroom for roughly 5-6 more `VACUUM INTO` backups at current size before repeating the 97%-full incident — fewer than that once the DB itself grows further. This deserves a standing decision from Nick (a retention window, a compaction job, or just periodic manual pruning of `.bak` files after confirming each migration landed clean), not a one-time fix.

---

## 8. Why the WAL file is 3.35 GB against a 4 MB auto-checkpoint threshold

Measured: `PRAGMA page_size` = 4096, `PRAGMA wal_autocheckpoint` = 1000 (the SQLite default, i.e. checkpoint triggers every ~4 MB of WAL growth). `lsof` confirms exactly one process (PID 56651, the live server) has the file open, and `server/db/index.js:13` confirms exactly one `new DatabaseSync(...)` call exists in the entire codebase — there is no second reader/writer connection to blame for holding a snapshot open.

Two things combine to explain a WAL 800x over its nominal threshold, both grounded in what's actually in the code:
1. **No code anywhere calls `PRAGMA wal_checkpoint`, in any mode, ever** (`grep -rn "wal_checkpoint" server --include=*.js` → zero hits in application code). SQLite's automatic checkpoints always run in `PASSIVE` mode, which folds committed pages back into the main file **but does not truncate the WAL file's size on disk** — it can only reset the log pointer to the start, and only if no reader still needs the older frames. The file's on-disk size is a high-water mark that a long-lived process will only ever grow, never shrink, without an explicit `wal_checkpoint(TRUNCATE)` — which nothing in this codebase issues.
2. **The write rate is genuinely extreme in bursts.** Measured live: `polymarket_quotes` alone is taking ~1.27M INSERTs/hour right now (T-60 capture during Week 1), and `nfl_blind_input_mutations` (the audit trigger spine) logged ~29K rows in the last measured hour. At that rate, a WAL that only checkpoints passively between bursts, and never truncates, will simply ratchet upward every game week and hold its peak between them.

This exact issue was already flagged once before, at a much smaller scale — a prior Claude session (`56bcd279…jsonl`, part of the same 6-agent audit dispatch quoted above) listed as unaddressed: **"that 932 MB WAL that's never checkpointed."** It has grown roughly **3.6x since then** (932 MB → 3.35 GB) with nothing in the codebase changed in between. This is a known, previously-reported, still-unaddressed issue, not a new one — worth closing this time with an actual fix (a scheduled off-peak `PRAGMA wal_checkpoint(TRUNCATE)`, e.g. run by the same scheduler that already runs the health-check `quick_check`) rather than another flag.

One caution for whoever eventually fixes this: `PRAGMA quick_check`/`integrity_check` on this file was measured elsewhere in the chat history at **159 seconds** against a 9.8 GB DB (it's now 11.6 GB, so slower still) — a fact the codebase already accounts for by throttling that check to once/24h (`server/db/index.js:166-201`, `GRIDIRON_DB_INTEGRITY_INTERVAL_HOURS`). A `wal_checkpoint(TRUNCATE)` job should similarly run off-peak/scheduled, not on every request, and specifically **not** while the live T-60 capture window is active (would compete with the capture writes and could stall them under `busy_timeout`).

---

## 9. `server/data/` lab and log directories — one confirmed duplicate

All of `server/data/{market-lab,tree-lab,role-scenario-lab,book-lag-lab,evidence-datasets,news-event-impact,expert-selector-lab}` are gitignored (`.gitignore:30-36`) and only two small JSON files (`analyst-notes-2026.json`, `draft-audit-signals-2026.json`) under `server/data/` are actually tracked in git — correctly.

| Directory | Size | Contents | Verdict |
|---|---:|---|---|
| `evidence-datasets/` | 552 MB | one dataset (`05ed3ece6d9b4590/`) + `latest.json` | fine, no duplication |
| `market-lab/` | ~13.5 MB (3 runs) | **see below** | one confirmed duplicate |
| `tree-lab/` | 10 MB | one run | fine |
| `expert-selector-lab/` | 10 MB | two runs 4 min apart, different content | normal retry, fine |
| `book-lag-lab/` | 108 KB | one run | fine |
| `role-scenario-lab/`, `news-event-impact/` | <40 KB each | one manifest each | fine |

**`market-lab/` has three run directories, all from 2026-09-08, and two of them are the same dataset run twice:**
- `20260908T152001Z-7f69ded8` and `20260908T152747Z-7f69ded8` share the identical dataset hash `7f69ded8` in their directory name, contain byte-for-byte the same file set (`dataset.json`, `preregistered.json`, `report.json`, and 12 `.joblib`/`-predictions.json` pairs for spreads/totals × 2023-2025), 12 minutes apart. This is a re-run of the exact same pilot, not two different experiments.
- `20260908T152845Z-334b4b45` (dataset hash `334b4b45`, ~1 minute after the second run) is genuinely different — it additionally has `*-tpot-trials.json` files for each market/season, meaning this run added TPOT hyperparameter search on top of the same base dataset.
- This matches the task briefing's "three market-lab runs of the same dataset" almost exactly, with the nuance that it's 2-of-3 duplicated, not all three. Safe to delete the older of the two `7f69ded8` runs (`20260908T152001Z`) — it is gitignored, reproducible, and superseded by its own 12-minutes-later twin.

---

## 10. Two known, previously-flagged, currently-fixed items — verified live in the DB

Cross-referencing chat history against the live database found two prior "Claude found X" moments that **are** actually resolved now (unlike §4, §6, §8):

**`players.gsis_id` crosswalk corruption** — a background task (`8346c03e-…jsonl:1995`, `0fa93b9e-…jsonl:4`) reported Travis Kelce's real stats sitting under a *different* player's row ("Noah Gray", id 424) via a shared/misassigned `gsis_id`, plus a list of a dozen other name-collision players with zero `player_week_usage` rows. `git log --all --oneline --grep="crosswalk"` finds the fix: commit `a222fc1` "Fix the players.gsis_id crosswalk so espn_id always wins and a gsis is never on two rows." Verified live just now:
```
players WHERE name LIKE '%Kelce%' -> exactly one row, id 8654, gsis_id 00-0030506 (correct)
SELECT gsis_id, COUNT(*) FROM players GROUP BY gsis_id HAVING COUNT(*)>1 -> 0 rows
```
Confirmed genuinely fixed, not just claimed fixed.

**Two ESPN leagues not syncing** — a prior session's fantasy audit (`56bcd279…jsonl`, §7 quote block) reported "Two leagues stopped syncing — id 5 (ESPN 404, six weeks stale) and id 29 (401, expired credentials)." Checked the live `leagues` table just now: **still true today.**
```
id=5,  league_id=59957314,  connection_status='sync_failed', sync_error='ESPN API 404'
id=29, league_id=648921311, connection_status='sync_failed', sync_error='ESPN API 401'
```
This is a data-freshness gap in the fantasy domain that has now persisted at least since that prior report through today — worth a direct nudge to Nick since it's a one-click ESPN re-auth away from being fixed, not an engineering task.

---

## 11. Cleanup plan (concrete, tiered by risk)

**Safe to do now, no confirmation needed (0 rows / reproducible / gitignored):**
1. `DROP TABLE auction_sales; DROP TABLE auction_settings;` — 0 rows, zero code references anywhere in the tree, feature was explicitly reverted "not wanted" by Nick on 2026-09-04.
2. `git rm --cached server/data.sqlite.pre-migration-2026-09-11T00-19-06-457Z.bak-journal` and delete the 1 KB file — orphaned artifact of a failed backup attempt, already superseded by the successful one 3 minutes later.
3. Add to `.gitignore`: `*.pre-migration-*.bak-journal`, `*.pre-migration-*.bak-wal`, `*.pre-migration-*.bak-shm` — closes the gap that let (2) happen.
4. Delete `server/data/market-lab/20260908T152001Z-7f69ded8/` — byte-identical duplicate of `20260908T152747Z-7f69ded8/`, gitignored, reproducible by re-running the lab.

**Needs Nick's explicit confirmation before acting (destructive / not git-recoverable):**
5. Delete `server/data.sqlite.pre-migration-2026-09-11T00-21-58-169Z.bak` (9.79 GB) — this is the *only* remaining recovery point older than migration 035; per the code's own stated policy ("choosing which recovery point to give up... belongs to a person who knows what is in it"), do not drop it without asking, but it is a large, safe-to-eventually-drop chunk of the 24.8 GB total once Nick confirms the live DB (currently at 035, `quick_check ok` per the code's own health-check table) is trusted.
6. `nfl_scottfree_game_features` (285 rows) — has an import script and a test but no serving path; ask whether it's active WIP or abandoned before dropping.

**Needs an engineering decision, not a cleanup action:**
7. Fabricated `nfl_qbr_weekly` season=2026 placeholder rows (§4) — either purge until real data lands, or add an `is_placeholder` column so `qbrTrailingForPlayer`/`teamQbrProfile` can refuse to trust them. This is actively wrong data feeding live Week 1 decisions, not a hygiene issue.
8. WAL truncation (§8) — add a scheduled off-peak `PRAGMA wal_checkpoint(TRUNCATE)`, explicitly **not** during active T-60 capture windows.
9. Retention policy (§7) — no code anywhere prunes `polymarket_quotes`, `nfl_quote_tape`, `nfl_line_snapshots`, etc. Disk math says the next `dbSize + 2GB` migration-guard refusal is a matter of weeks-to-months at current growth, not years. This needs a standing decision (archive-to-cold-storage, a retention window, or accepted manual pruning), not a one-off fix.

**Do not touch (per hard rules and the app's own stated policy):**
- The live `server/data.sqlite` / `-wal` / `-shm` — server is actively capturing Week 1 T-60 packets on PID 56651.
- `server/data.sqlite.pre-migration-2026-09-11T00-21-58-169Z.bak` until Nick explicitly says to drop it (see #5).
- `evidence-datasets/`, `nfl_team_cards`, `nfl_blind_audit_weeks`, and the other large audit/evidence JSON-blob tables — these are the tamper-evident history the whole "blind audit" architecture exists to protect (§5); large-but-legitimate, not cleanup targets.

---

## 12. Chat-history method note

Scope for this history-reader is the data layer specifically (`server/data.sqlite`, `server/data/`, `.gitignore`, `git ls-files`, disk usage); no specific chat-transcript path was assigned. As a bonus pass, I keyword-scanned (streamed, not loaded whole) all 20 `*.jsonl` session files under `~/.claude/projects/-Users-nick-matta-Claude-Artifacts/` (and the smaller `-fantasy-football-dashboard` project dir) that matched data-layer terms (`VACUUM INTO`, `pre-migration`, `wal_checkpoint`, `market-lab`, `bak-journal`, `97% full`, `dbstat`, disk-size figures, etc.), skipping this session's own transcript. That surfaced the two incident narratives quoted verbatim in §7-8 and the two prior-finding cross-checks in §10 and §4. I did not do a full line-by-line read of all 20 files (several are 15-33 MB spanning unrelated feature work — trade engine, live draft UX, MLB props, etc.) since that falls outside a data-layer-scoped pass; flagging this in case another history-reader's slice already covers those files' non-data-layer content, or in case Nick wants a dedicated full pass over them later.

## Files referenced in this audit
- `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/.gitignore`
- `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/server/db/index.js`
- `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/server/services/nfl-qbr.js`
- `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/server/migrations/009_authoritative_actor_and_ownership_guards.js`
- `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/server/migrations/022_scottfree_game_features.js`
- Git commits: `10105b1`, `603d6b4`, `889dcf1`, `a222fc1`
- Chat sessions: `~/.claude/projects/-Users-nick-matta-Claude-Artifacts/{56bcd279-faac-49bd-bb5e-5c81df4657f1, 77190978-4d50-4315-861c-375dfc788580, 8346c03e-eebc-46ff-9c7c-b9e7e69ec0fe, 0fa93b9e-e454-4fd1-b592-2a30af9584a7, 1b318097-0717-4617-809c-b7a26c4217fb}.jsonl`
- Scratch data behind this report: `dbstat.json`, `rowcounts.json`, `domain_breakdown.json`, `code_refs.json`, `chat_hits.json`, `indexes.json`, `triggers.json` — all in this same scratchpad directory.
