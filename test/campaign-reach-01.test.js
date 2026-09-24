/**
 * REACH-01: why every path died (dropped_by_reason), the reach filter before the target slice,
 * the chained finish up to the mode's max give, and the closest miss printed as its whole chain.
 * Pre-registration: docs/tdd/2026-09-24-reach-01.tdd.md (M1-M6).
 * Made-up leagues only (test/fixtures/campaign-league.mjs and small linear worlds); no DB, no simulation.
 * The market values in the arithmetic test are the plan's measured league-4 numbers, unlabelled.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { REACH_ENV, REACH_TARGETS, reachFlag, reachBound, targetReach } = await import('../server/services/campaign/reach.js');
const { makeScorer, searchTarget, newOverpaySink, flipReach } = await import('../server/services/campaign/search.js');
const { toleranceCheck, toleranceViolation, rankPlans, tolerancesFor, MODES } = await import('../server/services/campaign/modes.js');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry } = await import('../server/services/campaign/view.js');
const { validateLeague } = await import('../server/services/campaign/plans-schema.js');
const { makeAdapter, makePlayers } = await import('./fixtures/campaign-league.mjs');

const ON = { [REACH_ENV]: '1' }, OFF = { [REACH_ENV]: '0' };

/* ---------------------------------------------------------------- the flag */

test('flag: only 1 turns it on; unset is off even under preview (unproven until league 4 is measured)', () => {
  assert.equal(reachFlag({ [REACH_ENV]: '1' }), 'on');
  assert.equal(reachFlag({ [REACH_ENV]: '0', GRIDIRON_PREVIEW_UNCONFIRMED: '1' }), 'off');
  assert.equal(reachFlag({ GRIDIRON_PREVIEW_UNCONFIRMED: '1' }), 'off');
  assert.equal(reachFlag({}), 'off');
  assert.equal(REACH_TARGETS, 8);
});

/* -------------------------------------------------------- reach arithmetic */

// Nick's tradable currency (fc_value, the plan's section 4 cause 1), untouchables already out.
const MINE = [3583, 1920, 1910, 1783, 743, 637, 637, 615, 366, 286, 134, 19];

test('reach bound: the plan arithmetic (direct 2-give 5,503, 3-give 7,413)', () => {
  const b = reachBound({ mine: MINE, outside: [], maxGiveDirect: 3, maxGiveChain: 2, maxOverpay: 0 });
  assert.equal(b.direct[2], 5503);
  assert.equal(b.direct[3], 7413);
  assert.equal(b.best, 7413);
  // A 5,796 WR needs >= 5,100 on his screen: in reach with two gives.
  const wr = targetReach(5796, b);
  assert.equal(wr.in_reach, true);
  assert.equal(wr.min_gives, 2);
  // A 9,722 RB needs >= 8,555: out of reach by any direct package.
  assert.equal(targetReach(9722, b).in_reach, false);
  // A 6,791 RB needs >= 5,976: direct only with three gives.
  assert.equal(targetReach(6791, b).min_gives, 3);
});

test('reach bound: a one-chip chain through a real 6,166 piece (the closest-miss chain)', () => {
  const b = reachBound({ mine: MINE, outside: [6166], maxGiveDirect: 3, maxGiveChain: 2, maxOverpay: 0 });
  // Two of Nick's (3,583 + 1,910 = 5,493) for the 6,166 piece, then that piece + the best one left (1,920) = 8,086.
  assert.equal(b.chain, 8086);
  assert.equal(b.best, 8086);
  assert.equal(targetReach(6791, b).in_reach, true, 'the 6,791 RB is chain-reachable with two gives');
  assert.equal(targetReach(9722, b).in_reach, false, 'the 9,722 RB is still not');
  // With no chip piece anywhere in the league, the chain adds nothing.
  assert.equal(reachBound({ mine: MINE, outside: [99999], maxGiveDirect: 3, maxGiveChain: 2 }).chain, null);
});

test('flipReach packages up to k of Nick\'s best pieces', () => {
  assert.equal(flipReach(MINE).package_value, 5503);
  assert.equal(flipReach(MINE, 3).package_value, 7413);
});

/* ---------------------------------------------------- tolerance reason codes */

test('toleranceCheck names each gate with a code; toleranceViolation keeps its text', () => {
  const tol = tolerancesFor('balanced');
  const step = (give, extra = {}) => ({ team: '2', give, get: ['9'], p: 0.5, delta: 0.01, ...extra });
  const cases = [
    [{ steps: [step(['1', '2', '3'])] }, 'max_give_per_step'],
    [{ steps: [step(['1'], { delta: -0.5 })] }, 'max_downside_per_step'],
    [{ steps: [step(['1']), step(['2']), step(['3'])] }, 'max_offers_per_manager_week'],
    [{ steps: [step(['1'])] }, null],
  ];
  for (const [plan, code] of cases) {
    const c = toleranceCheck(plan, tol, { originalIds: ['1', '2', '3', '4'] });
    assert.equal(c?.code ?? null, code);
    assert.equal(toleranceViolation(plan, tol, { originalIds: ['1', '2', '3', '4'] }), c?.why ?? null);
  }
  const u = toleranceCheck({ steps: [step(['1'])] }, tol, { originalIds: ['1'], untouchables: ['1'] });
  assert.equal(u.code, 'untouchable');
  const { dropped } = rankPlans([{ steps: [step(['1'], { p: 0.01 })] }], 'all_in', tolerancesFor('all_in'), {});
  assert.equal(dropped[0].code, 'p_complete_floor');
});

/* ---------------------------------------------- M1: every path accounted for */

const planOn = (env, { adapter = makeAdapter(), mode = 'balanced', targets } = {}) =>
  planLeague(adapter, { objective: normaliseObjective({ risk_mode: mode }), env, ...(targets ? { budget: { targets } } : {}) });

test('M1: dropped_by_reason sums to candidates_scored in every mode', () => {
  for (const mode of MODES) {
    for (const env of [ON, OFF]) {
      const res = planOn(env, { mode });
      const d = res.reach.dropped_by_reason;
      assert.equal(d.candidates, res.candidates_scored);
      for (const m of MODES) {
        const r = d.modes[m];
        const tol = Object.values(r.tolerance).reduce((s, n) => s + n, 0);
        assert.equal(r.kept + tol + r.p_complete_floor, res.candidates_scored, `${mode}/${m}`);
      }
      assert.equal(d.search.no_overpay, res.no_overpay.rejected);
      const confirmed = d.modes[mode].confirm;
      assert.ok(confirmed, 'the objective mode carries the confirm counts');
      assert.equal(confirmed.checked - confirmed.failed >= res.deck.length, true);
      for (const m of MODES.filter(x => x !== mode)) assert.equal(d.modes[m].confirm, null, 'confirm runs for the objective mode only');
    }
  }
});

/* -------------------------------- M2 + M3: the filter frees slots, soundly */

test('M2 + M3: out-of-reach targets are skipped (never findable) and the next ones are searched', () => {
  const base = planOn(OFF, { targets: 3 });
  const top3 = base.targets.map(String);
  assert.equal(top3.length, 3);
  // Price the three top upgrades far past anything Nick can hand over.
  const players = makePlayers();
  for (const id of top3) players.set(Number(id), { ...players.get(Number(id)), value: 99999 });
  const mk = () => { const a = makeAdapter({ players }); return a; };

  const off = planOn(OFF, { adapter: mk(), targets: 3 });
  assert.deepEqual(off.targets.map(String), top3, 'off: the same three are searched');
  const on = planOn(ON, { adapter: mk(), targets: 3 });
  const skipped = on.reach.targets.filter(t => !t.in_reach).map(t => t.player);
  assert.deepEqual([...skipped].sort(), [...top3].sort(), 'on: exactly the unreachable three are skipped');
  assert.equal(on.reach.dropped_by_reason.search.out_of_reach, 3);
  assert.equal(on.targets.length, 3);
  assert.ok(on.targets.every(t => !top3.includes(String(t))), 'on: three reachable targets take their slots');
  // M2: searched unfiltered (off searches only these three), the skipped targets produce no path at all.
  assert.equal(off.candidates_scored, 0, 'off: the three unreachable targets produce no path at all');
  assert.ok(on.candidates_scored > 0, 'on: the freed slots produce paths');
});

/* ----------------------------------- M4: the chained finish follows the mode */

// Nick (team 1): A 100, B 90, C 90, D 10. Team 2 holds the target T and a filler; team 3 holds X (200).
// Direct: the best three-give is 280. Chain: B + C (180) for X (200), then A + X + D (310) for T.
function chainWorld(tValue) {
  const V = { 1: 100, 2: 90, 3: 90, 4: 10, 21: tValue, 22: 5, 31: 200, 32: 5 };
  const rosters = new Map([[1, [1, 2, 3, 4]], [2, [21, 22]], [3, [31, 32]]]);
  const players = new Map(Object.entries(V).map(([id, value]) => [Number(id), { name: `p${id}`, position: 'WR', value }]));
  const adapter = { league: { me: 1 }, players, rosters, managers: new Map([[1, {}], [2, {}], [3, {}]]), untouchable: new Set(),
    searchOpts: { twoForOne: true, fillers: 0 }, priceStep: () => ({ p: 0.5 }) };
  const d = (team, ids) => {
    const base = new Set(rosters.get(team));
    let s = 0;
    for (const id of ids) if (!base.has(id)) s += (id === 21 ? 10 : 1) * V[id] * 1e-4;
    for (const id of base) if (!ids.includes(id)) s -= V[id] * 1e-5;
    return s;
  };
  const block = (state, t) => (t == null ? null
    : { title_delta: d(t, state.get(t) ?? rosters.get(t)), title_delta_se: 0.0001, title_delta_clears_noise: true, title_before: 0.1 });
  const S = makeScorer({ rescore: (state, a, b) => ({ me: block(state, a), them: block(state, b) }) }, adapter);
  const vals = { tradable: id => (players.get(id)?.value ?? 0) > 0, addN: new Map(), lossN: new Map(),
    lossO: new Map([[21, { team: 2 }], [22, { team: 2 }], [31, { team: 3 }], [32, { team: 3 }]]) };
  return { adapter, S, vals };
}
const OBJ = { kind: 'title', goal: 'title' };

test('M4: a finish that needs three gives after a chip is found at chainGive 3 only', () => {
  const w = chainWorld(345); // needs >= 303.6 on his screen
  const two = searchTarget(w.S, w.adapter, w.vals, OBJ, 21);
  assert.equal(two.length, 0, 'chained finish capped at 2: nothing reaches T');
  const three = searchTarget(w.S, w.adapter, w.vals, OBJ, 21, { chainGive: 3 });
  const hit = three.find(p => p.steps.length === 2 && p.steps[1].give.length === 3);
  assert.ok(hit, 'the chip-then-3-for-1 path is found');
  assert.deepEqual(hit.steps[1].give.map(Number).sort((a, b) => a - b), [1, 4, 31]);
});

/* ----------------------------------------- M6: the closest miss is a chain */

test('M6: the overpay sink keeps the chain in front of the overpaying finish, and the reason prints it', () => {
  const w = chainWorld(290); // A + X (300) for T (290) is fair on his screen but a +3% overpay
  const sink = newOverpaySink(0);
  searchTarget(w.S, w.adapter, w.vals, OBJ, 21, { overpaySink: sink });
  const c = sink.closest;
  assert.ok(c, 'a closest overpay is kept');
  assert.deepEqual(c.get.map(Number), [21]);
  assert.ok(c.give.map(Number).includes(31), 'the finish spends the chipped-in piece');
  assert.equal(c.chain.length, 1);
  assert.deepEqual(c.chain[0].get.map(Number), [31]);
  assert.equal(String(c.chain[0].team), '3');

  const a = makeAdapter();
  const res = planOn(OFF, { adapter: a });
  const names = a.names();
  const empty = { ...res, best: null, deck: [], playbook: [], candidates_scored: 0,
    no_overpay: { max_overpay: 0, rejected: 3, closest: { team: '2', give: ['1', '21'], get: ['11'], pct: 0.017,
      chain: [{ team: '3', give: ['2', '3'], get: ['21'] }] } } };
  const entry = toEntry(empty, { names, as_of: '2026-09-24T00:00:00Z' });
  const reason = entry.next_move.reason;
  const first = `${names['2']} + ${names['3']} for ${names['21']} (Team 3)`;
  const then = `then ${names['1']} + ${names['21']} for ${names['11']}`;
  assert.ok(reason.includes(first), reason);
  assert.ok(reason.includes(then), reason);
  assert.ok(reason.indexOf(first) < reason.indexOf(then), 'the chain reads in order');
  assert.match(reason, /at \+2% market value/);
  assert.deepEqual(validateLeague(entry).errors, []);
});

/* ---------------------------------------------- M5: off is today's planner */

test('M5: flag off, targets and chain width are the incumbent\'s', () => {
  const res = planOn(OFF, { targets: 3 });
  assert.equal(res.reach.flag, 'off');
  assert.equal(res.reach.chain_give, 2);
  assert.equal(res.reach.dropped_by_reason.search.out_of_reach, 0);
  assert.equal(res.targets.length, 3);
  const on = planOn(ON, { mode: 'all_in' });
  assert.equal(on.reach.chain_give, 3, 'on: all_in chains up to its max give (3)');
  assert.equal(planOn(ON, { mode: 'balanced' }).reach.chain_give, 2, 'on: balanced stays at 2');
});
