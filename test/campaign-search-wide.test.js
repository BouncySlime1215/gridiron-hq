/**
 * SEARCH-WIDE (ONE-PLAN s5 night 6): a node budget, a wider depth-3 beam, laterals only toward the
 * Blue chip floor, and free-agent claims as steps, all inside the one planner, behind
 * GRIDIRON_SEARCH_WIDE (default off). Pre-registration: docs/tdd/2026-09-25-search-wide.tdd.md (W1-W8).
 * Made-up four-team league (test/fixtures/campaign-league.mjs); no DB, no simulation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { makeAdapter, makePlayers } = await import('./fixtures/campaign-league.mjs');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { validatePlans } = await import('../server/services/campaign/plans-schema.js');
const { dealKey } = await import('../server/services/campaign/paths.js');
const { makeScorer, playerValues, searchTarget, overpayPct } = await import('../server/services/campaign/search.js');
const wide = await import('../server/services/campaign/search-wide.js');
const { buildPlansFile } = await import('../scripts/campaign/produce-plans.mjs');

const { SEARCH_WIDE_ENV, searchWideFlag, wideBudget, WIDE_DEFAULTS, FREE_AGENT, isLateral, lateralOk, makeDropOk, newWideSink } = wide;
const ON = { [SEARCH_WIDE_ENV]: '1' };
const OFF = {};
const AS_OF = '2026-09-25T00:00:00.000Z';
/** A made-up season of processed waiver claims: 22 won, 7 lost to another team -> p = 23/31. */
const WAIVERS = { won: 22, lost: 7 };
const CLAIM_P = +(23 / 31).toFixed(4);

/** Depth pieces (scored below 83) on every roster; everyone else is a Blue chip (90). */
const DEPTH = new Set(['4', '7', '14', '15', '24', '25', '34', '35', '42']);
const scoreFrom = (depth = DEPTH, extra = {}) => id => {
  const k = String(id);
  if (k in extra) return extra[k] == null ? null : { score: extra[k], label: 'fixture' };
  return { score: depth.has(k) ? 70 : 90, label: 'fixture' };
};
/** The fixture league with two free agents Nick could claim (41 WR ros 9.5, 42 TE ros 4) in its players map. */
const withFreeAgents = (extraPlayers = []) => {
  const players = makePlayers();
  players.set(41, { id: 41, name: 'P41', position: 'WR', value: 500, power: 9.5, ros_ppg: 9.5, injury: 0, bye: null, trend_kind: null });
  players.set(42, { id: 42, name: 'P42', position: 'TE', value: 300, power: 4, ros_ppg: 4, injury: 0, bye: null, trend_kind: null });
  for (const p of extraPlayers) players.set(p.id, p);
  return players;
};
const claimAdapter = ({ pool = ['41', '42'], extraPlayers = [], scoreOf = scoreFrom(), extraFa = [] } = {}) => {
  const a = makeAdapter({ players: withFreeAgents(extraPlayers) });
  a.freeAgents = [...a.freeAgents, ...extraFa];
  a.claimUniverse = new Set(pool);
  a.scoreOf = scoreOf;
  a.waiverRecord = WAIVERS;
  return a;
};

const OBJ = normaliseObjective({ risk_mode: 'balanced' });
const keyOf = p => p.steps.map(dealKey).join('>');
const tierOkOf = scoreOf => id => (scoreOf(id)?.score ?? -Infinity) >= 83;

/** One target's search on the planning world, off or with the wide options. */
const searchOne = (a, target, wideOpts = null) => {
  const S = makeScorer(a.world(a.seed), a);
  const vals = playerValues(S, a, OBJ);
  const plans = searchTarget(S, a, vals, OBJ, target, { maxOverpay: Infinity, ...(wideOpts ? { wide: wideOpts } : {}) });
  return { plans, S };
};
const wideOpts = (a, over = {}) => {
  const sink = newWideSink(WIDE_DEFAULTS);
  return { candidates: 100000, rescoresLeft: () => Infinity, beam: WIDE_DEFAULTS.beam, tierOk: tierOkOf(a.scoreOf),
    dropOk: () => false, claimPool: [], claimP: CLAIM_P, sink, ...over };
};

/* ------------------------------------------------------------------ flag */

test('flag: only GRIDIRON_SEARCH_WIDE=1 turns it on; budgets read from env with safe defaults', () => {
  assert.equal(searchWideFlag({}), 'off');
  assert.equal(searchWideFlag({ [SEARCH_WIDE_ENV]: '0' }), 'off');
  assert.equal(searchWideFlag({ [SEARCH_WIDE_ENV]: 'true' }), 'off');
  assert.equal(searchWideFlag({ [SEARCH_WIDE_ENV]: '1' }), 'on');
  assert.deepEqual(wideBudget({}), { ...WIDE_DEFAULTS });
  assert.equal(wideBudget({ GRIDIRON_SEARCH_WIDE_CANDIDATES: '50', GRIDIRON_SEARCH_WIDE_RESCORES: '7' }).candidates, 50);
  assert.equal(wideBudget({ GRIDIRON_SEARCH_WIDE_RESCORES: '7' }).rescores, 7);
  assert.equal(wideBudget({ GRIDIRON_SEARCH_WIDE_CANDIDATES: '-3' }).candidates, WIDE_DEFAULTS.candidates);
  assert.equal(wideBudget({ GRIDIRON_SEARCH_WIDE_CANDIDATES: 'lots' }).candidates, WIDE_DEFAULTS.candidates);
  assert.equal(wideBudget({ GRIDIRON_SEARCH_WIDE_BEAM: '8' }).beam, 8);
  assert.ok(WIDE_DEFAULTS.candidates >= 2000, 'the plan asks for >= 2,000 candidates scored');
});

/* ----------------------------------------------------------- W1: budget */

test('W1: the candidate budget binds on extras; the incumbent shortlist is never cut', () => {
  const a = claimAdapter();
  const off = searchOne(a, 11).plans;
  const o = wideOpts(a, { candidates: 3 });
  const on = searchOne(claimAdapter(), 11, o).plans;
  assert.ok(o.sink.used.extras <= 3, `extras scored ${o.sink.used.extras}`);
  assert.equal(o.sink.budget_hit, 'candidates');
  const onKeys = new Set(on.map(keyOf));
  for (const p of off) assert.ok(onKeys.has(keyOf(p)), `incumbent path ${keyOf(p)} kept under a tiny budget`);
});

test('W1: a spent rescore budget stops extras and says so', () => {
  const a = claimAdapter();
  const o = wideOpts(a, { rescoresLeft: () => 0 });
  searchOne(a, 11, o);
  assert.equal(o.sink.used.extras, 0);
  assert.equal(o.sink.budget_hit, 'rescores');
});

test('W1: planner splits the league budget across targets and reports it', () => {
  const res = planLeague(claimAdapter(), { objective: OBJ, env: { ...ON, GRIDIRON_SEARCH_WIDE_CANDIDATES: '6' } });
  const sw = res.search_wide;
  assert.equal(sw.flag, 'on');
  assert.equal(sw.budget.candidates, 6);
  assert.ok(sw.used.extras <= 6, `league extras ${sw.used.extras}`);
  assert.equal(sw.budget_hit, 'candidates');
  assert.ok(Number.isInteger(sw.used.rescores) && sw.used.rescores >= 0);
});

/* ------------------------------------------------ W2 + W3: wider, never worse */

test('W2: on the same seed the wide search keeps every incumbent path and scores more', () => {
  for (const target of [11, 21, 31]) {
    const a = claimAdapter({ scoreOf: () => ({ score: 90, label: 'all blue' }) });
    const off = searchOne(a, target).plans;
    const on = searchOne(a, target, wideOpts(a)).plans;
    const onKeys = new Set(on.map(keyOf));
    for (const p of off) assert.ok(onKeys.has(keyOf(p)), `target ${target}: ${keyOf(p)} missing on`);
    assert.ok(on.length > off.length, `target ${target}: on ${on.length} vs off ${off.length}`);
  }
  const offRes = planLeague(makeAdapter(), { objective: OBJ, env: OFF });
  const onRes = planLeague(makeAdapter(), { objective: OBJ, env: ON });
  assert.ok(onRes.candidates_scored > offRes.candidates_scored);
});

test('W3: depth 3 widened: a second chip may give 2', () => {
  const a = claimAdapter({ scoreOf: () => ({ score: 90, label: 'all blue' }) });
  const twoInSecond = p => p.steps.length === 3 && !p.steps[1].claim && p.steps[1].give.length === 2;
  const offAll = [11, 21, 31].flatMap(t => searchOne(a, t).plans);
  const onAll = [11, 21, 31].flatMap(t => searchOne(a, t, wideOpts(a)).plans);
  assert.equal(offAll.filter(twoInSecond).length, 0, 'off: the second chip gives 1');
  assert.ok(onAll.some(twoInSecond), 'on: a 3-step path whose second chip gives 2');
});

/* ------------------------------------------------------------ W4: laterals */

test('W4: isLateral / lateralOk on hand-built steps', () => {
  const ok = tierOkOf(scoreFrom());
  assert.equal(isLateral({ team: '2', give: [4], get: [14] }, ok), true);
  assert.equal(isLateral({ team: '2', give: [4], get: [11] }, ok), false);
  assert.equal(isLateral({ team: '2', give: [1], get: [14] }, ok), false);
  assert.equal(isLateral({ team: FREE_AGENT, claim: true, give: [7], get: [42] }, ok), false, 'a claim is not a lateral trade');
  const lat = { team: '2', give: [4], get: [14] };
  assert.equal(lateralOk([lat, { team: '3', give: [14], get: [21] }], ok), true, 'ends holding a Blue chip');
  assert.equal(lateralOk([lat, { team: '3', give: [7], get: [21] }], ok), false, 'still holds the depth piece at the end');
  assert.equal(lateralOk([{ team: '2', give: [1], get: [11] }], ok), true, 'no lateral, nothing to check');
  assert.equal(lateralOk([lat, { team: '3', give: [14], get: [21] }], () => false), false, 'unscored fails closed');
});

test('W4: a lateral path survives only when everything held at the end passes 83', () => {
  const a = claimAdapter();
  const o = wideOpts(a);
  const on = [11, 21, 31].flatMap(t => searchOne(a, t, o).plans);
  assert.ok(o.sink.laterals.seen > 0, 'the fixture has lateral paths to judge');
  const ok = tierOkOf(a.scoreOf);
  const withLat = on.filter(p => p.steps.some(st => isLateral(st, ok)));
  for (const p of withLat) assert.ok(lateralOk(p.steps, ok), `${keyOf(p)} ends below the floor`);
  // The target itself scored below the floor: every lateral path toward it goes, and is counted.
  const low = claimAdapter({ scoreOf: scoreFrom(DEPTH, { 21: 70 }) });
  const o2 = wideOpts(low);
  const onLow = searchOne(low, 21, o2).plans;
  const ok2 = tierOkOf(low.scoreOf);
  assert.equal(onLow.filter(p => p.steps.some(st => isLateral(st, ok2))).length, 0);
  assert.ok(o2.sink.laterals.dropped > 0, 'lateral drops counted');
});

/* -------------------------------------------------------------- W5: claims */

test('W5: makeDropOk: only scored depth, never untouchable or pinned', () => {
  const scoreOf = scoreFrom(new Set(['7', '160', '80', '277', '9']), { 8: null });
  const dropOk = makeDropOk({ scoreOf, floor: 83, untouchable: new Set(['9']) });
  assert.equal(dropOk(7), true);
  for (const id of [160, 80, 277]) assert.equal(dropOk(id), false, `${id} is pinned never-give`);
  assert.equal(dropOk(9), false, 'untouchable');
  assert.equal(dropOk(1), false, 'a Blue chip is never dropped');
  assert.equal(dropOk(8), false, 'unscored fails closed');
  assert.equal(makeDropOk({ scoreOf: null, floor: 83 })(7), false, 'no score source fails closed');
});

const claimsOf = plans => plans.filter(p => p.steps.some(st => st.claim));

test('W5: a claim ends a 1- or 2-trade path, drops same-position depth with lower ros_ppg', () => {
  const a = claimAdapter();
  const pool = a.freeAgents.filter(f => a.claimUniverse.has(String(f.id)));
  const o = wideOpts(a, { claimPool: pool, dropOk: makeDropOk({ scoreOf: a.scoreOf, floor: 83, untouchable: new Set() }) });
  const plans = [11, 21, 31].flatMap(t => searchOne(a, t, o).plans);
  const cl = claimsOf(plans);
  assert.ok(cl.length > 0, 'claim paths found');
  for (const p of cl) {
    const i = p.steps.findIndex(st => st.claim);
    assert.equal(i, p.steps.length - 1, 'the claim is the last step');
    assert.ok(i >= 1 && p.steps.length <= 3, 'after 1 or 2 trades');
    const st = p.steps[i];
    assert.equal(st.team, FREE_AGENT);
    assert.equal(st.p, CLAIM_P, 'the league\'s waiver-win rate, never 1');
    assert.equal(st.give.length, 1); assert.equal(st.get.length, 1);
    const drop = a.players.get(st.give[0]), add = a.players.get(st.get[0]);
    assert.equal(drop.position, add.position);
    assert.ok(add.ros_ppg > drop.ros_ppg);
    assert.ok(DEPTH.has(String(st.give[0])));
    const acquired = new Set(p.steps.slice(0, i).flatMap(s => s.get.map(String)));
    assert.ok(!acquired.has(String(st.give[0])), 'never drops a player acquired on the path');
    assert.notEqual(String(st.get[0]), '42', 'TE 42 (ros 4) beats no droppable TE');
  }
  assert.ok(o.sink.claims.built > 0);
});

test('W5: no claim without a pool, a droppable piece, or a better free agent; never a pinned never-get', () => {
  const a = claimAdapter();
  const noPool = wideOpts(a, { claimPool: [], dropOk: () => true });
  assert.equal(claimsOf([11, 21].flatMap(t => searchOne(a, t, noPool).plans)).length, 0);
  const pool = a.freeAgents.filter(f => a.claimUniverse.has(String(f.id)));
  const noDrop = wideOpts(a, { claimPool: pool, dropOk: () => false });
  assert.equal(claimsOf([11, 21].flatMap(t => searchOne(a, t, noDrop).plans)).length, 0);
  const worse = wideOpts(a, { claimPool: [{ id: 42, position: 'TE', ros_ppg: 4 }], dropOk: () => true });
  assert.equal(claimsOf([11, 21].flatMap(t => searchOne(a, t, worse).plans)).length, 0, 'TE 42 beats no TE');
  const olave = { id: 290, name: 'P290', position: 'WR', value: 900, power: 12, ros_ppg: 12, injury: 0, bye: null, trend_kind: null };
  const b = claimAdapter({ pool: ['290'], extraPlayers: [olave], extraFa: [{ id: 290, name: 'P290', position: 'WR', ros_ppg: 12 }] });
  const res = planLeague(b, { objective: OBJ, env: ON });
  const steps = [...(res.deck ?? []).flatMap(c => c.plan.steps), ...Object.values(res.risk_modes ?? {}).flatMap(m => m?.best?.steps ?? [])];
  assert.ok(!steps.some(st => st.get.map(String).includes('290')), 'pinned never-get is never claimed');
  assert.equal(res.search_wide.claims.pool, 0, '290 is removed from the pool before search');
});

/* ------------------------------------------------------ W6: hard rules hold */

test('W6: flag on, Nick\'s hard rules hold on every served step', () => {
  const a = claimAdapter();
  a.maxOverpay = 0;
  a.untouchable = new Set(['2']);
  const res = planLeague(a, { objective: OBJ, env: ON });
  const cards = res.deck.map(c => c.plan);
  const modeBest = Object.values(res.risk_modes).map(m => m?.best).filter(Boolean);
  const val = id => a.players.get(id)?.value ?? 0;
  for (const p of [...cards, ...modeBest]) {
    for (const st of p.steps) {
      assert.ok(!st.give.map(String).includes('2'), 'untouchable never given (or dropped)');
      if (st.claim) continue;
      const pct = overpayPct(st.give.reduce((s, id) => s + val(id), 0), st.get.reduce((s, id) => s + val(id), 0));
      assert.ok(pct <= 1e-9 || st.depth_premium, `overpay ${pct}`);
    }
  }
  for (const p of cards) assert.equal(p.beats_no_trade, true, 'every served card beats doing nothing on the confirm dice');
});

/* ------------------------------------------------------------ W7: off is today */

test('W7: flag off is today: no search_wide key, same output as the variable unset', () => {
  const unset = planLeague(makeAdapter(), { objective: OBJ, env: {} });
  const zero = planLeague(makeAdapter(), { objective: OBJ, env: { [SEARCH_WIDE_ENV]: '0' } });
  assert.equal('search_wide' in unset, false);
  assert.deepEqual(JSON.parse(JSON.stringify(zero)), JSON.parse(JSON.stringify(unset)));
});

/* ------------------------------------------------------------- W8: contract */

const produce = async (env, adapterFn, objectives = {}) => {
  const file = await buildPlansFile([{ id: 99, load: async () => ({ adapter: adapterFn() }) }],
    { generated_at: AS_OF, clock: () => 0, env, objectives });
  return file;
};
/** A strong free-agent TE (ros 14) over Nick's depth TE 5 (ros 9): a claim worth serving in all-in. */
const claimTeAdapter = () => claimAdapter({ pool: ['44'],
  extraPlayers: [{ id: 44, name: 'P44', position: 'TE', value: 800, power: 14, ros_ppg: 14, injury: 0, bye: null, trend_kind: null }],
  extraFa: [{ id: 44, name: 'P44', position: 'TE', ros_ppg: 14 }], scoreOf: scoreFrom(new Set([...DEPTH, '5'])) });
const stepsIn = entry => {
  const out = [];
  const walk = x => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== 'object') return;
    if (x.partner != null && Array.isArray(x.give) && Array.isArray(x.get)) out.push(x);
    Object.values(x).forEach(walk);
  };
  walk([entry.next_move, entry.alternatives]);
  return out;
};

test('W8 (#406 finding 3): flag on, the file passes its contract and NO served step is a claim; the best claim is shadow', async () => {
  const file = await produce(ON, claimTeAdapter, { 99: { risk_mode: 'all_in' } });
  assert.deepEqual(validatePlans(file).errors ?? [], []);
  const entry = file.leagues[0];
  assert.ok(!entry.error, entry.error);
  const sw = entry._run.inputs.search_wide;
  assert.equal(sw.flag, 'on');
  for (const k of ['budget', 'used', 'budget_hit', 'laterals', 'claims', 'modes_first_steps', 'modes_differ']) assert.ok(k in sw, k);
  assert.equal(stepsIn(entry).filter(s => s.partner === FREE_AGENT).length, 0, 'the UI never gets a "send to free_agent" step');
  const all = JSON.stringify([entry.next_move, entry.alternatives, entry.itinerary, entry.targets]);
  assert.equal(all.includes(`"partner":"${FREE_AGENT}"`), false);
  assert.ok(sw.claims.kept > 0, 'claims were still found and kept by the hard filters');
  assert.equal(sw.claims.served, false);
  assert.ok(sw.claims.shadow_best?.steps.some(st => st.claim && st.partner === FREE_AGENT), 'the best claim path is reported as shadow');
  assert.ok(sw.claims.shadow_best.steps.at(-1).p < 1);
});

test('W8: flag off, the producer writes no search_wide key', async () => {
  const file = await produce(OFF, () => claimAdapter());
  assert.equal(validatePlans(file).ok, true);
  assert.equal(file.leagues[0]._run.inputs.search_wide, undefined);
});

/* ---------------------------------------------- #406 finding 1: claim P(yes) */

test('claim P(yes): the league\'s waiver-win rate, smoothed; too few claims or none -> no claims at all', () => {
  assert.deepEqual(wide.claimProbability({ won: 22, lost: 7 }), { status: 'ok', basis: 'waiver.league_rate', p: CLAIM_P, won: 22, lost: 7, n: 29 });
  assert.equal(wide.claimProbability({ won: 2, lost: 1 }).status, 'not_enough_data');
  assert.equal(wide.claimProbability(null).status, 'no_history');
  const a = claimAdapter();
  delete a.waiverRecord;
  const res = planLeague(a, { objective: OBJ, env: ON });
  assert.equal(res.search_wide.claims.p_yes.status, 'no_history');
  assert.equal(res.search_wide.claims.pool, 0, 'no rate: no claim is built (fails closed)');
  assert.equal(res.search_wide.claims.built, 0);
  const b = planLeague(claimAdapter(), { objective: OBJ, env: ON });
  assert.equal(b.search_wide.claims.p_yes.p, CLAIM_P);
});

test('claim P(yes) < 1 is what the path\'s expected value is priced on', async () => {
  const { pathExpectation } = await import('../server/services/campaign/paths.js');
  const a = claimAdapter();
  const pool = a.freeAgents.filter(f => a.claimUniverse.has(String(f.id)));
  const drop = makeDropOk({ scoreOf: a.scoreOf, floor: 83, untouchable: new Set() });
  const half = claimsOf([11, 21, 31].flatMap(t => searchOne(a, t, wideOpts(a, { claimPool: pool, dropOk: drop, claimP: 0.5 })).plans));
  assert.ok(half.length > 0);
  for (const p of half) {
    assert.equal(p.steps.at(-1).p, 0.5);
    assert.equal(p.expected, pathExpectation(p.steps).expected);
    const sure = pathExpectation(p.steps.map((st, i) => (i === p.steps.length - 1 ? { ...st, p: 1 } : st))).expected;
    assert.notEqual(p.expected, sure, 'the chance of losing the claim moves the path\'s value');
  }
});

/* --------------------------------------- #406 finding 2: one read of the flag */

test('one flag read: the planner follows the adapter\'s searchWide, whatever its own env says', () => {
  const offAdapter = Object.assign(claimAdapter(), { searchWide: 'off' });
  const r1 = planLeague(offAdapter, { objective: OBJ, env: ON });
  assert.equal('search_wide' in r1, false, 'the world was built without claims: the planner must not widen');
  const onAdapter = Object.assign(claimAdapter(), { searchWide: 'on' });
  const r2 = planLeague(onAdapter, { objective: OBJ, env: OFF });
  assert.equal(r2.search_wide?.flag, 'on', 'the world was built for it: the planner widens');
});

/* ------------------------- #406 finding 5: the claim's P(yes) label vs LIVE-BLEND (#404) */

test('a claim step\'s P(yes) is never labelled an acceptance model\'s, even if it carried a blend basis', async () => {
  const { stepPSource } = await import('../server/services/campaign/view.js');
  assert.equal(stepPSource({ claim: true }), 'plan.path');
  assert.equal(stepPSource({ claim: true, p_basis: 'pyes_blend' }), 'plan.path');
  assert.equal(stepPSource({ claim: true, p_basis: 'activity_baseline' }), 'plan.path');
  assert.equal(stepPSource({ p_basis: 'pyes_blend' }), 'blend.accept');
  assert.equal(stepPSource({ p_basis: 'activity_baseline' }), 'activity.accept');
  assert.equal(stepPSource({}), 'clone.accept');
  // And the search never gives a claim step a blend basis or a gate p (so LIVE-BLEND cannot re-blend it).
  const a = claimAdapter();
  const pool = a.freeAgents.filter(f => a.claimUniverse.has(String(f.id)));
  const o = wideOpts(a, { claimPool: pool, dropOk: makeDropOk({ scoreOf: a.scoreOf, floor: 83, untouchable: new Set() }) });
  const claimSteps = claimsOf([11, 21, 31].flatMap(t => searchOne(a, t, o).plans)).map(p => p.steps.at(-1));
  assert.ok(claimSteps.length > 0);
  for (const st of claimSteps) assert.deepEqual([st.p_basis, st.p_gate, st.probe], [undefined, undefined, undefined]);
});
