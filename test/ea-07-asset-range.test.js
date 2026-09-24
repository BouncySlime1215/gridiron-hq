/**
 * EA-07 (BROKEN-NUMBERS row C, the trade card): with the one world on, an asset's
 * served floor/ceiling/avg and the lineup total's spread come from the player's
 * pool in this NFL week's world (season-sim.js#worldPoolFor: the same seed address,
 * projection, game script, availability and RL-17-3 scale as the title odds), not
 * from player-week-engine.js#playerWeekDistribution's own cache-key-seeded pool.
 * Off, the served range is exactly the old one.
 *
 * Fixture: test/asset-universe-bye-week-range.test.js's (player-week-engine.js
 * mocked; matchups.js real, so AAA's week-6 bye is a real bye). projections.js's
 * buildProjections is mocked to give the four WRs a last-season shape the world can
 * sample; sampleWeeks is real.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-ea07-asset-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '6';
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
delete process.env.GRIDIRON_ONE_WORLD;

const wrParams = targets => ({
  position: 'WR', attempts: 0, carries: 0, targets, dispersion: 10,
  ypa: 7, pass_td_rate: 0.045, int_rate: 0.025, ypc: 4.2, rush_td_rate: 0.03,
  catch_rate: 0.68, ypt: 8, rec_td_rate: 0.05
});
const WEEK_PROJECTION = { ppg: 20, params: wrParams(8), ensemble_shift: 0, volume: { target_share: 0.2 } };
const WEEK_DIST = { p10: 8, p90: 32, mean: 20, boom_rate: 0.22, bust_rate: 0.11 };
const realWeekEngine = await import('../server/services/player-week-engine.js');
mock.module('../server/services/player-week-engine.js', {
  namedExports: {
    ...realWeekEngine,
    buildPlayerWeekEngine: () => new Map([[901, { ...WEEK_PROJECTION }], [902, { ...WEEK_PROJECTION }]]),
    playerWeekDistribution: () => ({ ...WEEK_DIST })
  }
});
const LAST_SEASON = new Map([
  [901, { ppg: 14, params: wrParams(7), volume: { target_share: 0.18 } }],
  [902, { ppg: 14, params: wrParams(7), volume: { target_share: 0.18 } }]
]);
const realProjections = await import('../server/services/projections.js');
mock.module('../server/services/projections.js', {
  namedExports: { ...realProjections, buildProjections: () => LAST_SEASON }
});

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { assetUniverse, lineupSpread } = await import('../server/services/trade-engine.js');
const { worldPoolFor } = await import('../server/services/season-sim.js');
const { rangeFromPool, ONE_WORLD_ENV } = await import('../server/services/one-world.js');
const { deriveFormat } = await import('../server/services/format.js');
const { scoringFor } = await import('../server/services/scoring.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES
     (1, 'AAA', 'Alpha', 'AFC', 'East'), (2, 'BBB', 'Beta', 'NFC', 'West')`);
for (let w = 1; w <= 14; w++) {
  if (w !== 6) run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 1, ?, 'BBB', 1)`, w);
  run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 2, ?, 'AAA', 0)`, w);
}
run(`INSERT INTO players (id, name, position, team_id) VALUES (901, 'Bye Guy', 'WR', 1)`);
run(`INSERT INTO players (id, name, position, team_id) VALUES (902, 'Plays Guy', 'WR', 2)`);

const lg = () => ({ id: 1, team_count: 10, ppr: 1, best_ball: 0, league_type: null, payload: null });
const universe = () => assetUniverse(lg(), deriveFormat(lg()).formatKey);
const withEnv = (vars, fn) => {
  const prior = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  const set = (key, v) => { if (v == null) delete process.env[key]; else process.env[key] = v; };
  for (const [key, v] of Object.entries(vars)) set(key, v);
  try { return fn(); } finally { for (const [key, v] of Object.entries(prior)) set(key, v); }
};

test('EA-07 off (default): the served range is the week engine\'s, unchanged', () => {
  const plays = universe().get(902);
  assert.equal(plays.floor, WEEK_DIST.p10);
  assert.equal(plays.ceiling, WEEK_DIST.p90);
  assert.equal(plays.range_source, undefined);
});

test('EA-07 RED (row C): on, the card\'s floor/ceiling/avg are the player\'s pool in the one world', () => {
  withEnv({ [ONE_WORLD_ENV]: '1' }, () => {
    const u = universe();
    const plays = u.get(902);
    const pool = worldPoolFor({ ...plays }, 6, { scoring: scoringFor(lg()), proj: LAST_SEASON });
    const range = rangeFromPool(pool, 'WR');
    assert.ok(range.p90 > 0, 'control: a real pool');
    assert.equal(plays.range_source, 'world');
    assert.equal(plays.floor, range.p10);
    assert.equal(plays.ceiling, range.p90);
    assert.equal(plays.avg, range.mean);
    assert.equal(plays.boom, range.boom_rate);
    // The lineup total's spread reads the same pool's moments.
    const spread = lineupSpread({ slots: [{ player: plays }] });
    assert.equal(spread.mean, +range.mean.toFixed(1));
    // A bye stays a known zero.
    const bye = u.get(901);
    assert.equal(bye.floor, 0);
    assert.equal(bye.ceiling, 0);
    assert.equal(bye.range_source, 'bye');
  });
});
