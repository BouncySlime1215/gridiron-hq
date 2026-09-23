/**
 * S-19 contract: one hype producer.
 *
 * Every surface that says anything about a player's hype / sell-high returns
 * the same value for the same player, and that value is
 * `server/services/hype.js#playerHype`:
 *   - POST /api/players/:id/analyze (no-key branch and AI branch), which used
 *     to fall back to players.js heuristicVerdict ("sell into the hype");
 *   - waiver-brain.js sellHigh, which used to fit its own price curve;
 *   - GET /api/trades/:leagueId/market/:playerId (TM-09, #183).
 * The TM-09 table is replaced by a fixture so one player has a current-season
 * row (a known non-zero case); the real table has no 2026 row.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-hype-one-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';
// Week 6, so several current-season rows are eligible and the test can see which one is served.
process.env.NFL_WEEK = '6';
delete process.env.GRIDIRON_ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

let fixtureTable = null;
const realMarket = await import('../server/services/trade-market.js?real');
mock.module('../server/services/trade-market.js', {
  namedExports: { ...realMarket, loadMarketTable: () => fixtureTable } });
let apiKey = null;
const realClaude = await import('../server/services/claude.js?real');
mock.module('../server/services/claude.js', {
  namedExports: { ...realClaude, getApiKey: () => apiKey,
    callClaude: async () => ({ content: [{ type: 'text', text: '{"verdict":"HOLD","evidence_ids":[]}' }] }) } });

const { db, run, row } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { hashSessionToken } = await import('../server/platform/auth.js');
const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');
const { tradeWeekContext } = await import('../server/services/trade-engine.js');
const { playerHype } = await import('../server/services/hype.js');
const { sellHigh } = await import('../server/services/waiver-brain.js');
const { default: tradesRouter } = await import('../server/routes/trades.js');
const { default: playersRouter } = await import('../server/routes/players.js');

const { season } = tradeWeekContext();
fixtureTable = {
  meta: { unit: 'TM-09', units: 'points above replacement per game, league scoring', sign: 'hype = price - value' },
  results: { h1: { passed: true } }, position_price_to_value: { RB: 0.9, WR: 0.9 }, cells: [],
  player_weeks: [
    // Three eligible weeks in scrambled order (3, 6, 2): the latest (6) must win, so neither the
    // first row, the last row, nor the earliest row can pass by accident.
    { season, week: 3, sleeper_id: '9001', pos: 'RB', n: 4, price: 2.9, value: 2.4, hype: 0.5 },
    { season, week: 6, sleeper_id: '9001', pos: 'RB', n: 4, price: 3.1, value: 2.3, hype: 0.8 },
    { season, week: 2, sleeper_id: '9001', pos: 'RB', n: 3, price: 2.6, value: 2.4, hype: 0.2 },
    // A week that has not happened yet (tradeWeekContext is week 6 via NFL_WEEK): never served.
    { season, week: 18, sleeper_id: '9001', pos: 'RB', n: 5, price: 9.9, value: 2.0, hype: 7.9 },
    { season: season - 2, week: 1, sleeper_id: '9002', pos: 'WR', n: 3, price: 1.0, value: 1.6, hype: -0.6 },
  ],
};

run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (8812, 'hype-user', 'Reader')`);
run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at)
     VALUES (8812, ?, datetime('now','+1 day'))`, hashSessionToken('hype-token'));
run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id, current_week)
     VALUES (71, 'sleeper', 'sl-hype-71', ?, 'L71', ?, 10, '1', 6)`, season,
  JSON.stringify({ users: [{ user_id: 'u1', display_name: 'Me' }],
    rosters: [{ roster_id: 1, owner_id: 'u1', players: ['9001', '9002'] }] }));
run(`INSERT OR IGNORE INTO league_memberships(league_id, user_id, role) VALUES (71, 8812, 'member')`);
run(`INSERT INTO players(id, name, position, sleeper_id) VALUES (90001, 'Hyped Player', 'RB', '9001')`);
run(`INSERT INTO players(id, name, position, sleeper_id) VALUES (90002, 'Old Row', 'WR', '9002')`);
run(`INSERT INTO players(id, name, position, sleeper_id) VALUES (90003, 'No Sleeper', 'TE', NULL)`);
// The input the retired heuristic read: +25% in 30 days, which it called SELL "sell into the hype".
run(`INSERT INTO player_metrics(player_id, source, value) VALUES (90001, 'fc_value', 100), (90001, 'fc_trend30', 20)`);

const app = express();
app.use(express.json());
app.use('/api/trades', ...legacyAuthenticated, tradesRouter);
app.use('/api/players', ...legacyAuthenticated, playersRouter);
app.use((e, req, res, next) => { res.status(500).json({ error: e.message }); });
const server = app.listen(0);
const port = server.address().port;
test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
const call = async (method, url) => {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { authorization: 'Bearer hype-token' } });
  const text = await res.text();
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  return { status: res.status, body: isJson ? JSON.parse(text) : null };
};

test('control: the producer serves a number for a current-season row and abstains otherwise', () => {
  const hyped = playerHype({ sleeperId: '9001' });
  assert.equal(hyped.available, true);
  assert.equal(hyped.hype, 0.8, 'the latest row at or before the current week, never a later one');
  assert.equal(hyped.season, season);
  assert.equal(hyped.week, 6, 'served row is week 6 (the current week), not week 2, 3 or 18');
  const old = playerHype({ sleeperId: '9002' });
  assert.equal(old.available, false, 'a row from an earlier season is not this season\'s hype');
  assert.equal(old.hype, null);
  const noId = playerHype({ sleeperId: null });
  assert.equal(noId.available, false);
  assert.equal(noId.reason, 'no_sleeper_id', 'a missing id is said as such, not as "no trade price"');
});

test('default-off: no surface turns hype into a SELL/BUY call', () => {
  for (const id of ['9001', '9002', null]) assert.equal(playerHype({ sleeperId: id }).verdict, null);
});

for (const [id, sleeperId] of [[90001, '9001'], [90002, '9002'], [90003, null]]) {
  test(`contract: every hype surface returns playerHype for player ${id}`, async () => {
    const expected = playerHype({ sleeperId });

    apiKey = null;
    const noKey = await call('POST', `/api/players/${id}/analyze`);
    assert.deepEqual(noKey.body?.hype, expected, 'analyze (no API key) hype');

    apiKey = 'test-key';
    const ai = await call('POST', `/api/players/${id}/analyze`);
    assert.deepEqual(ai.body?.hype, expected, `analyze (AI branch) hype: ${ai.status} ${JSON.stringify(ai.body)?.slice(0, 300)}`);
    apiKey = null;

    const market = await call('GET', `/api/trades/71/market/${id}`);
    assert.equal(market.status, 200);
    assert.deepEqual(market.body?.hype, expected, 'TM-09 market route hype');

    if (sleeperId) {
      const sh = sellHigh(71);
      const reading = (sh.readings ?? []).find(r => r.id === id);
      assert.deepEqual(reading?.hype, expected, 'sellHigh reading hype');
    }
  });
}

test('retired heuristic: a +25% FantasyCalc month no longer yields SELL "into the hype"', async () => {
  run('DELETE FROM player_analysis WHERE player_id = 90001');
  apiKey = null;
  const res = await call('POST', '/api/players/90001/analyze');
  assert.notEqual(res.body?.verdict, 'SELL');
  assert.equal(row('SELECT verdict FROM player_analysis WHERE player_id = 90001'), undefined,
    'no hype-derived verdict is written without a validated signal');
});

test('retired sellHigh: flags only what the one producer calls SELL', () => {
  const sh = sellHigh(71);
  assert.ok(Array.isArray(sh.readings) && sh.readings.length === 2, 'both rostered players are read');
  assert.deepEqual(sh.candidates, sh.readings.filter(r => r.hype.verdict === 'SELL'));
});

test('no other served string claims sell-high or names the removed sellHigh curve', () => {
  // tagDeal (trade-engine.js) is not exported, so this scans the served server source.
  const root = new URL('../server/', import.meta.url);
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p);
  } };
  walk(root.pathname);
  const src = Object.fromEntries(files.map(f => [path.relative(root.pathname, f), fs.readFileSync(f, 'utf8')]));
  // Control: the scan reads the files it must (a known string is found).
  assert.ok(src['services/trade-engine.js']?.includes("tags.push('Sell the Veteran')"), 'control: scan sees trade-engine tags');
  const hits = Object.entries(src).flatMap(([f, s]) => [
    ...(/tags\.push\(\s*['"]Sell High['"]/.test(s) ? [`${f}: deal tag 'Sell High' (an age rule, not a hype read)`] : []),
    ...(s.includes('waiver-brain#sellHigh') ? [`${f}: names the removed waiver-brain#sellHigh curve`] : []),
  ]);
  assert.deepEqual(hits, []);
});
