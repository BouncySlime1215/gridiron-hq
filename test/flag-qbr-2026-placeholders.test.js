import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// scripts/flag-qbr-2026-placeholders.mjs — Giant Plan section 3, item 6.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-qbr-placeholder-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { flagPlaceholders, findPlaceholders, ensureColumn, PLACEHOLDER_SEASON, SOURCE_SEASON } =
  await import('../scripts/flag-qbr-2026-placeholders.mjs');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const insert = (season, week, team, id, total, plays, pts = 1, epa = 2, raw = 3, sack = 0) =>
  run(`INSERT INTO nfl_qbr_weekly
    (season,week,team,player_id,name,opponent,qbr_total,pts_added,qb_plays,epa_total,qbr_raw,sack,qualified,fetched_at)
    VALUES (?,?,?,?,?,'OPP',?,?,?,?,?,?,1,datetime('now'))`,
  season, week, team, id, `Player ${id}`, total, pts, plays, epa, raw, sack);

// A real 2025 week, then an exact copy landed on 2026 by whatever produced the bug.
insert(SOURCE_SEASON, 1, 'KC', 'A', 71.4, 34, 1.2, 40.1, 68.0, 0.5);
insert(PLACEHOLDER_SEASON, 1, 'KC', 'A', 71.4, 34, 1.2, 40.1, 68.0, 0.5);

// A genuine 2026 row for a different player: differs from any 2025 row it
// could be compared against, so it must never be flagged.
insert(SOURCE_SEASON, 1, 'KC', 'B', 20.0, 10, 0.1, 5.0, 22.0, 0);
insert(PLACEHOLDER_SEASON, 1, 'KC', 'B', 55.5, 30, 0.9, 30.0, 60.0, 1);

// A 2026 row with no 2025 counterpart at all (rookie, new team) — must not match.
insert(PLACEHOLDER_SEASON, 1, 'NE', 'C', 45.0, 20, 0.4, 12.0, 44.0, 0);

test('is_placeholder column is added on demand and is idempotent', () => {
  ensureColumn(db);
  ensureColumn(db); // second call must not throw ("duplicate column")
  const cols = db.prepare('PRAGMA table_info(nfl_qbr_weekly)').all().map(c => c.name);
  assert.ok(cols.includes('is_placeholder'));
});

test('finds only the exact 2025->2026 copy, not the genuine or missing-counterpart rows', () => {
  const matches = findPlaceholders();
  assert.equal(matches.length, 1);
  assert.equal(matches[0].team, 'KC');
  assert.equal(matches[0].player_id, 'A');
});

test('dry run reports the match but writes nothing', () => {
  const result = flagPlaceholders({ apply: false });
  assert.equal(result.dry_run, true);
  assert.equal(result.would_flag, 1);
  const flaggedNow = db.prepare('SELECT COUNT(*) n FROM nfl_qbr_weekly WHERE is_placeholder=1').get().n;
  assert.equal(flaggedNow, 0);
});

test('--apply flags exactly the copied row and leaves every other row at 0', () => {
  const result = flagPlaceholders({ apply: true });
  assert.equal(result.dry_run, false);
  assert.equal(result.flagged, 1);
  const flaggedA = db.prepare(`SELECT is_placeholder FROM nfl_qbr_weekly
    WHERE season=? AND team='KC' AND player_id='A'`).get(PLACEHOLDER_SEASON);
  assert.equal(flaggedA.is_placeholder, 1);
  const untouched = db.prepare(`SELECT COUNT(*) n FROM nfl_qbr_weekly WHERE is_placeholder=0`).get().n;
  assert.equal(untouched, 4, 'the other four rows (two genuine 2026, two 2025 source rows) stay unflagged');
});

test('re-running --apply is idempotent', () => {
  const result = flagPlaceholders({ apply: true });
  assert.equal(result.flagged, 1, 'UPDATE re-affirms the same already-1 row; nothing new to flag');
});
