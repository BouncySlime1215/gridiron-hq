/**
 * nfl_team_week_features holds 2021-2025 Rams games under both 'LA' and
 * 'LAR'. teamWeeks() must return each Rams game once, keep 'LA' rows that have
 * no 'LAR' twin, and leave every other team untouched.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-rams-dedupe-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';
const { db, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const insert = (season, week, team, epa) => run(
  `INSERT INTO nfl_team_week_features (season, week, team, opponent, home, features) VALUES (?,?,?,?,?,?)`,
  season, week, team, 'SEA', 1, JSON.stringify({ off_epa_per_play: epa }));
insert(2024, 1, 'LAR', 0.1); insert(2024, 1, 'LA', 0.1);
insert(2024, 2, 'LA', 0.2);
insert(2024, 1, 'SEA', -0.1);

const { teamWeeks } = await import('../server/services/nfl-pbp.js');

test('a Rams game stored as both LA and LAR is returned once, as LAR', () => {
  const week1 = teamWeeks(2024).filter(r => r.week === 1 && ['LA', 'LAR'].includes(r.team));
  assert.deepEqual(week1.map(r => r.team), ['LAR']);
});

test('an LA row with no LAR twin is kept', () => {
  assert.equal(teamWeeks(2024).filter(r => r.week === 2 && r.team === 'LA').length, 1);
});

test('other teams are untouched', () => {
  assert.equal(teamWeeks(2024).filter(r => r.team === 'SEA').length, 1);
});
