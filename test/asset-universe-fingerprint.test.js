/**
 * The asset-universe cache must change when any input it reads changes.
 *
 * assetUniverse() is memoised on a fingerprint of the tables buildAssetUniverse reads
 * (compute-cache.js: "a hit is provably the same answer"). This branch gave the build
 * new inputs without adding them to the fingerprint:
 *   - the promoted weekly weight set (weekly_ensemble_fits): a promotion or rollback
 *     changes every projection, but a `promoted` flag update changes no row count or
 *     max id, so only the active set's id can key it;
 *   - leagues.payload / fetched_at (espnStatusById: "ESPN wins when fresher");
 *   - nfl_availability_rates / nfl_availability_role_rates (chance to play);
 *   - player_week_snaps (role tiers).
 * With the scheduler off nothing else changes, so the stale answer was served until a
 * restart. contingency.js also held the fitted availability tables for the life of the
 * process, so a refit in another process was never seen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-asset-fingerprint-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '2';

const { db, run, row } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { assetUniverse, tradeWeekContext } = await import('../server/services/trade-engine.js');
const { deriveFormat } = await import('../server/services/format.js');
const { saveWeeklyFit } = await import('../server/services/weekly-weight-store.js');
const contingency = await import('../server/services/contingency.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const payload = { teams: [{ id: 1, name: 'Mine', roster: { entries: [] } }] };
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (61, 'espn', 'fp-61', 2026, 'Fingerprint', '1', 10, 1, ?, '2026-09-18 01:00:00')`, JSON.stringify(payload));
const lg = () => row('SELECT * FROM leagues WHERE id = 61');
const universe = () => assetUniverse(lg(), deriveFormat(lg()).formatKey);
const LEDGER = { sample_size: 0, validation_size: 0, candidate_mae: null, champion_mae: null,
  candidate_spearman: null, champion_spearman: null, coverage_80: null };
const vector = w => Object.fromEntries(['QB', 'RB', 'WR', 'TE'].map(p => [p, w]));

test('no change: the same cached object', () => {
  assert.equal(universe(), universe());
});

test('promoting or rolling back a weekly weight set rebuilds the universe', () => {
  saveWeeklyFit({ ...LEDGER, data_hash: 'fp-a', through_season: 2025, through_week: 18, promoted: true, weights: vector([0.2, 0.4, 0.15, 0.05, 0.2]) });
  const before = universe();
  saveWeeklyFit({ ...LEDGER, data_hash: 'fp-b', through_season: 2025, through_week: 18, promoted: true, weights: vector([1, 0, 0, 0, 0]) });
  const promoted = universe();
  assert.notEqual(promoted, before, 'a new champion must not be served the old universe');
  // A rollback is a flag update: no count, no max id changes.
  run(`UPDATE weekly_ensemble_fits SET promoted = 0 WHERE data_hash LIKE '%:fp-b'`);
  assert.notEqual(universe(), promoted, 'a rollback must not be served the rolled-back universe');
});

test('a league sync (payload / fetched_at) rebuilds the universe', () => {
  const before = universe();
  run(`UPDATE leagues SET fetched_at = '2026-09-18 02:00:00' WHERE id = 61`);
  assert.notEqual(universe(), before);
});

test('an availability refit or a new snap load rebuilds the universe', () => {
  // The fit script creates these tables (contingency.js DDL); production has the first only.
  db.exec(contingency.AVAILABILITY_RATES_DDL);
  let before = universe();
  run(`INSERT INTO nfl_availability_rates (scope, team, report_status, practice_status, p_active, n, raw_rate, shrunk, fitted_at)
       VALUES ('league', '', 'questionable', 'any', 0.8, 100, 0.8, 0, '2026-09-18 03:00:00')`);
  assert.notEqual(universe(), before, 'nfl_availability_rates');
  db.exec(contingency.AVAILABILITY_ROLE_RATES_DDL);
  before = universe();
  run(`INSERT INTO nfl_availability_role_rates (report_status, practice_status, position, tier, gap, p_active, n, raw_rate, config, fitted_at)
       VALUES ('noreport', '*', '*', '*', '*', 0.97, 500, 0.97, '{}', '2026-09-18 03:00:00')`);
  assert.notEqual(universe(), before, 'nfl_availability_role_rates');
  run(`INSERT INTO players (id, name, position) VALUES (9900, 'Snap Player', 'RB')`);
  before = universe();
  run(`INSERT INTO player_week_snaps (player_id, season, week, offense_snaps, offense_pct) VALUES (9900, 2026, 1, 50, 0.8)`);
  assert.notEqual(universe(), before, 'player_week_snaps');
});

test('the fitted availability lookup follows a refit made after the first read', () => {
  const { season, week } = tradeWeekContext();
  db.exec(contingency.AVAILABILITY_RATES_DDL);
  db.exec(contingency.AVAILABILITY_ROLE_RATES_DDL);
  run(`DELETE FROM nfl_availability_rates`);
  run(`DELETE FROM nfl_availability_role_rates`);
  contingency.resetAvailabilityCache();
  run(`INSERT INTO players (id, name, position, gsis_id) VALUES (9901, 'Report Player', 'WR', '00-9901')`);
  run(`INSERT INTO nfl_injuries (season, week, gsis_id, report_status, practice_status) VALUES (?, ?, '00-9901', 'Questionable', 'Limited')`, season, week);
  const first = contingency.weeklyAvailability(season, week).get(9901).active_probability;
  // Another process (scripts/fit-availability.mjs) writes the fitted table.
  run(`INSERT INTO nfl_availability_rates (scope, team, report_status, practice_status, p_active, n, raw_rate, shrunk, fitted_at)
       VALUES ('league', '', 'questionable', 'limited', 0.61, 400, 0.61, 0, '2026-09-18 04:00:00'),
              ('league', '', 'questionable', 'any', 0.7, 900, 0.7, 0, '2026-09-18 04:00:00')`);
  const second = contingency.weeklyAvailability(season, week).get(9901).active_probability;
  assert.notEqual(second, first, `the refit must be read without a restart (${first} -> ${second})`);
  assert.equal(second, 0.61);
});
