import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Same isolated-DB pattern used across this suite: point GRIDIRON_DB_PATH at a
// throwaway file before anything imports server/db/index.js.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-football-context-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { availabilityPicture } = await import('../server/services/football-context.js');

await runMigrations();

after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

function addPlayer(name, position) {
  return db.prepare(`INSERT INTO players (name, position, fantasy_relevant) VALUES (?, ?, 1)`)
    .run(name, position).lastInsertRowid;
}
function addUsage(playerId, season, week, team) {
  db.prepare(`INSERT INTO player_week_usage (player_id, season, week, team, position, targets, carries)
    VALUES (?, ?, ?, ?, 'WR', 6, 0)`).run(playerId, season, week, team);
}

test('availabilityPicture: an empty nfl_injuries table is a data gap, not "healthy"', () => {
  const pid = addPlayer('Test Receiver A', 'WR');
  addUsage(pid, 2024, 5, 'DET');

  // nfl_injuries has zero rows anywhere — the exact shape of an unloaded feed
  // (or an offline rig with no injury data at all), not a team with no injuries.
  const result = availabilityPicture('DET', 2024, 8);

  assert.equal(result.injury_data_available, false);
  assert.match(result.reading, /data gap/i);
  assert.doesNotMatch(result.reading, /close to healthy/i);
});

test('availabilityPicture: injury rows for a different team do not mark this team\'s data available', () => {
  const pid = addPlayer('Test Receiver B', 'WR');
  addUsage(pid, 2024, 5, 'DET');
  db.prepare(`INSERT INTO nfl_injuries (season, week, gsis_id, team, full_name, position, report_status, practice_status, injury)
    VALUES (2024, 7, 'other-team-player', 'GB', 'Someone Else', 'WR', 'Questionable', 'Limited', 'ankle')`).run();

  const result = availabilityPicture('DET', 2024, 8);

  assert.equal(result.injury_data_available, false);
  assert.match(result.reading, /data gap/i);
});

test('availabilityPicture: injury rows for this team/season mean zero-flagged reads as genuinely healthy', () => {
  const pid = addPlayer('Test Receiver C', 'WR');
  addUsage(pid, 2024, 5, 'DET');
  // The feed has been loaded for DET this season (a different week's report),
  // even though the target week itself has nobody flagged.
  db.prepare(`INSERT INTO nfl_injuries (season, week, gsis_id, team, full_name, position, report_status, practice_status, injury)
    VALUES (2024, 3, 'det-other-player', 'DET', 'Someone Healthy Now', 'WR', 'Probable', 'Full', 'knee')`).run();

  const result = availabilityPicture('DET', 2024, 8);

  assert.equal(result.injury_data_available, true);
  assert.match(result.reading, /close to healthy/i);
});
