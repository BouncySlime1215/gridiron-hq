/**
 * The chance-to-play loader must say which model priced the numbers, and must not
 * turn a broken fit table into a quiet downgrade.
 *
 * review-fixes-2, finding 1 (silent-failure-hunter): contingency.js#fittedAvailability
 * caught EVERY read error with a bare catch, so a missing table, a missing column or a
 * locked database all became "no role layer" and every player was priced on the
 * pooled path. Production ran that way from 2026-09-18 00:07 (nfl_availability_rates
 * only; the role table was never written) with no log line, no flag on the asset
 * universe and no note on Start/Sit — healthy starters sat at about 0.81 to play.
 *
 * Rules pinned here:
 *   - a table that does not exist is a named state, not an error: availabilityBasis()
 *     is 'role' | 'pooled' | 'constants', warned once per availabilityFitStamp();
 *   - any other read error (a table from another schema, a missing column) throws;
 *   - assetUniverse().context and lineupCall() carry the basis, so a page can say it.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-availability-loader-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '2';

const { db, run, row } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const contingency = await import('../server/services/contingency.js');
const realTradeEngine = await import('../server/services/trade-engine.js');
const { deriveFormat } = await import('../server/services/format.js');

// lineupCall reads the universe through a mock (the fixture pattern of
// test/lineup-floor-objective.test.js); the real universe is tested above it.
let mockedAssets = new Map();
mock.module('../server/services/trade-engine.js', {
  namedExports: {
    ...realTradeEngine,
    assetUniverse: () => mockedAssets,
    tradeWeekContext: () => ({ season: 2026, week: 2 }),
    lineupDiff: () => ({ error: 'not under test' })
  }
});
const { lineupCall } = await import('../server/services/lineup-brain.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const dropAll = () => {
  db.exec('DROP TABLE IF EXISTS nfl_availability_rates');
  db.exec('DROP TABLE IF EXISTS nfl_availability_role_rates');
  contingency.resetAvailabilityCache();
};
const leagueRate = (p, fittedAt) => run(`INSERT OR REPLACE INTO nfl_availability_rates
  (scope, team, report_status, practice_status, p_active, n, raw_rate, shrunk, fitted_at)
  VALUES ('league', '', 'none', 'any', ?, 1000, ?, 0, ?)`, p, p, fittedAt);
const roleRate = fittedAt => run(`INSERT OR REPLACE INTO nfl_availability_role_rates
  (report_status, practice_status, position, tier, gap, p_active, n, raw_rate, config, fitted_at)
  VALUES ('noreport', '*', '*', '*', '*', 0.95, 800, 0.95, '{"byPosition":false}', ?)`, fittedAt);
const warnings = () => {
  const spy = mock.method(console, 'warn', () => {});
  return {
    about: text => spy.mock.calls.filter(c => String(c.arguments.join(' ')).includes(text)).length,
    restore: () => spy.mock.restore()
  };
};

run(`INSERT INTO players (id, name, position, gsis_id) VALUES (7001, 'Loader Receiver', 'WR', '00-7001')`);

test('no fitted table at all: basis "constants", said once, not per request', () => {
  dropAll();
  const warn = warnings();
  try {
    contingency.weeklyAvailability(2026, 2);
    contingency.weeklyAvailability(2026, 2);
    const basis = contingency.availabilityBasis();
    assert.equal(basis.basis, 'constants');
    assert.deepEqual(basis.missing, ['nfl_availability_rates', 'nfl_availability_role_rates']);
    assert.equal(warn.about('nfl_availability_role_rates'), 1, 'warned exactly once for this fit stamp');
  } finally { warn.restore(); }
});

test('league table without the role table: basis "pooled", warned once per fit stamp', () => {
  dropAll();
  db.exec(contingency.AVAILABILITY_RATES_DDL);
  leagueRate(0.83, '2026-09-18T00:07:01Z');
  const warn = warnings();
  try {
    contingency.weeklyAvailability(2026, 2);
    contingency.weeklyAvailability(2026, 2);
    assert.equal(contingency.availabilityBasis().basis, 'pooled');
    assert.deepEqual(contingency.availabilityBasis().missing, ['nfl_availability_role_rates']);
    assert.equal(warn.about('nfl_availability_role_rates'), 1);
    // A refit of the league table is a new stamp: said again.
    leagueRate(0.84, '2026-09-18T01:00:00Z');
    contingency.weeklyAvailability(2026, 2);
    assert.equal(warn.about('nfl_availability_role_rates'), 2);
  } finally { warn.restore(); }
});

test('both tables: basis "role" and no warning', () => {
  dropAll();
  db.exec(contingency.AVAILABILITY_RATES_DDL);
  db.exec(contingency.AVAILABILITY_ROLE_RATES_DDL);
  leagueRate(0.83, '2026-09-18T00:07:01Z');
  roleRate('2026-09-18T00:07:01Z');
  const warn = warnings();
  try {
    contingency.weeklyAvailability(2026, 2);
    const basis = contingency.availabilityBasis();
    assert.equal(basis.basis, 'role');
    assert.deepEqual(basis.missing, []);
    assert.equal(warn.about('nfl_availability'), 0);
  } finally { warn.restore(); }
});

test('a role table that exists but cannot be read fails loudly instead of pricing everyone on the pooled path', () => {
  dropAll();
  db.exec(contingency.AVAILABILITY_RATES_DDL);
  leagueRate(0.83, '2026-09-18T00:07:01Z');
  // A table from another schema version: no `config` column.
  db.exec(`CREATE TABLE nfl_availability_role_rates (report_status TEXT, practice_status TEXT, position TEXT,
    tier TEXT, gap TEXT, p_active REAL, n INTEGER, raw_rate REAL, fitted_at TEXT)`);
  run(`INSERT INTO nfl_availability_role_rates VALUES ('noreport', '*', '*', '*', '*', 0.95, 800, 0.95, '2026-09-18')`);
  assert.throws(() => contingency.weeklyAvailability(2026, 2), /config/);
});

test('a league table that cannot be read fails loudly, and so does the fit stamp', () => {
  dropAll();
  db.exec(`CREATE TABLE nfl_availability_rates (scope TEXT, team TEXT, p_active REAL)`);
  assert.throws(() => contingency.availabilityFitStamp(), /fitted_at/);
  assert.throws(() => contingency.weeklyAvailability(2026, 2), /fitted_at|report_status/);
  dropAll();
});

test('the asset universe says which availability model priced it', () => {
  dropAll();
  db.exec(contingency.AVAILABILITY_RATES_DDL);
  leagueRate(0.83, '2026-09-18T00:07:01Z');
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
       VALUES (71, 'espn', 'al-71', 2026, 'Loader', '1', 10, 1, ?, '2026-09-18 01:00:00')`,
  JSON.stringify({ teams: [{ id: 1, name: 'Mine', roster: { entries: [] } }] }));
  const lg = row('SELECT * FROM leagues WHERE id = 71');
  const warn = warnings();
  try {
    const universe = realTradeEngine.assetUniverse(lg, deriveFormat(lg).formatKey);
    assert.equal(universe.context.availability_basis?.basis, 'pooled');
    assert.deepEqual(universe.context.availability_basis?.missing, ['nfl_availability_role_rates']);
  } finally { warn.restore(); }
});

test('Start/Sit carries the availability basis of the universe it solved on', () => {
  const basis = { basis: 'pooled', missing: ['nfl_availability_role_rates'], stamp: 'x' };
  mockedAssets = new Map([[1, {
    id: 1, name: 'Solo Quarterback', position: 'QB', team_abbr: 'MID', espn_id: 9101, available: true,
    current_week_ppg: 18, adj_ppg: 18, ppg: 18, ros_ppg: 18, ceiling: 27, floor: 9, active_probability: 0.95, bye: 9
  }]]);
  mockedAssets.context = { season: 2026, week: 2, availability_basis: basis };
  const payload = { teams: [{ id: 1, name: 'Mine', roster: { entries: [{ lineupSlotId: 0,
    playerPoolEntry: { player: { id: 9101, fullName: 'Solo Quarterback', defaultPositionId: 1, injuryStatus: 'ACTIVE' } } }] } }],
  schedule: [] };
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions, payload)
       VALUES (72, 'espn', 'al-72', 2026, 'Loader lineup', '1', 10, 1, ?, ?)`, JSON.stringify(['QB']), JSON.stringify(payload));
  const call = lineupCall(72);
  assert.ok(!call.error, call.error);
  assert.deepEqual(call.availability_basis, basis);
});
