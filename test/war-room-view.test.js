/**
 * WR-1 + FIX-04: the War Room view (server/services/war-room-view.js) reads the
 * plans contract (server/services/campaign/plans-schema.js, warroom-plans/1) and
 * its switch (server/services/warroom-flag.js).
 *
 *  - flag off -> { enabled: false } and nothing else;
 *  - the view is the validated league entry plus { enabled, preview, preview_reason,
 *    snapshot, sources, banner }: every contract section passes through unchanged;
 *  - the deck is alternatives.value, head first (the dropped-best-plan bug, D3/U1);
 *  - a section that fails the contract is failed with its reason, the rest pass;
 *  - preview -> every server sentence carries the prefix;
 *  - failed and unknown fields never carry a value, anywhere in the view;
 *  - no plans file / no entry / planner error / failed self-check each have their own state.
 * Fixtures: test/fixtures/warroom-contract/ui-contract-plans.json (#238's hand-written
 * contract fixture with FIX-03's three extra sections, for exact names and numbers),
 * test/fixtures/warroom-contract/producer-plans.json (the real producer's output, FIX-03) and test/fixtures/war-room-plans.json (the study's old shape). Invented player
 * names and team ids only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'warroom-contract', 'ui-contract-plans.json');
const REAL = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'warroom-contract', 'producer-plans.json'), 'utf8'));
const STUDY_FIXTURE = path.join(HERE, 'fixtures', 'war-room-plans.json');
const producer = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const study = JSON.parse(fs.readFileSync(STUDY_FIXTURE, 'utf8'));

const { warRoomFlag, warRoomPlansPath, WARROOM_ENV, WARROOM_PLANS_ENV } = await import('../server/services/warroom-flag.js');
const { buildWarRoomView, warRoomView, loadPlans, __resetPlansCache, SOURCES, VIEW_SECTIONS } = await import('../server/services/war-room-view.js');
const { SECTIONS, SOURCE_IDS } = await import('../server/services/campaign/plans-schema.js');
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
    if (typeof node.status === 'string' && typeof node.source === 'string') out.push([at, node]);
    for (const [k, v] of Object.entries(node)) fields(v, `${at}.${k}`, out);
  }
  return out;
}

const ON = { enabled: true, preview: false };
const PREVIEW = { enabled: true, preview: true };
const head = doc => ({ schema: doc.schema, producer: doc.producer, producer_version: doc.producer_version });
const plansOf = doc => ({ status: 'ok', entries: structuredClone(doc.leagues ?? doc), as_of: doc.generated_at ?? '2026-09-23T00:00:00.000Z', id: 'plans@1', head: head(doc) });
const okPlans = () => plansOf(producer);

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

test('the view is the league entry plus { enabled, preview, preview_reason, snapshot, sources, banner }', () => {
  const v = buildWarRoomView(1, okPlans(), ON);
  const entry = producer.leagues[0];
  const meta = ['enabled', 'league_id', 'snapshot', 'sources', 'banner'];
  assert.deepEqual(Object.keys(v).sort(), [...new Set([...meta, ...Object.keys(entry), ...VIEW_SECTIONS])].sort());
  assert.equal(v.enabled, true);
  assert.equal(v.league_id, 1);
  assert.equal(v.league, 1);
  assert.equal(v.me, '3');
  assert.deepEqual(v.names, entry.names);
  assert.deepEqual(v.snapshot, { id: 'plans@1', as_of: producer.generated_at, ...head(producer) });
  const p = buildWarRoomView(1, okPlans(), PREVIEW);
  assert.equal(p.preview, true);
  assert.ok(p.preview_reason.length > 10);
});

test('each contract section passes through unchanged (U2, U3: nothing hard-coded "not built")', () => {
  const v = buildWarRoomView(1, okPlans(), ON);
  const entry = producer.leagues[0];
  for (const k of Object.keys(SECTIONS)) assert.deepEqual(v[k], entry[k], `${k} passes through`);
  for (const k of ['destination', 'speed_curve', 'catch_up', 'brain_report', 'attention']) {
    assert.equal(v[k].status, 'ok', `${k} is the producer's, not a placeholder`);
  }
  // The old view names are gone: one shape for UI and Coach.
  for (const k of ['suggestions', 'flips', 'brain_check', 'acq', 'flip', 'baseline']) assert.ok(!(k in v), `${k} is not in the view`);
});

test('the deck is alternatives.value: a head that differs from alternatives[1] is card 1 (D3/U1)', () => {
  const plans = okPlans();
  const deck = plans.entries[0].alternatives.value;
  assert.notEqual(deck[0].move_id, deck[1].move_id, 'control: the fixture head differs from alternatives[1]');
  assert.notEqual(deck[0].steps[0].partner, deck[1].steps[0].partner, 'control: the two cards differ on screen');
  const v = buildWarRoomView(1, plans, ON);
  assert.equal(v.alternatives.status, 'ok');
  assert.equal(v.alternatives.value[0].move_id, 'L1-m1');
  assert.equal(v.alternatives.value[0].rank, 1);
  assert.equal(v.alternatives.value[0].steps[0].partner, '7');
  assert.equal(v.next_move.value.move_id, v.alternatives.value[0].move_id);
});

test('the real producer fixture (FIX-03): every section passes through, _run stays out, the deck head is next_move', () => {
  for (const entry of REAL.leagues) {
    const v = buildWarRoomView(entry.league, plansOf(REAL), ON);
    assert.equal('_run' in v, false, "the producer's bookkeeping is not served");
    if (entry.error) {
      for (const k of Object.keys(SECTIONS)) assert.equal(v[k].status, 'failed', `${entry.league} ${k}`);
      continue;
    }
    for (const k of Object.keys(SECTIONS)) assert.deepEqual(v[k], entry[k], `league ${entry.league}: ${k} passes through`);
    if (v.alternatives.status === 'ok' && v.alternatives.value.length) {
      assert.equal(v.alternatives.value[0].rank, 1);
      assert.equal(v.next_move.value.move_id, v.alternatives.value[0].move_id);
    }
  }
});

test('number_health: passes through when the contract declares it, else unknown with a reason', () => {
  const v = buildWarRoomView(1, okPlans(), ON);
  assert.ok(VIEW_SECTIONS.includes('number_health'));
  if ('number_health' in SECTIONS) assert.deepEqual(v.number_health, producer.leagues[0].number_health);
  else {
    assert.equal(v.number_health.status, 'unknown');
    assert.match(v.number_health.reason, /contract/);
  }
});

test('sources: one label per contract SourceId (U7)', () => {
  assert.deepEqual(Object.keys(SOURCES).sort(), [...SOURCE_IDS].sort());
  for (const s of Object.values(SOURCES)) assert.ok(s.label.length > 3 && typeof s.calibrated === 'boolean');
  assert.deepEqual(buildWarRoomView(1, okPlans(), ON).sources, SOURCES);
});

test('a section that breaks the contract is failed with the reason; the rest still pass', () => {
  const plans = okPlans();
  plans.entries[0].targets.value[0].p_reach.value = 1.7;
  plans.entries[0].alternatives.value[1].rank = 5;
  const v = buildWarRoomView(1, plans, ON);
  assert.equal(v.targets.status, 'failed');
  assert.match(v.targets.reason, /contract/);
  assert.ok(!('value' in v.targets));
  assert.equal(v.alternatives.status, 'failed', 'a deck out of order is hidden, not re-sorted');
  assert.deepEqual(v.flip_map, producer.leagues[0].flip_map);
  assert.deepEqual(v.destination, producer.leagues[0].destination);
});

test("the study's old shape: prototype keys are dropped and every section says the producer did not write it", () => {
  const v = buildWarRoomView(1, plansOf(study), ON);
  for (const k of ['acq', 'flip', 'baseline', 'owner_mapping_present']) assert.ok(!(k in v), k);
  for (const k of Object.keys(SECTIONS)) {
    assert.equal(v[k].status, 'unknown', k);
    assert.match(v[k].reason, /did not write/, k);
  }
});

test('preview -> every server sentence prefixed; not in preview -> no prefix', async () => {
  __resetPlansCache();
  const v = await withEnv({ [WARROOM_ENV]: null, [PREVIEW_ENV]: '1', [WARROOM_PLANS_ENV]: FIXTURE }, () => warRoomView(1));
  assert.equal(v.enabled, true);
  assert.equal(v.preview, true);
  assert.ok(v.banner.startsWith(`${PREVIEW_PREFIX}: `), v.banner);
  const all = fields(v);
  assert.ok(all.length > 40, `a real view has many fields (${all.length})`);
  for (const [at, f] of all) if (f.reason) assert.ok(f.reason.startsWith(`${PREVIEW_PREFIX}: `), `${at}.reason is prefixed: ${f.reason}`);
  const plain = buildWarRoomView(1, okPlans(), ON);
  assert.equal(plain.preview, undefined);
  assert.ok(!JSON.stringify(plain).includes(PREVIEW_PREFIX));
});

test('failed and unknown fields carry no value, in every state the view can be in', () => {
  const states = [
    buildWarRoomView(1, okPlans(), PREVIEW),
    buildWarRoomView(2, okPlans(), ON),                 // planner error -> failed
    buildWarRoomView(3, okPlans(), ON),                 // partly unknown producer entry
    buildWarRoomView(99, okPlans(), ON),                // no entry -> unknown
    buildWarRoomView(1, plansOf(study), ON),            // old shape -> unknown
    buildWarRoomView(3, plansOf(study), ON),            // old shape, failed self-check -> failed
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
    }
  }
  assert.ok(hidden > 50, `control: the states above do hide fields (${hidden})`);
});

test('hidden states: planner error and failed self-check are failed; no entry and no file are unknown', async () => {
  const e = buildWarRoomView(2, okPlans(), ON);
  assert.equal(e.alternatives.status, 'failed');
  assert.match(e.alternatives.reason, /world failed/);
  const s = buildWarRoomView(3, plansOf(study), ON);
  assert.equal(s.alternatives.status, 'failed');
  assert.equal(s.flip_map.status, 'failed');
  const none = buildWarRoomView(99, okPlans(), ON);
  assert.equal(none.next_move.status, 'unknown');
  assert.match(none.next_move.reason, /No plan has been run for this league/);
  assert.deepEqual(none.names, {});

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
    assert.equal(v.alternatives.status, 'failed');
    const good = path.join(dir, 'good.json');
    fs.writeFileSync(good, JSON.stringify(producer));
    const g = await loadPlans(good);
    assert.deepEqual(g.head, head(producer));
    assert.equal(g.as_of, producer.generated_at);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the route computes nothing: it imports the contract and no producer module', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'server', 'services', 'war-room-view.js'), 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1]).sort();
  // FP-GUARD: fantasypros-guard.js strips FantasyPros keys on the way out; it computes nothing.
  // PLANS-EXPIRE: campaign/plan-age.js is a pure date rule (planned_at vs now); it computes no number.
  // STEP-REGRET at the serve step: campaign/serve-regret.js only holds back served moves; it computes no number.
  // LAST-GOOD: campaign/last-good.js reads the refresh record (sync_log) and labels the view; it computes no number.
  assert.deepEqual(imports, ['./campaign/last-good.js', './campaign/plan-age.js', './campaign/plans-schema.js', './campaign/serve-regret.js', './fantasypros-guard.js', './preview-mode.js', './warroom-flag.js', 'node:fs/promises']);
});

test('fixtures carry team ids only (no manager or league names)', () => {
  for (const f of [FIXTURE, STUDY_FIXTURE]) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /"(owner_name|manager|team_name|league_name|display_name)"/);
  }
});
