/**
 * FIX-03: the campaign producer writes the War Room contract (plans-schema.js,
 * `warroom-plans/1`), not its own prototype shape. Rows P1-P25 of
 * INTEGRATION-AUDIT-0923 section 4a, each pinned on the made-up four-team
 * league in test/fixtures/campaign-league.mjs. No DB, no simulation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { SKIP_WEIGHT } = await import('../server/services/campaign/partners.js');
const { toEntry, failedEntry, plansFile } = await import('../server/services/campaign/view.js');
const { buildPlansFile } = await import('../scripts/campaign/produce-plans.mjs');
const schema = await import('../server/services/campaign/plans-schema.js');
const { makeProducerPlans } = await import('./fixtures/warroom-contract/make-producer-plans.mjs');
const { validatePlans, validateLeague, tradeoffKey, SCHEMA_VERSION, STATUSES, SECTIONS } = schema;

const AS_OF = '2026-09-24T00:00:00.000Z';
const STOPS = [{ kind: 'get', player: '21' }, { kind: 'sell', player: '7' }];
const plan = (obj = {}, opts = {}) => {
  const a = makeAdapter(opts);
  const res = planLeague(a, { objective: normaliseObjective({ risk_mode: 'balanced', ...obj }) });
  return { a, res, entry: toEntry(res, { names: a.names(), as_of: AS_OF }) };
};
const errs = entry => validateLeague(entry).errors.map(e => `${e.path}: ${e.message}`);
const allStatuses = v => {
  const out = new Set();
  const walk = x => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (!x || typeof x !== 'object') return;
    if (typeof x.status === 'string' && 'source' in x) out.add(x.status);
    Object.values(x).forEach(walk);
  };
  walk(v);
  return out;
};

test('P2/P3/P23: a planned league validates with validateLeague, with no view, acq or flip', () => {
  for (const obj of [{}, { kind: 'points', points_per_week: 95 }, { kind: 'player', target: '21' }, { stops: STOPS }]) {
    const { entry } = plan(obj);
    assert.deepEqual(errs(entry), [], JSON.stringify(obj));
    for (const k of ['view', 'acq', 'flip', 'objective', 'next_step', 'trajectory', 'seed', 'phases_ms', 'inputs']) {
      assert.equal(k in entry, false, `${k} must not sit at the entry top level`);
    }
    for (const k of Object.keys(SECTIONS)) assert.ok(k in entry, `section ${k}`);
  }
});

test('P1: the file head is the contract head and the whole file validates', () => {
  const { entry } = plan();
  const file = plansFile([entry], { generated_at: AS_OF });
  assert.equal(file.schema, SCHEMA_VERSION);
  assert.deepEqual(Object.keys(file).sort(), ['generated_at', 'leagues', 'producer', 'producer_version', 'schema']);
  assert.deepEqual(validatePlans(file).errors, []);
});

test('P4: only ok, unknown and failed are written', () => {
  for (const obj of [{}, { kind: 'points', points_per_week: 95 }]) {
    const { entry } = plan(obj);
    for (const s of allStatuses(entry)) assert.ok(STATUSES.includes(s), `status ${s}`);
  }
});

test('P8/P9 (D3): the deck head is card 1 and next_move is that same move', () => {
  const { res, entry } = plan();
  const deck = entry.alternatives.value;
  assert.equal(deck.length, res.deck.length, 'the whole deck, head included');
  assert.equal(entry.next_move.status, 'ok');
  assert.equal(entry.next_move.value.move_id, deck[0].move_id);
  assert.deepEqual(deck.map(m => m.rank), deck.map((_, i) => i + 1));
  const head = deck[0].steps[0], best = res.best.steps[0];
  assert.equal(head.partner, String(best.team));
  assert.deepEqual(head.give, best.give.map(String));
});

test('move ids are stable across re-runs and distinct inside a deck', () => {
  const one = plan().entry.alternatives.value.map(m => m.move_id);
  const two = plan().entry.alternatives.value.map(m => m.move_id);
  assert.deepEqual(one, two);
  assert.equal(new Set(one).size, one.length);
});

test('P10/P11: each played step carries typed deltas, message, opening, walk-away, send-when and the reply table', () => {
  const { res, entry } = plan();
  const st = entry.next_move.value.steps[0];
  assert.equal(st.title_odds_delta.status, 'ok');
  assert.equal(st.title_odds_delta.source, 'sim.title');
  assert.equal(typeof st.title_odds_delta.clears_2se, 'boolean');
  assert.equal(st.title_after.status, 'ok');
  assert.equal(st.message.status, 'ok');
  assert.equal(st.message.source, 'plan.template');
  assert.equal(st.opening.status, 'ok');
  assert.deepEqual(st.opening.value.get, res.best.steps[0].get.map(String));
  assert.equal(st.walk_away.status, 'ok');
  assert.ok(st.walk_away.value.max_give.length);
  assert.equal(st.send_when.status, 'ok');
  assert.deepEqual(Object.keys(st.reply_table.value), ['accept', 'decline', 'counter', 'silence']);
  // The decline row names the backup: the next card in the deck.
  const decline = st.reply_table.value.decline.value;
  assert.equal(decline.move_id, entry.alternatives.value[1].move_id);
  assert.equal(st.p_yes.guess, true);
  assert.equal(st.p_yes.unit, 'probability');
});

test('P25: a step carries the acceptance band it was priced with', () => {
  const { entry } = plan();
  const st = entry.next_move.value.steps[0];
  assert.ok(st.p_yes_band, 'p_yes_band');
  assert.ok(st.p_yes_band.low <= st.p_yes.value && st.p_yes.value <= st.p_yes_band.high);
});

test('P20: stop_tradeoffs are keyed by tradeoffKey, for stops and for the other risk modes', () => {
  const { entry } = plan({ stops: STOPS });
  assert.equal(entry.stop_tradeoffs.status, 'ok');
  const keys = Object.keys(entry.stop_tradeoffs.value);
  assert.ok(keys.includes(tradeoffKey({ type: 'add_stop', stop: { kind: 'get', player_id: '21', label: 'x' } })), keys.join());
  assert.ok(keys.includes('mode:safe') && keys.includes('mode:all_in'), keys.join());
  assert.equal(keys.includes('mode:balanced'), false, 'the current mode is not a trade-off');
  for (const k of keys) assert.ok(schema.TRADEOFF_KEY.test(k), k);
});

test('P12/P13/P16: targets, flip_map, risk_modes and partners are contract sections', () => {
  const { res, entry } = plan();
  assert.equal(entry.targets.status, 'ok');
  const t = entry.targets.value[0];
  assert.equal(t.mode_fit.status, 'ok');
  assert.equal(t.why.status, 'ok');
  assert.equal(typeof t.is_plan_target, 'boolean');
  assert.equal(entry.flip_map.status, 'ok');
  for (const f of entry.flip_map.value) if (f.legs) assert.equal(f.legs.p_both.status, 'ok');
  assert.deepEqual(entry.risk_modes.value.map(m => m.mode), ['safe', 'balanced', 'all_in']);
  assert.deepEqual(entry.risk_modes.value.filter(m => m.active).map(m => m.mode), ['balanced']);
  assert.equal(entry.partners.value.length, res.partners.length);
});

test('P14/P15: without a brain read, brain_report and number_health say so instead of hard-coding a verdict', () => {
  const { entry } = plan();
  for (const k of ['brain_report', 'number_health']) {
    assert.equal(entry[k].status, 'unknown', k);
    assert.match(entry[k].reason, /not read/); // FIX-05 fills them when the producer passes the reads (campaign-brain-gate.test.js)
  }
});

test('P17/P18: feasibility is the points contract or unknown; goal, risk mode and tolerances are typed', () => {
  const pts = plan({ kind: 'points', points_per_week: 95 }).entry;
  assert.equal(pts.feasibility.status, 'ok');
  assert.equal(pts.feasibility.value.points_per_week, 95);
  assert.equal(pts.destination.value.goal.value.kind, 'points');
  const title = plan().entry;
  assert.equal(title.feasibility.status, 'unknown');
  assert.match(title.feasibility.reason, /points objective not set/);
  const who = plan({ kind: 'player', target: '21' }).entry;
  assert.deepEqual(who.destination.value.goal.value, { kind: 'get_player', label: 'Get P21 (WR)', player_id: '21' });
  const until = plan({ risk_mode: 'safe', risk_until_week: 6 }).entry;
  assert.deepEqual(until.destination.value.risk_mode.value, { mode: 'safe', until_week: 6 });
  assert.equal(title.destination.value.eta_week.status, 'ok');
});

test('P21/P22: attention is per league; finder_best_expected comes from the adapter or says why not', async () => {
  const doc = await makeProducerPlans();
  const ok = doc.leagues.filter(l => !l.error);
  for (const l of ok) {
    assert.equal(l.attention.status, 'ok');
    assert.equal(l.attention.value.of, doc.leagues.length);
  }
  assert.equal(ok[0].finder_best_expected.status, 'ok');
  const noFinder = toEntry({ ...plan().res, finder_best: null }, { names: makeAdapter().names(), as_of: AS_OF });
  assert.equal(noFinder.finder_best_expected.status, 'unknown');
});

test('a failed league is the contract failed shape: league, me, names, error', () => {
  const e = failedEntry({ league: 5, me: '1', error: 'world failed: no schedule' }, { names: {} });
  assert.deepEqual(Object.keys(e).sort(), ['error', 'league', 'me', 'names']);
  assert.deepEqual(validateLeague(e).errors, []);
  assert.equal(failedEntry({ league: 5, me: null, error: 'x' }).me, 'unknown');
});

test('a league that fails validateLeague is written as the failed shape, and the file still validates', async () => {
  const a = makeAdapter();
  a.names = () => ({}); // every player id now fails "is not in this league's names"
  const doc = await buildPlansFile([{ id: 99, load: async () => ({ adapter: a }) }], { generated_at: AS_OF, clock: () => 0 });
  const [l] = doc.leagues;
  assert.match(l.error, /contract check/);
  assert.deepEqual(validatePlans(doc).errors, []);
});

test('replan reads the previous run from _run: same move -> not changed', async () => {
  const load = async () => ({ adapter: makeAdapter() });
  const first = await buildPlansFile([{ id: 99, load }], { generated_at: AS_OF, clock: () => 0 });
  const prev = new Map(first.leagues.map(e => [String(e.league), e]));
  const second = await buildPlansFile([{ id: 99, load }], { generated_at: AS_OF, clock: () => 0, previous: prev });
  assert.equal(first.leagues[0]._run.changed.changed, true);
  assert.equal(second.leagues[0]._run.changed.changed, false);
  assert.equal(second.leagues[0]._run.changed.reason, 'same next move');
});

test('extended vocabularies: unit and guess are typed-field keys; SKIP and DECLINE reasons are shared', () => {
  const { entry } = plan();
  const bad = structuredClone(entry);
  bad.next_move.value.steps[0].p_yes.unit = 'bananas';
  assert.ok(errs(bad).some(e => /unit/.test(e)));
  bad.next_move.value.steps[0].p_yes.unit = 'probability';
  bad.next_move.value.steps[0].p_yes.guess = 'yes';
  assert.ok(errs(bad).some(e => /guess/.test(e)));
  for (const s of ['plan.template', 'chat.labels', 'asset.ros']) assert.ok(schema.SOURCE_IDS.includes(s), s);
  assert.deepEqual([...schema.SKIP_REASONS], ['player', 'cost', 'manager', 'not_now']);
  assert.deepEqual([...schema.DECLINE_REASONS], ['wants_more', 'likes_his_player', 'not_interested', 'not_now', 'other']);
  for (const r of schema.SKIP_REASONS) assert.ok(SKIP_WEIGHT[r] > 0, `SKIP_WEIGHT.${r}`);
});

test('the committed producer fixture is what the real producer writes on the fixture league', async () => {
  const committed = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/warroom-contract/producer-plans.json'), 'utf8'));
  assert.deepEqual(await makeProducerPlans(), committed);
});
