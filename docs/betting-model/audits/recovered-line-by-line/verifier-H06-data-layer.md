# Verification of H06-data-layer claims #288, #289, #290

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only throughout).
All sqlite reads via `node -e` with `node:sqlite` `{ readOnly: true }`. No writes, no git state changes, no server touched.

## Claim #288 — nfl_qbr_weekly season=2026 rows are fabricated copies of season=2025

Files read:
- `server/services/nfl-qbr.js` (101 lines, full file read; lines_read=101, wc -l=101)
- `server/services/projections.js:520-570` (context around cited usage at line 551)
- `server/services/scheduler.js:330-400` (refreshQbrAndWeather + registration)
- `server/services/nfl-matchup-specialists.js`, `server/services/line-move-study.js` (grep-verified import lines)

### Reachability
`grep -rn` confirms:
- `server/services/projections.js:32` imports `qbrTrailingForPlayer`; `projections.js:551` calls it inside `buildProjections`'s player loop, gated by `qbrSignal?.enabled && qbrSignal.k` (line 550).
- `server/services/projections.js:192`: `export const QBR_SIGNAL = { enabled: true, k: 0.073, center: 53.26, window: 8 };` — the default passed at `projections.js:367` (`qbrSignal = QBR_SIGNAL`). **Enabled by default**, not behind a disabled flag.
- `server/services/nfl-matchup-specialists.js:27,150` and `server/services/line-move-study.js:29,193` both import and call `teamQbrProfile`.
- `server/services/nfl-matchup-specialists.js:149,228,242`: `qb_state` is a real, registered `MATCHUP_ROLES` entry, confirming the claim's "betting model's qb_state feature" wording is accurate (grep also finds `qb_state` weights baked into `server/data/expert-selector-lab/latest.json`, i.e. an actual model artifact that used this role).
- `server/services/scheduler.js:370-376` defines `refreshQbrAndWeather()` which calls `syncQbr({ seasons: [season-1, season] })`; `scheduler.js:759` registers it in the job table (`nfl_qbr_weather: { run: refreshQbrAndWeather, maxAgeMinutes: 24*60, tier: 'growth', ... }`). This is a live, scheduled job, not dead code.

So `nfl_qbr_weekly` data flows into `qbrTrailingForPlayer` (feeds `projections.js` QB point estimates) and into `teamQbrProfile` (feeds the `qb_state` matchup-specialist role and `line-move-study.js`). Fully reachable from the running app.

### Data verification (read-only queries against server/data.sqlite)
Queried `nfl_qbr_weekly` directly (readOnly connection):
- Kyler Murray (player_id 3917315): season=2026 week=1 row = `qbr_total 49.4, pts_added -0.5, epa_total 3.9, fetched_at '2026-09-10 03:51:00'`. Season=2025 week=1 row for the same player = **identical** `qbr_total/pts_added/epa_total`, `fetched_at '2026-09-12 04:17:13'`. This exactly matches the claim's cited snippet, including the two fetched_at timestamps.
- Season=2026 has all 18 distinct weeks present, 541 total rows, as of a sync that ran 2026-09-10 03:51:00 — i.e., ingested *before* any 2026 games were played (today is 2026-09-12, "NFL Week 1 T-60" per the live capture context), so a full 18-week 2026 dataset already existing on 09-10 is itself informative.
- Joined season=2026 vs season=2025 on (player_id, week): 540 of 541 2026 rows have a season=2025 counterpart on the same week/player. Of those 540, **537 match exactly** on qbr_total/pts_added/epa_total; only 3 differ (all in week 1, player_ids 12483, 4431452, 4361741).
- `fetched_at` breakdown for season=2026: 537 rows carry `fetched_at = '2026-09-10 03:51:00'` (the original bulk ingest) and only 4 week-1 rows carry `fetched_at = '2026-09-12 04:17:13'` (today's re-sync, presumably after real week-1 games had actually been played) — of those 4 freshly-refetched rows, 3 now diverge from the season=2025 numbers (real data) and 1 still coincidentally matches.
- Net: every 2026 row not yet refreshed by today's sync (537 of 541, i.e. week 1's un-refreshed rows plus the entirety of weeks 2-18) is byte-identical to the corresponding 2025 row. This is not "similar," it is exact copy-through, and it remains live in the table right now — nothing marks these rows as placeholder/unverified, and `qbrTrailingForPlayer`/`teamQbrProfile` have no season-vintage sanity check that would exclude them.

### Verdict reasoning
The reachability chain is real and currently live (scheduled job + non-default-disabled signal + actual model artifact referencing `qb_state`). The data claim is substantively correct: the overwhelming majority of season=2026 rows across all 18 weeks are exact copies of season=2025, still unflagged, and architecturally capable of biasing `qbrTrailingForPlayer`'s trailing-window read for a current QB during the live week (a call with `through=2026` will draw first from `season<=2026` rows, i.e. these copied rows, before season 2025's real rows, since the query in `qbrTrailingForPlayer` orders `season DESC, week DESC` — the 2026 (copied) rows are preferred over the genuine 2025 ones. Confirmed at `nfl-qbr.js:86-91`.).

One overstatement: the claim's wording "still live and unflagged, feeding QB features during Week 1 right now" is accurate, but "all 18 weeks are fabricated copies" is very slightly imprecise — 4 of the 33 week-1 rows have since been correctly refreshed with real data (partial self-healing already in progress from today's scheduled sync). This is a minor rounding of "537/541" to "all," not a fabrication of the underlying defect. I do not treat this as disqualifying.

**Verdict: not refuted. P1 stands** — a real, reachable, currently-live data-integrity defect feeding both the projections QB signal and the betting model's qb_state feature.

---

## Claim #289 — .gitignore backup-sidecar patterns miss `-journal`/`-wal`/`-shm`, and this already caused a real incident (889dcf1)

Files read: `.gitignore` (53 lines, full file, lines_read=53, wc -l=53).

Full content of the relevant tail (lines 47-53):
```
47: # Guard against a backup path that evaluated to a bare string (2026-09-10):
48: # a shell quoting mistake made VACUUM INTO write a 9.3 GB database to a file
49: # literally named "undefined", and `git add -A` committed it. The real fix was
50: # the quoting; this is the seatbelt.
51: undefined
52: *.sqlite.bak
53: *.pre-migration-*.bak
```
(Earlier duplicate/adjacent patterns also exist at lines 25-27: `server/data.sqlite.bak.*`, `server/data.sqlite.pre-reset-*.bak-shm`, `server/data.sqlite.pre-reset-*.bak-wal` — these cover the *pre-reset* backup family's -shm/-wal, but there is no equivalent for the *pre-migration* family's -journal/-wal/-shm, nor for the generic `.sqlite.bak`/`.pre-migration-*.bak` patterns at 52-53.)

### git verification
- `git show --name-only 889dcf1` lists three files, including **`server/data.sqlite.pre-migration-2026-09-11T00-19-06-457Z.bak-journal`** — a real, already-committed pre-migration backup sidecar, exactly the incident the claim describes.
- `git ls-tree -r HEAD --name-only | grep pre-migration` still returns that same file today — it is **still tracked at HEAD**, confirming "remains tracked today."
- `git check-ignore -v` against synthetic filenames of the same shape:
  - `server/data.sqlite.pre-migration-<ts>.bak` → matched by `.gitignore:53` (`*.pre-migration-*.bak`).
  - `server/data.sqlite.pre-migration-<ts>.bak-journal` → **not ignored** (exit 1, no match).
  - `server/data.sqlite.pre-migration-<ts>.bak-wal` → **not ignored**.
  - `server/data.sqlite.pre-migration-<ts>.bak-shm` → **not ignored**.

This is a fully verified, reproducible gap: the exact sidecar-suffix variants that are unprotected are the ones that already got committed once, and the file committed then is still sitting in the tree today, unremediated.

**Verdict: not refuted. P2 stands.**

---

## Claim #290 — WAL mode with no checkpoint-truncation logic; WAL file only grows

Files read: `server/db/index.js` (225 lines, full file read; lines_read=225, wc -l=225).

Line 17: `PRAGMA journal_mode = WAL;` (inside the `db.exec` block at lines 15-19, run unconditionally at module load — this module is the single shared `db` connection imported by essentially the whole server, and it is the live process's own database file per the environment's stated live server on port 5177 / PID 56651).

### Reachability / code search
- `grep -rn "wal_checkpoint\|wal_autocheckpoint\|journal_size_limit"` across all `.js`/`.mjs`/`.json` in the repo (excluding node_modules): **zero matches**. No file anywhere issues `PRAGMA wal_checkpoint(...)`, sets `wal_autocheckpoint`, or sets `journal_size_limit`.
- A separate grep for the bare word "checkpoint" does find hits, but every one of them (`nfl-rebuild-progress.js`, `nfl-engine-backfill.js`, `nfl-espn-pbp.js`, `scripts/nfl-2022-2025-rebuild.mjs`) is an **application-level resumability checkpoint** (a `nfl_engine_backfill_checkpoints` / `nfl_rebuild_checkpoints` table tracking job progress), unrelated to SQLite's WAL mechanism. None of them call SQLite's `wal_checkpoint` pragma. So the claim "no corresponding checkpoint-truncation logic anywhere in the codebase" is accurate — there is truncation-relevant application code with a similar name, but nothing that touches the WAL file.
- Live pragma read (readOnly connection): `PRAGMA wal_autocheckpoint` returns `1000` (SQLite's compiled-in default — nothing in this codebase overrides it), and `PRAGMA journal_mode` returns `wal`, confirming line 17's pragma is actually in effect on the live database file, not merely present in source.
- Default PASSIVE auto-checkpointing (the only kind that ever runs here, since nothing configures TRUNCATE/RESTART mode) does not truncate the WAL file on disk even when it fully succeeds, and cannot make progress past any concurrent reader's snapshot — so growth is architecturally expected, not merely theoretical.

### Actual measured state (read-only `ls -la` / `du`, no writes)
- `server/data.sqlite-wal` is **3,346,807,872 bytes = 3.35 GB** at the moment of this check — this is an exact match to the claim's cited figure ("3.35GB"), measured independently rather than taken on faith from the claim.
- `server/data.sqlite` itself is 11 GB (`du -sh` shows 11G / `ls -la` shows 11,876,143,104 bytes).
- Disk: `df -h /` shows 66Gi available of 460Gi (20% used) — so the impact clause "consumes disk headroom the migration guard (assertRoomForSnapshot) depends on" is correctly describing a real, applicable mechanism (`assertRoomForSnapshot` at `server/db/index.js:124-148` does compute `statfsSync(...).bavail` and compares against `statSync(databasePath).size + 2GB`) — note `assertRoomForSnapshot` sizes only the main `.sqlite` file, not the `-wal` file, so a growing WAL silently eats the same free-space pool that guard is trying to protect without being counted in the guard's own headroom math. This is a real, if secondary, mechanism-level connection, not an invented one.

I could not independently verify the claim's aside "grown from 932MB (per a prior chat session's finding)" — that number is not checkable from this file system state alone (no historical snapshots of `-wal` size were available to me), so I treat it as an uncorroborated but plausible aside rather than load-bearing for the verdict. The core, checkable claims (no checkpoint-truncation code exists; current WAL size 3.35GB; unbounded-growth mechanism is real and reachable from the live process) all hold.

**Verdict: not refuted. P2 stands.**

---

## Summary

| key | refuted | severity |
|---|---|---|
| H06-data-layer#288 | false | P1 |
| H06-data-layer#289 | false | P2 |
| H06-data-layer#290 | false | P2 |

All three claims survive adversarial reachability + data verification. None found to be dead/unregistered code; all three touch live, imported, scheduled, or actively-running paths, and the underlying data/config facts were independently reproduced with read-only queries rather than taken from the claim text.
