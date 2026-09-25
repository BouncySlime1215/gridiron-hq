/**
 * PUSH-01 (NORTH-STAR-PLAN row 7): a push when the War Room's next move changes.
 *
 * Before this unit the producer appended one row per changed league to
 * pushes.jsonl (scripts/campaign/produce-plans.mjs) and nothing in the repo read
 * that file, so no change ever reached Nick. These tests pin the replacement:
 * the producer's run is diffed against stored state (next_move.move_id and the
 * objective's feasibility status), each change queues exactly one alert, a
 * repeat run or a flip back before delivery sends nothing, 23:00-08:00 ET holds
 * the alert, and the whole thing is off unless its own flag is on (never preview mode).
 * Plan item 16: a push goes out only for a changed next move that passes every one of
 * Nick's rules (never-give.js#ruleVerdict, the ONE rule gate) and beats doing nothing;
 * a goal-feasibility change rides along with such a push, never alone.
 * In-memory SQLite, stand-in sender, no network, no real league data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const push = await import('../server/services/campaign/push-alerts.js');
const { ruleVerdict, PINNED_NEVER_GIVE, PINNED_NEVER_GET } = await import('../server/services/campaign/never-give.js');
const mig = await import('../server/migrations/091_warroom_push_alerts.js');

const fresh = () => { const d = new DatabaseSync(':memory:'); mig.up(d); return d; };

// 2026-09-24 is EDT (UTC-4): 14:00Z = 10 AM ET, 07:00Z = 3 AM ET, 12:00Z = 8 AM ET.
const DAY = '2026-09-24T14:00:00.000Z';
const NIGHT = '2026-09-24T07:00:00.000Z';
const EIGHT = '2026-09-24T12:00:00.000Z';

// Made-up players. Nick gives 4 + 7 (depth) for 22 (a Blue chip, 88): he gets more market value than he gives.
const FC = new Map([['4', 3000], ['7', 2000], ['22', 5200], ['30', 3100], ['31', 9000], ['160', 7000], ['80', 6000], ['277', 6500], ['290', 5000], ['55', 5000]]);
const SCORE = new Map([['4', 70], ['7', 65], ['22', 88], ['30', 72], ['31', 90], ['290', 86], ['55', 85]]);
// The rule gate as the producer builds it (never-give.js#ruleGate), on made-up rules: the real ruleVerdict.
const RULES = { neverGive: new Set(PINNED_NEVER_GIVE), neverGet: new Set(PINNED_NEVER_GET), sold: new Set(['55']),
  fc: FC, scoreOf: id => SCORE.get(String(id)) ?? null, closed: null };
const GATE = { check: t => ruleVerdict(RULES, t) };
const gateFor = () => GATE;
const LEGAL = [{ partner: '3', give: ['4', '7'], get: ['22'], title_odds_delta: { status: 'ok', value: 0.05, clears_2se: true } }];
const gain = v => ({ status: 'ok', value: v, source: 'sim.title', unit: 'title_odds' });
const move = (id, change_reason, steps = LEGAL, delta = gain(0.05)) => ({ status: 'ok', source: 'plan.path',
  value: { move_id: id, steps, delta_final: delta, ...(change_reason ? { change_reason } : {}) } });
const noMove = { status: 'unknown', reason: 'The planner found no trade path worth sending this week.', source: 'plan.path' };
// Served contract fields only (FIX-293-1): no `_run` on any entry these tests build.
const feasOk = (status, change_reason) => ({ status: 'ok', source: 'sim.title',
  value: { points_per_week: 120, status, ...(change_reason ? { change_reason } : {}) } });
const entry = (league, next_move, feas = null) => ({
  league, me: '1', names: {}, next_move,
  feasibility: feas ? feasOk(feas) : { status: 'unknown', reason: 'points objective not set', source: 'sim.title' }
});
const file = (at, ...leagues) => ({ schema: 'warroom-plans/1', generated_at: at, leagues });

function sender() {
  const sent = [];
  const send = async msg => { sent.push(msg); return { channel: 'test' }; };
  return { sent, send };
}
const ON = { GRIDIRON_WARROOM_PUSH_ENABLED: '1' };
// Every call passes the gate unless the test is about the gate.
const run = (d, f, o = {}) => push.runPushAlerts(d, f, { gateFor, ...o });

test('migration 091 is additive: two new tables, nothing dropped or altered', () => {
  const src = fs.readFileSync(new URL('../server/migrations/091_warroom_push_alerts.js', import.meta.url), 'utf8');
  const up = src.slice(src.indexOf('export function up'), src.indexOf('export function down'));
  assert.doesNotMatch(up, /DROP|ALTER|DELETE/i);
  const d = fresh();
  const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  assert.deepEqual(tables, ['warroom_push_alerts', 'warroom_push_state']);
  mig.up(d); // idempotent
  const q = d.prepare("INSERT INTO warroom_push_alerts (league_id, kind, from_value, to_value, reason, created_at) VALUES ('1', 'next_move', 'a', 'b', 'r', 't')");
  q.run();
  assert.throws(() => q.run(), /UNIQUE/, 'at most one queued alert per league and kind');
});

test('first run records a baseline and pushes nothing (turning the flag on is not a flood)', async () => {
  const d = fresh(); const s = sender();
  const r = await run(d, file(DAY, entry(1, move('L1-a')), entry(2, move('L2-a'), 'reachable')), { env: ON, now: new Date(DAY), send: s.send });
  assert.equal(r.status, 'ok');
  assert.equal(r.queued, 0);
  assert.equal(s.sent.length, 0);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM warroom_push_state').get().n, 3);
});

test('a changed next_move.move_id sends exactly one push; the same move on the next run sends none', async () => {
  const d = fresh(); const s = sender(); const o = { env: ON, send: s.send };
  await run(d, file(DAY, entry(1, move('L1-a'))), { ...o, now: new Date(DAY) });
  const r = await run(d, file(DAY, entry(1, move('L1-b', 'better partner now: Team 3'))), { ...o, now: new Date(DAY) });
  assert.equal(r.queued, 1); assert.equal(r.sent, 1);
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].league, '1');
  assert.match(s.sent[0].text, /next move/i);
  assert.match(s.sent[0].text, /better partner now/);
  const again = await run(d, file(DAY, entry(1, move('L1-b'))), { ...o, now: new Date(DAY) });
  assert.equal(again.queued, 0); assert.equal(again.sent, 0);
  assert.equal(s.sent.length, 1, 'dedupe: one push per change');
});

test('no move clearing the bar pushes nothing (it is not a move); a failed league is not a change', async () => {
  const d = fresh(); const s = sender(); const o = { env: ON, send: s.send, now: new Date(DAY) };
  await run(d, file(DAY, entry(1, move('L1-a'))), o);
  await run(d, file(DAY, { league: 1, me: '1', names: {}, error: 'world failed: x' }), o);
  assert.equal(s.sent.length, 0, 'a failed run is not a change of move');
  await run(d, file(DAY, entry(1, move('L1-a'))), o);
  assert.equal(s.sent.length, 0, 'recovering to the same move is not a change either');
  const r = await run(d, file(DAY, entry(1, noMove)), o);
  assert.equal(r.queued, 0);
  assert.equal(s.sent.length, 0, 'plan item 16: only a changed move that passes the rules is pushed');
});

test('a feasibility change alone waits; it rides along with the next move push, once', async () => {
  const d = fresh(); const s = sender(); const o = { env: ON, send: s.send, now: new Date(DAY) };
  await run(d, file(DAY, entry(4, move('L4-a'), 'reachable')), o);
  const r = await run(d, file(DAY, entry(4, move('L4-a'), 'out_of_reach')), o);
  assert.equal(r.queued, 1); assert.equal(r.waiting, 1);
  assert.equal(s.sent.length, 0, 'the next move did not change: no push');
  assert.match(r.line, /waiting 1/);
  await run(d, file(DAY, entry(4, move('L4-b'), 'out_of_reach')), o);
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].text, /next move/i);
  assert.match(s.sent[0].text, /out of reach/);
  await run(d, file(DAY, entry(4, move('L4-b'), 'out_of_reach')), o);
  assert.equal(s.sent.length, 1);
});

test('a move and a feasibility change in one run are one push for that league', async () => {
  const d = fresh(); const s = sender(); const o = { env: ON, send: s.send, now: new Date(DAY) };
  await run(d, file(DAY, entry(5, move('L5-a'), 'on_track')), o);
  await run(d, file(DAY, entry(5, move('L5-b'), 'reachable')), o);
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].text, /next move/i);
  assert.match(s.sent[0].text, /reachable/);
});

test('quiet hours 23:00-08:00 ET hold the push; the next run from 8 AM sends only the latest move', async () => {
  const d = fresh(); const s = sender(); const o = { env: ON, send: s.send };
  assert.equal(push.inQuietHours(new Date(NIGHT)), true);
  assert.equal(push.inQuietHours(new Date('2026-09-25T02:59:00.000Z')), false, '10:59 PM EDT is not quiet');
  assert.equal(push.inQuietHours(new Date('2026-09-25T03:00:00.000Z')), true, '11:00 PM EDT is quiet');
  assert.equal(push.inQuietHours(new Date('2026-09-24T04:59:00.000Z')), true, '12:59 AM EDT is quiet');
  assert.equal(push.inQuietHours(new Date('2026-09-24T11:59:00.000Z')), true, '7:59 AM EDT is quiet');
  assert.equal(push.inQuietHours(new Date(EIGHT)), false, '8:00 AM ET is not quiet');
  assert.equal(push.inQuietHours(new Date('2026-12-01T03:59:00.000Z')), false, '10:59 PM EST (UTC-5) is not quiet');
  assert.equal(push.inQuietHours(new Date('2026-12-01T04:00:00.000Z')), true, '11:00 PM EST is quiet');
  assert.equal(push.inQuietHours(new Date('2026-12-01T12:30:00.000Z')), true, '7:30 AM EST is quiet');
  assert.equal(push.inQuietHours(new Date('2026-12-01T13:00:00.000Z')), false, '8:00 AM EST is not quiet');
  await run(d, file(NIGHT, entry(1, move('L1-a'))), { ...o, now: new Date(NIGHT) });
  const r1 = await run(d, file(NIGHT, entry(1, move('L1-b'))), { ...o, now: new Date(NIGHT) });
  assert.equal(r1.held, 1); assert.equal(s.sent.length, 0);
  const r2 = await run(d, file(NIGHT, entry(1, move('L1-c'))), { ...o, now: new Date(NIGHT) });
  assert.equal(r2.superseded, 1); assert.equal(s.sent.length, 0);
  await run(d, file(EIGHT, entry(1, move('L1-c'))), { ...o, now: new Date(EIGHT) });
  assert.equal(s.sent.length, 1, 'one push for the night, about the move that stands');
  const rows = d.prepare("SELECT status, to_value FROM warroom_push_alerts ORDER BY id").all().map(r => `${r.status}:${r.to_value}`);
  assert.deepEqual(rows, ['superseded:L1-b', 'sent:L1-c']);
});

test('a move that flips back before delivery sends nothing', async () => {
  const d = fresh(); const s = sender(); const o = { env: ON, send: s.send };
  await run(d, file(NIGHT, entry(1, move('L1-a'))), { ...o, now: new Date(NIGHT) });
  await run(d, file(NIGHT, entry(1, move('L1-b'))), { ...o, now: new Date(NIGHT) });
  await run(d, file(NIGHT, entry(1, move('L1-a'))), { ...o, now: new Date(NIGHT) });
  await run(d, file(EIGHT, entry(1, move('L1-a'))), { ...o, now: new Date(EIGHT) });
  assert.equal(s.sent.length, 0);
});

test('after a push is sent, moving back to the old move is a new change and pushes again', async () => {
  const d = fresh(); const s = sender(); const o = { env: ON, send: s.send, now: new Date(DAY) };
  await run(d, file(DAY, entry(1, move('L1-a'))), o);
  await run(d, file(DAY, entry(1, move('L1-b'))), o);
  await run(d, file(DAY, entry(1, move('L1-a'))), o);
  assert.equal(s.sent.length, 2, 'Nick was told L1-b; L1-a is news again');
});

test('a failed send stays queued with its error and retries; three failures mark it failed', async () => {
  const d = fresh(); let calls = 0;
  const send = async () => { calls++; throw new Error('channel down'); };
  const o = { env: ON, send, now: new Date(DAY) };
  await run(d, file(DAY, entry(1, move('L1-a'))), o);
  const r = await run(d, file(DAY, entry(1, move('L1-b'))), o);
  assert.equal(r.failed, 1);
  assert.match(r.line, /channel down/);
  await run(d, file(DAY, entry(1, move('L1-b'))), o);
  await run(d, file(DAY, entry(1, move('L1-b'))), o);
  await run(d, file(DAY, entry(1, move('L1-b'))), o);
  assert.equal(calls, 3);
  const row = d.prepare('SELECT status, attempts, error FROM warroom_push_alerts').get();
  assert.deepEqual({ ...row }, { status: 'failed', attempts: 3, error: 'channel down' });
});

test('no channel configured: the alert stays queued and the summary says why', async () => {
  const d = fresh(); const o = { env: ON, send: null, now: new Date(DAY) };
  await run(d, file(DAY, entry(1, move('L1-a'))), o);
  const r = await run(d, file(DAY, entry(1, move('L1-b'))), o);
  assert.equal(r.unsent, 1);
  assert.match(r.line, /no push channel/);
});

test('flag: off by default touches nothing; preview mode never turns it on (plan rule: own flag only)', async () => {
  const d = fresh(); const s = sender();
  const off = await run(d, file(DAY, entry(1, move('L1-a'))), { env: {}, now: new Date(DAY), send: s.send });
  assert.equal(off.status, 'off');
  assert.equal(d.prepare('SELECT COUNT(*) n FROM warroom_push_state').get().n, 0);
  const saved = process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
  process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
  try {
    const r = await run(d, file(DAY, entry(1, move('L1-a'))), { env: { GRIDIRON_PREVIEW_UNCONFIRMED: '1' }, now: new Date(DAY), send: s.send });
    assert.equal(r.status, 'off', 'preview mode is not this unit\'s switch');
    assert.equal(d.prepare('SELECT COUNT(*) n FROM warroom_push_state').get().n, 0);
  } finally {
    if (saved === undefined) delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED; else process.env.GRIDIRON_PREVIEW_UNCONFIRMED = saved;
  }
  const src = fs.readFileSync(new URL('../server/services/campaign/push-alerts.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /preview-mode|previewUnconfirmed/);
});

test('the table missing (091 not applied yet) is reported inert, not swallowed', async () => {
  const d = new DatabaseSync(':memory:');
  const r = await run(d, file(DAY, entry(1, move('L1-a'))), { env: ON, now: new Date(DAY), send: null });
  assert.equal(r.status, 'inert');
  assert.match(r.line, /091/);
});

test('the push carries no league or manager names, only the league id', async () => {
  const d = fresh(); const s = sender(); const o = { env: ON, send: s.send, now: new Date(DAY) };
  const named = (id) => ({ ...entry(1, move(id, 'better partner now: Team 3')), names: { 3: 'Some Manager' } });
  await run(d, file(DAY, named('L1-a')), o);
  await run(d, file(DAY, named('L1-b')), o);
  assert.doesNotMatch(s.sent[0].text, /Some Manager/);
});

test('the producer hands every run to the push step (the unread pushes.jsonl is gone)', () => {
  const src = fs.readFileSync(new URL('../scripts/campaign/produce-plans.mjs', import.meta.url), 'utf8');
  assert.match(src, /await runPushAlerts\(svc\.db\.db, file, \{ env, gateFor \}\)/, 'the live plans file, the process env and the rule gate reach the push step');
  assert.match(src, /ruleGate\(svc\.db, \{ leagueId/, 'the gate is never-give.js#ruleGate, the ONE rule gate');
  assert.doesNotMatch(src, /pushes\.jsonl/);
});

test('senders: ntfy when its URL is set, macOS notification on darwin, otherwise none', () => {
  assert.equal(push.defaultSender({}, 'linux'), null);
  assert.equal(typeof push.defaultSender({ GRIDIRON_PUSH_NTFY_URL: 'https://ntfy.example/topic' }, 'linux'), 'function');
  assert.equal(typeof push.defaultSender({}, 'darwin'), 'function');
});

test('FIX-293-1: a plans file without _run still yields both kinds, from served fields only', async () => {
  const e = { league: 7, me: '1', names: {},
    next_move: move('L7-b', 'better partner now: Team 3'),
    feasibility: feasOk('out_of_reach', 'was reachable with a trade, now out of reach (chance 40% -> 12%)') };
  assert.equal('_run' in e, false);
  const obs = push.observedValues(e);
  assert.deepEqual(obs.map(o => o.kind), ['next_move', 'feasibility']);
  assert.equal(obs[0].reason, 'better partner now: Team 3');
  assert.equal(obs[1].value, 'out_of_reach');
  assert.match(obs[1].reason, /now out of reach \(was reachable/);

  // A non-points league carries its status on feasibility_points.outlook.
  const side = { league: 8, me: '1', names: {}, next_move: move('L8-a'),
    feasibility: { status: 'unknown', reason: 'planned on title odds', source: 'sim.title' },
    feasibility_points: { status: 'ok', source: 'sim.title', value: { outlook: 'reachable' } } };
  assert.deepEqual(push.observedValues(side).map(o => [o.kind, o.value]), [['next_move', 'L8-a'], ['feasibility', 'reachable']]);

  // _run alone is never read: an entry whose only feasibility is in _run watches no feasibility.
  const runOnly = { league: 9, me: '1', names: {}, next_move: move('L9-a'),
    _run: { changed: { changed: true, reason: 'from _run' }, feasibility_detail: { kind: 'points', status: 'reachable' } } };
  const o9 = push.observedValues(runOnly);
  assert.deepEqual(o9.map(o => o.kind), ['next_move']);
  assert.notEqual(o9[0].reason, 'from _run');

  // End to end without _run: baseline, then both change -> one message with both reasons.
  const d = fresh(); const s = sender();
  await run(d, file(DAY, entry(7, move('L7-a'), 'reachable')), { env: ON, now: new Date(DAY), send: s.send });
  const r = await run(d, file(DAY, e), { env: ON, now: new Date(DAY), send: s.send });
  assert.equal(r.queued, 2);
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].text, /better partner now/);
  assert.match(s.sent[0].text, /out of reach/);
});

test('preview-mode.js does not list push-alerts.js (no preview activation)', () => {
  const src = fs.readFileSync(new URL('../server/services/preview-mode.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /push-alerts/);
});

test('FIX-293-1: the real producer fixture with every _run deleted still yields both kinds and their reasons', () => {
  const plans = JSON.parse(fs.readFileSync(new URL('./fixtures/warroom-contract/producer-plans.json', import.meta.url), 'utf8'));
  for (const e of plans.leagues) delete e._run;
  const by = Object.fromEntries(plans.leagues.map(e => [e.league, push.observedValues(e)]));
  const four = Object.fromEntries(by[4].map(o => [o.kind, o]));
  assert.equal(four.next_move.reason, 'new numbers moved a different deal to the top');
  assert.equal(four.feasibility.value, 'reachable');
  assert.match(four.feasibility.reason, /was out of reach, now reachable/);
  const three = Object.fromEntries(by[3].map(o => [o.kind, o]));
  assert.equal(three.feasibility.value, 'on_track');
  assert.match(three.feasibility.reason, /was reachable with a trade, now on track/);
  assert.deepEqual(by[2], [], 'a failed league is not read');
});

/* ------------------------------------------------ plan item 16: every rule, before any push */

const leg = (give, get, clears = true) => ({ partner: '3', give, get, title_odds_delta: { status: 'ok', value: 0.04, clears_2se: clears } });
const blockedRows = d => d.prepare("SELECT status, to_value, reason FROM warroom_push_alerts WHERE status = 'blocked' ORDER BY id").all();

async function afterLegal(bad, o = {}) {
  const d = fresh(); const s = sender(); const opt = { env: ON, send: s.send, now: new Date(DAY), ...o };
  await run(d, file(DAY, entry(1, move('L1-a'))), opt);
  const r = await run(d, file(DAY, entry(1, bad)), opt);
  return { d, s, r };
}

for (const [label, steps, reason] of [
  ['Nico Collins (160) given', [leg(['160'], ['22'])], 'never_give'],
  ['Chase Brown (80) given', [leg(['80'], ['22'])], 'never_give'],
  ['A.J. Brown (277) given while nothing measures a consistent Blue chip', [leg(['277'], ['31'])], 'never_give'],
  ['Olave (290) brought back', [leg(['4', '7'], ['290'])], 'never_get'],
  ['a player Nick sold this season (no buy-backs)', [leg(['4', '7'], ['55'])], 'sold_this_season'],
  ['a final get under the Blue chip floor (83)', [leg(['4'], ['30'])], 'below_blue_chip'],
  ['a final get the board does not score', [leg(['4'], ['99'])], 'unscored'],
  ['an overpay on market value (cap 0)', [leg(['31'], ['22'])], 'overpay'],
]) {
  test(`plan item 16: no push when the new move breaks a rule: ${label}`, async () => {
    const { d, s, r } = await afterLegal(move('L1-bad', 'new numbers moved a different deal to the top', steps));
    assert.equal(s.sent.length, 0);
    assert.equal(r.queued, 0); assert.equal(r.blocked, 1);
    assert.match(r.line, /blocked 1/);
    const rows = blockedRows(d);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].to_value, 'L1-bad');
    assert.match(rows[0].reason, new RegExp(reason));
  });
}

test('plan item 16: a flip leg below the floor is fine; only the final gets must be Blue chips', async () => {
  const path = [leg(['4'], ['30']), leg(['30', '7'], ['22'])];
  const { s, r } = await afterLegal(move('L1-flip', 'a new path', path));
  assert.equal(r.blocked, 0);
  assert.equal(s.sent.length, 1);
  // ...but every leg's gives are still checked: the flip leg may not give an untouchable.
  const bad = await afterLegal(move('L1-flip2', 'a new path', [leg(['160'], ['30']), leg(['30', '7'], ['22'])]));
  assert.equal(bad.s.sent.length, 0);
  assert.equal(bad.r.blocked, 1);
});

test('plan item 16: a move that does not beat doing nothing is not pushed', async () => {
  for (const [label, m] of [
    ['zero gain', move('L1-z', 'x', LEGAL, gain(0))],
    ['a loss', move('L1-l', 'x', LEGAL, gain(-0.01))],
    ['gain unknown', move('L1-u', 'x', LEGAL, { status: 'unknown', reason: 'no sim', source: 'sim.title' })],
    ['a leg that does not clear 2 SE on the confirm dice', move('L1-n', 'x', [leg(['4', '7'], ['22'], false)])],
    ['no steps', move('L1-e', 'x', [])],
  ]) {
    const { s, r, d } = await afterLegal(m);
    assert.equal(s.sent.length, 0, label);
    assert.equal(r.blocked, 1, label);
    assert.match(blockedRows(d)[0].reason, /no_edge|no_path/, label);
  }
});

test('plan item 16: no rule gate means no push (fails closed)', async () => {
  for (const o of [{ gateFor: undefined }, { gateFor: () => null }, { gateFor: () => { throw new Error('ledger unreadable'); } }]) {
    const d = fresh(); const s = sender(); const opt = { env: ON, send: s.send, now: new Date(DAY) };
    await push.runPushAlerts(d, file(DAY, entry(1, move('L1-a'))), { ...opt, ...o });
    const r = await push.runPushAlerts(d, file(DAY, entry(1, move('L1-b'))), { ...opt, ...o });
    assert.equal(s.sent.length, 0);
    assert.equal(r.blocked, 1);
    assert.match(blockedRows(d)[0].reason, /rules_unreadable/);
  }
});

test('plan item 16: a move queued overnight is re-checked at 8 AM; one that now breaks a rule is not sent', async () => {
  const d = fresh(); const s = sender();
  let closed = null;
  const gate = { check: t => ruleVerdict({ ...RULES, closed }, t) };
  const o = { env: ON, send: s.send, gateFor: () => gate };
  await run(d, file(NIGHT, entry(1, move('L1-a'))), { ...o, now: new Date(NIGHT) });
  const r1 = await run(d, file(NIGHT, entry(1, move('L1-b'))), { ...o, now: new Date(NIGHT) });
  assert.equal(r1.held, 1);
  closed = 'objectives file unreadable';
  const r2 = await run(d, file(EIGHT, entry(1, move('L1-b'))), { ...o, now: new Date(EIGHT) });
  assert.equal(s.sent.length, 0);
  assert.equal(r2.blocked, 1);
  assert.deepEqual(d.prepare('SELECT status FROM warroom_push_alerts').all().map(x => x.status), ['blocked']);
});

test('plan item 16: after a blocked move, the next legal move pushes; a return to the move Nick was told sends nothing', async () => {
  const d = fresh(); const s = sender(); const o = { env: ON, send: s.send, now: new Date(DAY) };
  await run(d, file(DAY, entry(1, move('L1-a'))), o);
  await run(d, file(DAY, entry(1, move('L1-bad', 'x', [leg(['160'], ['22'])]))), o);
  await run(d, file(DAY, entry(1, move('L1-a'))), o);
  assert.equal(s.sent.length, 0, 'L1-a is what Nick was last told');
  await run(d, file(DAY, entry(1, move('L1-c', 'a new deal'))), o);
  assert.equal(s.sent.length, 1);
});

test('plan item 16: the pushed text names no player a rule blocks (league id and reason only)', async () => {
  const { s } = await afterLegal(move('L1-b', 'better partner now: Team 3'));
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].text, /^League 1: /);
  assert.doesNotMatch(s.sent[0].text, /Collins|Chase Brown|A\.J\. Brown|Olave/);
});
