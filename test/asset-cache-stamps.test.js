/**
 * The asset-universe / findTrades cache must see in-place updates to what it serves.
 *
 * review-fixes-2, finding 5 (silent-failure-hunter): ASSET_INPUT_TABLES stamped
 * nfl_injuries on a column that does not exist ('id'), and compute-cache.js swallowed
 * the SQL error, so the stamp silently degraded to a row count. syncInjuries updates a
 * status in place (ON CONFLICT DO UPDATE: same row count, same rowid, and 2026 rows
 * carry no modified_at), so a Friday Questionable -> Out never invalidated the cached
 * active_probability. Proven on a production copy: fingerprint identical before and
 * after, Zay Flowers still served at 0.658. The MAX(week) stamps on player_week_usage
 * and player_week_snaps (always 18) and game_lines (always 22) are constant for the
 * same reason: an in-place stat correction or line move is never seen.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-asset-stamps-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '2';

const { db, run, row } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const te = await import('../server/services/trade-engine.js');
const { fingerprint } = await import('../server/services/compute-cache.js');
const { deriveFormat } = await import('../server/services/format.js');
const contingency = await import('../server/services/contingency.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// The fit script creates these (contingency.js DDL); the stamp check covers them too.
db.exec(contingency.AVAILABILITY_RATES_DDL);
db.exec(contingency.AVAILABILITY_ROLE_RATES_DDL);

run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (81, 'espn', 'st-81', 2026, 'Stamps', '1', 10, 1, ?, '2026-09-18 01:00:00')`,
JSON.stringify({ teams: [{ id: 1, name: 'Mine', roster: { entries: [] } }] }));
const lg = () => row('SELECT * FROM leagues WHERE id = 81');
const universe = () => te.assetUniverse(lg(), deriveFormat(lg()).formatKey);
const { season, week } = te.tradeWeekContext();

run(`INSERT INTO players (id, name, position, gsis_id) VALUES (8101, 'Stamp Receiver', 'WR', '00-8101')`);
run(`INSERT INTO player_week_usage (player_id, season, week, team, position, targets, receptions, receiving_yards)
     VALUES (8101, ?, 1, 'AAA', 'WR', 8, 6, 80)`, season);
run(`INSERT INTO nfl_injuries (season, week, gsis_id, team, full_name, position, report_status, practice_status, injury)
     VALUES (?, ?, '00-8101', 'AAA', 'Stamp Receiver', 'WR', 'Questionable', 'Limited Participation in Practice', 'Hamstring')`,
season, week);
run(`INSERT INTO game_lines (season, week, team, opponent, home, spread, total, source, fetched_at)
     VALUES (?, ?, 'AAA', 'BBB', 1, -3, 44, 'espn', '2026-09-18 01:00:00')`, season, week);

test('every asset-input stamp names a real column on the migrated schema', () => {
  assert.ok(Array.isArray(te.ASSET_INPUT_TABLES), 'ASSET_INPUT_TABLES is exported for this check');
  const broken = [];
  for (const t of te.ASSET_INPUT_TABLES) {
    if (typeof t === 'string' || !t.stamp) continue;
    try { row(`SELECT MAX(${t.stamp}) AS m FROM ${t.table}`); } catch (error) { broken.push(`${t.table}.${t.stamp}: ${error.message}`); }
  }
  assert.deepEqual(broken, []);
});

test('an injury status changed in place for the served week rebuilds the universe', () => {
  const before = universe();
  const p0 = before.get(8101).active_probability;
  // syncInjuries' upsert: same row, same count, modified_at stays blank.
  run(`UPDATE nfl_injuries SET report_status = 'Out' WHERE season = ? AND week = ? AND gsis_id = '00-8101'`, season, week);
  const after = universe();
  assert.notEqual(after, before, 'Questionable -> Out must not be served from the cache');
  assert.ok(after.get(8101).active_probability < p0, `${p0} -> ${after.get(8101).active_probability}`);
});

test('a stat correction made in place for the served season rebuilds the universe', () => {
  const before = universe();
  run(`UPDATE player_week_usage SET receiving_yards = receiving_yards + 7 WHERE player_id = 8101 AND season = ? AND week = 1`, season);
  assert.notEqual(universe(), before);
});

test('a line moved in place rebuilds the universe', () => {
  const before = universe();
  // gamescript.js ESPN upsert: same row, new spread and fetched_at.
  run(`UPDATE game_lines SET spread = -6.5, fetched_at = '2026-09-18 02:00:00' WHERE season = ? AND week = ? AND team = 'AAA'`, season, week);
  assert.notEqual(universe(), before);
});

test('a stamp that does not resolve is reported once, not silently reduced to a row count', () => {
  const spy = mock.method(console, 'error', () => {});
  try {
    const first = fingerprint([{ table: 'players', stamp: 'no_such_column' }]);
    fingerprint([{ table: 'players', stamp: 'no_such_column' }]);
    const said = spy.mock.calls.filter(c => String(c.arguments.join(' ')).includes('players.no_such_column'));
    assert.equal(said.length, 1, 'reported once per table and stamp');
    assert.match(first, /players:\d+:stamp-error/);
    // A table that does not exist is still a named, quiet state.
    assert.equal(fingerprint(['no_such_table_here']), 'no_such_table_here:absent');
    assert.equal(spy.mock.calls.filter(c => String(c.arguments.join(' ')).includes('no_such_table_here')).length, 0);
  } finally { spy.mock.restore(); }
});
