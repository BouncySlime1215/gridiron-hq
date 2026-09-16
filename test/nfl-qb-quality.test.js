/**
 * Tests for `teamStartingQbQuality` -- the starting-QB-quality signal RUNBOOK
 * Sec4.1 adds to the market-correction head after injuries/availability
 * measured no difference.
 *
 * Three properties matter here, mirroring the shape
 * `test/nfl-availability-weighting.test.js` already established for the
 * analogous injury/snap-share signal:
 *
 *   1. The signal reflects THIS TEAM'S CURRENT starter's own history, not
 *      some other player's -- the whole point of matching by name off the
 *      depth chart rather than reading a team-wide average.
 *   2. A genuine rookie, or anyone making his first career start, produces
 *      `qbr: null` / `evidence: false` -- never a fabricated average.
 *   3. It never reads the CURRENT week's own QBR -- that would be reading
 *      the outcome of the very game this feature is meant to help forecast.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-qb-quality-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, run, dbPath } = await import('../server/db/index.js');
assert.equal(dbPath, process.env.GRIDIRON_DB_PATH,
  'this test must never be able to reach the real database');
await (await import('../server/db/migrate.js')).runMigrations();
const { teamStartingQbQuality, clearQbQualityCache } =
  await import('../server/services/nfl-qb-quality.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

function depth(season, week, team, gsisId, playerName, posRank, captured = '2024-09-01T00:00:00Z') {
  run(`INSERT OR REPLACE INTO nfl_depth
       (season, week, team, gsis_id, player_name, pos_abb, pos_rank, pos_slot, captured)
       VALUES (?,?,?,?,?, 'QB', ?, 'QB1', ?)`,
  season, week, team, gsisId, playerName, posRank, captured);
}

function qbr(season, week, team, playerId, name, qbrTotal, qbPlays = 35) {
  run(`INSERT OR REPLACE INTO nfl_qbr_weekly
       (season, week, team, player_id, name, opponent, qbr_total, qb_plays, fetched_at)
       VALUES (?,?,?,?,?, 'OPP', ?, ?, datetime('now'))`,
  season, week, team, playerId, name, qbrTotal, qbPlays);
}

test('the signal reflects the CURRENT starter, not a different player on the same team', () => {
  clearQbQualityCache();
  // KC's week-3 starter is "Star Passer". His own prior weeks were strong.
  // A backup ("Bench Warmer") who also has QBR rows for this team must never
  // be the source of the number.
  depth(2024, 3, 'KC', 'starter-id', 'Star Passer', 1);
  depth(2024, 3, 'KC', 'backup-id', 'Bench Warmer', 2);
  qbr(2024, 1, 'KC', 'espn-starter', 'Star Passer', 80);
  qbr(2024, 2, 'KC', 'espn-starter', 'Star Passer', 90);
  qbr(2024, 1, 'KC', 'espn-backup', 'Bench Warmer', 10);
  qbr(2024, 2, 'KC', 'espn-backup', 'Bench Warmer', 5);

  const result = teamStartingQbQuality(2024, 3, 'KC');
  assert.equal(result.evidence, true);
  assert.equal(result.starter.name, 'Star Passer');
  assert.equal(result.qbr, 85, 'must average the STARTER\'s own two prior weeks (80, 90), not the backup\'s');
});

test('a genuine rookie/no-history starter produces null, not a fabricated average', () => {
  clearQbQualityCache();
  // A depth-chart starter with zero admissible nfl_qbr_weekly rows anywhere
  // -- his first career start.
  depth(2024, 1, 'DET', 'rookie-id', 'Rookie Passer', 1);

  const result = teamStartingQbQuality(2024, 1, 'DET');
  assert.equal(result.evidence, false);
  assert.equal(result.qbr, null, 'a starter with no admissible prior QBR must never get a fabricated average');
  assert.ok(result.starter, 'the starter is still identified even though he has no history');
  assert.equal(result.starter.name, 'Rookie Passer');
});

test('no depth-chart row at all is missing evidence, not a healthy default', () => {
  clearQbQualityCache();
  const result = teamStartingQbQuality(2031, 5, 'ZZZ');
  assert.equal(result.starter, null);
  assert.equal(result.qbr, null);
  assert.equal(result.evidence, false);
});

test('it does not use the CURRENT week\'s own QBR -- that would be reading the outcome being predicted', () => {
  clearQbQualityCache();
  // The only QBR row on file for this starter is the SAME week being
  // forecast, which is information that does not exist until after the
  // game. It must not be used.
  depth(2024, 7, 'PHI', 'future-id', 'Future Starter', 1);
  qbr(2024, 7, 'PHI', 'espn-future', 'Future Starter', 99);
  const withCurrentWeekOnly = teamStartingQbQuality(2024, 7, 'PHI');
  assert.equal(withCurrentWeekOnly.evidence, false,
    'a QBR row from the week being predicted must not count as admissible history');
  assert.equal(withCurrentWeekOnly.qbr, null);

  clearQbQualityCache();
  // Now give him a genuinely earlier week -- the number must appear, and it
  // must be the earlier week's value, not the current week's 99.
  qbr(2024, 6, 'PHI', 'espn-future', 'Future Starter', 60);
  const withPriorWeek = teamStartingQbQuality(2024, 7, 'PHI');
  assert.equal(withPriorWeek.evidence, true);
  assert.equal(withPriorWeek.qbr, 60, 'only the strictly-earlier week may inform this forecast');
});

test('prior-season history is admissible for a week-1 starter (a season already in the past)', () => {
  clearQbQualityCache();
  depth(2025, 1, 'BUF', 'vet-id', 'Veteran Passer', 1);
  qbr(2024, 15, 'BUF', 'espn-vet', 'Veteran Passer', 70);
  qbr(2024, 16, 'BUF', 'espn-vet', 'Veteran Passer', 74);

  const result = teamStartingQbQuality(2025, 1, 'BUF');
  assert.equal(result.evidence, true);
  assert.equal(result.qbr, 72, 'an entire prior season is safely in the past regardless of the new week');
});

test('a token/kneel-down appearance (few plays) is not counted as a qualifying prior start', () => {
  clearQbQualityCache();
  depth(2024, 10, 'DAL', 'starter-id', 'Real Starter', 1);
  // Only a 2-play mop-up appearance on file -- not a real performance.
  qbr(2024, 9, 'DAL', 'espn-real', 'Real Starter', 5, 2);

  const result = teamStartingQbQuality(2024, 10, 'DAL');
  assert.equal(result.evidence, false, 'a sub-threshold play count must not count as a qualifying start');
});

test('a defender-style ambiguous signature abstains rather than attaching the wrong player\'s history', () => {
  clearQbQualityCache();
  // Two different quarterbacks share a first-initial + surname signature
  // ("t tempest") and neither matches the starter's full normalized name
  // exactly -- must abstain, not guess.
  depth(2024, 4, 'NE', 'ambig-id', 'Tom Tempest', 1);
  qbr(2024, 2, 'NE', 'espn-a', 'Tim Tempest', 55);
  qbr(2024, 3, 'CHI', 'espn-b', 'Ted Tempest', 65);

  const result = teamStartingQbQuality(2024, 4, 'NE');
  assert.equal(result.evidence, false, 'an ambiguous signature match must abstain, not pick either candidate');
});

test('the cache separates different team-weeks and is only invalidated by clearQbQualityCache', () => {
  clearQbQualityCache();
  depth(2024, 5, 'SEA', 'p1', 'Player One', 1);
  qbr(2024, 4, 'SEA', 'espn-1', 'Player One', 50);
  depth(2024, 5, 'ARI', 'p2', 'Player Two', 1);
  qbr(2024, 4, 'ARI', 'espn-2', 'Player Two', 88);

  const sea = teamStartingQbQuality(2024, 5, 'SEA');
  const ari = teamStartingQbQuality(2024, 5, 'ARI');
  assert.equal(sea.qbr, 50, 'SEA must not see ARI\'s starter\'s number');
  assert.equal(ari.qbr, 88, 'ARI must not see SEA\'s starter\'s number');

  // Change SEA's underlying prior QBR without clearing the cache: the
  // already-cached answer must be served unchanged.
  run(`UPDATE nfl_qbr_weekly SET qbr_total = 999 WHERE team='SEA' AND player_id='espn-1'`);
  const seaStillCached = teamStartingQbQuality(2024, 5, 'SEA');
  assert.equal(seaStillCached.qbr, 50, 'a cached answer must not silently change underneath the caller');

  clearQbQualityCache();
  const seaAfterClear = teamStartingQbQuality(2024, 5, 'SEA');
  assert.equal(seaAfterClear.qbr, 999, 'clearing the cache must make the fresh underlying value visible');
});
