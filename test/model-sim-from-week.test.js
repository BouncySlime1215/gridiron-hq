/**
 * The simulator routes start from the league's real week.
 *
 * `GET /api/model/:leagueId/simulate` and `POST /api/model/:leagueId/trade-impact` both
 * defaulted `from_week` to 1, and no UI caller passes it — MyTeam.tsx requests
 * `?runs=N` only. (Model.tsx was the other caller and has since been deleted,
 * unrouted and unimported; MyTeam.tsx is the live one, and still sends no week.) `simulateSeason` carries in a real record
 * only when fromWeek > 1 (its `initialRecords`), so every playoff and title number on
 * screen was simulated with the standings thrown away.
 *
 * `league-week.js` says it in its own header: "Never a hard-coded 1 — that is how the
 * app spent two weeks showing week-1 lineups (2026-09-17)". Migration 056 exists to
 * make the real week available. These routes defaulted to 1 anyway.
 *
 * Measured on league 5 before the change, paired on one seed, from_week 1 against 2:
 * playoff odds moved 9.5 points on average and 15.3 at most across ten teams, from
 * discarding a single played week. This test pins the behaviour, not that number.
 *
 * The simulator itself is mocked. What is under test is which week the routes ask for,
 * and running a real simulation would be slow and would test something else.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { Readable, PassThrough } from 'node:stream';
import { ServerResponse } from 'node:http';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-simweek-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
await runMigrations();

const realSim = await import('../server/services/season-sim.js');
/** Every call the routes make into the simulator, so the week asked for is inspectable. */
const calls = [];
mock.module('../server/services/season-sim.js', {
  namedExports: {
    ...realSim,
    simulateSeason: (_lg, opts) => { calls.push({ fn: 'simulateSeason', ...opts }); return { teams: [] }; },
    tradeImpact: (_lg, opts) => { calls.push({ fn: 'tradeImpact', ...opts }); return { ok: true }; }
  }
});

run(`INSERT INTO users (subject) VALUES ('sim:viewer')`);
const userId = row(`SELECT id FROM users WHERE subject='sim:viewer'`).id;
run(`INSERT INTO auth_sessions (user_id,token_hash,expires_at) VALUES (?,?,datetime('now','+1 day'))`,
  userId, hashSessionToken('sim-token'));

/**
 * A synced league sitting in week 6. The payload carries `status.currentMatchupPeriod`
 * as well, so the column and the payload agree except where a test makes them differ.
 */
const PAYLOAD = JSON.stringify({
  status: { currentMatchupPeriod: 6 },
  settings: { scheduleSettings: { matchupPeriodCount: 14, playoffTeamCount: 6 } },
  schedule: []
});

/** The routes are behind league membership, so every fixture league needs one. */
function joinLeague(id) {
  run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (?, ?, 'member')`, id, userId);
}

function insertLeague({ id, currentWeek }) {
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, payload, current_week)
       VALUES (?, 'espn', ?, 2026, ?, '1', ?, ?)`,
    id, `L${id}`, `League ${id}`, PAYLOAD, currentWeek);
  joinLeague(id);
}

const { default: modelRouter } = await import('../server/routes/model.js');
const app = express();
app.use(express.json());
app.use('/api/model', modelRouter);
app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message }));

function request(url, { method = 'GET', body } = {}) {
  const encoded = body === undefined ? '' : JSON.stringify(body);
  const headers = { authorization: 'Bearer sim-token' };
  if (encoded) { headers['content-type'] = 'application/json'; headers['content-length'] = String(Buffer.byteLength(encoded)); }
  const req = new Readable({ read() { this.push(encoded || null); if (encoded) this.push(null); } });
  req.url = `/api/model${url}`; req.method = method; req.headers = headers;
  req.socket = new PassThrough(); req.connection = req.socket;
  const res = new ServerResponse(req);
  let payload = '';
  res.write = chunk => { payload += chunk; return true; };
  return new Promise((resolve, reject) => {
    res.end = chunk => { if (chunk) payload += chunk; resolve({ status: res.statusCode, payload }); return res; };
    app(req, res, err => (err ? reject(err) : resolve({ status: res.statusCode, payload })));
  });
}

test('GET /simulate defaults to the league\'s current week, not 1', async () => {
  insertLeague({ id: 101, currentWeek: 6 });
  calls.length = 0;
  const { status } = await request('/101/simulate?runs=10');
  assert.equal(status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, 'simulateSeason');
  assert.equal(calls[0].fromWeek, 6, 'the route must ask for the real week');
  assert.notEqual(calls[0].fromWeek, 1, 'defaulting to 1 discards the standings');
});

test('an explicit from_week still wins, so a deliberate from-scratch run is unaffected', async () => {
  insertLeague({ id: 102, currentWeek: 6 });
  calls.length = 0;
  await request('/102/simulate?runs=10&from_week=1');
  assert.equal(calls[0].fromWeek, 1);
  calls.length = 0;
  await request('/102/simulate?runs=10&from_week=9');
  assert.equal(calls[0].fromWeek, 9);
});

test('the cache key follows the resolved week, so two leagues cannot share a result', async () => {
  // The key used to interpolate `req.query.from_week ?? 1`, which is the same string
  // for every league when nobody passes it. With the default resolved per league, the
  // keys differ, and the second league must get its own simulation rather than the
  // first league's memoised one.
  insertLeague({ id: 103, currentWeek: 4 });
  insertLeague({ id: 104, currentWeek: 11 });
  calls.length = 0;
  await request('/103/simulate?runs=10');
  await request('/104/simulate?runs=10');
  assert.equal(calls.length, 2, 'the second league must not be served the first one\'s cache entry');
  assert.deepEqual(calls.map(c => c.fromWeek), [4, 11]);
});

test('POST /trade-impact defaults to the current week too', async () => {
  // A trade is judged on the title-odds difference it makes, so evaluating it from
  // week 1 asks what the deal would be worth to a team with no record.
  insertLeague({ id: 105, currentWeek: 8 });
  calls.length = 0;
  const { status } = await request('/105/trade-impact', {
    method: 'POST', body: { their_team_id: '2', i_give: [], i_get: [] }
  });
  assert.equal(status, 200);
  assert.equal(calls[0].fn, 'tradeImpact');
  assert.equal(calls[0].fromWeek, 8);
});

test('trade-impact honours an explicit from_week', async () => {
  insertLeague({ id: 106, currentWeek: 8 });
  calls.length = 0;
  await request('/106/trade-impact', {
    method: 'POST', body: { their_team_id: '2', from_week: 2 }
  });
  assert.equal(calls[0].fromWeek, 2);
});

test('a league with no current_week column falls back to the payload, still not 1', async () => {
  // Leagues synced before migration 056 have no column. `leagueCurrentWeek` reads
  // status.currentMatchupPeriod next, which this payload sets to 6.
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, payload)
       VALUES (107, 'espn', 'L107', 2026, 'League 107', '1', ?)`, PAYLOAD);
  joinLeague(107);
  calls.length = 0;
  await request('/107/simulate?runs=10');
  assert.equal(calls[0].fromWeek, 6);
});

test('week 1 is still week 1 when that is genuinely where the league is', async () => {
  // The fix must not push a preseason league forward. Carrying in standings that do
  // not exist would be its own defect.
  insertLeague({ id: 108, currentWeek: 1 });
  calls.length = 0;
  await request('/108/simulate?runs=10');
  assert.equal(calls[0].fromWeek, 1);
});
