/**
 * LADDER-01: ladder cards (ONE-PLAN night 5). A ladder is a chained path: an early rung brings in a
 * piece and a later rung spends it, depth -> level below -> blue chip. Each card shows P(yes) per rung
 * (labelled a guess while p is the 0.30-centred band midpoint), what Nick holds if that rung lands, and
 * what happens at each "no" (a backup rung sharing the steps before it, or stop and keep what he has).
 *
 * Rules the cards enforce (hard filters, Nick 9/24, ONE-PLAN 10b): the final get is Blue chip 83+ on
 * the PLAYER-SCORE score; no rung gives Nico Collins (160), Chase Brown (80) or A.J. Brown (277, until
 * AJ-HEALTHY prices him) or anything in adapter.untouchable; no rung gets Chris Olave (290); no rung
 * gives more market value than it gets past the cap; in Fuck-it a ladder is at most 2 rungs while p is
 * the guess. Flag GRIDIRON_LADDER ('1'); off (default) the producer's entry is byte for byte today's;
 * on, the section is added and nothing else in the entry moves (shadow).
 *
 * Made-up leagues only (a tiny linear world, and test/fixtures/campaign-league.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { makeScorer, searchTarget } = await import('../server/services/campaign/search.js');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry } = await import('../server/services/campaign/view.js');
const { validateLeague } = await import('../server/services/campaign/plans-schema.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const L = await import('../server/services/campaign/ladder.js');
const { ladderFlag, ladderCards, tierOf, LADDER_ENV, FINAL_FLOOR, LEVEL_BELOW, NEVER_GIVE, NEVER_GET, ALL_IN_GUESS_MAX_RUNGS } = L;

/* ------------------------------------------------------------- the rule */

test('flag: off by default, "1" on, "0" off; no preview auto-on', () => {
  assert.equal(LADDER_ENV, 'GRIDIRON_LADDER');
  assert.equal(ladderFlag({}), 'off');
  assert.equal(ladderFlag({ GRIDIRON_LADDER: '1' }), 'on');
  assert.equal(ladderFlag({ GRIDIRON_LADDER: '0' }), 'off');
  assert.equal(ladderFlag({ GRIDIRON_PREVIEW_UNCONFIRMED: '1' }), 'off');
});

test("Nick's constants: floor 83, level below 74, pinned never-give / never-get ids, Fuck-it 2 rungs", () => {
  assert.equal(FINAL_FLOOR, 83);
  assert.equal(LEVEL_BELOW, 74);
  assert.deepEqual([...NEVER_GIVE].sort(), ['160', '277', '80']);
  assert.deepEqual([...NEVER_GET], ['290']);
  assert.equal(ALL_IN_GUESS_MAX_RUNGS, 2);
  assert.equal(tierOf(83), 'blue_chip');
  assert.equal(tierOf(82.9), 'level_below');
  assert.equal(tierOf(74), 'level_below');
  assert.equal(tierOf(73.9), 'depth');
  assert.equal(tierOf(null), 'unscored');
});

/* --------------------------------- a tiny chained world: the acquired piece is spent */

// Nick (1): A 11 (45) + B 12 (45) = 90. Team 2: chip C 21 (100). Team 3: target T 31 (110).
// Direct: A + B = 90 < 0.88 x 110 = 96.8, not fair on team 3's screen. Chained: A + B for C
// (-10% on his screen, Nick gives less), then C for T (100 vs 110: -9%, fair, no overpay).
const VALUES = { 11: 45, 12: 45, 21: 100, 22: 5, 31: 110, 32: 5 };
function chainWorld() {
  const rosters = new Map([[1, [11, 12]], [2, [21, 22]], [3, [31, 32]]]);
  const players = new Map(Object.entries(VALUES).map(([id, value]) => [Number(id), { name: `p${id}`, position: 'WR', value }]));
  const adapter = {
    league: { me: 1 }, players, rosters, managers: new Map([[2, {}], [3, {}]]), untouchable: new Set(),
    searchOpts: { twoForOne: true, fillers: 0 },
    priceStep: () => ({ p: 0.3, band: { low: 0.22, high: 0.38 }, basis: 'heuristic_unanchored' }),
  };
  const d = (team, ids) => {
    const base = new Set(rosters.get(team));
    let s = 0;
    for (const id of ids) if (!base.has(id)) s += (id === 31 ? 5 : 1) * VALUES[id] * 1e-4;
    for (const id of base) if (!ids.includes(id)) s -= VALUES[id] * 1e-5;
    return s;
  };
  const block = (state, t) => (t == null ? null
    : { title_delta: d(t, state.get(t) ?? rosters.get(t)), title_delta_se: 0.0001, title_delta_clears_noise: true, title_before: 0.1 });
  const S = makeScorer({ rescore: (state, a, b) => ({ me: block(state, a), them: block(state, b) }) }, adapter);
  const vals = { tradable: id => (players.get(id)?.value ?? 0) > 0, addN: new Map(), lossN: new Map(),
    lossO: new Map([[31, { team: 3 }], [32, { team: 3 }], [21, { team: 2 }], [22, { team: 2 }]]) };
  return { adapter, S, vals };
}
const SCORES = { 11: 40, 12: 38, 21: 76, 22: 10, 31: 88, 32: 10 };
const scoreOf = id => (SCORES[id] == null ? null : { score: SCORES[id] });
const OBJ = { kind: 'title', goal: 'title' };

test('the chained finish spends the piece the first rung brought in', () => {
  const { adapter, S, vals } = chainWorld();
  const plans = searchTarget(S, adapter, vals, OBJ, 31);
  const chain = plans.find(p => p.steps.length === 2 && p.chained);
  assert.ok(chain, 'a 2-rung chained path to the target exists');
  assert.deepEqual(chain.steps[0].get.map(Number), [21]);
  assert.deepEqual(chain.steps[1].give.map(Number), [21], 'rung 2 gives the chip rung 1 got');
  assert.ok(!plans.some(p => p.steps.length === 1), 'no direct path reaches the target');
});

test('a ladder card: depth -> level below -> blue chip, p per rung as a guess, "no" at every rung', () => {
  const { adapter, S, vals } = chainWorld();
  const plans = searchTarget(S, adapter, vals, OBJ, 31);
  const out = ladderCards(plans, { mode: 'balanced', scoreOf, players: adapter.players });
  assert.equal(out.cards.length, 1);
  const c = out.cards[0];
  assert.equal(String(c.target), '31');
  assert.deepEqual(c.climb, ['depth', 'level_below', 'blue_chip']);
  assert.equal(c.rank_basis, 'p_guess');
  assert.equal(c.rungs.length, 2);
  for (const r of c.rungs) {
    assert.equal(r.p_guess, true);
    assert.ok(r.p > 0 && r.p < 1);
    assert.ok(Number.isFinite(r.if_yes));
    assert.ok(r.on_no && ['backup', 'stop'].includes(r.on_no.kind));
  }
  // Rung 1 has no other opening in this world: a "no" stops, Nick keeps today's team (+0).
  assert.equal(c.rungs[0].on_no.kind, 'stop');
  assert.equal(c.rungs[0].on_no.keep, 0);
  // Rung 2's "no" leaves Nick holding the chip: what rung 1 landed.
  assert.equal(c.rungs[1].on_no.kind, 'stop');
  assert.equal(c.rungs[1].on_no.keep, c.rungs[0].if_yes);
  assert.ok(Math.abs(c.p_complete - 0.09) < 1e-9, 'two 0.30 guesses multiply to 0.09');
});

/* ---------------------------------------------- hand-built plans for each filter */

const step = (team, give, get, p = 0.3, delta = 0.01) => ({ team, give, get, p, delta, se: 0.002 });
const plan = (target, steps) => ({ target, owner: steps[steps.length - 1].team, steps, chained: true });
const players = new Map(Object.entries({ 1: 100, 2: 100, 3: 100, 5: 100, 80: 100, 160: 100, 277: 100, 290: 100, 7: 100, 8: 100, 9: 90, 10: 200 })
  .map(([id, value]) => [id, { value }]));
const sc = { 1: 20, 2: 20, 3: 20, 5: 76, 7: 90, 8: 82, 9: 76, 10: 95, 80: 90, 160: 90, 277: 85, 290: 84 };
const scoreOf2 = id => (sc[id] == null ? null : { score: sc[id] });
const cardsFor = (plans, opts = {}) => ladderCards(plans, { mode: 'balanced', scoreOf: scoreOf2, players, ...opts });

test('final get under Blue chip 83 is dropped; unscored fails closed', () => {
  const below = plan('8', [step('2', ['1'], ['5']), step('3', ['5'], ['8'])]);
  const unscored = plan('99', [step('2', ['1'], ['5']), step('3', ['5'], ['99'])]);
  const good = plan('7', [step('2', ['1'], ['5']), step('3', ['5'], ['7'])]);
  const out = cardsFor([below, unscored, good]);
  assert.deepEqual(out.cards.map(c => String(c.target)), ['7']);
  assert.equal(out.dropped_by_reason.final_below_floor, 1);
  assert.equal(out.dropped_by_reason.final_unscored, 1);
  assert.equal(out.considered, 3);
});

test('no rung gives 160, 80, 277 or an adapter untouchable; no rung gets Olave (290)', () => {
  const mk = give => plan('7', [step('2', [give], ['5']), step('3', ['5'], ['7'])]);
  const out = cardsFor([mk('160'), mk('80'), mk('277'), mk('3'),
    plan('7', [step('2', ['1'], ['290']), step('3', ['290'], ['7'])])], { untouchable: new Set(['3']) });
  assert.equal(out.cards.length, 0);
  assert.equal(out.dropped_by_reason.gives_untouchable, 4);
  assert.equal(out.dropped_by_reason.never_get, 1);
});

test('a rung that gives more market value than it gets (past the cap) is dropped', () => {
  // 10 (200) for 7 (100): +100% overpay.
  const over = plan('7', [step('2', ['1'], ['5']), step('3', ['10'], ['7'])]);
  const out = cardsFor([over]);
  assert.equal(out.cards.length, 0);
  assert.equal(out.dropped_by_reason.overpay, 1);
  assert.equal(cardsFor([over], { maxOverpay: Infinity }).cards.length, 1, 'uncapped it would pass');
});

test('only chained multi-rung paths are ladders', () => {
  const direct = { target: '7', owner: '3', steps: [step('3', ['1'], ['7'])], chained: false };
  const unchained = { target: '7', owner: '3', steps: [step('2', ['1'], ['5']), step('3', ['2'], ['7'])], chained: false };
  const out = cardsFor([direct, unchained]);
  assert.equal(out.cards.length, 0);
  assert.equal(out.dropped_by_reason.not_a_ladder, 2);
});

test('Fuck-it: a 3-rung ladder is dropped while p is the guess; 2 rungs pass; Balanced keeps 3', () => {
  const three = plan('7', [step('2', ['1'], ['5']), step('4', ['5'], ['9']), step('3', ['9'], ['7'])]);
  const two = plan('7', [step('2', ['2'], ['5']), step('3', ['5'], ['7'])]);
  const allIn = cardsFor([three, two], { mode: 'all_in' });
  assert.equal(allIn.cards.length, 1);
  assert.equal(allIn.cards[0].rungs.length, 2);
  assert.equal(allIn.dropped_by_reason.all_in_rungs_p_guess, 1);
  assert.equal(cardsFor([three, two]).cards.length, 2);
  // A rung whose p is fitted (E1 passed) lifts the cap.
  const fitted = plan('7', three.steps.map(s => ({ ...s, p_basis: 'fitted' })));
  assert.equal(cardsFor([fitted], { mode: 'all_in' }).cards.length, 1);
});

test('backup at a "no": the best other rung sharing the steps before it', () => {
  const a = plan('7', [step('2', ['1'], ['5'], 0.3, 0.01), step('3', ['5'], ['7'], 0.3, 0.05)]);
  const b = plan('7', [step('2', ['1'], ['5'], 0.3, 0.01), step('4', ['5'], ['7'], 0.3, 0.04)]);
  const out = cardsFor([a, b]);
  const c = out.cards.find(x => x.rungs[1].partner === '3');
  assert.equal(c.rungs[1].on_no.kind, 'backup');
  assert.equal(c.rungs[1].on_no.partner, '4');
  assert.deepEqual(c.rungs[1].on_no.give, ['5']);
});

/* --------------------------------------------- the whole planner: shadow only */

const SCORE_FIX = { 11: 90, 21: 85, 31: 84, 12: 60, 22: 60, 32: 60, 2: 78, 3: 76, 13: 75, 23: 74, 33: 74 };
const run = (env, mode = 'balanced') => {
  const a = makeAdapter();
  a.scoreOf = id => (SCORE_FIX[id] == null ? { score: 30 } : { score: SCORE_FIX[id] });
  const res = planLeague(a, { objective: normaliseObjective({ risk_mode: mode }), env });
  return { a, res, entry: toEntry(res, { names: a.names(), as_of: '2026-09-25T00:00:00Z' }) };
};

test('flag off: no ladders key anywhere (the producer entry is today\'s)', () => {
  const { res, entry } = run({});
  assert.equal('ladders' in res, false);
  assert.equal('ladders' in entry, false);
});

test('flag on: the entry validates, carries the ladders section, and nothing else moves', () => {
  for (const mode of ['safe', 'balanced', 'all_in']) {
    const off = run({}, mode), on = run({ GRIDIRON_LADDER: '1' }, mode);
    const { ladders, ...rest } = on.entry;
    assert.ok(ladders, `${mode}: section present`);
    assert.deepEqual(rest, off.entry, `${mode}: every other section is byte for byte the flag-off entry`);
    const errs = validateLeague(on.entry);
    assert.deepEqual(errs, [], `${mode}: ${JSON.stringify(errs.slice(0, 3))}`);
    assert.equal(ladders.status, 'ok');
    assert.equal(ladders.guess, true);
    for (const c of ladders.value.cards) {
      assert.ok(SCORE_FIX[c.target] >= 83, 'final get is a Blue chip');
      if (mode === 'all_in') assert.ok(c.rungs.length <= 2);
      for (const r of c.rungs) {
        assert.equal(r.p.guess, true);
        for (const id of r.give) assert.ok(!NEVER_GIVE.includes(id));
      }
    }
  }
});
