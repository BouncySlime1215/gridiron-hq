/**
 * WARROOM-CONTRACT: one plans-file shape for the campaign producer, the War
 * Room view (PR #231) and Coach's War Room actions (PR #230).
 *
 *  1. The producer fixture validates, and it writes every path the contract
 *     declares, so "the producer writes it" is shown, not assumed.
 *  2. The UI's and Coach's own fixtures are validated; the ways they fail are
 *     pinned, and each is a mismatch listed in consumer-reads.js with its fix.
 *  3. Every key a consumer reads is a key the producer writes, except the
 *     recorded mismatches; a new unmatched read fails, and so does a recorded
 *     mismatch that has started to resolve.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validatePlans, validateLeague, schemaPaths, writtenPaths, tradeoffKey, TRADEOFF_KEY, SECTIONS, SCHEMA_VERSION
} from '../server/services/campaign/plans-schema.js';
import { READS } from './fixtures/warroom-contract/consumer-reads.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = name => JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/warroom-contract', name), 'utf8'));
const PRODUCER = fixture('producer-plans.json');
const UI_FIXTURE = fixture('ui-war-room-plans.json');
const COACH_FIXTURE = fixture('coach-plans.json');

const META = /\.(status|reason|source|se|clears_2se|as_of|n)$/;
/** next_move is one deck entry, and the four reply rows share one shape. */
const norm = p => p
  .replace(/^leagues\[\]\.next_move\.value/, 'leagues[].alternatives.value[]')
  .replace(/\.reply_table\.value\.(accept|decline|counter|silence)/, '.reply_table.value.*');
const clone = v => JSON.parse(JSON.stringify(v));
const paths = r => r.errors.map(e => e.path);

/* ------------------------------------------------------------ producer */

test('the producer fixture validates against the contract', () => {
  const r = validatePlans(PRODUCER);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(PRODUCER.schema, SCHEMA_VERSION);
});

/**
 * Declared paths the producer cannot write yet, each with the unit that will.
 * The fixture is the real producer's output (FIX-03), so these stay out of the
 * next test until their unit lands; the test after it fails the day one of
 * them starts being written, so an entry cannot linger.
 */
const PENDING = [
  { unit: 'FIX-05', why: 'the producer does not read the brain report yet', path: /^leagues\[\]\.brain_report\.value(\.|\[|$)/ },
  { unit: 'FIX-05', why: 'the producer does not read the number audit yet', path: /^leagues\[\]\.number_health\.value(\.|\[|$)/ },
  { unit: 'unassigned', why: 'no planner rule reads these two sliders', path: /^leagues\[\]\.destination\.value\.tolerances\.value\.(reputation_budget|ai_spend)$/ }
];
const pending = p => PENDING.some(x => x.path.test(p));

test('the producer fixture writes every path the contract declares', () => {
  const written = new Set([...writtenPaths(PRODUCER)].map(norm));
  const missing = [...new Set([...schemaPaths()].map(norm))].filter(p => !META.test(p) && !written.has(p) && !pending(p));
  assert.deepEqual(missing, []);
});

test('each pending path is declared and still not written', () => {
  const declared = [...schemaPaths()].filter(p => !META.test(p));
  const written = new Set([...writtenPaths(PRODUCER)].map(norm));
  for (const x of PENDING) {
    const hits = declared.filter(p => x.path.test(p));
    assert.ok(hits.length, `${x.unit}: ${x.path} matches no declared path`);
    assert.deepEqual(hits.filter(p => written.has(norm(p))), [], `${x.unit}: written now; drop it from PENDING`);
  }
});

test('every league section is present unless the whole run failed', () => {
  const doc = clone(PRODUCER);
  delete doc.leagues[0].speed_curve;
  assert.deepEqual(paths(validatePlans(doc)), ['$.leagues[0].speed_curve']);
  // A failed run carries only its error.
  assert.equal(validateLeague({ league: 9, me: '1', names: {}, error: 'world failed' }).ok, true);
});

/* ------------------------------------------------------- typed fields */

test('typed fields: ok carries a value; unknown and failed carry a reason and no value', () => {
  const at = mutate => { const doc = clone(PRODUCER); mutate(doc.leagues[0]); return validatePlans(doc); };
  assert.equal(at(l => { delete l.attention.value; }).ok, false);
  assert.equal(at(l => { l.attention = { status: 'unknown', source: 'campaign.plan', value: 0, reason: 'x' }; }).ok, false);
  assert.equal(at(l => { l.attention = { status: 'failed', source: 'campaign.plan' }; }).ok, false);
  assert.equal(at(l => { l.attention = { status: 'unknown', source: 'campaign.plan', reason: 'Not ranked yet.' }; }).ok, true);
  assert.equal(at(l => { l.attention = { status: 'zero', source: 'campaign.plan', reason: 'No offers yet.' }; }).ok, false, 'only ok / unknown / failed');
  assert.equal(at(l => { l.attention.source = 'made.up'; }).ok, false, 'source must be a known SourceId');
  assert.equal(at(l => { l.destination.value.title_now = 0.118; }).ok, false, 'a bare number is not a typed field');
  assert.equal(at(l => { l.next_move.value.steps[0].p_yes.value = 1.4; }).ok, false, 'a probability stays in 0..1');
});

test('cross-key rules: known player ids, deck order, next move is the deck head, no extra keys', () => {
  const at = mutate => { const doc = clone(PRODUCER); mutate(doc.leagues[0]); return paths(validatePlans(doc)); };
  assert.ok(at(l => { l.alternatives.value[0].steps[0].give = ['999']; }).includes('$.leagues[0].alternatives.value[0].steps[0].give[0]'));
  assert.ok(at(l => { l.alternatives.value.reverse(); }).includes('$.leagues[0].alternatives.value[0].rank'));
  assert.ok(at(l => { l.next_move.value.move_id = 'L1-m2'; }).includes('$.leagues[0].next_move.value.move_id'));
  assert.ok(at(l => { l.alternatives.value[0].steps[0].p = 0.38; }).includes('$.leagues[0].alternatives.value[0].steps[0].p'));
});

/* ------------------------------------------------------ stop_tradeoffs */

test("stop_tradeoffs keys follow Coach's tradeoffKey grammar exactly", () => {
  const cases = [
    [{ type: 'add_stop', stop: { kind: 'get', label: 'Get him', player_id: '702' } }, 'add:get:702'],
    [{ type: 'add_stop', stop: { kind: 'cover_bye', label: 'Cover', week: 9 } }, 'add:cover_bye:9'],
    [{ type: 'add_stop', stop: { kind: 'custom', label: '  Keep A TE  ' } }, 'add:custom:keep a te'],
    [{ type: 'remove_stop', stop_id: 's3' }, 'remove:s3'],
    [{ type: 'set_risk_mode', mode: 'all_in' }, 'mode:all_in'],
    [{ type: 'set_risk_mode', mode: 'safe', until_week: 6 }, 'mode:safe:until:6'],
    [{ type: 'set_tolerance', key: 'max_assets', value: 2 }, 'tolerance:max_assets:2'],
    [{ type: 'set_tolerance', key: 'ai_spend', value: 12.5 }, 'tolerance:ai_spend:12.5'],
    [{ type: 'set_objective', goal: 'title' }, 'objective:title'],
    [{ type: 'set_objective', goal: 'get_player', player_id: '702' }, 'objective:get_player:702'],
    [{ type: 'set_objective', goal: 'points', points_per_week: 140 }, 'objective:points:140']
  ];
  for (const [action, key] of cases) {
    assert.equal(tradeoffKey(action), key);
    assert.ok(TRADEOFF_KEY.test(key), key);
  }
  for (const bad of ['mode:yolo', 'tolerance:max_assets:two', 'add:trade:702', 'objective:win', 'remove:', 'mode:safe:until:19']) {
    assert.equal(TRADEOFF_KEY.test(bad), false, bad);
  }
  for (const key of Object.keys(COACH_FIXTURE.stop_tradeoffs)) assert.ok(TRADEOFF_KEY.test(key), key);
  for (const key of Object.keys(PRODUCER.leagues[0].stop_tradeoffs.value)) assert.ok(TRADEOFF_KEY.test(key), key);
});

/* ------------------------------------------------- consumer fixtures */

test("the UI's fixture (#231) is the study's shape, and fails the contract only where the mismatch list says", () => {
  const offending = new Set(), missing = new Set();
  for (const entry of UI_FIXTURE) {
    for (const e of validateLeague(entry, '$').errors) {
      const top = e.path.split('.')[1];
      if (e.message === 'is not in the contract') offending.add(top);
      else if (e.message.startsWith('is required')) missing.add(top);
    }
  }
  // acq, flip and baseline are the study's names the contract renames (consumer-reads.js, #231 fixes).
  // owner_mapping_present is written by the study and read by nobody.
  assert.deepEqual([...offending].sort(), ['acq', 'baseline', 'flip', 'owner_mapping_present']);
  // Every campaign section is absent: the study run writes none of them. It also
  // omits `names` on a league whose run failed; the contract requires it (may be {}).
  assert.deepEqual([...missing].sort(), [...Object.keys(SECTIONS), 'names'].sort());
});

test("Coach's fixture (#230) fails the contract only where the mismatch list says", () => {
  const r = validateLeague({ league: 1, me: '3', ...COACH_FIXTURE }, '$');
  const got = [...new Set(r.errors.map(e => `${e.path.split('.').slice(0, 2).join('.')} ${e.message}`))].sort();
  assert.deepEqual(got.filter(s => !s.includes('is required')), [
    '$.alternatives must be a typed field { status, source, ... }',
    '$.destination must be a typed field { status, source, ... }',
    '$.flips is not in the contract',
    '$.itinerary must be a typed field { status, source, ... }',
    '$.stop_tradeoffs must be a typed field { status, source, ... }'
  ]);
  // Wrapped as typed fields, its stop_tradeoffs entry still lacks the keys CoachDock renders.
  const wrapped = validateLeague({ league: 1, me: '3', names: COACH_FIXTURE.names,
    stop_tradeoffs: { status: 'ok', source: 'campaign.plan', value: COACH_FIXTURE.stop_tradeoffs } }, '$');
  const entry = wrapped.errors.filter(e => e.path.startsWith('$.stop_tradeoffs')).map(e => e.path.replace('$.stop_tradeoffs.value.mode:all_in.', '')).sort();
  assert.deepEqual(entry, ['cost', 'gain', 'net', 'new_next_move_changes']);
});

/* ------------------------------------------- reads vs writes (the gate) */

const DECLARED = schemaPaths();
const WRITTEN = new Set([...writtenPaths(PRODUCER)].map(norm));
/** A read resolves when the producer writes the path, and a scalar read does not land on a typed field. */
const resolves = r => DECLARED.has(r.reads) && WRITTEN.has(norm(r.reads)) && !(r.scalar && DECLARED.has(`${r.reads}.status`));

test('every key a consumer reads is a key the producer writes', () => {
  const unmatched = READS.filter(r => !r.fix && !resolves(r));
  assert.deepEqual(unmatched.map(r => `#${r.pr} ${r.where} reads ${r.reads}`), []);
});

test('each recorded mismatch is still a mismatch, and its fix names a real contract path', () => {
  for (const r of READS.filter(x => x.fix)) {
    assert.equal(resolves(r), false, `#${r.pr} ${r.where}: ${r.reads} resolves now; drop its fix`);
    assert.ok(DECLARED.has(r.fix.to) && WRITTEN.has(norm(r.fix.to)), `#${r.pr} ${r.where}: fix target ${r.fix.to} is not written`);
    assert.ok(r.fix.line.length > 10);
  }
});

test('when a consumer file is in this tree, each recorded read still appears in it', t => {
  const present = READS.filter(r => fs.existsSync(path.join(ROOT, r.where.split(':')[0])));
  if (!present.length) { t.skip('neither #230 nor #231 is merged into this tree yet'); return; }
  for (const r of present) {
    const src = fs.readFileSync(path.join(ROOT, r.where.split(':')[0]), 'utf8');
    const leaf = r.reads.replace(/(\.value|\[\]|\{\})+$/, '').split('.').pop().replace(/\W/g, '');
    assert.ok(src.includes(leaf), `${r.where} no longer mentions ${leaf}; update consumer-reads.js`);
  }
});
