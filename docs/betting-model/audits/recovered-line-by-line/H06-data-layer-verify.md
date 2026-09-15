# Adversarial verification: H06-data-layer (3 claims)

Verifier stance: impact lens. A claim survives only if it changes money staked, a
decision recorded, data integrity fed into a live model, backtest leakage, or a
number Nick actually reads on a page — right now, not hypothetically.

## H06-data-layer#288 — nfl_qbr_weekly season=2026 fabricated from season=2025

**DB-level fact-check (read-only node:sqlite query against server/data.sqlite):**

- Confirmed exact duplicate for the cited example:
  - season=2026 wk1 Kyler Murray: `{qbr_total:49.4, pts_added:-0.5, qb_plays:46,
    epa_total:3.9, qbr_raw:46.5, sack:-2.1}`, fetched_at `2026-09-10 03:51:00`
  - season=2025 wk1 Kyler Murray: identical 6 values, fetched_at `2026-09-12 04:17:13`
- season=2026 has rows for **all 18 weeks** already (`SELECT DISTINCT week ... season=2026`
  → 1..18), which is impossible for real data on 2026-09-12 (only week 1 has been played).
- Systematic check across the whole table: of 541 season=2026 rows, **537 (99.3%) are
  byte-identical** to the season=2025 row for the same (week, player_id) — `qbr_total`,
  `pts_added`, `epa_total` all match exactly. Only 4 rows differ.
- `fetched_at` grouping for season=2026: 537 rows stamped `2026-09-10 03:51:00` (one
  single batch write, covering weeks 1-18 at once — this is NOT what `syncQbr()`'s
  normal CSV pull could produce, since nflverse's `qbr_week_level.csv` would not contain
  weeks 2-18 of a season that hasn't been played yet); 4 rows stamped `2026-09-12
  04:17:13` (today — Stafford/Maye/Lock/Purdy, real week-1 results landing via the
  normal scheduled sync as games conclude).
- season=2025 was also just re-fetched in full today (540/540 rows stamped
  `2026-09-12 04:17:13`), consistent with `scheduler.js:371-375`'s
  `refreshQbrAndWeather()` calling `syncQbr({ seasons: [season-1, season] })` on its
  normal schedule (server/services/scheduler.js:371-375).

So the core DB-level claim is **verified true**: the bulk of `nfl_qbr_weekly` season=2026
is a fabricated/placeholder copy of season=2025, written in one shot on 2026-09-10,
sitting unflagged in the live database right now.

**But the "feeding QB features during Week 1 right now" impact claim does not hold up.**
Traced every consumer of this table:

- `server/services/nfl-qbr.js:53-71` `teamQbrProfile(season, week, team)` — query is
  `WHERE team=? AND ((season=? AND week<?) OR season=?)` with the last param =
  `season - 1`. For week=1, `season=2026 AND week<1` is empty, so only the
  **prior season (2025, real data)** branch contributes. The fabricated 2026 rows are
  structurally excluded at week 1.
- `server/services/nfl-qbr.js:84-96` `qbrTrailingForPlayer(espnId, through, throughWeek)`
  — when `throughWeek` is a number, query is `season<through OR (season=through AND
  week<=throughWeek)`. Every live caller that matters passes `throughWeek = week - 1`:
  - `server/services/player-week-engine.js:143` (`through: season, throughWeek: week - 1`)
    — this is the actual live weekly engine; for week=1, `throughWeek=0`, so
    `season=2026 AND week<=0` matches nothing.
  - `server/services/projections.js:551` reads through `buildProjections`'s `through`/
    `throughWeek`, which every real caller hardcodes to `through: season - 1` or
    `through, throughWeek: week-1` (server/routes/model.js:404/426/482,
    server/services/season-sim.js:166/363, server/services/draft-assist.js:83,
    server/services/week-postmortem.js:109, server/services/ceiling-lineup.js:54,
    server/services/preseason-model.js:459 via `inHouseProjections(season - 1)` at
    preseason-model.js:602). None of these currently pass `through=2026` together with
    a null `throughWeek`, which is the only combination that would read the fabricated
    rows unfiltered (`qbrTrailingForPlayer`'s `throughWeek==null` branch is `season<=
    through`, with no week gate at all).
  - The betting model's own `qb_state` role — the exact feature the claim names —
    calls the same cutoff-safe `teamQbrProfile` (server/services/nfl-matchup-
    specialists.js:150 `differential('qb_state', ...)`, and
    server/services/line-move-study.js:193 `teamQbrProfile(g.season, g.week, ...)`).
    Both exclude fabricated season=2026 data at week=1 for the same reason as above.
  - No frontend caller (`client/src/api.ts`, `client/src/pages/Model.tsx`, etc.) ever
    sends a `through=2026` query param to `/projections` — the route defaults to
    `SEASON - 1` (server/routes/model.js:401-402), so even the one theoretically
    leaky combination is never exercised from the UI today.

**Conclusion:** the fabrication is real and verified, but it is currently a dormant
defect, not an active one. Every code path that is actually invoked for week 1 of the
2026 season — fantasy projections and the betting model's `qb_state` feature alike —
is cutoff-safe by construction and reads only real season ≤ 2025 data. Nothing Nick
sees today is corrupted by this. The genuine forward risk is narrower than claimed:
if the weekly `syncQbr()` resync (server/services/scheduler.js:371) ever stalls or
errors between now and the week-2 build, `teamQbrProfile`'s `week<2` branch would
then pick up the still-fabricated week-1 2026 row instead of a corrected one. That's
worth someone's attention, but it is not "silently corrupting fantasy projections and
the betting model's qb_state feature" right now, which is the claim as written.

**Verdict: refuted=true** (the specific real-time-impact claim), confidence 0.75,
corrected_severity P3 — data hygiene defect confirmed at the DB layer, but the
codebase's existing cutoff-safety keeps it from touching any live output today.

---

## H06-data-layer#289 — .gitignore missing -journal/-wal/-shm for pre-migration .bak

**Fact-check:**

- `.gitignore` (53 lines total, read in full):
  - lines 6-7: `server/data.sqlite-shm`, `server/data.sqlite-wal` (live DB sidecars, not
    backups)
  - line 11: `server/data.sqlite*.bak`
  - lines 25-27: `server/data.sqlite.bak.*`, `server/data.sqlite.pre-reset-*.bak-shm`,
    `server/data.sqlite.pre-reset-*.bak-wal` — note: covers `-bak-shm`/`-bak-wal` for the
    `pre-reset-*` naming scheme, but **no `-bak-journal` pattern anywhere**, for either
    naming scheme.
  - lines 49-53: the "Guard against a backup path that evaluated to a bare string"
    comment, then `undefined`, `*.sqlite.bak`, `*.pre-migration-*.bak` — again, only the
    `.bak` file itself, no `-journal`/`-wal`/`-shm` sidecar variants for the
    `pre-migration-*` scheme that `server/db/index.js:103`
    (`` `${databasePath}.pre-migration-${stamp}.bak` ``) actually uses.
- Confirmed via `git log --oneline | grep 889dcf1` and `git show 889dcf1 --stat`: that
  commit exists (2026-09-10, "Return to Codex...").
- Confirmed via `git ls-files | grep -i bak`: the file
  `server/data.sqlite.pre-migration-2026-09-11T00-19-06-457Z.bak-journal` **is currently
  tracked in the repo** (not merely a past incident — it is sitting in HEAD right now,
  1024 bytes per `ls -la`).

So the claim is **accurate and currently live**: a `.bak-journal` file is tracked today,
and the `.gitignore` patterns genuinely do not cover that sidecar extension for either
backup naming scheme, so the next interrupted `VACUUM INTO` (or crash mid-backup) would
repeat the exact same commit-a-database-fragment mistake.

**Impact lens:** this changes no number on any page, no staked bet, no recorded
fantasy/trade decision, and doesn't touch any model's inputs or backtest. It's a
repo-hygiene / credential-hygiene issue (the tracked file is a fragment of a database
that legitimately contains ESPN session cookies per the .gitignore's own comment at
line 3-4, and per server/db/index.js:210-213's espn_s2/swid columns) — real, but outside
this audit's specific impact criteria (money/decision/data-integrity-fed-to-a-
model/backtest/page-number).

**Verdict: refuted=true** on the impact lens (not on the facts, which check out),
confidence 0.65, corrected_severity P3.

---

## H06-data-layer#290 — WAL mode with no checkpoint-truncation logic

**Fact-check:**

- `server/db/index.js:15-19`: `PRAGMA journal_mode = WAL;` confirmed at line 17, with
  no companion `PRAGMA wal_checkpoint(...)` anywhere nearby or elsewhere.
- Repo-wide search (`grep -rni "checkpoint"`, excluding node_modules/.git) turns up
  zero uses of `wal_checkpoint` or any SQLite checkpoint pragma in the whole codebase
  — every "checkpoint" hit is an unrelated backfill/rebuild-progress table
  (`nfl_engine_backfill_checkpoints`, `nfl_rebuild_checkpoints`), not WAL management.
  Confirms: nothing in this codebase ever runs `PRAGMA wal_checkpoint(TRUNCATE)` or
  equivalent.
- Confirmed current file sizes on disk (`ls -la server/data.sqlite*`):
  - `server/data.sqlite`: 11,876,143,104 bytes (~11.9 GB)
  - `server/data.sqlite-wal`: **3,346,807,872 bytes ≈ 3.35 GB (decimal)** — matches the
    claimed current figure exactly.
  - `server/data.sqlite-shm`: 851,968 bytes
- Disk headroom (`df -h`): 460 GiB total, 349 GiB used, **66 GiB available, 85%
  capacity** on the volume holding this database.
- `assertRoomForSnapshot` (server/db/index.js:124-148) does depend on free disk space
  (`statfsSync(...).bavail`) before allowing a pre-migration `VACUUM INTO`, so an
  ever-growing WAL file genuinely does eat into the margin that function is guarding.

The technical claim is accurate: SQLite's default PASSIVE auto-checkpoint (every 1000
pages) copies frames back to the main file but does not shrink the `-wal` file on disk
(only a `TRUNCATE`-mode checkpoint does, and nothing in this codebase ever requests
one), so the WAL's on-disk size only ratchets up to its high-water mark and stays
there.

**Impact lens:** at 66 GB free / 85% used, this is not currently blocking anything —
no migration is failing today, no capture is at risk today, no number on a page is
wrong because of it. It's a real, verifiable operational/capacity risk that compounds
during an active capture window (today is NFL Week 1 2026, and the live capture
process on port 5177 is actively writing), but it hasn't yet changed any output,
decision, or staked amount. Per this audit's impact lens, it doesn't clear the bar.

**Verdict: refuted=true** on the impact lens (facts confirmed accurate), confidence
0.6, corrected_severity P3.

---

## Summary table

| key | facts checked out? | live impact verified? | verdict | corrected severity |
|---|---|---|---|---|
| #288 | yes — DB fabrication is real (537/541 rows) | no — every live consumer is cutoff-safe, traced end to end | refuted | P3 |
| #289 | yes — gap is real, tracked file exists today | no — repo hygiene, not a model/page/money impact | refuted | P3 |
| #290 | yes — WAL is 3.35GB, no checkpoint logic anywhere | no — 66GB still free, nothing blocked yet | refuted | P3 |
