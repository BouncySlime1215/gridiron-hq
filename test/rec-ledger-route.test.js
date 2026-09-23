/**
 * The recommendation ledger at its call sites, and its reader.
 *
 * Call sites: GET /api/trades/:leagueId/{find,offer,offer-many,lineup,waivers}
 * each add one `recordRoute(...)` call and must return exactly what they
 * returned before. Reader: GET /api/grades/:leagueId/ledger, the route that
 * makes the table reach something (counts per kind, graded share).
 *
 * WHAT IS REAL AND WHAT IS NOT. The routes, the ledger, the migration and the
 * reader are real. The engines are stubbed (findTrades, offerFor, offerForMany,
 * lineupCall, waiverBoard) and return fixtures in their own field names
 * (trade-engine.js:1719-1722 `deals.push`, :2351 offerFor, :2491 offerForMany;
 * lineup-brain.js lineupCall `lineup[].player/over`; waiver-wire.js
 * waiverBoard `immediate[]` / `stashes[]`), because a league valuation is not under test.
 *
 * Every name below is made up. No league, manager or player in it is real.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-rec-ledger-route-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { hashSessionToken } = await import('../server/platform/auth.js');
const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');

const P = (id, name) => ({ id, name, position: 'RB', value: 10 });
const context = { season: 2026, week: 4 };
const FIND = {
  mode: 'league', me: { roster_id: '1', owner: 'Owner Me' }, considered: 40, context,
  deals: [
    { partner: 'Owner Two', partner_id: '2', i_give: [P(301, 'Give One')], i_get: [P(302, 'Get One')],
      me: { ppg_delta: 1.1 }, horizon: { value: 0.9 }, score_signed: 2.2 },
    { partner: 'Owner Three', partner_id: '3', i_give: [P(303, 'Give Two')], i_get: [P(304, 'Get Two')],
      me: { ppg_delta: 0.7 }, horizon: { value: 0.5 }, score_signed: 1.4 },
  ],
  edge_removed: 0,
};
const OFFER = {
  target: P(305, 'Target One'), owner_id: '4', context,
  offers: [
    { i_give: [P(306, 'Offer A')], me: { ppg_delta: 0.4 }, horizon: { value: 0.3 }, rank: 1 },
    { i_give: [P(307, 'Offer B'), P(308, 'Offer C')], me: { ppg_delta: 0.6 }, horizon: { value: 0.5 }, rank: 2 },
  ],
};
const OFFER_MANY = {
  mode: 'targets', context, me: { roster_id: '1' },
  ladders: [
    { targets: [P(309, 'Target Two')], owner_id: '5',
      offers: [{ i_give: [P(310, 'Offer D')], me: { ppg_delta: 0.2 }, horizon: { value: 0.2 }, rank: 1 }] },
    { targets: [P(311, 'Target Three')], owner_id: '6', error: 'marked never trades' },
  ],
};
const LINEUP = {
  season: 2026, week: 4, objective: 'mean',
  lineup: [
    { slot: 'RB', player: { id: 312, name: 'Start One', week_points: 14 },
      over: { id: 313, name: 'Bench One', week_points: 12 } },
    { slot: 'QB', player: { id: 314, name: 'Start Two', week_points: 20 }, over: null },
  ],
};
const WAIVERS = {
  season: 2026, week: 4, roster_id: '1',
  immediate: [
    { player: 'Wire One', player_id: 315, projected_ppg: 9, upgrade: 2.5,
      drop_candidate: { player: 'Cut One', player_id: 316, ppg: 3 } },
  ],
  stashes: [
    { player: 'Stash One', player_id: 317, projected_ppg: 0, ros_ppg: 8, upgrade: 0, ros_upgrade: 1.2,
      drop_candidate: null, ros_drop_candidate: { player: 'Cut Two', player_id: 318, ros_ppg: 4 } },
  ],
};

const realEngine = await import('../server/services/trade-engine.js');
mock.module('../server/services/trade-engine.js', {
  namedExports: {
    ...realEngine,
    findTrades: () => structuredClone(FIND),
    offerFor: () => structuredClone(OFFER),
    offerForMany: () => structuredClone(OFFER_MANY),
  },
});
const realBrain = await import('../server/services/lineup-brain.js');
mock.module('../server/services/lineup-brain.js', {
  namedExports: { ...realBrain, lineupCall: () => structuredClone(LINEUP) },
});
const realWire = await import('../server/services/waiver-wire.js');
mock.module('../server/services/waiver-wire.js', {
  namedExports: { ...realWire, waiverBoard: () => structuredClone(WAIVERS) },
});

const { default: tradesRouter } = await import('../server/routes/trades.js');
const { default: gradesRouter } = await import('../server/routes/grades.js');

run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (8811, 'ledger-route-user', 'Reader')`);
run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at)
     VALUES (8811, ?, datetime('now','+1 day'))`, hashSessionToken('ledger-token'));
run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (8812, 'ledger-outsider', 'Outsider')`);
run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at)
     VALUES (8812, ?, datetime('now','+1 day'))`, hashSessionToken('outsider-token'));
for (const id of [71, 72]) {
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id)
       VALUES (?, 'espn', ?, 2026, ?, ?, 6, '1')`, id, `espn-ledger-${id}`, `L${id}`,
  JSON.stringify({ teams: [], members: [] }));
  run(`INSERT OR IGNORE INTO league_memberships(league_id, user_id, role) VALUES (?, 8811, 'member')`, id);
}

const app = express();
app.use(express.json());
app.use('/api/trades', ...legacyAuthenticated, tradesRouter);
app.use('/api/grades', ...legacyAuthenticated, gradesRouter);
const server = app.listen(0);
const port = server.address().port;
test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const get = async (url, token = 'ledger-token') => {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  return { status: res.status, body: isJson ? JSON.parse(text) : null, text };
};
const ledgerRows = (leagueId, kind) => rows(
  `SELECT kind, disposition, season, week, horizon, predicted_json, baseline_call_json
   FROM rec_ledger WHERE league_id = ? AND kind = ? ORDER BY id`, leagueId, kind);

test('GET /find records each shown deal at +2 and +5 weeks and returns the engine output unchanged', async () => {
  const res = await get('/api/trades/71/find?team_id=1');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, FIND);
  const r = ledgerRows(71, 'trade');
  assert.equal(r.length, 4);
  assert.deepEqual(r.map(x => x.horizon), [2, 5, 2, 5]);
  assert.ok(r.every(x => x.disposition === 'shown' && x.season === 2026 && x.week === 4));
  const p = JSON.parse(r[0].predicted_json);
  assert.deepEqual(p.give.map(x => x.id), [301]);
  assert.deepEqual(p.get.map(x => x.id), [302]);
  assert.equal(p.source, 'find');
  assert.equal(JSON.parse(r[0].baseline_call_json).call, 'no_trade');
});

test('a refresh of /find adds no row', async () => {
  await get('/api/trades/71/find?team_id=1');
  assert.equal(ledgerRows(71, 'trade').length, 4);
});

test('GET /offer records each rung as a trade for the target', async () => {
  const res = await get('/api/trades/72/offer?team_id=1&player_id=305');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, OFFER);
  const r = ledgerRows(72, 'trade');
  assert.equal(r.length, 4);
  const p = JSON.parse(r[2].predicted_json);
  assert.deepEqual(p.give.map(x => x.id), [307, 308]);
  assert.deepEqual(p.get.map(x => x.id), [305]);
  assert.equal(p.source, 'offer');
});

test('GET /offer-many records each ladder rung, and skips a ladder that returned an error', async () => {
  const res = await get('/api/trades/72/offer-many?team_id=1&player_ids=309,311');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, OFFER_MANY);
  const r = ledgerRows(72, 'trade').filter(x => JSON.parse(x.predicted_json).source === 'offer-many');
  assert.equal(r.length, 2);
  assert.deepEqual(JSON.parse(r[0].predicted_json).get.map(x => x.id), [309]);
});

test('GET /lineup records the lineup once at +1 week, with the benched alternative as the baseline', async () => {
  const res = await get('/api/trades/71/lineup?team_id=1');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, LINEUP);
  const r = ledgerRows(71, 'lineup');
  assert.equal(r.length, 1);
  assert.equal(r[0].horizon, 1);
  assert.deepEqual(JSON.parse(r[0].predicted_json).starters.map(s => s.id), [312, 314]);
  assert.deepEqual(JSON.parse(r[0].baseline_call_json).alternatives, [{ slot: 'RB', id: 313, week_points: 12 }]);
});

test('GET /waivers records each immediate claim and each stash, each with its own drop', async () => {
  const res = await get('/api/trades/71/waivers?team_id=1');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, WAIVERS);
  const r = ledgerRows(71, 'waiver');
  assert.equal(r.length, 4);
  const p = JSON.parse(r[0].predicted_json);
  assert.equal(p.claim_type, 'immediate');
  assert.equal(p.add.id, 315);
  assert.equal(p.drop.id, 316);
  const st = JSON.parse(r[2].predicted_json);
  assert.equal(st.claim_type, 'stash');
  assert.equal(st.add.id, 317);
  assert.equal(st.drop.id, 318);
});

test('GET /api/grades/:leagueId/ledger counts rows per kind and the graded share', async () => {
  // Known-nonzero control first: league 71 has rows from the calls above.
  run(`UPDATE rec_ledger SET graded_at = datetime('now'), score = 1, outcome_json = '{}'
       WHERE league_id = 71 AND kind = 'lineup'`);
  const res = await get('/api/grades/71/ledger');
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'ok');
  assert.equal(res.body.league_id, 71);
  assert.deepEqual(res.body.kinds.trade, { rows: 4, shown: 4, considered_not_shown: 0, graded: 0, graded_share: 0 });
  assert.deepEqual(res.body.kinds.lineup, { rows: 1, shown: 1, considered_not_shown: 0, graded: 1, graded_share: 1 });
  assert.deepEqual(res.body.kinds.waiver, { rows: 4, shown: 4, considered_not_shown: 0, graded: 0, graded_share: 0 });
  assert.deepEqual(res.body.kinds.scenario, { rows: 0, shown: 0, considered_not_shown: 0, graded: 0, graded_share: null });
  assert.deepEqual(res.body.total, { rows: 9, graded: 1, graded_share: +(1 / 9).toFixed(4) });
  assert.deepEqual(res.body.horizons, { trade: [2, 5], lineup: [1], waiver: [2, 5], scenario: [] });
});

test('the ledger reader is scoped: another league\'s rows are not counted, and a non-member is refused', async () => {
  const res = await get('/api/grades/72/ledger');
  assert.equal(res.body.kinds.trade.rows, 6);
  assert.equal(res.body.kinds.lineup.rows, 0);
  const outsider = await get('/api/grades/71/ledger', 'outsider-token');
  assert.equal(outsider.status, 403);
  const missing = await get('/api/grades/999/ledger');
  assert.equal(missing.status, 404);
});

test('server/index.js mounts the grades router, so the reader is reachable in the app', () => {
  const src = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  // Control: a router known to be mounted is found by the same pattern.
  assert.match(src, /app\.use\('\/api\/trades', \.\.\.legacyAuthenticated, tradesRouter\)/);
  assert.match(src, /app\.use\('\/api\/grades', \.\.\.legacyAuthenticated, gradesRouter\)/);
});
