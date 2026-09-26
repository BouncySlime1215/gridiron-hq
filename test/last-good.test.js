/**
 * OFFLINE / LAST-GOOD MODE (Batch D item 53): a failed refresh keeps the last good plan on
 * screen with its "as of" time and blocks sending until a refresh succeeds.
 *
 * Pre-registered bar (docs/tdd/2026-09-26-last-good.tdd.md), all on made-up leagues:
 *  B1 flag off: the view is deepEqual to main's and neither send route reads sync_log.
 *  B2 flag on + a failed ESPN league sync or plan refresh: every plan section is served
 *     unchanged, plus `last_good` with as_of = the plans' generated_at and send_blocked.
 *  B3 flag on + failed: POST /requests offer.sent and POST /negotiations answer 409 with
 *     the reason, and record nothing.
 *  B4 a later successful run clears it: no `last_good`, the send routes pass the gate.
 *  B5 fail closed: a 'running' step older than 90 min, or a sync_log that cannot be read,
 *     blocks; a job with no row is no evidence and does not.
 *  B6 no dev text: the reason names no job id, table, path or env name.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-last-good-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.GRIDIRON_WARROOM_PLANS = path.join(temp, 'no-plans.json');
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
delete process.env.GRIDIRON_LAST_GOOD;

const { db, row, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const LG = await import('../server/services/campaign/last-good.js');
const { buildWarRoomView } = await import('../server/services/war-room-view.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');
const { negotiateRouter } = await import('../server/routes/warroom-negotiate.js');
const { default: warroomRouter } = await import('../server/routes/warroom.js');
const express = (await import('express')).default;

const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'warroom-contract', 'producer-plans.json'), 'utf8'));
const FLAG = { enabled: true, preview: false };
const NOW = Date.parse('2026-09-26T12:00:00.000Z');
const AS_OF = '2026-09-26T09:00:00.000Z';
const PLANS = { status: 'ok', entries: structuredClone(FIXTURE.leagues), as_of: AS_OF, id: 'plans@1' };
const LEAGUE = FIXTURE.leagues[0].league;
const ON = { [LG.LAST_GOOD_ENV]: '1' };

const syncRow = (job, last_status, extra = {}) => ({
  job, last_run_at: '2026-09-26T11:45:00.000Z', last_status, last_detail: null,
  consecutive_failures: last_status === 'error' ? 1 : 0, ...extra
});
const setSync = list => {
  run('DELETE FROM sync_log');
  for (const r of list) {
    run(`INSERT INTO sync_log (job, last_run_at, last_status, last_detail, runs, consecutive_failures) VALUES (?,?,?,?,1,?)`,
      r.job, r.last_run_at, r.last_status, r.last_detail, r.consecutive_failures);
  }
};
const withEnv = async (env, fn) => {
  const keep = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(keep)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  }
};

/* ------------------------------------------------------------------ app */

run(`INSERT INTO users (subject, display_name) VALUES ('owner', 'owner')`);
const owner = row('SELECT last_insert_rowid() AS id').id;
run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?,?,datetime('now','+1 day'))`, owner, hashSessionToken('owner-token'));
run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, team_count, my_team_id, fetched_at)
     VALUES (?, 'espn', 'lg-1', 2026, 'League A', '{"teams":[]}', 12, '1', '2026-09-26T05:00:00Z')`, LEAGUE);
run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (?, ?, 'commissioner')`, LEAGUE, owner);

const served = buildWarRoomView(LEAGUE, PLANS, FLAG, { now: NOW, env: {} });
const MOVE = served.alternatives?.value?.[0] ?? served.next_move?.value;
let negotiateGateCalls = 0;
const app = express();
app.use(express.json());
app.use('/api/warroom', ...legacyAuthenticated, negotiateRouter({
  view: async () => structuredClone(served), plans: async () => PLANS, clock: () => NOW,
  lastGood: async opts => { negotiateGateCalls++; return LG.currentLastGood({ ...opts, now: NOW }); }
}));
app.use('/api/warroom', ...legacyAuthenticated, warroomRouter);
app.use((err, _req, res, _next) => res.status(Number.isInteger(err.status) ? err.status : 500).json({ error: err.message }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/warroom/${LEAGUE}`;
test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const post = async (url, body) => {
  const res = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const LIVE = { GRIDIRON_WARROOM_ENABLED: '1', GRIDIRON_NEGOTIATE_UI: '1' };
const sendOffer = () => post(`${base}/requests`, { kind: 'offer.sent', payload: { move_id: MOVE.move_id ?? MOVE.id } });
const openThread = () => post(`${base}/negotiations`, { move_id: MOVE.move_id ?? MOVE.id, step_index: 0 });
const recorded = () => row(`SELECT COUNT(*) AS n FROM warroom_requests WHERE kind = 'offer.sent'`).n
  + row('SELECT COUNT(*) AS n FROM negotiation_threads').n;

/* ------------------------------------------------------------------ pure */

test('the flag: off unless exactly 1', () => {
  assert.equal(LG.lastGoodFlag({}), 'off');
  assert.equal(LG.lastGoodFlag({ [LG.LAST_GOOD_ENV]: 'true' }), 'off');
  assert.equal(LG.lastGoodFlag({ [LG.LAST_GOOD_ENV]: '0' }), 'off');
  assert.equal(LG.lastGoodFlag(ON), 'on');
});

test('B2/B5 jobFailure: error, running after an error, and stuck count; ok, fresh running and other jobs do not', () => {
  const now = NOW;
  assert.equal(LG.jobFailure(syncRow('league_rosters', 'ok'), { now }), null);
  assert.equal(LG.jobFailure(syncRow('nfl_lines', 'error'), { now }), null, 'only the refresh steps count');
  assert.deepEqual(LG.jobFailure(syncRow('league_rosters', 'error', { consecutive_failures: 3 }), { now }),
    { job: 'league_rosters', label: 'ESPN league sync', kind: 'error', since: '2026-09-26T11:45:00.000Z', consecutive: 3 });
  assert.equal(LG.jobFailure(syncRow('warroom_plans', 'running', { consecutive_failures: 2 }), { now }).kind, 'error');
  const started = m => JSON.stringify({ running: true, started_at: new Date(now - m * 60_000).toISOString() });
  assert.equal(LG.jobFailure(syncRow('warroom_plans', 'running', { last_detail: started(30) }), { now }), null);
  assert.equal(LG.jobFailure(syncRow('warroom_plans', 'running', { last_detail: started(LG.STUCK_MINUTES) }), { now }), null, '90 min is the edge');
  assert.equal(LG.jobFailure(syncRow('warroom_plans', 'running', { last_detail: started(LG.STUCK_MINUTES + 1) }), { now }).kind, 'stuck');
});

test('B5 refreshState: no rows is ok (no evidence); an unreadable log is its own status', () => {
  assert.deepEqual(LG.refreshState({ rows: [], now: NOW }), { status: 'ok', failed: [] });
  assert.equal(LG.refreshState({ readError: new Error('no such table: sync_log') }).status, 'unreadable');
  const s = LG.refreshState({ rows: [syncRow('warroom_plans', 'error'), syncRow('league_rosters', 'error')], now: NOW });
  assert.deepEqual(s.failed.map(f => f.job), ['league_rosters', 'warroom_plans'], 'fixed order');
});

test('B6 the block: as_of is the plans time, send blocked, the reason is plain English with no dev text', () => {
  const s = LG.refreshState({ rows: [syncRow('league_rosters', 'error'), syncRow('warroom_plans', 'error')], now: NOW });
  const b = LG.lastGoodBlock(s, { plansAsOf: AS_OF });
  assert.equal(b.as_of, AS_OF);
  assert.equal(b.send_blocked, true);
  assert.equal(b.failed_since, '2026-09-26T11:45:00.000Z');
  assert.equal(b.reason, 'Offline: the last ESPN league sync and plan refresh failed, so this is the last good plan. Sending is paused until a refresh succeeds.');
  const unreadable = LG.lastGoodBlock(LG.refreshState({ readError: new Error('x') }), { plansAsOf: null });
  assert.match(unreadable.reason, /refresh record could not be read.*its time is unknown/);
  for (const text of [b.reason, unreadable.reason, ...b.failed.map(f => f.label)]) {
    assert.doesNotMatch(text, /league_rosters|warroom_plans|sync_log|GRIDIRON_|\/|\.js|\.json/, text);
  }
  assert.equal(LG.lastGoodBlock({ status: 'ok', failed: [] }), null);
});

test('B1/B5 currentLastGood: off never reads; on reads, and an unreadable log fails closed', async () => {
  let reads = 0;
  const read = () => { reads++; return [syncRow('league_rosters', 'error')]; };
  assert.equal(await LG.currentLastGood({ env: {}, read }), null);
  assert.equal(reads, 0, 'flag off never reads sync_log');
  assert.equal((await LG.currentLastGood({ env: ON, read, plansAsOf: AS_OF, now: NOW })).as_of, AS_OF);
  assert.equal(reads, 1);
  const closed = await LG.currentLastGood({ env: ON, read: () => { throw new Error('SQLITE_CORRUPT'); } });
  assert.equal(closed.send_blocked, true);
  assert.equal(await LG.currentLastGood({ env: ON, read: () => [syncRow('league_rosters', 'ok')], now: NOW }), null);
  // The default reader: the app DB's sync_log, parameterised.
  setSync([syncRow('warroom_plans', 'error')]);
  assert.deepEqual((await LG.currentLastGood({ env: ON, now: NOW })).failed.map(f => f.label), ['plan refresh']);
  setSync([]);
});

/* ------------------------------------------------------------------ view */

test('B1 the view without a last_good block is exactly main\'s view', () => {
  const plain = buildWarRoomView(LEAGUE, PLANS, FLAG, { now: NOW, env: {} });
  assert.deepEqual(buildWarRoomView(LEAGUE, PLANS, FLAG, { now: NOW, env: {}, lastGood: null }), plain);
  assert.equal('last_good' in plain, false);
});

test('B2 a failed refresh serves every plan section unchanged, plus last_good with the plans\' as-of time', () => {
  const plain = buildWarRoomView(LEAGUE, PLANS, FLAG, { now: NOW, env: {} });
  const block = LG.lastGoodBlock(LG.refreshState({ rows: [syncRow('league_rosters', 'error')], now: NOW }), { plansAsOf: PLANS.as_of });
  const v = buildWarRoomView(LEAGUE, PLANS, FLAG, { now: NOW, env: {}, lastGood: block });
  const { last_good, ...rest } = v;
  assert.deepEqual(rest, plain, 'the last good plan is served as it was');
  assert.deepEqual(last_good, block);
  assert.equal(last_good.as_of, v.snapshot.as_of);
  assert.equal(last_good.send_blocked, true);
});

/* ------------------------------------------------------------------ routes */

test('B1 flag off: a failed sync row changes nothing on either send route', async () => {
  setSync([syncRow('league_rosters', 'error')]);
  await withEnv({ ...LIVE, [LG.LAST_GOOD_ENV]: null }, async () => {
    const a = await sendOffer();
    const b = await openThread();
    assert.equal(a.body.last_good, undefined);
    assert.equal(b.body.last_good, undefined);
  });
});

test('B3 flag on + a failed refresh: both send routes answer 409 with the reason and record nothing', async () => {
  setSync([syncRow('league_rosters', 'error')]);
  const before = recorded();
  await withEnv({ ...LIVE, ...ON }, async () => {
    const calls = negotiateGateCalls;
    const a = await sendOffer();
    assert.equal(a.status, 409);
    assert.equal(a.body.last_good.send_blocked, true);
    assert.match(a.body.error, /^Offline: .*Sending is paused until a refresh succeeds\.$/);
    const b = await openThread();
    assert.equal(b.status, 409);
    assert.equal(b.body.last_good.send_blocked, true);
    assert.equal(negotiateGateCalls, calls + 1);
  });
  assert.equal(recorded(), before, 'nothing recorded');
});

test('B5 flag on + a stuck plan refresh blocks too', async () => {
  setSync([{ ...syncRow('warroom_plans', 'running'),
    last_detail: JSON.stringify({ running: true, started_at: new Date(Date.now() - 3 * 3_600_000).toISOString() }) }]);
  await withEnv({ ...LIVE, ...ON }, async () => {
    const a = await sendOffer();
    assert.equal(a.status, 409);
    assert.equal(a.body.last_good.failed[0].kind, 'stuck');
  });
});

test('B4 a later successful run clears the block on both routes', async () => {
  setSync([syncRow('league_rosters', 'ok'), syncRow('warroom_plans', 'ok')]);
  await withEnv({ ...LIVE, ...ON }, async () => {
    const a = await sendOffer();
    const b = await openThread();
    assert.equal(a.body.last_good, undefined, JSON.stringify(a.body));
    assert.equal(b.body.last_good, undefined, JSON.stringify(b.body));
  });
  assert.ok(rows('SELECT job FROM sync_log').length === 2);
});
