/**
 * Tests for `availabilityDeficit` -- the injury weighting the production
 * ensemble's `availability` component reads.
 *
 * This function had no direct test: every existing reference to it either
 * mocks it away (`() => new Map()`) or only checks the null-on-no-report case
 * through `availabilityEdge`. So the arithmetic that decides how much a team
 * has actually lost -- whose absence counts, and how much -- was unpinned.
 *
 * Five properties matter here, and each one is a way the feature could be
 * silently wrong rather than loudly broken:
 *
 *   1. It weights by WHO is missing, not how many. A quarterback and a long
 *      snapper are not the same absence.
 *   2. It sees defenders. Snap share is read from offence AND defence; the
 *      query used to select `offense_pct` alone, which sent every defender to
 *      a flat default and made a starting corner indistinguishable from a
 *      fourth safety.
 *   3. Among defenders, it further tells a starter from a replacement-level
 *      player at the SAME position and snap share, using each defender's own
 *      prior-weeks PFR charted production -- and falls back to exactly the
 *      old flat positional weight wherever PFR has nothing (all of 2021-2023,
 *      or any genuinely uncharted player).
 *   4. Under a historical cutoff it admits only rows untouched since before
 *      that instant. `nfl_injuries` keeps no version history, so a row
 *      rewritten after kickoff cannot stand in for the pre-game report.
 *   5. Missing evidence is never a healthy roster.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-availability-weighting-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, run, dbPath } = await import('../server/db/index.js');
assert.equal(dbPath, process.env.GRIDIRON_DB_PATH,
  'this test must never be able to reach the real database');
await (await import('../server/db/migrate.js')).runMigrations();
const { availabilityDeficit, availabilityEdge, clearAvailabilityCache } =
  await import('../server/services/nfl-availability.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const MODIFIED = '2024-09-06T12:00:00Z';

function injury(season, week, team, name, position, status, modifiedAt = MODIFIED) {
  run(`INSERT OR REPLACE INTO nfl_injuries
       (season, week, gsis_id, team, full_name, position, report_status, modified_at)
       VALUES (?,?,?,?,?,?,?,?)`,
  season, week, `${name}-id`, team, name, position, status, modifiedAt);
}

function snaps(season, week, team, name, position, { offense = null, defense = null } = {}) {
  run(`INSERT OR REPLACE INTO nfl_snaps
       (season, week, player, team, position, offense_pct, defense_pct)
       VALUES (?,?,?,?,?,?,?)`,
  season, week, name, team, position, offense, defense);
}

function pfrDef(season, week, team, playerName, statsObj) {
  run(`INSERT OR REPLACE INTO nfl_pfr_adv
       (season, week, player_name, kind, team, opponent, stats)
       VALUES (?,?,?,?,?,?,?)`,
  season, week, playerName, 'def', team, 'OPP', JSON.stringify(statsObj));
}

test('an absence is weighted by who it is, not counted', () => {
  clearAvailabilityCache();
  // Both play every snap of their unit; only the position weight differs.
  snaps(2024, 1, 'KC', 'Star Quarterback', 'QB', { offense: 1.0 });
  snaps(2024, 1, 'KC', 'Long Snapper', 'LS', { offense: 1.0 });
  injury(2024, 2, 'KC', 'Star Quarterback', 'QB', 'Out');
  const qbOnly = availabilityDeficit(2024, 2).get('KC');

  clearAvailabilityCache();
  run(`DELETE FROM nfl_injuries WHERE season=2024 AND week=2`);
  injury(2024, 2, 'KC', 'Long Snapper', 'LS', 'Out');
  const lsOnly = availabilityDeficit(2024, 2).get('KC');

  assert.ok(qbOnly > lsOnly * 10,
    `losing the quarterback (${qbOnly}) must dwarf losing the long snapper (${lsOnly})`);
});

test('a defender is weighted by his real snap share, not a flat default', () => {
  clearAvailabilityCache();
  // Same position, same status, wildly different playing time. Before
  // defense_pct was read, both matched nothing and scored identically.
  snaps(2024, 1, 'SF', 'Starting Corner', 'CB', { defense: 0.95 });
  snaps(2024, 1, 'SF', 'Fourth Corner', 'CB', { defense: 0.05 });
  injury(2024, 2, 'SF', 'Starting Corner', 'CB', 'Out');
  const starter = availabilityDeficit(2024, 2).get('SF');

  clearAvailabilityCache();
  run(`DELETE FROM nfl_injuries WHERE season=2024 AND week=2 AND team='SF'`);
  injury(2024, 2, 'SF', 'Fourth Corner', 'CB', 'Out');
  const backup = availabilityDeficit(2024, 2).get('SF');

  assert.ok(starter > backup,
    `a 95%-snap corner (${starter}) must cost more than a 5% corner (${backup})`);
});

test('a productive charted defender costs more than an unproductive one, same position, snap share and status', () => {
  clearAvailabilityCache();
  // Identical snap share, identical position, identical status -- the only
  // difference is prior-weeks PFR production. Before this weight existed,
  // POSITION_WEIGHT.EDGE alone would have scored these two identically.
  snaps(2024, 1, 'DEN', 'Productive Edge', 'EDGE', { defense: 0.9 });
  snaps(2024, 1, 'DEN', 'Quiet Edge', 'EDGE', { defense: 0.9 });
  pfrDef(2024, 1, 'DEN', 'Productive Edge', { def_pressures: 8, def_sacks: 2, def_tackles_combined: 5, def_missed_tackles: 0 });
  pfrDef(2024, 1, 'DEN', 'Quiet Edge', { def_pressures: 0, def_sacks: 0, def_tackles_combined: 1, def_missed_tackles: 1 });

  injury(2024, 2, 'DEN', 'Productive Edge', 'EDGE', 'Out');
  const productive = availabilityDeficit(2024, 2).get('DEN');

  clearAvailabilityCache();
  run(`DELETE FROM nfl_injuries WHERE season=2024 AND week=2 AND team='DEN'`);
  injury(2024, 2, 'DEN', 'Quiet Edge', 'EDGE', 'Out');
  const quiet = availabilityDeficit(2024, 2).get('DEN');

  assert.ok(productive > quiet,
    `high prior-weeks pressures/sacks (${productive}) must cost more than a quiet prior week (${quiet}), same position and snap share`);
});

test('a defender with no PFR charting (2021-2023, or any uncharted player) falls back to the flat positional weight', () => {
  clearAvailabilityCache();
  // Real PFR def rows only exist from 2024 on; this is a genuine 2022 game
  // with no nfl_pfr_adv rows at all -- the fallback path this exercises, not
  // a theoretical one.
  snaps(2022, 1, 'NYJ', 'Old Era Corner', 'CB', { defense: 0.9 });
  injury(2022, 2, 'NYJ', 'Old Era Corner', 'CB', 'Out');
  const withoutPfr = availabilityDeficit(2022, 2).get('NYJ');

  // Same snap share and status on a position with a different flat weight,
  // matched against exactly what weightFor(position) would compute today.
  const expected = 0.9 * 1.0 * 1.0; // effective share x Out cost x POSITION_WEIGHT.CB
  assert.equal(withoutPfr, expected,
    'with no charted PFR rows for the season, the flat positional weight must be unchanged');

  const coverage = availabilityDeficit(2022, 2);
  assert.equal(coverage.pfrDefenseMatched, 0, 'no defender should have matched PFR production in an uncharted era');
  assert.equal(coverage.pfrDefenseUnmatched, 1, 'the unmatched defender must still be counted');
});

test('status severity is ordered: out costs more than doubtful costs more than questionable', () => {
  const cost = status => {
    clearAvailabilityCache();
    run(`DELETE FROM nfl_injuries WHERE season=2024 AND week=3`);
    snaps(2024, 1, 'BUF', 'Some Receiver', 'WR', { offense: 0.8 });
    injury(2024, 3, 'BUF', 'Some Receiver', 'WR', status);
    return availabilityDeficit(2024, 3).get('BUF');
  };
  assert.ok(cost('Out') > cost('Doubtful'));
  assert.ok(cost('Doubtful') > cost('Questionable'));
});

test('under a historical cutoff, a row rewritten after that instant is refused', () => {
  clearAvailabilityCache();
  run(`DELETE FROM nfl_injuries WHERE season=2024 AND week=4`);
  snaps(2024, 1, 'DAL', 'Revised Player', 'WR', { offense: 0.9 });
  // The stored row says 'Out', but it was last written AFTER the cutoff --
  // whatever it said beforehand is gone, so it cannot be used as if it were
  // the pre-game report.
  injury(2024, 4, 'DAL', 'Revised Player', 'WR', 'Out', '2024-09-30T12:00:00Z');

  const historical = availabilityDeficit(2024, 4, { cutoffAt: '2024-09-29T00:00:00Z' });
  assert.equal(historical.get('DAL'), undefined, 'a later revision must not be back-dated');

  clearAvailabilityCache();
  const live = availabilityDeficit(2024, 4);
  assert.ok(live.get('DAL') > 0, 'with no cutoff, the live caller still sees the current row');
});

test('a row with no modification time is inadmissible under a cutoff', () => {
  // This is every 2025 and 2026 row in the real table.
  clearAvailabilityCache();
  run(`DELETE FROM nfl_injuries WHERE season=2024 AND week=5`);
  snaps(2024, 1, 'MIA', 'Undated Player', 'WR', { offense: 0.9 });
  injury(2024, 5, 'MIA', 'Undated Player', 'WR', 'Out', null);

  const historical = availabilityDeficit(2024, 5, { cutoffAt: '2024-12-01T00:00:00Z' });
  assert.equal(historical.get('MIA'), undefined,
    'an undated row cannot establish what was known before the cutoff');
});

test('the live and historical answers are cached separately', () => {
  clearAvailabilityCache();
  run(`DELETE FROM nfl_injuries WHERE season=2024 AND week=6`);
  snaps(2024, 1, 'GB', 'Cache Player', 'WR', { offense: 0.9 });
  injury(2024, 6, 'GB', 'Cache Player', 'WR', 'Out', '2024-10-20T12:00:00Z');

  // Historical first, then live: a shared cache key would hand the live
  // caller the historical (empty) answer.
  const historical = availabilityDeficit(2024, 6, { cutoffAt: '2024-10-01T00:00:00Z' });
  const live = availabilityDeficit(2024, 6);
  assert.equal(historical.get('GB'), undefined);
  assert.ok(live.get('GB') > 0, 'the live answer must not be served from the historical cache');
});

test('snap shares come from strictly earlier weeks', () => {
  clearAvailabilityCache();
  run(`DELETE FROM nfl_injuries WHERE season=2024 AND week=7`);
  run(`DELETE FROM nfl_snaps WHERE season=2024 AND player='Future Player'`);
  // The only snaps this player has are in the week being predicted, which is
  // information that does not exist until after the game.
  snaps(2024, 7, 'PHI', 'Future Player', 'WR', { offense: 1.0 });
  injury(2024, 7, 'PHI', 'Future Player', 'WR', 'Out');
  const withFutureOnly = availabilityDeficit(2024, 7).get('PHI');

  clearAvailabilityCache();
  snaps(2024, 6, 'PHI', 'Future Player', 'WR', { offense: 1.0 });
  const withPriorWeek = availabilityDeficit(2024, 7).get('PHI');

  assert.ok(withPriorWeek > withFutureOnly,
    'week-7 snaps must not inform a week-7 forecast; only the earlier week may');
});

test('no injury report at all is missing evidence, not a healthy roster', () => {
  clearAvailabilityCache();
  assert.equal(availabilityDeficit(2031, 5).size, 0);
  assert.equal(availabilityEdge(2031, 5, 'PHI', 'WAS'), null,
    'an absent report must abstain, never report a zero edge');
});
