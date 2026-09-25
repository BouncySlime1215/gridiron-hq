/**
 * THREE-WAY CYCLES (Batch D item 21): pre-agreed A -> B -> C cycles as two linked two-team trades,
 * shadow only (GRIDIRON_THREE_WAY). Every leg and the holding between legs must pass Nick's rules:
 * never give (160, 80, 277 pinned; objective untouchables), never get (290), no buy-backs, the Blue
 * chip floor on the final get AND on the player held between legs, no overpay (cap 0) on either leg.
 * Made-up league (test/fixtures/campaign-league.mjs); no DB, no simulation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { threeWayFlag, findCycles, bilateralClears, threeWayBlock, cycleRules, CYCLE_DROPS } = await import('../server/services/campaign/three-way.js');
const { makeScorer, playerValues } = await import('../server/services/campaign/search.js');
const { screenFair } = await import('../server/services/campaign/paths.js');
const { ruleVerdict, withNeverGive } = await import('../server/services/campaign/never-give.js');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');

const P = (id, position, value, power) => ({ id, name: `P${id}`, position, value, power, ros_ppg: power, injury: 0, bye: null, trend_kind: null });

/** The fixture league, rules applied as the planner applies them, plus a scorer and values. */
function world({ scores = null, mutate = null } = {}) {
  let a = makeAdapter();
  if (scores) a.scoreOf = id => (scores[id] != null ? { score: scores[id], label: 'x' } : { score: 90, label: 'x' });
  if (mutate) mutate(a);
  a = withNeverGive(a);
  const S = makeScorer(a.world(a.seed), a);
  const vals = playerValues(S, a, normaliseObjective({ risk_mode: 'balanced' }));
  return { a, S, vals };
}
const run = (w, ctx = {}) => findCycles(w.S, null, w.a, w.vals, { targets: [11, 21, 31, 12, 22, 32], maxOverpay: Infinity, ...ctx });
const worth = (a, ids) => ids.reduce((s, id) => s + (a.players.get(Number(id))?.value ?? 0), 0);

test('flag: shadow or 1 searches, anything else is off', () => {
  assert.equal(threeWayFlag({}), 'off');
  assert.equal(threeWayFlag(undefined), 'off');
  assert.equal(threeWayFlag({ GRIDIRON_THREE_WAY: '0' }), 'off');
  assert.equal(threeWayFlag({ GRIDIRON_THREE_WAY: 'on' }), 'off', 'no served mode exists yet');
  assert.equal(threeWayFlag({ GRIDIRON_THREE_WAY: 'shadow' }), 'shadow');
  assert.equal(threeWayFlag({ GRIDIRON_THREE_WAY: '1' }), 'shadow');
});

test('a cycle is two linked trades with three teams, pre-agreed, ranked by title gain x joint P', () => {
  const w = world();
  const r = run(w);
  assert.ok(r.rows.length > 0, 'the fixture has cycles');
  for (const c of r.rows) {
    const [l1, l2] = c.legs;
    assert.notEqual(l1.team, l2.team, 'B and C are different teams');
    assert.ok(l1.team !== '1' && l2.team !== '1', 'Nick is the middle of both legs, never a partner');
    assert.equal(l1.get.length, 1);
    assert.equal(l2.give[0], l1.get[0], 'what leg 1 brings in is what leg 2 hands on');
    assert.equal(l2.get[0], c.target);
    assert.ok(Math.abs(c.p_joint - c.p1 * c.p2) < 1e-12);
    assert.ok(Math.abs(c.expected - c.p_joint * c.title_delta) < 1e-12, 'pre-agreed: all or nothing, no stranded leg');
    assert.ok(c.title_delta > 0);
    assert.equal(c.between.holds, l1.get[0]);
  }
  for (let i = 1; i < r.rows.length; i++) assert.ok(r.rows[i - 1].rank_score >= r.rows[i].rank_score, 'ranked');
  // Every enumerated candidate is kept, exact-scored or dropped under a named reason.
  assert.deepEqual(Object.keys(r.dropped_by_reason).sort(), [...CYCLE_DROPS].sort());
});

test('no overpay on either leg (cap 0 even when the adapter carries none), both legs fair on his screen', () => {
  const w = world();
  assert.equal(w.a.maxOverpay, Infinity, 'the fixture plans uncapped; cycles still hold Nick to 0');
  for (const c of run(w).rows) {
    for (const l of c.legs) {
      const give = worth(w.a, l.give), get = worth(w.a, l.get);
      assert.ok(give <= get + 1e-9, `leg to ${l.team}: gives ${give} <= gets ${get}`);
      assert.ok(screenFair(give, get), `leg to ${l.team} reads fair on his screen`);
    }
  }
});

test('never give 160 / 80 / 277 or an objective untouchable; never get 290', () => {
  const w = world({ mutate: a => {
    for (const [id, v] of [[160, 2600], [80, 1400], [277, 2200]]) a.players.set(id, P(id, 'WR', v, 12));
    a.rosters.set('1', [...a.rosters.get('1'), 160, 80, 277]);
    a.players.set(290, P(290, 'WR', 2600, 14));
    a.rosters.set('3', [...a.rosters.get('3'), 290]);
  } });
  const rows = run(w, { untouchables: ['3'], opts: { keep: 100 } }).rows;
  assert.ok(rows.length > 0);
  const gives = rows.flatMap(c => c.legs.flatMap(l => l.give));
  const gets = rows.flatMap(c => c.legs.flatMap(l => l.get));
  for (const id of ['160', '80', '277', '3']) assert.ok(!gives.includes(id), `${id} is never given`);
  assert.ok(!gets.includes('290'), 'Olave is never a get, not even between legs');
});

test('the Blue chip floor holds on the player held between legs (FLIP-STRANDED) and on the final get', () => {
  // Every player on teams 3 and 4 is under 83: nothing from them may be held between legs.
  const low = Object.fromEntries([21, 22, 23, 24, 25, 31, 32, 33, 34, 35].map(id => [id, 70]));
  const r = run(world({ scores: low }), { targets: [11] });
  assert.equal(r.rows.length, 0);
  assert.ok(r.dropped_by_reason.floor_between > 0);
  // A target under the floor is never a cycle's end.
  const r2 = run(world({ scores: { 11: 82 } }), { targets: [11] });
  assert.equal(r2.rows.length, 0);
  assert.equal(r2.dropped_by_reason.floor_final, 1);
  // Unscored fails closed.
  const w3 = world(); delete w3.a.scoreOf;
  assert.equal(run(w3).rows.length, 0);
});

test('no buy-backs and no reversals: sold players never come back, a failing leg drops the cycle', () => {
  const w = world();
  const all = run(w).rows;
  const heldBetween = all[0].between.holds;
  const r = run(w, { soldOut: id => String(id) === heldBetween, sold: new Set([heldBetween]) });
  assert.ok(r.rows.every(c => c.legs.every(l => !l.get.includes(heldBetween))));
  assert.ok(r.dropped_by_reason.trade_memory > 0);
  const none = run(w, { legOk: () => false });
  assert.equal(none.rows.length, 0);
});

test('fuzz: every leg passes never-give.js ruleVerdict and every holding passes the floor', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const scores = {};
    for (const id of [11, 12, 13, 14, 15, 21, 22, 23, 24, 25, 31, 32, 33, 34, 35]) scores[id] = 60 + ((seed * 7919 + id * 104729) % 40);
    const untouch = [String(1 + (seed % 7))];
    const w = world({ scores });
    const rules = cycleRules(w.a, { untouchables: untouch });
    for (const c of run(w, { untouchables: untouch }).rows) {
      for (const l of c.legs) assert.ok(ruleVerdict(rules, { give: l.give, get: l.get }).ok, `seed ${seed}: ${JSON.stringify(l)}`);
      assert.ok(scores[c.between.holds] >= 83 && scores[c.target] >= 83, `seed ${seed}: floor`);
      assert.ok(!c.legs.some(l => l.give.includes(untouch[0])), `seed ${seed}: untouchable given`);
    }
  }
});

test('bilateral first: the cycle search runs only when no single trade is served', () => {
  assert.equal(bilateralClears([null, { steps: [{}] }]), true);
  assert.equal(bilateralClears([{ steps: [{}, {}] }]), false);
  assert.equal(bilateralClears([]), false);
  let ran = 0;
  const skip = threeWayBlock({ flag: 'shadow', bilateral: true, ledgerMissing: false, run: () => { ran++; return { rows: [] }; } });
  assert.equal(skip.status, 'skipped_bilateral_clears');
  assert.equal(ran, 0);
  const miss = threeWayBlock({ flag: 'shadow', bilateral: false, ledgerMissing: true, run: () => { ran++; return { rows: [] }; } });
  assert.equal(miss.status, 'ledger_missing', 'fails closed like the served search');
  assert.equal(ran, 0);
  const ok = threeWayBlock({ flag: 'shadow', bilateral: false, ledgerMissing: false, chainKeys: new Set(['k1']), bestExpected: 0.01,
    run: () => ({ rows: [{ key: 'k1', expected: 0.02 }, { key: 'k2', expected: 0.005 }] }) });
  assert.equal(ok.served, false);
  assert.deepEqual(ok.rows.map(r => [r.also_chained, r.beats_best]), [[true, true], [false, false]]);
  assert.equal(ok.new_cycles, 1);
});

test('planner: off writes no key; shadow moves nothing served', () => {
  const plan = env => planLeague(makeAdapter(), { objective: normaliseObjective({ risk_mode: 'balanced' }), env });
  const off = plan({}), zero = plan({ GRIDIRON_THREE_WAY: '0' }), shadow = plan({ GRIDIRON_THREE_WAY: 'shadow' });
  assert.equal('three_way' in off, false);
  assert.equal('three_way' in zero, false);
  const served = r => JSON.stringify({ targets: r.targets, best: r.best, deck: r.deck, suggestions: r.suggestions,
    catch_up: r.catch_up, risk_modes: r.risk_modes, flip: r.flip });
  assert.equal(served(shadow), served(off));
  const tw = shadow.three_way;
  assert.equal(tw.served, false);
  assert.equal(tw.flag, 'shadow');
  const single = [shadow.best, ...shadow.deck.map(c => c.plan)].some(p => p?.steps.length === 1);
  assert.equal(tw.status, single ? 'skipped_bilateral_clears' : 'ok');
});

test('planner: with no single trade served, the shadow block searches the same targets and adds new cycles', () => {
  // The fixture serves a two-step chain in balanced (no single trade), so the cycle search runs.
  const res = planLeague(makeAdapter(), { objective: normaliseObjective({ risk_mode: 'balanced' }), env: { GRIDIRON_THREE_WAY: 'shadow' } });
  assert.ok(res.best && res.best.steps.length > 1 && res.deck.every(c => c.plan.steps.length > 1));
  const tw = res.three_way;
  assert.equal(tw.status, 'ok');
  assert.deepEqual(tw.per_target.map(t => t.target), res.targets.map(String));
  assert.ok(tw.rows.length > 0 && tw.new_cycles > 0, 'cycles the chained search did not already score');
  for (const c of tw.rows) assert.ok(c.confirm && Number.isFinite(c.confirm.title_delta), 'priced on the confirm dice too');
  // Pre-agreement is the point: the same legs sent one after the other can strand leg 1.
  assert.ok(tw.rows.some(c => c.expected > c.sequential_expected));
});
