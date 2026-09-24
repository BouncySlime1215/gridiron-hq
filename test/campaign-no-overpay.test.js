/**
 * NO-OVERPAY: Nick's cap on what he gives up in market value (the adapter's player value, the app's
 * one market price). Default 0: no planned step, flip leg Nick is on, or walk-away gives more market
 * value than he gets. Nothing clears -> the typed no-move reason names the closest overpay.
 * Made-up leagues (a tiny linear world, and test/fixtures/campaign-league.mjs); no DB, no simulation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const search = await import('../server/services/campaign/search.js');
const { makeScorer, searchTarget, flipLegs, overpayPct, nickOverpays, maxOverpayOf, newOverpaySink, DEFAULT_MAX_OVERPAY } = search;
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry, plansFile } = await import('../server/services/campaign/view.js');
const { validateLeague, validatePlans } = await import('../server/services/campaign/plans-schema.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');

/* ---------------------------------------------------------------- the rule */

test('the cap: default 0, a fraction of what Nick gets, Infinity = no cap', () => {
  assert.equal(DEFAULT_MAX_OVERPAY, 0);
  assert.equal(maxOverpayOf({}), 0);
  assert.equal(maxOverpayOf({ max_overpay: -1 }), 0);
  assert.equal(maxOverpayOf({ max_overpay: 'x' }), 0);
  assert.equal(maxOverpayOf({ max_overpay: 0.05 }), 0.05);
  assert.equal(maxOverpayOf({ max_overpay: Infinity }), Infinity);
  // Nico Collins + Chase Brown (4,670 + 5,705) for Jonathan Taylor (9,018): +15%.
  assert.equal(Math.round(overpayPct(10375, 9018) * 100), 15);
  assert.equal(nickOverpays(10375, 9018), true);
  assert.equal(nickOverpays(10375, 9018, 0.2), false);
  assert.equal(nickOverpays(9018, 9018), false, 'an even trade is not an overpay');
  assert.equal(nickOverpays(8000, 9018), false, 'getting more is never an overpay');
});

/* ------------------------------------------------ a tiny linear world */

// Team 1 = Nick. Team 2 holds the target T (100). Nick: 11 (60) + 12 (50) = 110 is fair on his
// screen (+10%) but a 10% overpay; 13 (100) is an even 1-for-1; 14 (95) Nick gets more.
const VALUES = { 11: 60, 12: 50, 13: 100, 14: 95, 21: 100, 22: 5 };
function world({ nick = [11, 12, 13, 14] } = {}) {
  const rosters = new Map([[1, nick], [2, [21, 22]]]);
  const players = new Map(Object.entries(VALUES).map(([id, value]) => [Number(id), { name: `p${id}`, position: 'WR', value }]));
  const adapter = {
    league: { me: 1 }, players, rosters, managers: new Map([[1, {}], [2, {}]]), untouchable: new Set(),
    searchOpts: { twoForOne: true, fillers: 0 },
    priceStep: () => ({ p: 0.5 }),
  };
  // Nick's title odds: T is worth a lot to him, his own players little (so every path gains).
  const d = (team, ids) => {
    const base = new Set(rosters.get(team));
    let s = 0;
    for (const id of ids) if (!base.has(id)) s += (id === 21 ? 5 : 1) * VALUES[id] * 1e-4;
    for (const id of base) if (!ids.includes(id)) s -= VALUES[id] * 1e-5;
    return s;
  };
  const block = (state, t) => (t == null ? null : (() => {
    const x = d(t, state.get(t) ?? rosters.get(t));
    return { title_delta: x, title_delta_se: 0.0001, title_delta_clears_noise: true, title_before: 0.1 };
  })());
  const S = makeScorer({ rescore: (state, a, b) => ({ me: block(state, a), them: block(state, b) }) }, adapter);
  const vals = { tradable: id => (players.get(id)?.value ?? 0) > 0, addN: new Map(), lossN: new Map(),
    lossO: new Map([[21, { team: 2 }], [22, { team: 2 }]]) };
  return { adapter, S, vals };
}
const OBJ = { kind: 'title', goal: 'title' };
const gives = plans => plans.filter(p => p.steps.length === 1).map(p => p.steps[0].give.map(Number).sort().join('+'));

test('a 2-for-1 that overpays is filtered; an even 1-for-1 passes', () => {
  const { adapter, S, vals } = world();
  const capped = gives(searchTarget(S, adapter, vals, OBJ, 21));
  assert.ok(capped.includes('13'), 'the even 1-for-1 is planned');
  assert.ok(capped.includes('14'), 'a 1-for-1 where Nick gets more is planned');
  assert.ok(!capped.includes('11+12'), 'the 2-for-1 that gives +10% market value is not');
  // Uncapped, the same search plans the overpay: the filter is what removes it.
  const open = gives(searchTarget(S, adapter, vals, OBJ, 21, { maxOverpay: Infinity }));
  assert.ok(open.includes('11+12'));
  // A looser cap lets it through.
  assert.ok(gives(searchTarget(S, adapter, vals, OBJ, 21, { maxOverpay: 0.1 })).includes('11+12'));
});

test('nothing but overpays: no path, and the sink keeps the closest one', () => {
  const { adapter, S, vals } = world({ nick: [11, 12] });
  const sink = newOverpaySink(0);
  const plans = searchTarget(S, adapter, vals, OBJ, 21, { overpaySink: sink });
  assert.equal(plans.length, 0);
  assert.ok(sink.rejected > 0);
  assert.deepEqual(sink.closest.give.map(Number).sort(), [11, 12]);
  assert.deepEqual(sink.closest.get.map(Number), [21]);
  assert.equal(Math.round(sink.closest.pct * 100), 10);
});

test('flip legs: a leg Nick overpays on is dropped, and flagged as dropped by the cap', () => {
  const val = id => VALUES[id] ?? 0;
  // Leg 1: Nick's fair packages for T (100) are 11+12 (110, +10%) only -> capped out.
  const capped = flipLegs({ player: 21, myIds: [11, 12], bIds: [13], val, lossN: new Map(), addN: new Map() });
  assert.equal(capped.legX, null);
  assert.equal(capped.capped.a, true);
  // Leg 2: T (100) for 14 (95) gives more than Nick gets -> capped out; for 13 (100) it is even -> kept.
  assert.equal(flipLegs({ player: 21, myIds: [13], bIds: [14], val, lossN: new Map(), addN: new Map() }).legY, null);
  assert.deepEqual(flipLegs({ player: 21, myIds: [13], bIds: [13], val, lossN: new Map(), addN: new Map() }).legY, [13]);
  const open = flipLegs({ player: 21, myIds: [11, 12], bIds: [14], val, lossN: new Map(), addN: new Map(), maxOverpay: Infinity });
  assert.deepEqual(open.legX.map(Number).sort(), [11, 12]);
  assert.deepEqual(open.legY, [14]);
});

/* ------------------------------------------- the whole planner, capped */

const plan = (maxOverpay, mode = 'balanced', obj = {}) => {
  const a = makeAdapter();
  a.maxOverpay = maxOverpay;
  return { a, res: planLeague(a, { objective: normaliseObjective({ risk_mode: mode, ...obj }) }) };
};
const overpays = (a, res, max) => {
  const v = id => Math.max(0, Number(a.players.get(id)?.value) || 0);
  const sum = ids => ids.reduce((s, id) => s + v(id), 0);
  const out = [];
  for (const c of res.deck) {
    for (const st of c.plan.steps) if (nickOverpays(sum(st.give), sum(st.get), max)) out.push(['step', st]);
    for (const pb of c.playbooks ?? [c.playbook]) {
      const st = c.plan.steps[pb?.step_index ?? 0];
      if (pb?.walk_away && nickOverpays(sum(pb.walk_away.give), sum(st.get), max)) out.push(['walk_away', pb.walk_away]);
    }
  }
  for (const f of res.flip.realised) {
    if (!f.legs) continue;
    const gx = f.legs.give_a_ids ?? [f.legs.give_a], gy = f.legs.get_b_ids ?? [f.legs.get_b];
    if (nickOverpays(sum(gx), v(f.player), max)) out.push(['flip leg 1', f]);
    if (nickOverpays(v(f.player), sum(gy), max)) out.push(['flip leg 2', f]);
  }
  return out;
};

test('the fixture league overpays uncapped, and nothing overpays at the default', () => {
  for (const mode of ['safe', 'balanced', 'all_in']) {
    const open = plan(Infinity, mode);
    const capped = plan(undefined, mode);
    assert.equal(capped.res.tolerances.max_overpay, 0, 'the default cap is 0');
    assert.deepEqual(overpays(capped.a, capped.res, 0), [], `${mode}: no step, walk-away or flip leg overpays`);
    if (mode === 'balanced') assert.ok(overpays(open.a, open.res, 0).length > 0, 'the fixture has overpays to remove');
  }
});

test('walk-away is capped: the most you give never passes the cap', () => {
  let checked = 0;
  for (const max of [0, 0.05]) {
    const { a, res } = plan(max, 'all_in');
    const v = id => Math.max(0, Number(a.players.get(id)?.value) || 0);
    for (const c of res.deck) {
      const st = c.plan.steps[0];
      if (!c.playbook?.walk_away) continue;
      const give = c.playbook.walk_away.give.reduce((s, id) => s + v(id), 0);
      const get = st.get.reduce((s, id) => s + v(id), 0);
      assert.ok(give <= get * (1 + max) + 1e-6, `walk-away ${give} for ${get} passes +${max * 100}%`);
      checked++;
    }
  }
  assert.ok(checked > 0, 'at least one walk-away was priced');
});

test('nothing clears without overpaying: the typed reason names the closest overpay', () => {
  const { a, res } = plan(0, 'balanced', { tolerances: { max_assets: 3 } });
  // Force the empty deck the cap produces when every path overpays: the same result with no plans.
  const empty = { ...res, best: null, deck: [], playbook: [], candidates_scored: 0,
    no_overpay: { max_overpay: 0, rejected: 7, closest: { team: '2', give: ['1', '2'], get: ['21'], pct: 0.153 } } };
  const names = a.names();
  const entry = toEntry(empty, { names, as_of: '2026-09-24T00:00:00Z' });
  assert.equal(entry.next_move.status, 'unknown');
  assert.match(entry.next_move.reason, /^Nothing clears without overpaying; the closest is /);
  assert.ok(entry.next_move.reason.includes(`${names['1']} + ${names['2']} for ${names['21']}`), entry.next_move.reason);
  assert.match(entry.next_move.reason, /at \+15% market value \(your cap: \+0%\)/);
  assert.deepEqual(validateLeague(entry).errors, []);
  // With paths that do not overpay but miss the sliders, the reason says both.
  const both = toEntry({ ...empty, candidates_scored: 4 }, { names, as_of: '2026-09-24T00:00:00Z' });
  assert.match(both.next_move.reason, /None of the 4 paths .* Nothing clears without overpaying; the closest is /);
  // The planner fills the sink itself.
  assert.equal(res.no_overpay.max_overpay, 0);
  assert.ok(Number.isInteger(res.no_overpay.rejected));
});

test('the capped plan still validates against the contract', () => {
  const { a, res } = plan(undefined);
  const entry = toEntry(res, { names: a.names(), as_of: '2026-09-24T00:00:00Z' });
  assert.deepEqual(validateLeague(entry).errors, []);
  const doc = plansFile([entry], { generated_at: '2026-09-24T00:00:00Z' });
  assert.equal(validatePlans(doc).ok, true, JSON.stringify(validatePlans(doc).errors));
});
