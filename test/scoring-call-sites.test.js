/**
 * A-03: every production caller of scoringFor hands the league's own weights,
 * with ESPN stat id 24 read as rushing yards and 42 as receiving yards, to the
 * model it drives.
 *
 * The unit tests in test/scoring.test.js prove scoringFor itself. They cannot
 * catch a call site that rebuilds, swaps or overrides the weights on the way
 * in, and a skeptic showed that such a mutant at routes/model.js:431 (and a
 * `{ slot: 16 }` mutant at trade-engine.js:296) survived every existing suite.
 * So the fixture league pays 0.2 per rushing yard (id 24) and 0.1 per
 * receiving yard (id 42) — different on purpose — and each test captures the
 * `scoring` argument where it reaches buildProjections, simulateSeason,
 * tradeImpact or buildPlayerWeekEngine.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-scoring-call-sites-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const realProjections = await import('../server/services/projections.js');
const realWeekEngine = await import('../server/services/player-week-engine.js');

/** Every `scoring` argument, tagged with the function that received it. */
const seen = [];
const STOP = new Error('captured: stop here');

// `namedExports`, NOT `exports` (see test/ceiling-lineup-recency.test.js:84).
mock.module('../server/services/projections.js', {
  namedExports: {
    ...realProjections,
    buildProjections: (args = {}) => { seen.push({ at: 'buildProjections', scoring: args.scoring }); return new Map(); }
  }
});
// season-sim.js is mocked whole, not spread from the real module: importing it
// first would load trade-engine.js (season-sim.js:27) before the week-engine
// mock below exists, and trade-engine would then keep the real engine.
mock.module('../server/services/season-sim.js', {
  namedExports: {
    __test: {},
    simulateSeason: (_lg, opts = {}) => { seen.push({ at: 'simulateSeason', scoring: opts.scoring }); return { teams: [] }; },
    // model.js also imports simStartWeek (B-01, #162); the start week is not
    // what this file checks, so an explicit week wins and the default is 1.
    simStartWeek: (_lg, requested = null) => (Number.isInteger(Number(requested)) && Number(requested) >= 1 ? Number(requested) : 1),
    tradeImpact: (_lg, opts = {}) => { seen.push({ at: 'tradeImpact', scoring: opts.scoring }); return { ok: true }; },
    // model.js also imports the trade-impact default run count (RL-6-3); its value is
    // not what this file checks. Same number as season-sim.js (SENSE_CHECK_SIM_RUNS).
    TRADE_IMPACT_RUNS: 1200,
    // EA-07 (league-world.js, trade-engine.js) imports these; the one world is off here.
    worldPoolFor: () => null, rosBasisFlag: () => ({ on: false, preview: false }),
    tradeImpactWorld: () => ({ fail: { error: 'mocked' } })
  }
});
mock.module('../server/services/player-week-engine.js', {
  namedExports: {
    ...realWeekEngine,
    buildPlayerWeekEngine: (args = {}) => { seen.push({ at: 'buildPlayerWeekEngine', scoring: args.scoring }); throw STOP; }
  }
});

const { default: modelRouter } = await import('../server/routes/model.js');
const { assetUniverse } = await import('../server/services/trade-engine.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api/model', modelRouter);
app.use((err, req, res, next) => res.status(err.status ?? 500).json({ error: err.message }));
const server = app.listen(0);
const { port } = server.address();
const base = `http://127.0.0.1:${port}/api/model`;

test.after(() => {
  server.close();
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

// ESPN scoringItems shape. 24 (rushing yards) pays 0.2, 42 (receiving yards)
// pays 0.1; 25 (rushing TD) pays 6, 43 (receiving TD) pays 4. A caller that
// swaps rushing and receiving produces rush_yd 0.1 / rec_yd 0.2.
const scoringItems = [
  { statId: 3, points: 0.04 }, { statId: 4, points: 4 }, { statId: 20, points: -2 },
  { statId: 24, points: 0.2 }, { statId: 25, points: 6 },
  { statId: 42, points: 0.1 }, { statId: 43, points: 4 },
  { statId: 72, points: -2 },
  // A D/ST item whose real value lives only in pointsOverrides['16']. A caller
  // that passes { slot: 16 } for a skill-player model is wrong, and this
  // makes it visible on rec (0.5 in slot 16 vs 1 at base).
  { statId: 99, points: 0, pointsOverrides: { 16: 1 } },
  { statId: 53, points: 1, pointsOverrides: { 16: 0.5 } }
];
const payload = { settings: { scoringSettings: { scoringItems } }, teams: [] };
run(`INSERT INTO leagues (platform, league_id, season, name, ppr, payload, roster_positions)
     VALUES ('espn','call-site-league',2026,'Call Site League',1,?,?)`,
  JSON.stringify(payload), JSON.stringify(['QB', 'RB', 'WR', 'TE']));
const lg = row(`SELECT * FROM leagues WHERE league_id = 'call-site-league'`);

const token = 'scoring-call-site-token';
run('INSERT INTO users (subject, display_name) VALUES (?,?)', 'call-site-tester', 'Call Site Tester');
const userId = row('SELECT last_insert_rowid() AS id').id;
run('INSERT INTO league_memberships (league_id, user_id, role) VALUES (?,?,?)', lg.id, userId, 'commissioner');
run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?,?,datetime('now','+1 day'))`,
  userId, hashSessionToken(token));
const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

function assertLeagueWeights(at) {
  const hit = seen.filter(s => s.at === at).at(-1);
  assert.ok(hit, `${at} was never called, so the call site was not exercised`);
  assert.equal(hit.scoring.rush_yd, 0.2, `${at}: rush_yd must come from ESPN id 24`);
  assert.equal(hit.scoring.rec_yd, 0.1, `${at}: rec_yd must come from ESPN id 42`);
  assert.equal(hit.scoring.rush_td, 6, `${at}: rush_td must come from ESPN id 25`);
  assert.equal(hit.scoring.rec_td, 4, `${at}: rec_td must come from ESPN id 43`);
  assert.equal(hit.scoring.rec, 1, `${at}: skill-player weights are the base values, not the D/ST slot's`);
}

test('GET /api/model/projections (routes/model.js:431) hands buildProjections the league weights', async () => {
  const res = await fetch(`${base}/projections?league_id=${lg.id}`, { headers: auth });
  assert.equal(res.status, 200, await res.clone().text());
  assertLeagueWeights('buildProjections');
});

test('GET /api/model/:leagueId/simulate (routes/model.js:458) hands simulateSeason the league weights', async () => {
  const res = await fetch(`${base}/${lg.id}/simulate?runs=10&seed=1`, { headers: auth });
  assert.equal(res.status, 200, await res.clone().text());
  assertLeagueWeights('simulateSeason');
});

test('POST /api/model/:leagueId/trade-impact (routes/model.js:477) hands tradeImpact the league weights', async () => {
  const res = await fetch(`${base}/${lg.id}/trade-impact`, {
    method: 'POST', headers: auth, body: JSON.stringify({ their_team_id: 2, runs: 10, seed: 1 })
  });
  assert.equal(res.status, 200, await res.clone().text());
  assertLeagueWeights('tradeImpact');
});

test('assetUniverse (trade-engine.js:296) hands buildPlayerWeekEngine the league weights', () => {
  assert.throws(() => assetUniverse(lg, 'rd_1qb_ppr1', { season: 2026, week: 3 }), e => e === STOP);
  assertLeagueWeights('buildPlayerWeekEngine');
});
