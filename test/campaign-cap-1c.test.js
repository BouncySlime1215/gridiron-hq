/**
 * CAP-1C (Nick's decision 1c, 2026-09-24): the overpay cap stays 0 by default, with one exception.
 * A depth-only 2-for-1 consolidation (exactly two of Nick's players for one, no blue chip in the give)
 * may give up to +12% market value, and is planned ONLY if Nick's weekly starting-lineup points AND his
 * title odds both rise on paired dice, and still rise when the deck is re-priced on fresh dice.
 * Made-up leagues (a tiny linear world, and test/fixtures/campaign-league.mjs); no DB, no simulation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const search = await import('../server/services/campaign/search.js');
const { makeScorer, searchTarget, overpayPct, DEPTH_PREMIUM_MAX, BLUE_CHIP_SCORE, NEVER_DEPTH, depthPremiumOf, boardOf, isDepth, depthOnlyTwoForOne,
  newPremiumSink, premiumHolds } = search;
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry, plansFile } = await import('../server/services/campaign/view.js');
const { validateLeague, validatePlans } = await import('../server/services/campaign/plans-schema.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');

/* ---------------------------------------------------------------- the rule */

test('the premium: +12% by default, never above +12%, off when set to 0', () => {
  assert.equal(DEPTH_PREMIUM_MAX, 0.12);
  assert.equal(depthPremiumOf({}), 0.12);
  assert.equal(depthPremiumOf({ depth_premium: 0.05 }), 0.05);
  assert.equal(depthPremiumOf({ depth_premium: 0 }), 0);
  assert.equal(depthPremiumOf({ depth_premium: 0.5 }), 0.12, 'Nick said up to +12%: a larger setting is clamped');
  assert.equal(depthPremiumOf({ depth_premium: -1 }), 0.12);
  assert.equal(depthPremiumOf({ depth_premium: 'x' }), 0.12);
});

test('board: a Map or an object of scores; none, empty or all-unscored is no board (fails closed)', () => {
  assert.equal(BLUE_CHIP_SCORE, 83);
  assert.equal(boardOf({}), null);
  assert.equal(boardOf({ board: {} }), null, 'an empty board is no board');
  assert.equal(boardOf({ board: new Map() }), null);
  assert.equal(boardOf({ board: { 1: null, 2: 'x' } }), null, 'an all-unscored board is no board');
  assert.deepEqual([...boardOf({ board: { 1: 70, 2: null } })], [['1', 70]]);
  assert.deepEqual([...boardOf({ board: new Map([[7, 90]]) })], [['7', 90]]);
});

test('depth: an explicit score below 83, never an unscored player, never 160 / 80 / 277', () => {
  const board = new Map([['1', 70], ['2', 83], ['160', 50], ['80', 50], ['277', 60]]);
  assert.equal(isDepth(1, { board }), true);
  assert.equal(isDepth(2, { board }), false, '83 is a blue chip');
  assert.equal(isDepth(3, { board }), false, 'unscored is never depth');
  for (const id of ['160', '80', '277']) {
    assert.ok(NEVER_DEPTH.has(id));
    assert.equal(isDepth(id, { board }), false, `${id} is never depth, whatever the board says`);
  }
  assert.equal(isDepth(1, { board, untouchable: new Set(['1']) }), false);
});

test('depth-only 2-for-1: exactly two given for one, none a blue chip or untouchable', () => {
  const board = new Map([['1', 60], ['2', 60], ['3', 60], ['8', 60], ['9', 90]]);
  const untouchable = new Set(['8']);
  const ok = (give, get) => depthOnlyTwoForOne({ give, get }, { board, untouchable });
  assert.equal(ok([1, 2], [21]), true);
  assert.equal(ok([1, 9], [21]), false, 'a blue chip in the give');
  assert.equal(ok([1, 8], [21]), false, 'an untouchable in the give');
  assert.equal(ok([1], [21]), false, '1-for-1');
  assert.equal(ok([1, 2, 3], [21]), false, '3-for-1');
  assert.equal(ok([1, 2], [21, 22]), false, '2-for-2');
  assert.equal(ok([1, 4], [21]), false, 'an unscored player in the give');
  assert.equal(depthOnlyTwoForOne({ give: [1, 2], get: [21] }, { board: null }), false, 'no board: depth-only cannot be checked');
});

test('premiumHolds: lineup points AND title odds both rise on the step', () => {
  const me = (t, p) => ({ title_delta: t, points_delta: p });
  assert.equal(premiumHolds(me(0.01, 1.5), null).ok, true);
  assert.equal(premiumHolds(me(0.01, -0.1), null).why, 'lineup_points');
  assert.equal(premiumHolds(me(-0.01, 2), null).why, 'title_odds');
  assert.equal(premiumHolds(me(0.01, undefined), null).why, 'no_lineup_points');
  // A later step is judged on its own change, not the path's total.
  assert.equal(premiumHolds(me(0.03, 5), me(0.02, 6)).why, 'lineup_points');
  assert.equal(premiumHolds(me(0.03, 7), me(0.02, 6)).ok, true);
});

/* ------------------------------------------------ a tiny linear world */

// Team 1 = Nick. Team 2 holds the target T 21 (100).
// 11 (60) + 12 (50) = 110: +10%, depth-only: inside the premium.
// 11 (60) + 15 (55) = 115: +15%: past the premium (12 + 15 = 105, +5%, rides it).
// 16 (60, blue chip) + 12 (50) = 110: +10% but a blue chip in the give.
// 17 (70) + 18 (40) = 110: +10%, depth-only, but Nick's lineup gets WORSE (17 is his starter, 18 a bench piece).
const VALUES = { 11: 60, 12: 50, 15: 55, 16: 60, 17: 70, 18: 40, 21: 100 };
// Lineup points per player (what the lineup loses when he leaves, gains when he arrives).
const POINTS = { 11: 1, 12: 1, 15: 1, 16: 1, 17: 12, 18: 0, 21: 10 };
// Board scores: 16 is the blue chip (90); the rest are depth.
const BOARD = { 11: 70, 12: 60, 15: 65, 16: 90, 17: 75, 18: 50, 21: 85 };
function world({ nick = [11, 12, 15, 16, 17, 18], board = BOARD } = {}) {
  const rosters = new Map([[1, nick], [2, [21]]]);
  const players = new Map(Object.entries(VALUES).map(([id, value]) => [Number(id), { name: `p${id}`, position: 'WR', value }]));
  const adapter = {
    league: { me: 1 }, players, rosters, managers: new Map([[1, {}], [2, {}]]), untouchable: new Set(),
    searchOpts: { twoForOne: true, fillers: 0 },
    priceStep: () => ({ p: 0.5 }),
  };
  const d = (team, ids, per) => {
    const base = new Set(rosters.get(team));
    let s = 0;
    for (const id of ids) if (!base.has(id)) s += per[id];
    for (const id of base) if (!ids.includes(id)) s -= per[id];
    return s;
  };
  // Title odds follow lineup points here, except 17 + 18 where they rise while points fall (a bye-week quirk).
  const block = (state, t) => (t == null ? null : (() => {
    const ids = state.get(t) ?? rosters.get(t);
    const pts = d(t, ids, POINTS);
    const title = ids.includes(21) && !ids.includes(17) && !ids.includes(18) ? 0.002 : pts * 1e-3;
    return { title_delta: title, title_delta_se: 0.0001, title_delta_clears_noise: true, title_before: 0.1,
      points_delta: pts, points_delta_se: 0.1 };
  })());
  const S = makeScorer({ rescore: (state, a, b) => ({ me: block(state, a), them: block(state, b) }) }, adapter);
  const vals = { tradable: id => (players.get(id)?.value ?? 0) > 0, addN: new Map(), lossN: new Map(),
    lossO: new Map([[21, { team: 2 }]]) };
  return { adapter, S, vals, board: boardOf({ board }) };
}
const OBJ = { kind: 'title', goal: 'title' };
// The 1-step plans where Nick gives MORE market value than he gets (even or under-give trades are the plain cap's business).
const gives = plans => plans.filter(p => p.steps.length === 1 && p.steps[0].give.reduce((s, id) => s + VALUES[id], 0) > 100)
  .map(p => p.steps[0].give.map(Number).sort((a, b) => a - b).join('+'));

test('cap 0 alone: no 2-for-1 that overpays is planned', () => {
  const { adapter, S, vals } = world();
  assert.deepEqual(gives(searchTarget(S, adapter, vals, OBJ, 21)), []);
});

test('with the premium and a board: only the depth-only 2-for-1 that raises points and title odds is planned', () => {
  const { adapter, S, vals, board } = world();
  const sink = newPremiumSink(0.12, board);
  const plans = searchTarget(S, adapter, vals, OBJ, 21, { depthPremium: 0.12, board, premiumSink: sink });
  assert.deepEqual(gives(plans).sort(), ['11+12', '12+15']);
  const st = plans.find(p => gives([p])[0] === '11+12').steps[0];
  assert.equal(Math.round(st.depth_premium.pct * 100), 10);
  assert.equal(st.depth_premium.cap, 0.12);
  assert.ok(st.depth_premium.points_delta > 0 && st.depth_premium.title_delta > 0);
  assert.equal(sink.gated_out.lineup_points, 1, '17 + 18 raises title odds but drops lineup points: gated out');
  assert.ok(sink.screened >= 2);
  assert.equal(sink.board, 'on');
});

test('+15% is past the premium, and a blue chip in the give never rides it', () => {
  const { adapter, S, vals, board } = world({ nick: [15, 11, 16, 12] });
  const found = gives(searchTarget(S, adapter, vals, OBJ, 21, { depthPremium: 0.12, board }));
  assert.ok(!found.includes('11+15'), '+15%');
  assert.ok(!found.includes('12+16'), 'blue chip 16');
  assert.ok(found.includes('11+12'));
  assert.ok(Math.abs(overpayPct(115, 100) - 0.15) < 1e-9);
});

test('no board: the premium is off and the cap stays 0', () => {
  const { adapter, S, vals } = world();
  const sink = newPremiumSink(0.12, null);
  assert.deepEqual(gives(searchTarget(S, adapter, vals, OBJ, 21, { depthPremium: 0.12, board: null, premiumSink: sink })), []);
  assert.equal(sink.board, 'none');
  assert.match(sink.reason, /no blue-chip board/);
});

/* ------------------------------------------- the whole planner */

// Fixture: Nick's P6 (RB 1500, bench) + P7 (WR 1300, bench) = 2800 for Team 3's P21 (WR 2600) is +7.7%.
// Fixture board: P1 (QB) is the blue chip; every other fixture player is scored as depth.
const FIXTURE_BOARD = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 11, 12, 13, 14, 15, 21, 22, 23, 24, 25, 31, 32, 33, 34, 35]
  .map(id => [id, id === 1 ? 90 : 60]));
const plan = ({ board = FIXTURE_BOARD, premium, flipConfirm = false, failConfirm = false, mode = 'balanced', extra = null } = {}) => {
  const a = makeAdapter();
  a.maxOverpay = 0;
  if (board) a.board = board;
  if (extra) extra(a);
  if (failConfirm) {
    // The confirm world fails to build: no fresh dice at all.
    const w0 = a.world;
    a.world = s => (s === a.seed ? w0(s) : { fail: 'confirm world failed (test)' });
  }
  if (premium != null) a.depthPremium = premium;
  if (flipConfirm) {
    // Fresh dice disagree: on any seed but the planning seed, the lineup points of every changed roster fall.
    const w0 = a.world;
    a.world = s => {
      const w = w0(s);
      if (s === a.seed) return w;
      return { ...w, rescore: (state, x, y) => {
        const r = w.rescore(state, x, y);
        return { ...r, me: { ...r.me, points_delta: state.size ? -Math.abs(r.me.points_delta) - 1 : 0 } };
      } };
    };
  }
  return { a, res: planLeague(a, { objective: normaliseObjective({ risk_mode: mode }) }) };
};
const premiumSteps = res => res.deck.flatMap(c => c.plan.steps.filter(s => s.depth_premium));

test('planner: premium steps are depth-only 2-for-1s within +12%, with points and title up on both seeds', () => {
  const { a, res } = plan();
  const v = id => a.players.get(id)?.value ?? 0;
  const sum = ids => ids.reduce((s, id) => s + v(id), 0);
  assert.equal(res.tolerances.max_overpay, 0);
  assert.equal(res.tolerances.depth_premium, 0.12);
  assert.equal(res.no_overpay.depth_premium.board, 'on');
  const steps = premiumSteps(res);
  assert.ok(steps.length > 0, 'the fixture yields at least one premium card');
  for (const st of steps) {
    assert.equal(st.give.length, 2);
    assert.equal(st.get.length, 1);
    assert.ok(!st.give.map(String).includes('1'), 'blue chip P1 is never in a premium give');
    const pct = overpayPct(sum(st.give), sum(st.get));
    assert.ok(pct > 0 && pct <= 0.12 + 1e-9, `premium ${pct}`);
    assert.ok(st.depth_premium.points_delta > 0 && st.depth_premium.title_delta > 0);
    assert.ok(st.depth_premium.confirmed, 'the fresh-dice numbers are on the step');
    assert.ok(st.depth_premium.confirmed.points_delta > 0 && st.depth_premium.confirmed.title_delta > 0);
  }
  // Every other step is still at the 0 cap.
  for (const c of res.deck) for (const st of c.plan.steps) {
    if (!st.depth_premium) assert.ok(overpayPct(sum(st.give), sum(st.get)) <= 1e-9);
  }
});

test('planner: the walk-away never climbs past the planned premium', () => {
  const { a, res } = plan({ mode: 'all_in' });
  const v = id => a.players.get(id)?.value ?? 0;
  const sum = ids => ids.reduce((s, id) => s + v(id), 0);
  for (const c of res.deck) {
    const st = c.plan.steps[0];
    if (!c.playbook?.walk_away) continue;
    const cap = st.depth_premium ? st.depth_premium.pct : 0;
    assert.ok(overpayPct(sum(c.playbook.walk_away.give), sum(st.get)) <= cap + 1e-9);
  }
});

test('planner: no board -> no premium steps, and the reason says why', () => {
  const { res } = plan({ board: null });
  assert.deepEqual(premiumSteps(res), []);
  assert.equal(res.no_overpay.depth_premium.board, 'none');
});

test('planner: premium set to 0 -> no premium steps (the plain 0 cap)', () => {
  const { res } = plan({ premium: 0 });
  assert.deepEqual(premiumSteps(res), []);
});

test('planner: a premium card whose lineup points fall on fresh dice is dropped, and counted', () => {
  const { res } = plan({ flipConfirm: true });
  assert.deepEqual(premiumSteps(res), []);
  assert.ok(res.no_overpay.depth_premium.confirm_failed > 0);
});

test('served: the premium is typed on the step and the file validates', () => {
  const { a, res } = plan();
  const entry = toEntry(res, { names: a.names(), as_of: '2026-09-24T00:00:00Z' });
  assert.deepEqual(validateLeague(entry).errors, []);
  const doc = plansFile([entry], { generated_at: '2026-09-24T00:00:00Z' });
  assert.equal(validatePlans(doc).ok, true, JSON.stringify(validatePlans(doc).errors));
  const served = (entry.alternatives.value ?? []).flatMap(m => m.steps).filter(s => s.depth_premium);
  assert.ok(served.length > 0);
  for (const s of served) {
    assert.equal(s.depth_premium.status, 'ok');
    assert.match(s.depth_premium.value.text, /^Depth-only 2-for-1 at \+\d+% market value \(cap \+12%\)/);
  }
});

test('planner: an empty board or an unscored give never rides the premium', () => {
  assert.deepEqual(premiumSteps(plan({ board: {} }).res), [], 'empty board');
  // Only the blue chip is scored: every other player is unscored, so nothing is depth.
  assert.deepEqual(premiumSteps(plan({ board: { 1: 90 } }).res), [], 'unscored gives');
});

test('planner: objectives-file untouchables are never in a premium give', () => {
  const base = premiumSteps(plan().res);
  const hit = String(base[0].give[0]);
  const { a } = plan();
  const res = planLeague(Object.assign(a, { board: FIXTURE_BOARD }),
    { objective: normaliseObjective({ risk_mode: 'balanced', untouchables: [hit] }) });
  assert.ok(premiumSteps(res).every(st => !st.give.map(String).includes(hit)));
});

test('planner: the confirm world failing serves no premium card, and counts it', () => {
  const { res } = plan({ failConfirm: true });
  assert.equal(res.confirm.status, 'failed');
  assert.deepEqual(premiumSteps(res), []);
  assert.ok(res.no_overpay.depth_premium.confirm_failed > 0);
});

test('planner: above 0%, the opening and walk-away are only the planned premium pair', () => {
  let checked = 0;
  for (const mode of ['balanced', 'all_in']) {
    const { a, res } = plan({ mode });
    const v = id => a.players.get(id)?.value ?? 0;
    const sum = ids => ids.reduce((s, id) => s + v(id), 0);
    const same = (x, y) => x.map(String).sort().join() === y.map(String).sort().join();
    for (const c of res.deck) {
      const st = c.plan.steps[0];
      for (const give of [c.playbook?.opening?.give, c.playbook?.walk_away?.give].filter(Boolean)) {
        if (overpayPct(sum(give), sum(st.get)) > 1e-9) { assert.ok(st.depth_premium && same(give, st.give), `${give} vs planned ${st.give}`); checked++; }
      }
    }
  }
  assert.ok(checked > 0, 'at least one premium opening or walk-away was priced');
});

test('planner: no backup step is an unconfirmed premium step', () => {
  const { res } = plan({ flipConfirm: true });
  for (const b of res.backups) if (b) assert.ok(!b.step.depth_premium);
});
