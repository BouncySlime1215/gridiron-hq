import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Weekly QBR profiles are strictly prior and follow the actual starter.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-qbr-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const qbr = await import('../server/services/nfl-qbr.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const row = (season, week, team, id, name, total, plays) => run(`INSERT INTO nfl_qbr_weekly
  (season,week,team,player_id,name,opponent,qbr_total,pts_added,qb_plays,epa_total,qbr_raw,sack,qualified,fetched_at)
  VALUES (?,?,?,?,?,'OPP',?,0,?,0,?,0,1,datetime('now'))`, season, week, team, id, name, total, plays, total);

// 2022: starter A all season at ~70. 2023: A weeks 1-3, then B (a backup at ~35) from week 4.
for (let w = 1; w <= 17; w++) row(2022, w, 'KC', 'A', 'Starter A', 70 + (w % 3), 35);
for (let w = 1; w <= 3; w++) row(2023, w, 'KC', 'A', 'Starter A', 68, 34);
for (let w = 4; w <= 6; w++) { row(2023, w, 'KC', 'B', 'Backup B', 35, 33); row(2023, w, 'KC', 'A', 'Starter A', 50, 3); }

test('the profile before week 4 is starter A from this season and last, with no change flagged', () => {
  const p = qbr.teamQbrProfile(2023, 4, 'KC');
  assert.equal(p.starter.player_id, 'A');
  assert.equal(p.starter_changed, 0);
  assert.equal(p.starter_starts, 6, 'six most recent starts: three this season, three from last');
  assert.ok(p.starter_qbr > 65 && p.starter_qbr < 72);
  assert.equal(p.this_season_weeks, 3);
});

test('once the backup takes the snaps the profile follows him and flags the change', () => {
  const p = qbr.teamQbrProfile(2023, 5, 'KC');
  assert.equal(p.starter.player_id, 'B', 'most plays in the most recent prior week');
  assert.equal(p.starter_changed, 1);
  assert.equal(p.starter_qbr, 35);
  assert.equal(p.starter_starts, 1);
  const later = qbr.teamQbrProfile(2023, 7, 'KC');
  assert.equal(later.starter_changed, 0, 'B has now started two weeks running');
  assert.equal(later.starter_starts, 3);
  assert.equal(qbr.teamQbrProfile(2023, 1, 'NOPE'), null);
});
