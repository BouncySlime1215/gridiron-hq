/**
 * SERVE-LOG REPRO (batch D item 31): every served response is pinned to the
 * code, league snapshot, producer arguments and seed that made it, and
 * `reproduceCard` / scripts/eval/repro-card.mjs re-runs the pinned producer and
 * compares every number. Pre-registration: docs/tdd/2026-09-26-serve-log-repro.tdd.md.
 *
 * WHAT IS REAL AND WHAT IS NOT. The migration, serve-log queue and flush, the
 * routes, the pin and the reproduce logic are real. The four producers are
 * stand-ins that draw from the REAL stats-util `random()` stream, the way
 * season-sim does, so a number served without a recorded seed cannot be
 * reproduced and a recorded one can. Every name below is made up.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-serve-pin-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';
delete process.env.GRIDIRON_SERVE_PIN;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
const SHA = 'a'.repeat(40);
process.env.GRIDIRON_CODE_SHA = SHA;

const { db, row, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { hashSessionToken } = await import('../server/platform/auth.js');
const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');
const { random, withRandomSeed, keyedSeed } = await import('../server/services/stats-util.js');

// ------------------------------------------------------------------ seed-dependent stand-ins
const draw = () => +random().toFixed(6);
const simTeams = () => [
  { roster_id: '1', playoff_odds: draw(), playoff_odds_95: [0.1, 0.2], title_odds: draw(),
    title_odds_95: [0.01, 0.3], finals_odds: draw(), expected_wins: 7.5, expected_points: 1500.2 },
  { roster_id: '2', playoff_odds: draw(), playoff_odds_95: [0.1, 0.2], title_odds: draw(),
    title_odds_95: [0.01, 0.3], finals_odds: draw(), expected_wins: 7.1, expected_points: 1480.9 },
];
const realSim = await import('../server/services/season-sim.js');
mock.module('../server/services/season-sim.js', {
  namedExports: {
    ...realSim,
    simulateSeason: (lg, { runs = 2000, fromWeek = null } = {}) => ({ runs, weeks: 14, from_week: fromWeek ?? 4, teams: simTeams() }),
    // Like the real one: seeds itself (caller's seed, else one per league sync).
    tradeImpact: (lg, o = {}) => {
      const seed = o.seed == null ? keyedSeed('trade-impact', lg.id, lg.fetched_at ?? '') : Number(o.seed);
      return withRandomSeed(seed, () => ({
        runs: o.runs ?? 400, from_week: 4, seed, paired_simulation: true,
        me: { roster_id: String(o.myTeamId), title_before: draw(), title_after: draw(), title_delta: draw(), title_delta_se: 0.01,
          playoff_before: draw(), playoff_after: draw(), playoff_delta: draw(), playoff_delta_se: 0.02, wins_delta: draw() },
        them: { roster_id: String(o.theirTeamId), title_before: draw(), title_after: draw(), title_delta: draw(), title_delta_se: 0.01,
          playoff_before: draw(), playoff_after: draw(), playoff_delta: draw(), playoff_delta_se: 0.02, wins_delta: draw() },
      }));
    },
  },
});
const realTitle = await import('../server/services/title-odds-trades.js');
mock.module('../server/services/title-odds-trades.js', {
  namedExports: {
    ...realTitle,
    titleOddsTrades: (leagueId, { teamId = null, runs = 400 } = {}) => withRandomSeed(keyedSeed('tt', leagueId), () => ({
      league: 'L', considered: 9, simulated: 1, runs_each: runs,
      deals: [{ partner_id: '2', i_give: [{ id: 102 }], i_get: [{ id: 201 }], ppg_delta: 1.2, value_delta: 300,
        title_before: draw(), title_after: draw(), title_delta: draw(), title_delta_se: 0.01, playoff_delta: draw(),
        their_title_delta: draw(), their_title_delta_se: 0.01, team_seen: teamId }],
    })),
  },
});
const realEngine = await import('../server/services/trade-engine.js');
mock.module('../server/services/trade-engine.js', {
  namedExports: {
    ...realEngine,
    findTrades: (lg, { limit = 20, excludeIds = new Set() } = {}) => ({
      mode: 'league', me: { roster_id: '1' }, model_context: { engine: 'test-engine', cutoff: '2026-W3' },
      deals: [{ partner_id: '2', i_give: [{ id: 102 }], i_get: [{ id: 201 }],
        me: { ppg_delta: 1.5 + limit / 1000, value_delta: 250 - excludeIds.size, floor_delta: -0.8, ceiling_delta: 2.1 },
        them: { ppg_delta: 0.4, value_delta: -250 } }],
    }),
  },
});

const serveLog = await import('../server/services/serve-log.js');
const pin = await import('../server/services/serve-pin.js');
const repro = await import('../server/services/serve-repro.js');
const { default: tradesRouter } = await import('../server/routes/trades.js');
const { default: modelRouter } = await import('../server/routes/model.js');

// ------------------------------------------------------------------ app setup
run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (8812, 'serve-pin-user', 'Reader')`);
run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at)
     VALUES (8812, ?, datetime('now','+1 day'))`, hashSessionToken('serve-pin-token'));
const PAYLOAD = { teams: [{ id: 1 }, { id: 2 }], members: [], note: 'made-up league' };
function insertLeague(id, { payload = PAYLOAD, fetchedAt = '2026-09-24 12:00:00' } = {}) {
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id, fetched_at, current_week)
       VALUES (?, 'espn', ?, 2026, ?, ?, 2, '1', ?, 4)`, id, `espn-pin-${id}`, `L${id}`, JSON.stringify(payload), fetchedAt);
  run(`INSERT OR IGNORE INTO league_memberships(league_id, user_id, role) VALUES (?, 8812, 'member')`, id);
}
insertLeague(71);
const leagueRow = id => row('SELECT * FROM leagues WHERE id = ?', id);

const app = express();
app.use(express.json());
app.use('/api/trades', ...legacyAuthenticated, tradesRouter);
app.use('/api/model', ...legacyAuthenticated, modelRouter);
const server = app.listen(0);
const port = server.address().port;
test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const call = async (method, url, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method, headers: { authorization: 'Bearer serve-pin-token', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json(), requestId: res.headers.get('x-served-request-id') };
};
const IMPACT_BODY = { my_team_id: '1', their_team_id: '2', i_give: [102], i_get: [201] };
const WAR_ROOM = {
  me: '1', plans_version: 'plans-test-1',
  next_move: { status: 'ok', value: { move_id: 'm1', steps: [{ partner: '2', give: [102], get: [201],
    p_yes: { status: 'ok', value: 0.3 }, title_odds_delta: { status: 'ok', value: 0.01, se: 0.005 },
    title_after: { status: 'ok', value: 0.1 } }] } },
  alternatives: { status: 'unknown', reason: 'none' },
};
/** One of each surface, flushed. Returns request ids by surface. */
async function serveAll() {
  const ids = {
    title_odds: (await call('GET', '/api/model/71/simulate?runs=300')).requestId,
    trade_impact: (await call('POST', '/api/model/71/trade-impact', IMPACT_BODY)).requestId,
    title_trades: (await call('GET', '/api/trades/71/title-trades?team_id=1')).requestId,
    trade_find: (await call('GET', '/api/trades/71/find?team_id=1&limit=30&exclude=301,302')).requestId,
    war_room: serveLog.recordServed(null, 'war_room', leagueRow(71), WAR_ROOM, {}, { args: { plans_version: 'plans-test-1' } }),
  };
  while (serveLog.serveLogState().queued) serveLog.flushServed();
  return ids;
}
const servedRows = () => rows(`SELECT surface, entity, field, value, model, model_version FROM served_numbers
  ORDER BY surface, entity, field`);
const pinRows = () => rows('SELECT * FROM served_pins ORDER BY served_at');
const reset = () => {
  serveLog.__resetServeLog(); pin.__resetServePin();
  run('DELETE FROM served_numbers'); run('DELETE FROM served_pins');
  delete process.env.GRIDIRON_SERVE_PIN; delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
  process.env.GRIDIRON_CODE_SHA = SHA;
  run('UPDATE leagues SET payload = ?, fetched_at = ? WHERE id = 71', JSON.stringify(PAYLOAD), '2026-09-24 12:00:00');
};
test.beforeEach(reset);
const head = { sha: SHA, source: 'env' };

// ------------------------------------------------------------------ migration
test('119 adds served_pins, additive only', () => {
  const cols = db.prepare('PRAGMA table_info(served_pins)').all().map(c => c.name);
  for (const c of ['request_id', 'league_id', 'surface', 'served_at', 'code_sha', 'snapshot_sha256', 'seed', 'pin']) {
    assert.ok(cols.includes(c), `served_pins.${c}`);
  }
  const src = fs.readFileSync(new URL('../server/migrations/119_served_pins.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src.replace(/export function down[\s\S]*$/, ''), /\b(DROP|ALTER|DELETE|UPDATE)\b/);
});

// ------------------------------------------------------------------ B1
test('B1: flag off writes no pin, leaves served rows as main serves them, and preview alone does not switch it on', async () => {
  assert.equal(pin.servePinOn({}), false);
  assert.equal(pin.servePinOn({ GRIDIRON_PREVIEW_UNCONFIRMED: '1' }), false, 'preview does not switch it on');
  assert.equal(pin.servePinOn({ GRIDIRON_SERVE_PIN: '1' }), true);
  process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
  await serveAll();
  assert.equal(pinRows().length, 0, 'no pins with the flag off');
  const off = servedRows();
  assert.ok(off.length > 0);
  assert.ok(off.filter(r => r.surface === 'title_odds').every(r => /seed=;/.test(r.model_version)),
    'unseeded /simulate still runs unseeded with the flag off');
  // Deterministic surfaces serve the same rows with the flag on (the pin adds rows elsewhere, changes none here).
  const stable = rs => rs.filter(r => ['trade_impact', 'title_trades', 'trade_find', 'war_room'].includes(r.surface));
  reset();
  process.env.GRIDIRON_SERVE_PIN = '1';
  await serveAll();
  assert.deepEqual(stable(servedRows()), stable(off), 'served rows identical with the flag on');
});

// ------------------------------------------------------------------ B2
test('B2: flag on pins every response on all five surfaces with code, snapshot, arguments and seed', async () => {
  process.env.GRIDIRON_SERVE_PIN = '1';
  const ids = await serveAll();
  const pins = pinRows();
  assert.equal(pins.length, 5, 'one pin per response');
  const wantSnap = crypto.createHash('sha256').update(leagueRow(71).payload).digest('hex');
  for (const [surface, id] of Object.entries(ids)) {
    const p = pins.find(r => r.request_id === id && r.surface === surface);
    assert.ok(p, `pin for ${surface}`);
    assert.match(p.code_sha, /^[0-9a-f]{40}$/);
    assert.equal(p.snapshot_sha256, wantSnap, `${surface} snapshot = sha256 of the league payload`);
    const body = JSON.parse(p.pin);
    for (const k of ['pin_version', 'surface', 'code', 'snapshot', 'args', 'seed_basis']) assert.ok(k in body, `${surface} pin.${k}`);
    assert.equal(body.snapshot.as_of, '2026-09-24 12:00:00');
  }
  const find = JSON.parse(pins.find(r => r.surface === 'trade_find').pin);
  assert.deepEqual(find.args.excludeIds.sort(), [301, 302]);
  assert.equal(find.args.limit, 30);
  const impact = pins.find(r => r.surface === 'trade_impact');
  assert.equal(impact.seed, keyedSeed('trade-impact', 71, '2026-09-24 12:00:00'), 'trade card seed recorded');
});

test('B2: the weekly snapshot pins its entries, and its title odds run on a recorded seed', async () => {
  process.env.GRIDIRON_SERVE_PIN = '1';
  const out = await serveLog.snapshotServedNumbers();
  const l71 = out.leagues.find(l => l.league_id === 71);
  assert.equal(l71.state, 'snapshotted');
  const pins = rows('SELECT * FROM served_pins WHERE request_id = ?', l71.request_id);
  assert.deepEqual(pins.map(p => p.surface).sort(), ['title_odds', 'title_trades', 'trade_find']);
  const odds = pins.find(p => p.surface === 'title_odds');
  assert.equal(odds.seed, pin.titleOddsSeed(leagueRow(71), { runs: 2000, fromWeek: null }));
  const r = await repro.reproduceCard({ leagueId: 71, requestId: l71.request_id, head });
  assert.equal(r.status, 'reproduced', JSON.stringify(r.surfaces));
});

// ------------------------------------------------------------------ B3
test('B3: same code and snapshot, every producer surface reproduces number for number', async () => {
  process.env.GRIDIRON_SERVE_PIN = '1';
  const ids = await serveAll();
  const seeded = (await call('GET', '/api/model/71/simulate?runs=300&seed=5')).requestId;
  serveLog.flushServed();
  for (const [surface, id] of [...Object.entries(ids).filter(([s]) => s !== 'war_room'), ['title_odds', seeded]]) {
    const r = await repro.reproduceCard({ leagueId: 71, requestId: id, head });
    assert.equal(r.status, 'reproduced', `${surface}: ${JSON.stringify(r.surfaces)}`);
    assert.equal(r.exit, 0);
    const s = r.surfaces[0];
    assert.ok(s.compared > 0 && s.equal === s.compared, `${surface}: ${s.equal}/${s.compared}`);
  }
});

// ------------------------------------------------------------------ B4
test('B4: a changed league snapshot is refused, not passed', async () => {
  process.env.GRIDIRON_SERVE_PIN = '1';
  const { trade_impact: id } = await serveAll();
  run('UPDATE leagues SET payload = ? WHERE id = 71', JSON.stringify({ ...PAYLOAD, note: 'changed' }));
  pin.__resetServePin();
  const r = await repro.reproduceCard({ leagueId: 71, requestId: id, head });
  assert.equal(r.status, 'snapshot_mismatch');
  assert.equal(r.exit, 2);
});

test('B4: different running code is refused with the checkout line', async () => {
  process.env.GRIDIRON_SERVE_PIN = '1';
  const { trade_impact: id } = await serveAll();
  const r = await repro.reproduceCard({ leagueId: 71, requestId: id, head: { sha: 'b'.repeat(40), source: 'env' } });
  assert.equal(r.status, 'code_mismatch');
  assert.equal(r.exit, 2);
  assert.match(r.surfaces[0].fix, new RegExp(`git checkout ${SHA}`));
});

test('B4: a number that does not come back is flagged with its entity and field', async () => {
  process.env.GRIDIRON_SERVE_PIN = '1';
  const { trade_impact: id } = await serveAll();
  run(`UPDATE served_numbers SET value = value + 0.5 WHERE request_id = ? AND field = 'title_delta'`, id);
  const r = await repro.reproduceCard({ leagueId: 71, requestId: id, head });
  assert.equal(r.status, 'mismatch');
  assert.equal(r.exit, 1);
  assert.ok(r.surfaces[0].diffs.some(d => d.entity === 'deal:1|2|102>201' && d.field === 'title_delta'), JSON.stringify(r.surfaces[0].diffs));
});

test('B4: a response served with the flag off has no pin and is not reproduced', async () => {
  const { trade_impact: id } = await serveAll();
  const r = await repro.reproduceCard({ leagueId: 71, requestId: id, head });
  assert.equal(r.status, 'no_pin');
  assert.equal(r.exit, 2);
});

test('B4: an unknown running code sha is not reproduced', async () => {
  process.env.GRIDIRON_SERVE_PIN = '1';
  const { trade_impact: id } = await serveAll();
  const r = await repro.reproduceCard({ leagueId: 71, requestId: id, head: { sha: null, reason: 'no git' } });
  assert.equal(r.status, 'code_unknown');
  assert.equal(r.exit, 2);
});

test('B4: a War Room card needs a producer run and says which', async () => {
  process.env.GRIDIRON_SERVE_PIN = '1';
  const { war_room: id } = await serveAll();
  const r = await repro.reproduceCard({ leagueId: 71, requestId: id, head });
  assert.equal(r.status, 'producer_run_needed');
  assert.equal(r.exit, 2);
  assert.match(r.surfaces[0].fix, /produce-plans\.mjs --leagues 71/);
});

test('B4: no drift case reports reproduced (summary)', () => {
  for (const s of ['snapshot_mismatch', 'code_mismatch', 'mismatch', 'no_pin', 'code_unknown', 'producer_run_needed']) {
    assert.notEqual(repro.REPRO_EXIT[s], 0, s);
  }
  assert.equal(repro.REPRO_EXIT.reproduced, 0);
});

// ------------------------------------------------------------------ B5
test('B5: unseeded title odds run on a keyed, recorded seed; an explicit seed is recorded as given', async () => {
  process.env.GRIDIRON_SERVE_PIN = '1';
  const a = await call('GET', '/api/model/71/simulate?runs=250');
  const b = await call('GET', '/api/model/71/simulate?runs=250');
  const c = await call('GET', '/api/model/71/simulate?runs=250&seed=5');
  serveLog.flushServed();
  const seedOf = id => row('SELECT seed FROM served_pins WHERE request_id = ?', id).seed;
  const want = pin.titleOddsSeed(leagueRow(71), { runs: 250, fromWeek: null });
  assert.equal(seedOf(a.requestId), want);
  assert.equal(seedOf(b.requestId), want, 'same sync, same seed');
  assert.deepEqual(a.body.teams, b.body.teams, 'same numbers');
  assert.equal(seedOf(c.requestId), 5);
});

// ------------------------------------------------------------------ B6
test('B6: the league payload is hashed once per sync, and a 2 MB payload hashes fast', () => {
  const lg = leagueRow(71);
  for (let i = 0; i < 10; i++) pin.snapshotPin(lg);
  assert.equal(pin.snapshotHashCount(), 1, '10 reads of one sync = 1 hash');
  pin.snapshotPin({ ...lg, fetched_at: '2026-09-24 12:15:00' });
  assert.equal(pin.snapshotHashCount(), 2, 'a new sync = 1 more');
  const big = { id: 99, fetched_at: 'x', payload: JSON.stringify({ blob: 'y'.repeat(2 * 1024 * 1024) }) };
  const t0 = process.hrtime.bigint();
  const s = pin.snapshotPin(big);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`# B6: 2 MB payload hashed in ${ms.toFixed(2)} ms`);
  assert.match(s.sha256, /^[0-9a-f]{64}$/);
  assert.ok(ms < 200, `${ms} ms`);
});

// ------------------------------------------------------------------ B7
test('B7: code sha comes from GRIDIRON_CODE_SHA, else .git/HEAD, else null with a reason', () => {
  assert.deepEqual(pin.codePin({ env: { GRIDIRON_CODE_SHA: SHA }, fresh: true }), { sha: SHA, source: 'env' });
  const repo = fs.mkdtempSync(path.join(temp, 'repo-'));
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x']);
  const want = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim();
  assert.deepEqual(pin.codePin({ env: {}, repoDir: repo, fresh: true }), { sha: want, source: 'git' });
  execFileSync('git', ['-C', repo, 'pack-refs', '--all']);
  assert.deepEqual(pin.codePin({ env: {}, repoDir: repo, fresh: true }), { sha: want, source: 'git' }, 'packed refs');
  const none = pin.codePin({ env: {}, repoDir: path.join(temp, 'no-repo'), fresh: true });
  assert.equal(none.sha, null);
  assert.ok(none.reason);
});

test('B7: no code sha still writes the pin (sha null + reason); the command answers code_unknown', async () => {
  process.env.GRIDIRON_SERVE_PIN = '1';
  delete process.env.GRIDIRON_CODE_SHA;
  pin.__resetServePin({ codeRepoDir: path.join(temp, 'no-repo') });
  const { trade_impact: id } = await serveAll();
  const p = row('SELECT * FROM served_pins WHERE request_id = ?', id);
  assert.equal(p.code_sha, null);
  assert.ok(JSON.parse(p.pin).code.reason);
  const r = await repro.reproduceCard({ leagueId: 71, requestId: id, head: pin.codePin() });
  assert.equal(r.status, 'code_unknown');
});

test('B7: a failed pin write rolls back the batch\'s numbers too and throws', async () => {
  process.env.GRIDIRON_SERVE_PIN = '1';
  const lg = leagueRow(71);
  serveLog.recordServed(null, 'war_room', lg, WAR_ROOM, {}, { args: {} });
  db.exec('ALTER TABLE served_pins RENAME TO served_pins_away');
  try {
    assert.throws(() => serveLog.flushServed(), /served_pins/);
    assert.equal(row('SELECT COUNT(*) n FROM served_numbers').n, 0, 'numbers rolled back with the pin');
    assert.equal(serveLog.serveLogState().queued, 1, 'batch back on the queue');
  } finally { db.exec('ALTER TABLE served_pins_away RENAME TO served_pins'); }
  serveLog.flushServed();
  assert.equal(row('SELECT COUNT(*) n FROM served_pins').n, 1);
});

// ------------------------------------------------------------------ B8
const CLI = new URL('../scripts/eval/repro-card.mjs', import.meta.url).pathname;
const cli = args => spawnSync(process.execPath, [CLI, '--db', process.env.GRIDIRON_DB_PATH, ...args],
  { encoding: 'utf8', env: { ...process.env, GRIDIRON_CODE_SHA: SHA } });

test('B8: the command prints a verdict, exits 2 on a card it cannot reproduce, and picks --latest', async () => {
  process.env.GRIDIRON_SERVE_PIN = '1';
  const { war_room: id } = await serveAll();
  const miss = cli(['--league', '71', '--request-id', 'nope', '--json']);
  assert.equal(miss.status, 2, miss.stderr);
  assert.equal(JSON.parse(miss.stdout).status, 'not_found');
  const wr = cli(['--league', '71', '--request-id', id]);
  assert.equal(wr.status, 2, wr.stderr);
  assert.match(wr.stdout, /needs a producer run/);
  const latest = cli(['--league', '71', '--latest', '--surface', 'war_room', '--json']);
  assert.equal(JSON.parse(latest.stdout).request_id, id);
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--request-id/);
});
