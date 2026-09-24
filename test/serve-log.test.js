/**
 * IDEA-001 serve-log: every number the app serves on a trade card, a title-odds
 * surface or a range is kept as served, so it can be graded later against what
 * happened instead of against a replay of today's code.
 *
 * Before this unit (origin/main d861c11): no table held a served trade-card or
 * title-odds number. `trade_outcomes` holds the proposals slate only; the
 * trade-impact, title-trades, simulate and find routes computed a number, sent it
 * and kept nothing.
 *
 * WHAT IS REAL AND WHAT IS NOT. The migration, the queue, the flush, the routes
 * and the weekly job's own logic are real. The four producers (`tradeImpact`,
 * `simulateSeason`, `titleOddsTrades`, `findTrades`) are stubbed with fixtures in
 * their own field names (season-sim.js:485-507 and :709-721, title-odds-trades.js:
 * 87-106, trade-engine.js:1276-1310), because a full league valuation is not what
 * is under test. Every name below is made up.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-serve-log-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, rows, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { hashSessionToken } = await import('../server/platform/auth.js');
const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');

// ------------------------------------------------------------------ fixtures
const IMPACT = {
  runs: 400, from_week: 4, seed: 777, paired_simulation: true,
  me: { roster_id: '1', owner: 'Owner Me', title_before: 0.12, title_after: 0.15, title_delta: 0.03,
    title_delta_se: 0.01, title_delta_clears_noise: true, playoff_before: 0.5, playoff_after: 0.56,
    playoff_delta: 0.06, playoff_delta_se: 0.02, playoff_delta_clears_noise: true, wins_delta: 0.4 },
  them: { roster_id: '2', owner: 'Owner Two', title_before: 0.1, title_after: 0.09, title_delta: -0.01,
    title_delta_se: 0.01, title_delta_clears_noise: false, playoff_before: 0.4, playoff_after: 0.39,
    playoff_delta: -0.01, playoff_delta_se: 0.02, playoff_delta_clears_noise: false, wins_delta: -0.1 },
};
const SIM = {
  runs: 2000, weeks: 14, from_week: 4, playoff_teams: 4,
  teams: [
    { roster_id: '1', owner: 'Owner Me', playoff_odds: 0.5, playoff_odds_95: [0.48, 0.52],
      title_odds: 0.12, title_odds_95: [0.11, 0.135], finals_odds: 0.2, expected_wins: 7.5, expected_points: 1500.2 },
    { roster_id: '2', owner: 'Owner Two', playoff_odds: 0.4, playoff_odds_95: [0.38, 0.42],
      title_odds: 0.1, title_odds_95: [0.09, 0.115], finals_odds: 0.18, expected_wins: 7.1, expected_points: 1480.9 },
  ],
};
const TITLE_TRADES = {
  league: 'L', considered: 9, simulated: 1, runs_each: 400,
  deals: [{
    partner: 'Owner Two', partner_id: '2',
    i_give: [{ id: 102, name: 'Give A', position: 'WR' }], i_get: [{ id: 201, name: 'Get A', position: 'RB' }],
    ppg_delta: 1.2, value_delta: 300, fairness: 'fair',
    title_before: 0.12, title_after: 0.15, title_delta: 0.03, title_delta_se: 0.01,
    title_delta_clears_noise: true, playoff_delta: 0.06,
    their_title_delta: -0.01, their_title_delta_se: 0.01, their_title_delta_clears_noise: false,
    mutual_title_gain: false,
  }],
};
const FOUND = {
  mode: 'league', me: { roster_id: '1', owner: 'Owner Me' },
  model_context: { engine: 'player-week-v2.1 + test', cutoff: '2026-W3' },
  deals: [{
    partner: 'Owner Two', partner_id: '2',
    i_give: [{ id: 102, name: 'Give A' }, { id: 101, name: 'Give B' }], i_get: [{ id: 201, name: 'Get A' }],
    me: { ppg_delta: 1.5, value_delta: 250, floor_delta: -0.8, ceiling_delta: 2.1 },
    them: { ppg_delta: 0.4, value_delta: -250 },
  }],
};

let simulateCalls = 0;
// The stub draws from the shared rng, as simulateSeason's world draw does
// (season-sim.js:444), so a served seed that replays the draw is a real check.
const { random } = await import('../server/services/stats-util.js');
const realSim = await import('../server/services/season-sim.js');
mock.module('../server/services/season-sim.js', {
  namedExports: {
    ...realSim,
    tradeImpact: () => structuredClone(IMPACT),
    simulateSeason: () => { simulateCalls++; return { ...structuredClone(SIM), draw: random() }; },
  },
});
const realTitle = await import('../server/services/title-odds-trades.js');
mock.module('../server/services/title-odds-trades.js', {
  namedExports: { ...realTitle, titleOddsTrades: () => structuredClone(TITLE_TRADES) },
});
const realEngine = await import('../server/services/trade-engine.js');
// FIX-243-1: the weekly lineup range per team. The rosters and the lineup model
// are stubbed; lineupSpread's own maths is trade-engine's and is not under test.
const LINEUP_TEAMS = [
  { roster_id: '1', owner: 'Owner Me', players: [{ id: 101, spread: { floor: 88.4, mean: 112.3, ceiling: 136.2 } }] },
  { roster_id: '2', owner: 'Owner Two', players: [{ id: 201, spread: { floor: 80.1, mean: 101.9, ceiling: 123.7 } }] },
];
mock.module('../server/services/trade-engine.js', {
  namedExports: {
    ...realEngine,
    findTrades: () => structuredClone(FOUND),
    assetUniverse: () => [],
    loadRosters: () => structuredClone(LINEUP_TEAMS),
    lineupSlots: () => [{ slot: 'FLEX' }],
    weekLineup: players => ({ slots: players.map(p => ({ slot: 'FLEX', player: p })) }),
    lineupSpread: lineup => ({ ...lineup.slots[0].player.spread, method: 'normal approximation of the lineup total' }),
  },
});

const serveLog = await import('../server/services/serve-log.js');
const { default: tradesRouter } = await import('../server/routes/trades.js');
const { default: modelRouter } = await import('../server/routes/model.js');
const { JOBS } = await import('../server/services/scheduler.js');
const { FANTASY_LIVE_JOBS } = await import('../scripts/refresh-live-data.mjs');

// ------------------------------------------------------------------ app setup
run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (8811, 'serve-log-user', 'Reader')`);
run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at)
     VALUES (8811, ?, datetime('now','+1 day'))`, hashSessionToken('serve-log-token'));
function insertLeague(id, { payload = { teams: [], members: [] }, fetchedAt = '2026-09-24 12:00:00', week = 4 } = {}) {
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id, fetched_at, current_week)
       VALUES (?, 'espn', ?, 2026, ?, ?, 2, '1', ?, ?)`,
  id, `espn-serve-${id}`, `L${id}`, payload == null ? null : JSON.stringify(payload), fetchedAt, week);
  run(`INSERT OR IGNORE INTO league_memberships(league_id, user_id, role) VALUES (?, 8811, 'member')`, id);
}
insertLeague(61);
insertLeague(62);
insertLeague(63, { payload: null });

const app = express();
app.use(express.json());
app.use('/api/trades', ...legacyAuthenticated, tradesRouter);
app.use('/api/model', ...legacyAuthenticated, modelRouter);
const server = app.listen(0);
const port = server.address().port;
test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const call = async (method, url, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method, headers: { authorization: 'Bearer serve-log-token', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json(), requestId: res.headers.get('x-served-request-id') };
};
const tableCount = () => row('SELECT COUNT(*) n FROM served_numbers').n;
const byField = rs => Object.fromEntries(rs.map(r => [`${r.entity}#${r.field}`, r.value]));
test.beforeEach(() => {
  serveLog.__resetServeLog();
  run('DELETE FROM served_numbers'); run('DELETE FROM game_lines'); run('DELETE FROM player_week_usage');
});
const leaguePayloadHash = id => createHash('sha256').update(row('SELECT payload FROM leagues WHERE id = ?', id).payload).digest('hex');

// ------------------------------------------------------------------ migration
test('079 adds served_numbers with every column the grader needs, and nothing else changes', () => {
  const cols = db.prepare('PRAGMA table_info(served_numbers)').all().map(c => c.name);
  for (const c of ['league_id', 'surface', 'entity', 'field', 'value', 'model', 'model_version',
    'as_of', 'served_at', 'request_id', 'trigger', 'season', 'week']) {
    assert.ok(cols.includes(c), `served_numbers.${c}`);
  }
  assert.ok(row(`SELECT 1 x FROM schema_migrations WHERE name='079_served_numbers'`), 'applied by name');
  const src = fs.readFileSync(new URL('../server/migrations/079_served_numbers.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src.replace(/export function down[\s\S]*$/, ''), /\b(DROP|ALTER|DELETE|UPDATE)\b/,
    'up() is additive only');
});

// ------------------------------------------------------------------ extractors
test('trade card impact: both sides\' title and playoff odds, and the ±2 SE band as a range', () => {
  const out = serveLog.servedNumbers('trade_impact', IMPACT, { myTeamId: '1', theirTeamId: '2', iGive: [102], iGet: [201] });
  const f = byField(out);
  const deal = 'deal:1|2|102>201';
  assert.equal(f[`${deal}#title_before`], 0.12);
  assert.equal(f[`${deal}#title_after`], 0.15);
  assert.equal(f[`${deal}#title_delta`], 0.03);
  assert.equal(f[`${deal}#title_delta_se`], 0.01);
  assert.equal(f[`${deal}#title_delta_lo`], 0.01, 'delta − 2 SE, the band the card prints');
  assert.equal(f[`${deal}#title_delta_hi`], 0.05);
  assert.equal(f[`${deal}#playoff_delta`], 0.06);
  assert.equal(f[`${deal}#their_title_delta`], -0.01);
  assert.equal(f[`${deal}#their_title_after`], 0.09);
  assert.ok(out.every(r => r.model === 'season-sim.tradeImpact'));
  assert.ok(out.every(r => r.model_version === 'runs=400;seed=777;from_week=4'), out[0].model_version);
});

test('title odds: each team\'s odds and its 95% interval', () => {
  const f = byField(serveLog.servedNumbers('title_odds', SIM, {}));
  assert.equal(f['team:1#title_odds'], 0.12);
  assert.equal(f['team:1#title_odds_lo'], 0.11);
  assert.equal(f['team:1#title_odds_hi'], 0.135);
  assert.equal(f['team:2#playoff_odds_hi'], 0.42);
  assert.equal(f['team:2#expected_wins'], 7.1);
});

test('title trades: per deal, the same delta and band as the card, plus the points it was ranked against', () => {
  const f = byField(serveLog.servedNumbers('title_trades', TITLE_TRADES, { myTeamId: '1' }));
  const deal = 'deal:1|2|102>201';
  assert.equal(f[`${deal}#title_delta`], 0.03);
  assert.equal(f[`${deal}#title_delta_lo`], 0.01);
  assert.equal(f[`${deal}#ppg_delta`], 1.2);
  assert.equal(f[`${deal}#their_title_delta_hi`], 0.01);
});

test('trade finder cards: ppg, value and the p10/p90 lineup range, ids sorted so one deal is one entity', () => {
  const out = serveLog.servedNumbers('trade_find', FOUND, {});
  const f = byField(out);
  const deal = 'deal:1|2|101,102>201';
  assert.equal(f[`${deal}#ppg_delta`], 1.5);
  assert.equal(f[`${deal}#floor_delta`], -0.8);
  assert.equal(f[`${deal}#ceiling_delta`], 2.1);
  assert.equal(f[`${deal}#their_ppg_delta`], 0.4);
  assert.equal(out[0].model_version, 'player-week-v2.1 + test|cutoff=2026-W3');
});

test('a null number is recorded as null, not skipped and not zero', () => {
  const out = serveLog.servedNumbers('trade_impact',
    { ...IMPACT, me: { ...IMPACT.me, title_delta_se: null } }, { myTeamId: '1', theirTeamId: '2', iGive: [102], iGet: [201] });
  const f = byField(out);
  assert.ok('deal:1|2|102>201#title_delta_se' in f);
  assert.equal(f['deal:1|2|102>201#title_delta_se'], null);
  assert.equal(f['deal:1|2|102>201#title_delta_lo'], null, 'no SE, no band');
});

// ------------------------------------------------------------------ queue
test('recording is a queue push: nothing reaches the table until the flush loop runs', () => {
  const lg = row('SELECT * FROM leagues WHERE id = 61');
  const id = serveLog.recordServed(null, 'title_odds', lg, SIM, {});
  assert.equal(tableCount(), 0, 'no write on the request thread');
  assert.equal(serveLog.serveLogState().queued, 1);
  const flushed = serveLog.flushServed();
  assert.equal(flushed.entries, 1);
  const got = rows('SELECT * FROM served_numbers WHERE request_id = ?', id);
  assert.equal(got.length, flushed.rows);
  assert.ok(got.length >= 14);
  assert.ok(got.every(r => r.league_id === 61 && r.as_of === '2026-09-24 12:00:00' && r.trigger === 'request'
    && r.surface === 'title_odds' && r.season === 2026 && r.week === 4));
  assert.equal(serveLog.serveLogState().queued, 0);
});

test('an error payload served no number, so it queues nothing and gets no request id', () => {
  const lg = row('SELECT * FROM leagues WHERE id = 61');
  assert.equal(serveLog.recordServed(null, 'trade_impact', lg, { error: 'both teams required' }, {}), null);
  assert.equal(serveLog.serveLogState().queued, 0);
});

test('a full queue drops its oldest entry and counts it, so a stalled flush is visible', () => {
  const lg = row('SELECT * FROM leagues WHERE id = 61');
  for (let i = 0; i < serveLog.SERVE_LOG_QUEUE_CAP + 3; i++) serveLog.recordServed(null, 'title_odds', lg, SIM, {});
  const s = serveLog.serveLogState();
  assert.equal(s.queued, serveLog.SERVE_LOG_QUEUE_CAP);
  assert.equal(s.dropped, 3);
});

test('one flush tick writes a bounded number of rows, so a full queue never blocks the thread in one go', () => {
  const lg = row('SELECT * FROM leagues WHERE id = 61');
  for (let i = 0; i < 10; i++) serveLog.recordServed(null, 'title_odds', lg, SIM, {});
  const per = serveLog.servedNumbers('title_odds', SIM, {}).length;
  const first = serveLog.flushServed({ maxRows: per * 3 });
  assert.equal(first.entries, 3, 'stops at the row budget');
  assert.equal(serveLog.serveLogState().queued, 7);
  assert.ok(serveLog.SERVE_LOG_FLUSH_ROWS <= 5000, 'the default tick stays small');
  while (serveLog.serveLogState().queued) serveLog.flushServed({ maxRows: per * 3 });
  assert.equal(tableCount(), per * 10, 'and the rest drains on later ticks');
});

test('a failed flush puts the batch back, records why, and throws', () => {
  const lg = row('SELECT * FROM leagues WHERE id = 61');
  serveLog.recordServed(null, 'title_odds', lg, SIM, {});
  const broken = { exec() {}, prepare() { throw new Error('disk I/O error'); } };
  assert.throws(() => serveLog.flushServed({ database: broken }), /disk I\/O error/);
  const s = serveLog.serveLogState();
  assert.equal(s.queued, 1, 'nothing lost');
  assert.match(s.last_error, /disk I\/O error/);
  serveLog.flushServed();
  assert.ok(tableCount() > 0, 'the next flush writes it');
});

test('an entry the extractor cannot read is counted and reported, and the rest of the batch still writes', () => {
  const lg = row('SELECT * FROM leagues WHERE id = 61');
  serveLog.recordServed(null, 'title_odds', lg, { teams: 'not a list' }, {});
  serveLog.recordServed(null, 'title_odds', lg, SIM, {});
  serveLog.flushServed();
  const s = serveLog.serveLogState();
  assert.equal(s.extract_errors, 1);
  assert.match(s.last_error, /title_odds/);
  assert.ok(tableCount() > 0);
});

test('the flush loop drains the queue on its own timer', async () => {
  const lg = row('SELECT * FROM leagues WHERE id = 61');
  serveLog.recordServed(null, 'title_odds', lg, SIM, {});
  const stop = serveLog.startServeLogFlusher({ intervalMs: 5 });
  try {
    for (let i = 0; i < 100 && tableCount() === 0; i++) await new Promise(r => setTimeout(r, 5));
  } finally { stop(); }
  assert.ok(tableCount() > 0);
});

// ------------------------------------------------------------------ routes
test('route: POST trade-impact queues what the trade card shows under the response\'s request id', async () => {
  const res = await call('POST', '/api/model/61/trade-impact',
    { my_team_id: '1', their_team_id: '2', i_give: [102], i_get: [201] });
  assert.equal(res.status, 200);
  assert.equal(res.body.me.title_delta, 0.03, 'the response itself is unchanged');
  assert.ok(res.requestId, 'X-Served-Request-Id');
  assert.equal(tableCount(), 0);
  serveLog.flushServed();
  const f = byField(rows('SELECT * FROM served_numbers WHERE request_id = ?', res.requestId));
  assert.equal(f['deal:1|2|102>201#title_after'], 0.15);
  assert.equal(f['deal:1|2|102>201#title_delta_hi'], 0.05);
});

test('route: GET simulate and GET title-trades queue title odds and title-trade numbers', async () => {
  const sim = await call('GET', '/api/model/61/simulate?runs=2000');
  const tt = await call('GET', '/api/trades/61/title-trades?team_id=1');
  assert.equal(sim.status, 200); assert.equal(tt.status, 200);
  serveLog.flushServed();
  assert.equal(byField(rows('SELECT * FROM served_numbers WHERE request_id = ?', sim.requestId))['team:1#title_odds'], 0.12);
  assert.equal(byField(rows('SELECT * FROM served_numbers WHERE request_id = ?', tt.requestId))['deal:1|2|102>201#title_delta'], 0.03);
});

test('route: GET find queues each trade card\'s numbers', async () => {
  const res = await call('GET', '/api/trades/61/find?team_id=1');
  assert.equal(res.status, 200);
  serveLog.flushServed();
  const f = byField(rows('SELECT * FROM served_numbers WHERE request_id = ?', res.requestId));
  assert.equal(f['deal:1|2|101,102>201#ceiling_delta'], 2.1);
});

test('route: an error payload serves no number and logs none', async () => {
  const res = await call('POST', '/api/model/63/trade-impact', { their_team_id: '2' });
  assert.equal(res.status, 400);
  assert.equal(serveLog.serveLogState().queued, 0);
});

test('route: GET served-numbers reads back what was served, with the queue\'s state', async () => {
  const res = await call('POST', '/api/model/61/trade-impact',
    { my_team_id: '1', their_team_id: '2', i_give: [102], i_get: [201] });
  serveLog.flushServed();
  const back = await call('GET', `/api/trades/61/served-numbers?request_id=${res.requestId}`);
  assert.equal(back.status, 200);
  assert.ok(back.body.rows.length > 0);
  assert.ok(back.body.rows.every(r => r.request_id === res.requestId && r.league_id === 61));
  assert.equal(back.body.queue.queued, 0);
  const other = await call('GET', '/api/trades/62/served-numbers');
  assert.equal(other.body.rows.length, 0, 'scoped to the league in the path');
});

// ------------------------------------------------------------------ weekly job
test('weekly snapshot: title odds, title trades and finder cards for each league, once per NFL week', async () => {
  const before = simulateCalls;
  const first = await serveLog.snapshotServedNumbers();
  const weekly = rows(`SELECT DISTINCT league_id, surface FROM served_numbers WHERE trigger = 'weekly' ORDER BY league_id, surface`);
  assert.deepEqual(weekly.map(r => `${r.league_id}:${r.surface}`).sort(),
    ['61:lineup_spread', '61:title_odds', '61:title_trades', '61:trade_find',
      '62:lineup_spread', '62:title_odds', '62:title_trades', '62:trade_find'].sort(),
    'league 63 has no payload, so nothing');
  assert.equal(first.leagues.find(l => l.league_id === 61).state, 'snapshotted');
  assert.equal(first.leagues.find(l => l.league_id === 63).state, 'not_synced');
  assert.equal(simulateCalls - before, 2);

  const again = await serveLog.snapshotServedNumbers();
  assert.ok(again.leagues.filter(l => l.league_id !== 63).every(l => l.state === 'already_snapshotted'));
  assert.equal(simulateCalls - before, 2, 'the same week is not re-simulated');

  run('UPDATE leagues SET current_week = 5 WHERE id = 61');
  const next = await serveLog.snapshotServedNumbers();
  assert.equal(next.leagues.find(l => l.league_id === 61).state, 'snapshotted', 'a new week snapshots again');
  run('UPDATE leagues SET current_week = 4 WHERE id = 61');
});

test('weekly snapshot is a scheduler job and runs in the refresh loop', () => {
  assert.ok(JOBS.served_numbers_weekly, 'registered');
  assert.equal(JOBS.served_numbers_weekly.run, serveLog.snapshotServedNumbers);
  assert.ok(FANTASY_LIVE_JOBS.includes('served_numbers_weekly'), 'runs while SCHEDULER_DISABLED=1');
});


// ------------------------------------------------------------------ FIX-243-2: replayable rows
test('100 adds seed and input_hash to served_numbers, additively', () => {
  const cols = db.prepare('PRAGMA table_info(served_numbers)').all().map(c => c.name);
  assert.ok(cols.includes('seed'), 'served_numbers.seed');
  assert.ok(cols.includes('input_hash'), 'served_numbers.input_hash');
  assert.ok(row(`SELECT 1 x FROM schema_migrations WHERE name='100_served_numbers_replay'`), 'applied by name');
  const src = fs.readFileSync(new URL('../server/migrations/100_served_numbers_replay.js', import.meta.url), 'utf8');
  const up = src.replace(/export function down[\s\S]*$/, '');
  assert.doesNotMatch(up, /\b(DROP|DELETE|UPDATE)\b/, 'up() only adds');
  assert.doesNotMatch(up.replace(/ALTER TABLE served_numbers ADD COLUMN/g, ''), /\bALTER\b/, 'the only ALTER is ADD COLUMN');
});

test('spec (e): /simulate with no seed generates one, serves it, and the row carries seed, input_hash, model_version and as_of', async () => {
  const res = await call('GET', '/api/model/61/simulate?runs=1234');
  assert.equal(res.status, 200);
  assert.ok(Number.isInteger(res.body.seed) && res.body.seed > 0, `served seed ${res.body.seed}`);
  serveLog.flushServed();
  const got = rows('SELECT * FROM served_numbers WHERE request_id = ?', res.requestId);
  assert.ok(got.length > 0);
  for (const r of got) {
    assert.equal(r.seed, res.body.seed, 'the seed actually used');
    assert.equal(r.input_hash, leaguePayloadHash(61), 'sha256 of the league snapshot');
    assert.match(r.model_version, new RegExp(`seed=${res.body.seed};`));
    assert.equal(r.as_of, '2026-09-24 12:00:00');
  }
  // Replayable: the same seed reproduces the same draw.
  const replay = await call('GET', `/api/model/61/simulate?runs=1234&seed=${res.body.seed}`);
  assert.equal(replay.body.seed, res.body.seed);
  assert.equal(replay.body.draw, res.body.draw, 'the recorded seed replays the served simulation');
});

test('spec (e): a supplied seed is the one recorded; every request surface carries input_hash and as_of', async () => {
  const sim = await call('GET', '/api/model/62/simulate?runs=1500&seed=4242');
  assert.equal(sim.body.seed, 4242);
  const imp = await call('POST', '/api/model/61/trade-impact', { my_team_id: '1', their_team_id: '2', i_give: [102], i_get: [201] });
  const tt = await call('GET', '/api/trades/61/title-trades?team_id=1');
  const fd = await call('GET', '/api/trades/61/find?team_id=1');
  serveLog.flushServed();
  assert.ok(rows('SELECT seed FROM served_numbers WHERE request_id = ?', sim.requestId).every(r => r.seed === 4242));
  assert.ok(rows('SELECT seed FROM served_numbers WHERE request_id = ?', imp.requestId).every(r => r.seed === 777),
    'trade impact records its paired seed');
  const ttSeed = realSim.tradeImpactSeed(row('SELECT * FROM leagues WHERE id = 61'));
  assert.ok(rows('SELECT seed FROM served_numbers WHERE request_id = ?', tt.requestId).every(r => r.seed === ttSeed),
    'title trades run under tradeImpactSeed(lg)');
  assert.ok(rows('SELECT seed FROM served_numbers WHERE request_id = ?', fd.requestId).every(r => r.seed === null),
    'the finder draws nothing, so no seed');
  const all = rows('SELECT * FROM served_numbers');
  assert.ok(all.length > 0);
  assert.ok(all.every(r => /^[0-9a-f]{64}$/.test(r.input_hash) && r.as_of && r.model_version != null));
});

test('spec (e): weekly rows carry the seed the job generated and the league snapshot hash', async () => {
  await serveLog.snapshotServedNumbers();
  const titleRows = rows(`SELECT * FROM served_numbers WHERE league_id = 61 AND trigger = 'weekly' AND surface = 'title_odds'`);
  assert.ok(titleRows.length > 0);
  const seeds = new Set(titleRows.map(r => r.seed));
  assert.equal(seeds.size, 1);
  assert.ok(Number.isInteger([...seeds][0]), 'a generated seed, not null');
  assert.ok(rows(`SELECT * FROM served_numbers WHERE trigger = 'weekly'`).every(r => r.input_hash === leaguePayloadHash(r.league_id)));
});

// ------------------------------------------------------------------ FIX-243-1: lineup ranges
test('weekly snapshot: lineup p10/p50/p90 for each team, one row per team per field', async () => {
  const out = await serveLog.snapshotServedNumbers();
  assert.equal(out.leagues.find(l => l.league_id === 61).state, 'snapshotted');
  const got = rows(`SELECT entity, field, value, model FROM served_numbers
    WHERE league_id = 61 AND trigger = 'weekly' AND surface = 'lineup_spread' ORDER BY entity, field`);
  assert.deepEqual(got.map(r => `${r.entity}#${r.field}=${r.value}`), [
    'team:1#lineup_p10=88.4', 'team:1#lineup_p50=112.3', 'team:1#lineup_p90=136.2',
    'team:2#lineup_p10=80.1', 'team:2#lineup_p50=101.9', 'team:2#lineup_p90=123.7',
  ]);
  assert.ok(got.every(r => r.model === 'trade-engine.lineupSpread'));
});

test('lineup_spread extractor: a team with no modelled starter is recorded as null, not skipped', () => {
  const out = serveLog.servedNumbers('lineup_spread',
    { teams: [{ roster_id: '9', floor: null, mean: undefined, ceiling: null }] }, {});
  assert.deepEqual(out.map(r => [r.entity, r.field, r.value]),
    [['team:9', 'lineup_p10', null], ['team:9', 'lineup_p50', null], ['team:9', 'lineup_p90', null]]);
});

// ------------------------------------------------------------------ spec (c): pregame only
const kickoffRow = (gameday, gametime, score = null) => run(`INSERT INTO game_lines(season, week, team, opponent, home, gameday, gametime, team_score)
  VALUES (2026, 4, 'AAA', 'BBB', 1, ?, ?, ?)`, gameday, gametime, score);

test('spec (c): the weekly capture is refused once the week\'s first kickoff has passed', async () => {
  kickoffRow('2020-01-05', '13:00');
  const out = await serveLog.snapshotServedNumbers();
  const l = out.leagues.find(x => x.league_id === 61);
  assert.equal(l.state, 'refused_slate_started');
  assert.match(l.reason, /slate has started/);
  assert.equal(tableCount(), 0, 'nothing written for a week already under way');
});

test('spec (c): refused once the week has outcomes, and allowed while the first kickoff is still ahead', async () => {
  const pid = row('SELECT id FROM players LIMIT 1')?.id
    ?? Number(run(`INSERT INTO players(name, position) VALUES ('Fixture Player', 'WR')`).lastInsertRowid);
  run('INSERT INTO player_week_usage(player_id, season, week) VALUES (?, 2026, 4)', pid);
  const done = await serveLog.snapshotServedNumbers();
  assert.equal(done.leagues.find(x => x.league_id === 61).state, 'refused_slate_started');
  assert.equal(tableCount(), 0);
  run('DELETE FROM player_week_usage');
  kickoffRow('2099-01-05', '13:00');
  const ahead = await serveLog.snapshotServedNumbers();
  assert.equal(ahead.leagues.find(x => x.league_id === 61).state, 'snapshotted');
});
