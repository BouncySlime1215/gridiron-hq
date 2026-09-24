/**
 * WR-1: the War Room view (server/services/war-room-view.js) and its switch
 * (server/services/warroom-flag.js).
 *
 *  - flag off -> { enabled: false } and nothing else;
 *  - preview mode -> enabled, preview: true, and every server sentence carries the prefix;
 *  - failed and unknown fields never carry a value, anywhere in the view;
 *  - the fixture's best plan step 0 maps byte-for-byte (team, give, get, p, delta);
 *  - no plans file / no entry / planner error / failed self-check each have their own state.
 * The fixture (test/fixtures/war-room-plans.json) is a trimmed prototype --json output with
 * invented player names and team ids only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'war-room-plans.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

const { warRoomFlag, warRoomPlansPath, WARROOM_ENV, WARROOM_PLANS_ENV } = await import('../server/services/warroom-flag.js');
const { buildWarRoomView, warRoomView, loadPlans, __resetPlansCache } = await import('../server/services/war-room-view.js');
const { PREVIEW_ENV, PREVIEW_PREFIX } = await import('../server/services/preview-mode.js');

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

/** Every typed field in the view, with its path. */
function fields(node, at = '$', out = []) {
  if (Array.isArray(node)) node.forEach((v, i) => fields(v, `${at}[${i}]`, out));
  else if (node && typeof node === 'object') {
    if (typeof node.status === 'string' && typeof node.producer === 'string') out.push([at, node]);
    for (const [k, v] of Object.entries(node)) fields(v, `${at}.${k}`, out);
  }
  return out;
}

const ON = { enabled: true, preview: false };
const PREVIEW = { enabled: true, preview: true };
const okPlans = () => ({ status: 'ok', entries: structuredClone(fixture), as_of: '2026-09-23T00:00:00.000Z', id: 'plans@1' });

test('flag: off by default, on for exactly "1", on under preview mode with preview marked', () => {
  withEnv({ [WARROOM_ENV]: null, [PREVIEW_ENV]: null }, () => assert.deepEqual(warRoomFlag(), { enabled: false, preview: false }));
  withEnv({ [WARROOM_ENV]: 'true', [PREVIEW_ENV]: null }, () => assert.equal(warRoomFlag().enabled, false));
  withEnv({ [WARROOM_ENV]: '1', [PREVIEW_ENV]: null }, () => assert.deepEqual(warRoomFlag(), { enabled: true, preview: false }));
  withEnv({ [WARROOM_ENV]: null, [PREVIEW_ENV]: '1' }, () => assert.deepEqual(warRoomFlag(), { enabled: true, preview: true }));
  withEnv({ [WARROOM_ENV]: '1', [PREVIEW_ENV]: '1' }, () => assert.deepEqual(warRoomFlag(), { enabled: true, preview: false }));
});

test('plans path: env var wins, else ~/gridiron-local/warroom/plans.json', () => {
  withEnv({ [WARROOM_PLANS_ENV]: '/x/y.json' }, () => assert.equal(warRoomPlansPath(), '/x/y.json'));
  withEnv({ [WARROOM_PLANS_ENV]: null }, () =>
    assert.equal(warRoomPlansPath(), path.join(os.homedir(), 'gridiron-local', 'warroom', 'plans.json')));
});

test('flag off -> { enabled: false } and nothing else (the tab is not drawn)', async () => {
  assert.deepEqual(buildWarRoomView(1, okPlans(), { enabled: false, preview: false }), { enabled: false });
  await withEnv({ [WARROOM_ENV]: null, [PREVIEW_ENV]: null, [WARROOM_PLANS_ENV]: FIXTURE },
    async () => assert.deepEqual(await warRoomView(1), { enabled: false }));
});

test('preview -> enabled, preview fields set, every server sentence prefixed', async () => {
  __resetPlansCache();
  const v = await withEnv({ [WARROOM_ENV]: null, [PREVIEW_ENV]: '1', [WARROOM_PLANS_ENV]: FIXTURE }, () => warRoomView(1));
  assert.equal(v.enabled, true);
  assert.equal(v.preview, true);
  assert.match(v.preview_reason, /study run/);
  assert.ok(v.banner.startsWith(`${PREVIEW_PREFIX}: `), v.banner);
  const all = fields(v);
  assert.ok(all.length > 40, `a real view has many fields (${all.length})`);
  for (const [at, f] of all) {
    assert.equal(f.preview, true, `${at} is marked preview`);
    if (f.reason) assert.ok(f.reason.startsWith(`${PREVIEW_PREFIX}: `), `${at}.reason is prefixed: ${f.reason}`);
  }
  // Not in preview: no prefix, no preview flag.
  const plain = buildWarRoomView(1, okPlans(), ON);
  assert.equal(plain.preview, undefined);
  assert.ok(!JSON.stringify(plain).includes(PREVIEW_PREFIX));
});

test('failed and unknown fields carry no value, in every state the view can be in', () => {
  const states = [
    buildWarRoomView(1, okPlans(), PREVIEW),
    buildWarRoomView(2, okPlans(), ON),                 // planner error -> failed
    buildWarRoomView(3, okPlans(), ON),                 // failed self-check -> failed
    buildWarRoomView(99, okPlans(), ON),                // no entry -> unknown
    buildWarRoomView(1, { status: 'unknown', reason: 'No plan has been run yet.' }, ON),
    buildWarRoomView(1, { status: 'failed', reason: 'The plans file is not valid JSON.' }, ON)
  ];
  let hidden = 0;
  for (const v of states) {
    for (const [at, f] of fields(v)) {
      assert.ok(['ok', 'unknown', 'failed'].includes(f.status), `${at}: ${f.status}`);
      if (f.status !== 'ok') {
        hidden++;
        assert.ok(!('value' in f), `${at} is ${f.status} and must not carry a value`);
        assert.ok(typeof f.reason === 'string' && f.reason.length > 10, `${at} says why`);
      } else {
        assert.ok('value' in f, `${at} is ok and carries its value`);
      }
      assert.ok(typeof f.source === 'string' && f.source.length, `${at} has a source label`);
    }
  }
  assert.ok(hidden > 50, `control: the states above do hide fields (${hidden})`);
});

test('fixture: best plan step 0 maps byte-for-byte onto the first deck card', () => {
  const v = buildWarRoomView(1, okPlans(), ON);
  const s0 = fixture[0].acq.best.steps[0];
  assert.equal(v.next_move.status, 'ok');
  const c = v.next_move.value.cards[0];
  assert.equal(c.origin, 'best');
  assert.equal(c.partner, s0.team);
  assert.deepEqual(c.give.map(p => p.id), s0.give);
  assert.deepEqual(c.get.map(p => p.id), s0.get);
  assert.equal(c.p_yes.value, s0.p);
  assert.equal(c.odds_effect.delta.value, s0.delta);
  assert.equal(c.odds_effect.delta.se, s0.se);
  assert.equal(c.odds_effect.delta.clears_2se, s0.clears);
  assert.equal(c.path_effect.expected.value, fixture[0].acq.best.expected);
  assert.equal(c.vs_finder.finder_expected.value, fixture[0].baseline.best_expected.expected);
  assert.deepEqual(c.give.map(p => p.name), ['M. Oduya (WR)', 'T. Kline (TE)']);
  assert.equal(c.partner_label, 'Team 7');
  // The numbers the study does not write are unknown, not 0.
  assert.equal(c.odds_effect.before.status, 'unknown');
  assert.equal(c.odds_effect.after.status, 'unknown');
  assert.equal(c.message.status, 'unknown');
  assert.equal(c.walk_away.status, 'unknown');
  for (const k of ['case_for', 'his_side', 'devils_advocate', 'news_check', 'confidence', 'counter']) {
    assert.equal(c.reasoning[k].status, 'unknown', k);
  }
  // Replies: accept = the plan's step 2, decline = the study's fallback; counter/silence not planned.
  assert.equal(c.replies.accept.status, 'ok');
  assert.match(c.replies.accept.value.do, /^Send step 2 to Team 2/);
  assert.equal(c.replies.decline.status, 'ok');
  assert.match(c.replies.decline.value.do, /Team 9/);
  assert.equal(c.replies.counter.status, 'unknown');
  assert.equal(c.replies.silence.status, 'unknown');
});

test('deck: named plans in producer order, duplicates dropped, at most 5; alternatives win when written', () => {
  const v = buildWarRoomView(1, okPlans(), ON);
  assert.deepEqual(v.next_move.value.cards.map(c => c.origin), ['best', 'best_direct', 'best_three', 'fallback']);
  const withAlts = okPlans();
  const alt = withAlts.entries[0].acq.best_direct;
  withAlts.entries[0].acq.alternatives = Array.from({ length: 7 }, () => structuredClone(alt));
  const w = buildWarRoomView(1, withAlts, ON);
  assert.equal(w.next_move.value.cards.length, 5);
  assert.ok(w.next_move.value.cards.every(c => c.origin === 'alternative'));
});

test('itinerary, targets and flips map producer fields and mark the rest unknown', () => {
  const v = buildWarRoomView(1, okPlans(), ON);
  const stops = v.itinerary.value.stops;
  assert.deepEqual(stops.map(s => [s.kind, s.status]), [['flip', 'next'], ['get', 'waiting']]);
  assert.equal(stops[1].odds_after.value, 0.041);
  const t = v.suggestions.value;
  assert.deepEqual(t.map(x => x.player.id), ['701', '702', '703']);
  assert.equal(t[0].p_reach.value, fixture[0].acq.best.p_complete);
  assert.equal(t[1].p_reach.status, 'unknown');
  assert.equal(t[0].gain_if_landed.status, 'unknown');
  const f = v.flips.value;
  assert.deepEqual(f.map(x => x.player.id), ['501', '502', '503'], 'producer order, no re-sort');
  assert.equal(f[0].legs.p_both.value, 0.1368);
  assert.equal(f[1].legs, null);
  assert.equal(f[1].legs_why_not, 'no screen-fair one-player leg');
  assert.match(f[2].legs_why_not, /Legs not searched/);
  assert.equal(v.brain_check.status, 'unknown');
  assert.equal(v.number_health.status, 'unknown');
  assert.equal(v.speed_curve.status, 'unknown');
  assert.equal(v.catch_up.status, 'unknown');
  assert.equal(v.destination.title_now.status, 'unknown');
});

test('hidden states: planner error and failed self-check are failed; no entry and no file are unknown', async () => {
  const e = buildWarRoomView(2, okPlans(), ON);
  assert.equal(e.next_move.status, 'failed');
  assert.match(e.next_move.reason, /world failed/);
  const s = buildWarRoomView(3, okPlans(), ON);
  assert.equal(s.next_move.status, 'failed');
  assert.equal(s.flips.status, 'failed');
  assert.ok(!JSON.stringify(s.flips).includes('0.024'), 'a failed flip map leaks no digits');
  const none = buildWarRoomView(99, okPlans(), ON);
  assert.equal(none.next_move.status, 'unknown');
  assert.match(none.next_move.reason, /No plan has been run for this league/);

  __resetPlansCache();
  const missing = await loadPlans(path.join(os.tmpdir(), `no-such-war-room-${process.pid}.json`));
  assert.equal(missing.status, 'unknown');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'war-room-'));
  try {
    const bad = path.join(dir, 'plans.json');
    fs.writeFileSync(bad, '{not json');
    const b = await loadPlans(bad);
    assert.equal(b.status, 'failed');
    assert.ok(!b.reason.includes(dir), 'the path is not echoed');
    const v = buildWarRoomView(1, b, ON);
    assert.equal(v.next_move.status, 'failed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the route computes nothing: it imports no producer module', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'server', 'services', 'war-room-view.js'), 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1]).sort();
  assert.deepEqual(imports, ['./preview-mode.js', './warroom-flag.js', 'node:fs/promises']);
});

test('fixture carries team ids only (no manager or league names)', () => {
  const txt = fs.readFileSync(FIXTURE, 'utf8');
  assert.doesNotMatch(txt, /"(owner_name|manager|team_name|league_name|display_name)"/);
  const v = buildWarRoomView(1, okPlans(), ON);
  for (const c of v.next_move.value.cards) assert.match(c.partner_label, /^Team \d+$/);
});
