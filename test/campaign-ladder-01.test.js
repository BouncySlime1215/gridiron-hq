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
 * the guess. Flag GRIDIRON_LADDER ('1', default off). Every section is always written (the contract's rule), so
 * on, the section fills and nothing else in the entry moves (shadow); off it is 'unknown' with the reason.
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
const { ladderFlag, ladderCards, tierOf, LADDER_ENV, LEVEL_BELOW, ALL_IN_GUESS_MAX_RUNGS } = L;
// Batch B: the ladder keeps no copy of Nick's lists or floor; it reads main's.
const { PINNED_NEVER_GIVE: NEVER_GIVE, PINNED_NEVER_GET: NEVER_GET } = await import('../server/services/campaign/never-give.js');
const GF = await import('../server/services/campaign/gets-floor.js');
const { tradeMemory } = await import('../server/services/campaign/trade-memory.js');
const { readFileSync } = await import('node:fs');
const { pathExpectation } = await import('../server/services/campaign/paths.js');

/* ------------------------------------------------------------- the rule */

test('flag: off by default, "1" on, "0" off; no preview auto-on', () => {
  assert.equal(LADDER_ENV, 'GRIDIRON_LADDER');
  assert.equal(ladderFlag({}), 'off');
  assert.equal(ladderFlag({ GRIDIRON_LADDER: '1' }), 'on');
  assert.equal(ladderFlag({ GRIDIRON_LADDER: '0' }), 'off');
  assert.equal(ladderFlag({ GRIDIRON_PREVIEW_UNCONFIRMED: '1' }), 'off');
});

test("Nick's constants: main's floor 83, level below 74, main's pinned never-give / never-get ids, Fuck-it 2 rungs", () => {
  assert.equal(GF.DEFAULT_GET_FLOOR, 83);
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
const players = new Map(Object.entries({ 1: 100, 2: 100, 3: 100, 5: 100, 80: 100, 160: 100, 277: 100, 290: 100, 7: 100, 8: 100, 9: 100, 10: 200, 99: 100 })
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
  // Rung 1 brings in 10 (200) for 1 (100); rung 2 spends 10 (200) on 7 (100): +100% overpay.
  const over = plan('7', [step('2', ['1'], ['10']), step('3', ['10'], ['7'])]);
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

test('flag off: the planner builds no cards; the section is unknown and says the flag is off', () => {
  const { res, entry } = run({});
  assert.equal('ladders' in res, false);
  assert.deepEqual(entry.ladders, { status: 'unknown', source: 'plan.path', reason: 'Ladder cards are off (GRIDIRON_LADDER).' });
});

test('flag on: the entry validates, carries the ladders section, and nothing else moves', () => {
  for (const mode of ['safe', 'balanced', 'all_in']) {
    const off = run({}, mode), on = run({ GRIDIRON_LADDER: '1' }, mode);
    const { ladders, ...rest } = on.entry;
    const { ladders: _off, ...offRest } = off.entry;
    assert.ok(ladders, `${mode}: section present`);
    assert.deepEqual(rest, offRest, `${mode}: every other section is byte for byte the flag-off entry`);
    const errs = validateLeague(on.entry).errors;
    assert.deepEqual(errs, [], `${mode}: ${JSON.stringify(errs.slice(0, 3))}`);
    assert.equal(ladders.status, 'ok');
    assert.equal(ladders.guess, true);
    if (mode !== 'safe') assert.ok(ladders.value.cards.length > 0, `${mode}: the fixture builds at least one ladder card`);
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

test('the schema\'s rung tiers are the module\'s', async () => {
  const { LADDER_TIERS, OPTIONAL_SECTIONS } = await import('../server/services/campaign/plans-schema.js');
  assert.deepEqual([...LADDER_TIERS], [...L.TIERS]);
  assert.ok(OPTIONAL_SECTIONS.includes('ladders'), 'a file written before LADDER-01 still validates');
});

/* --------------------------------- review fixes (coordinator batch-B on #394) */

test('review 1: everything Nick holds at the end must be 83+, not only the target (1-for-2 rung)', () => {
  // Rung 1 takes 5 AND 6 for 1; rung 2 spends 5 on the Blue-chip 7. 6 (score 60) is still held.
  const sc3 = { ...sc, 6: 60 };
  const players3 = new Map([...players, ['6', { value: 0 }]]);
  const held = plan('7', [step('2', ['1'], ['5', '6']), step('3', ['5'], ['7'])]);
  const out = ladderCards([held], { mode: 'balanced', scoreOf: id => (sc3[id] == null ? null : { score: sc3[id] }), players: players3 });
  assert.equal(out.cards.length, 0);
  assert.equal(out.dropped_by_reason.held_below_floor, 1);
  // An unscored held piece fails closed.
  const out2 = ladderCards([plan('7', [step('2', ['1'], ['5', '98']), step('3', ['5'], ['7'])])],
    { mode: 'balanced', scoreOf: scoreOf2, players: new Map([...players, ['98', { value: 0 }]]) });
  assert.equal(out2.dropped_by_reason.held_unscored, 1);
  // Spent on later: a piece given on is not held.
  assert.equal(cardsFor([plan('7', [step('2', ['1'], ['5']), step('3', ['5'], ['7'])])]).cards.length, 1);
});

test('review 2 / Batch B: a backup comes only from main\'s confirm-dice gate (confirmedActive); no confirm dice, no backup', () => {
  const a = plan('7', [step('2', ['1'], ['5'], 0.3, 0.01), step('3', ['5'], ['7'], 0.3, 0.05)]);
  const b = plan('7', [step('2', ['1'], ['5'], 0.3, 0.01), step('4', ['5'], ['7'], 0.3, 0.04)]);
  const card = out => out.cards.find(x => x.rungs[1].partner === '3');
  // No confirm dice: never a planning-dice backup (main: no confirm dice, no served move). The rung says stop.
  const plain = card(cardsFor([a, b]));
  assert.equal(plain.rungs[1].on_no.kind, 'stop');
  // confirmedActive says b does not beat doing nothing: no backup, stop.
  const failed = card(cardsFor([a, b], { confirmed: () => null }));
  assert.equal(failed.rungs[1].on_no.kind, 'stop');
  // confirmedActive returns b re-priced on the confirm dice: the card shows that plan's confirm-dice expected.
  const reB = plan('7', [step('2', ['1'], ['5'], 0.3, 0.01), step('4', ['5'], ['7'], 0.3, 0.02)]);
  const held = card(cardsFor([a, b], { confirmed: q => (q === b ? reB : null) }));
  assert.equal(held.rungs[1].on_no.kind, 'backup');
  assert.equal(held.rungs[1].on_no.dice, 'confirm');
  assert.equal(held.rungs[1].on_no.expected, pathExpectation(reB.steps).expected, 'the re-priced plan\'s number, not the planning one');
  assert.notEqual(held.rungs[1].on_no.expected, pathExpectation(b.steps).expected);
});

// Main's trade memory on a made-up ledger: Nick (team '0') sold 171 to team '9' and got 172 back.
const memFor = () => tradeMemory({ now: 1e12, valueAt: () => 100, trades: [{ tx_id: 't1', at: 1e12 - 1,
  moves: [{ player: '171', from: '0', to: '9' }, { player: '172', from: '9', to: '0' }] }] },
{ me: '0', valueNow: () => 100, positionOf: () => 'WR' });

test('review 3 / Batch B: main\'s trade memory: no player Nick sold comes back from ANY team, on any rung (290 still pinned)', () => {
  // Bought back from team '2', not the team he sold to ('9'): still a buy-back.
  const buyback = plan('7', [step('2', ['1'], ['171']), step('3', ['171'], ['7'])]);
  const ps = new Map([...players, ['171', { value: 100 }], ['172', { value: 100 }]]);
  const out = ladderCards([buyback], { mode: 'balanced', scoreOf: scoreOf2, players: ps, memory: memFor() });
  assert.equal(out.cards.length, 0);
  assert.equal(out.dropped_by_reason.sold, 1);
  // The last rung counts too.
  const late = plan('171', [step('2', ['1'], ['5']), step('3', ['5'], ['171'])]);
  assert.equal(ladderCards([late], { mode: 'balanced', scoreOf: id => ({ score: 90 }), players: ps, memory: memFor() }).dropped_by_reason.sold, 1);
  // Control: with no ledger the same path is a card (the rule, not a typo, drops it).
  assert.equal(ladderCards([buyback], { mode: 'balanced', scoreOf: id => ({ score: 90 }), players: ps }).cards.length, 1);
  // 290 stays pinned with no sold set at all.
  assert.equal(cardsFor([plan('7', [step('2', ['1'], ['290']), step('3', ['290'], ['7'])])]).dropped_by_reason.never_get, 1);
});

test('review 4: the destination\'s untouchables are applied beside adapter.untouchable', () => {
  const p = plan('7', [step('2', ['2'], ['5']), step('3', ['5'], ['7'])]);
  const out = cardsFor([p], { objectiveUntouchables: ['2'] });
  assert.equal(out.cards.length, 0);
  assert.equal(out.dropped_by_reason.gives_untouchable, 1);
});

test('review 4 + 5: planner passes objective untouchables; the section says planning dice', () => {
  const off = run({ GRIDIRON_LADDER: '1' });
  const given = new Set(off.res.ladders.cards.flatMap(c => c.rungs.flatMap(r => r.give)));
  assert.ok(given.size > 0, 'control: the fixture ladders give something');
  const ban = [...given][0];
  const a = makeAdapter();
  a.scoreOf = id => ({ score: SCORE_FIX[id] ?? 30 });
  const res = planLeague(a, { objective: normaliseObjective({ risk_mode: 'balanced', untouchables: [ban] }), env: { GRIDIRON_LADDER: '1' } });
  for (const c of res.ladders.cards) for (const r of c.rungs) assert.ok(!r.give.includes(ban));
  assert.equal(off.entry.ladders.value.dice, 'planning');
  assert.match(off.entry.ladders.value.basis, /planning dice/);
});

/* --------------------------------- Batch B (main decf7ebf): main's rules, one copy */

test('Batch B: the ladder keeps no second copy of Nick\'s lists, floor or held-set', () => {
  const src = readFileSync(new URL('../server/services/campaign/ladder.js', import.meta.url), 'utf8');
  for (const lit of ["'160'", "'80'", "'277'", "'290'"]) assert.ok(!src.includes(lit), `no pinned id literal ${lit}`);
  assert.equal(L.NEVER_GIVE, undefined);
  assert.equal(L.NEVER_GET, undefined);
  assert.equal(L.FINAL_FLOOR, undefined);
  assert.equal(L.heldAtEnd, undefined, 'held-at-end lives in gets-floor.js, shared with the planner');
  assert.deepEqual([...GF.heldAtEnd([step('2', ['1'], ['5', '6']), step('3', ['5'], ['7'])])].sort(), ['6', '7']);
});

test('Batch B: main\'s floor on everything held: a destination min_get_score raises it, a lower one never loosens it', () => {
  // 7 scores 90, 8 scores 82 (under 83). With floor 91 the 90 target fails too.
  const p7 = plan('7', [step('2', ['1'], ['5']), step('3', ['5'], ['7'])]);
  assert.equal(cardsFor([p7], { floor: 91 }).dropped_by_reason.final_below_floor, 1);
  assert.equal(cardsFor([p7], { floor: 91 }).floor, 91);
  const p8 = plan('8', [step('2', ['1'], ['5']), step('3', ['5'], ['8'])]);
  assert.equal(cardsFor([p8], { floor: 50 }).dropped_by_reason.final_below_floor, 1, '83 is the least');
  assert.equal(cardsFor([p8], { floor: 50 }).floor, 83);
  // Held: rung 1 is a 1-for-2 whose second player (9, score 76) is never given on.
  const held = plan('7', [step('2', ['1'], ['5', '9']), step('3', ['5'], ['7'])]);
  assert.equal(cardsFor([held]).dropped_by_reason.held_below_floor, 1);
});

test('Batch B through the planner: GETS-FLOOR=0 does not open the ladder floor; no confirm dice, no backup', () => {
  // Floor switched off by hand in the planner: ladder cards still hold everything they keep to 83+.
  const a = makeAdapter();
  a.scoreOf = id => ({ score: SCORE_FIX[id] ?? 30 });
  const res = planLeague(a, { objective: normaliseObjective({ risk_mode: 'balanced' }), env: { GRIDIRON_LADDER: '1', GRIDIRON_GETS_FLOOR: '0' } });
  for (const c of res.ladders.cards) {
    assert.ok((SCORE_FIX[c.target] ?? 30) >= 83);
    const held = GF.heldAtEnd(c.rungs.map(r => ({ give: r.give, get: r.get })));
    for (const id of held) assert.ok((SCORE_FIX[id] ?? 30) >= 83, `held ${id} is 83+`);
  }
  // No confirm world: every "no" is a stop.
  const b = makeAdapter();
  b.scoreOf = id => ({ score: SCORE_FIX[id] ?? 30 });
  const world = b.world.bind(b);
  b.world = seed => (seed === b.seed ? world(seed) : { fail: 'no confirm dice (test)' });
  const r2 = planLeague(b, { objective: normaliseObjective({ risk_mode: 'balanced' }), env: { GRIDIRON_LADDER: '1' } });
  for (const c of r2.ladders.cards) for (const r of c.rungs) assert.equal(r.on_no.kind, 'stop');
});
