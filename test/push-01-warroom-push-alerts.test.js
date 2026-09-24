/**
 * PUSH-01 (NORTH-STAR-PLAN row 7): a push when the War Room's next move changes.
 *
 * Before this unit the producer appended one row per changed league to
 * pushes.jsonl (scripts/campaign/produce-plans.mjs) and nothing in the repo read
 * that file, so no change ever reached Nick. These tests pin the replacement:
 * the producer's run is diffed against stored state (next_move.move_id and the
 * objective's feasibility status), each change queues exactly one alert, a
 * repeat run or a flip back before delivery sends nothing, 1-8 AM ET holds the
 * alert, and the whole thing is off unless its flag or preview mode is on.
 * In-memory SQLite, stand-in sender, no network, no real league data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const push = await import('../server/services/campaign/push-alerts.js');
const mig = await import('../server/migrations/087_warroom_push_alerts.js');

const fresh = () => { const d = new DatabaseSync(':memory:'); mig.up(d); return d; };

// 2026-09-24 is EDT (UTC-4): 14:00Z = 10 AM ET, 07:00Z = 3 AM ET, 12:00Z = 8 AM ET.
const DAY = '2026-09-24T14:00:00.000Z';
const NIGHT = '2026-09-24T07:00:00.000Z';
const EIGHT = '2026-09-24T12:00:00.000Z';

const move = id => ({ status: 'ok', value: { move_id: id }, source: 'plan.path' });
const noMove = { status: 'unknown', reason: 'The planner found no trade path worth sending this week.', source: 'plan.path' };
const entry = (league, next_move, feas = null, reason = 'new numbers moved a different deal to the top') => ({
  league, me: '1', names: {}, next_move,
  _run: { changed: { changed: true, reason }, feasibility_detail: feas ? { kind: 'points', status: feas } : null }
});
const file = (at, ...leagues) => ({ schema: 'warroom-plans/1', generated_at: at, leagues });

function sender() {
  const sent = [];
  const send = async msg => { sent.push(msg); return { channel: 'test' }; };
  return { sent, send };
}
const ON = { GRIDIRON_WARROOM_PUSH_ENABLED: '1' };

test('migration 087 is additive: two new tables, nothing dropped or altered', () => {
  const src = fs.readFileSync(new URL('../server/migrations/087_warroom_push_alerts.js', import.meta.url), 'utf8');
  const up = src.slice(src.indexOf('export function up'), src.indexOf('export function down'));
  assert.doesNotMatch(up, /DROP|ALTER|DELETE/i);
  const d = fresh();
  const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  assert.deepEqual(tables, ['warroom_push_alerts', 'warroom_push_state']);
  mig.up(d); // idempotent
});

test('first run records a baseline and pushes nothing (turning the flag on is not a flood)', async () => {
  const d = fresh(); const s = sender();
  const r = await push.runPushAlerts(d, file(DAY, entry(1, move('L1-a')), entry(2, move('L2-a'), 'reachable')), { env: ON, now: new Date(DAY), send: s.send });
  assert.equal(r.status, 'ok');
  assert.equal(r.queued, 0);
  assert.equal(s.sent.length, 0);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM warroom_push_state').get().n, 3);
});

test('a changed next_move.move_id sends exactly one push; the same move on the next run sends none', async () => {
  const d = fresh(); const s = sender(); const o = { env: ON, send: s.send };
  await push.runPushAlerts(d, file(DAY, entry(1, move('L1-a'))), { ...o, now: new Date(DAY) });
  const r = await push.runPushAlerts(d, file(DAY, entry(1, move('L1-b'), null, 'better partner now: Team 3')), { ...o, now: new Date(DAY) });
  assert.equal(r.queued, 1); assert.equal(r.sent, 1);
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].league, '1');
  assert.match(s.sent[0].text, /next move/i);
  assert.match(s.sent[0].text, /better partner now/);
  const again = await push.runPushAlerts(d, file(DAY, entry(1, move('L1-b'))), { ...o, now: new Date(DAY) });
  assert.equal(again.queued, 0); assert.equal(again.sent, 0);
  assert.equal(s.sent.length, 1, 'dedupe: one push per change');
});

test('no move clearing the bar is a change too; a failed league is not', async () => {
  const d = fresh(); const s = sender(); const o = { env: ON, send: s.send, now: new Date(DAY) };
  await push.runPushAlerts(d, file(DAY, entry(1, move('L1-a'))), o);
  await push.runPushAlerts(d, file(DAY, { league: 1, me: '1', names: {}, error: 'world failed: x' }), o);
  assert.equal(s.sent.length, 0, 'a failed run is not a change of move');
  await push.runPushAlerts(d, file(DAY, entry(1, move('L1-a'))), o);
  assert.equal(s.sent.length, 0, 'recovering to the same move is not a change either');
  await push.runPushAlerts(d, file(DAY, entry(1, noMove)), o);
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].text, /no move/i);
});

test('objective feasibility changing (reachable -> out of reach) pushes once', async () => {
  const d = fresh(); const s = sender(); const o = { env: ON, send: s.send, now: new Date(DAY) };
  await push.runPushAlerts(d, file(DAY, entry(4, move('L4-a'), 'reachable')), o);
  await push.runPushAlerts(d, file(DAY, entry(4, move('L4-a'), 'out_of_reach')), o);
  await push.runPushAlerts(d, file(DAY, entry(4, move('L4-a'), 'out_of_reach')), o);
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].text, /out of reach/);
});

test('a move and a feasibility change in one run are one push for that league', async () => {
  const d = fresh(); const s = sender(); const o = { env: ON, send: s.send, now: new Date(DAY) };
  await push.runPushAlerts(d, file(DAY, entry(5, move('L5-a'), 'on_track')), o);
  await push.runPushAlerts(d, file(DAY, entry(5, move('L5-b'), 'reachable')), o);
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].text, /next move/i);
  assert.match(s.sent[0].text, /reachable/);
});

test('quiet hours 1-8 AM ET hold the push; the next run from 8 AM sends only the latest move', async () => {
  const d = fresh(); const s = sender(); const o = { env: ON, send: s.send };
  assert.equal(push.inQuietHours(new Date(NIGHT)), true);
  assert.equal(push.inQuietHours(new Date('2026-09-24T04:59:00.000Z')), false, '12:59 AM ET is not quiet');
  assert.equal(push.inQuietHours(new Date('2026-09-24T05:00:00.000Z')), true, '1:00 AM ET is quiet');
  assert.equal(push.inQuietHours(new Date(EIGHT)), false, '8:00 AM ET is not quiet');
  assert.equal(push.inQuietHours(new Date('2026-12-01T12:30:00.000Z')), true, '7:30 AM EST (UTC-5) is quiet');
  await push.runPushAlerts(d, file(NIGHT, entry(1, move('L1-a'))), { ...o, now: new Date(NIGHT) });
  const r1 = await push.runPushAlerts(d, file(NIGHT, entry(1, move('L1-b'))), { ...o, now: new Date(NIGHT) });
  assert.equal(r1.held, 1); assert.equal(s.sent.length, 0);
  const r2 = await push.runPushAlerts(d, file(NIGHT, entry(1, move('L1-c'))), { ...o, now: new Date(NIGHT) });
  assert.equal(r2.superseded, 1); assert.equal(s.sent.length, 0);
  await push.runPushAlerts(d, file(EIGHT, entry(1, move('L1-c'))), { ...o, now: new Date(EIGHT) });
  assert.equal(s.sent.length, 1, 'one push for the night, about the move that stands');
  const rows = d.prepare("SELECT status, to_value FROM warroom_push_alerts ORDER BY id").all().map(r => `${r.status}:${r.to_value}`);
  assert.deepEqual(rows, ['superseded:L1-b', 'sent:L1-c']);
});

test('a move that flips back before delivery sends nothing', async () => {
  const d = fresh(); const s = sender(); const o = { env: ON, send: s.send };
  await push.runPushAlerts(d, file(NIGHT, entry(1, move('L1-a'))), { ...o, now: new Date(NIGHT) });
  await push.runPushAlerts(d, file(NIGHT, entry(1, move('L1-b'))), { ...o, now: new Date(NIGHT) });
  await push.runPushAlerts(d, file(NIGHT, entry(1, move('L1-a'))), { ...o, now: new Date(NIGHT) });
  await push.runPushAlerts(d, file(EIGHT, entry(1, move('L1-a'))), { ...o, now: new Date(EIGHT) });
  assert.equal(s.sent.length, 0);
});

test('a failed send stays queued with its error and retries; three failures mark it failed', async () => {
  const d = fresh(); let calls = 0;
  const send = async () => { calls++; throw new Error('channel down'); };
  const o = { env: ON, send, now: new Date(DAY) };
  await push.runPushAlerts(d, file(DAY, entry(1, move('L1-a'))), o);
  const r = await push.runPushAlerts(d, file(DAY, entry(1, move('L1-b'))), o);
  assert.equal(r.failed, 1);
  assert.match(r.line, /channel down/);
  await push.runPushAlerts(d, file(DAY, entry(1, move('L1-b'))), o);
  await push.runPushAlerts(d, file(DAY, entry(1, move('L1-b'))), o);
  await push.runPushAlerts(d, file(DAY, entry(1, move('L1-b'))), o);
  assert.equal(calls, 3);
  const row = d.prepare('SELECT status, attempts, error FROM warroom_push_alerts').get();
  assert.deepEqual({ ...row }, { status: 'failed', attempts: 3, error: 'channel down' });
});

test('no channel configured: the alert stays queued and the summary says why', async () => {
  const d = fresh(); const o = { env: ON, send: null, now: new Date(DAY) };
  await push.runPushAlerts(d, file(DAY, entry(1, move('L1-a'))), o);
  const r = await push.runPushAlerts(d, file(DAY, entry(1, move('L1-b'))), o);
  assert.equal(r.unsent, 1);
  assert.match(r.line, /no push channel/);
});

test('flag: off by default touches nothing; preview mode turns it on and labels the text', async () => {
  const d = fresh(); const s = sender();
  const off = await push.runPushAlerts(d, file(DAY, entry(1, move('L1-a'))), { env: {}, now: new Date(DAY), send: s.send });
  assert.equal(off.status, 'off');
  assert.equal(d.prepare('SELECT COUNT(*) n FROM warroom_push_state').get().n, 0);
  const prev = { GRIDIRON_PREVIEW_UNCONFIRMED: '1' };
  const saved = process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
  process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
  try {
    await push.runPushAlerts(d, file(DAY, entry(1, move('L1-a'))), { env: prev, now: new Date(DAY), send: s.send });
    const r = await push.runPushAlerts(d, file(DAY, entry(1, move('L1-b'))), { env: prev, now: new Date(DAY), send: s.send });
    assert.equal(r.preview, true);
    assert.match(s.sent[0].text, /^Preview \(unconfirmed forward\): /);
    const veto = await push.runPushAlerts(d, file(DAY, entry(1, move('L1-c'))), { env: { ...prev, GRIDIRON_WARROOM_PUSH_ENABLED: '0' }, now: new Date(DAY), send: s.send });
    assert.equal(veto.status, 'off', 'the flag set to 0 vetoes preview mode');
  } finally {
    if (saved === undefined) delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED; else process.env.GRIDIRON_PREVIEW_UNCONFIRMED = saved;
  }
});

test('the table missing (087 not applied yet) is reported inert, not swallowed', async () => {
  const d = new DatabaseSync(':memory:');
  const r = await push.runPushAlerts(d, file(DAY, entry(1, move('L1-a'))), { env: ON, now: new Date(DAY), send: null });
  assert.equal(r.status, 'inert');
  assert.match(r.line, /087/);
});

test('the push carries no league or manager names, only the league id', async () => {
  const d = fresh(); const s = sender(); const o = { env: ON, send: s.send, now: new Date(DAY) };
  const named = (id) => ({ ...entry(1, move(id), null, 'better partner now: Team 3'), names: { 3: 'Some Manager' } });
  await push.runPushAlerts(d, file(DAY, named('L1-a')), o);
  await push.runPushAlerts(d, file(DAY, named('L1-b')), o);
  assert.doesNotMatch(s.sent[0].text, /Some Manager/);
});

test('the producer hands every run to the push step (the unread pushes.jsonl is gone)', () => {
  const src = fs.readFileSync(new URL('../scripts/campaign/produce-plans.mjs', import.meta.url), 'utf8');
  assert.match(src, /runPushAlerts\(/);
  assert.doesNotMatch(src, /pushes\.jsonl/);
});

test('senders: ntfy when its URL is set, macOS notification on darwin, otherwise none', () => {
  assert.equal(push.defaultSender({}, 'linux'), null);
  assert.equal(typeof push.defaultSender({ GRIDIRON_PUSH_NTFY_URL: 'https://ntfy.example/topic' }, 'linux'), 'function');
  assert.equal(typeof push.defaultSender({}, 'darwin'), 'function');
});
