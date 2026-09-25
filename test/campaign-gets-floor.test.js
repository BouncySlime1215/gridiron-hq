/**
 * GETS-FLOOR: the player Nick ends a plan holding (the final leg's target) must score at or above
 * the floor on the blue-chip score (PLAYER-SCORE, adapter.scoreOf). Nick 9/24: final gets are Blue
 * chip, 83+. The floor applies to the GET only; what Nick pays with is never floored.
 *
 * Flag GRIDIRON_GETS_FLOOR: '1' enforces, 'shadow' counts what it would drop and moves nothing
 * served, unset or '0' is off. Made-up league (test/fixtures/campaign-league.mjs); no DB, no simulation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { DEFAULT_GET_FLOOR, getsFloorFlag, getFloorOf, floorRead, floorName } = await import('../server/services/campaign/gets-floor.js');
const { PINNED_NEVER_GIVE } = await import('../server/services/campaign/never-give.js');
const { makeScorer, playerValues, searchTarget } = await import('../server/services/campaign/search.js');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry, plansFile } = await import('../server/services/campaign/view.js');
const { validateLeague, validatePlans } = await import('../server/services/campaign/plans-schema.js');
const { makeAdapter, makePlayers } = await import('./fixtures/campaign-league.mjs');

/* ---------------------------------------------------------------- the rule */

test('the floor: 83 by default, a destination may only raise it', () => {
  assert.equal(DEFAULT_GET_FLOOR, 83);
  assert.equal(getFloorOf({}), 83);
  assert.equal(getFloorOf(null), 83);
  assert.equal(getFloorOf({ min_get_score: 'x' }), 83);
  assert.equal(getFloorOf({ min_get_score: -1 }), 83);
  assert.equal(getFloorOf({ min_get_score: 74 }), 83, 'never lowered under Nick\'s 83');
  assert.equal(getFloorOf({ min_get_score: 88 }), 88);
  assert.equal(floorName(88), 'Blue chip floor (88+)');
});

test('the flag: unset is off, 1 enforces, shadow counts', () => {
  assert.equal(getsFloorFlag({}), 'off');
  assert.equal(getsFloorFlag({ GRIDIRON_GETS_FLOOR: '1' }), 'on');
  assert.equal(getsFloorFlag({ GRIDIRON_GETS_FLOOR: 'shadow' }), 'shadow');
  assert.equal(getsFloorFlag({ GRIDIRON_GETS_FLOOR: '0' }), 'off');
  assert.equal(getsFloorFlag(undefined), 'off');
});

test('a read: at the floor passes, under it fails, unscored and no source fail closed', () => {
  const scoreOf = id => ({ 1: { score: 83, label: 'Blue chip' }, 2: { score: 82.9, label: 'Blue chip' }, 3: null })[id] ?? null;
  assert.deepEqual(floorRead(scoreOf, 1, 83), { player: '1', score: 83, label: 'Blue chip', passes: true, why: null });
  assert.deepEqual(floorRead(scoreOf, 2, 83), { player: '2', score: 82.9, label: 'Blue chip', passes: false, why: 'below_floor' });
  assert.deepEqual(floorRead(scoreOf, 3, 83), { player: '3', score: null, label: null, passes: false, why: 'unscored' });
  assert.deepEqual(floorRead(null, 1, 83), { player: '1', score: null, label: null, passes: false, why: 'no_score_source' });
  // A score that is not a finite number is unscored, never a pass.
  assert.equal(floorRead(() => ({ score: NaN }), 4, 83).why, 'unscored');
});

/* ------------------------------------------- the whole planner, floored */

// The fixture's natural targets are 11, 12, 13 (then 22, 32 in the suggestions).
// Only 11 (90) and 22 (85) are Blue chip.
const SCORES = { 11: 90, 12: 75, 13: 60, 22: 85, 32: 70 };
const scoreOf = id => (SCORES[id] != null ? { score: SCORES[id], label: SCORES[id] >= 80 ? 'Blue chip' : 'Level below' } : { score: 20, label: 'Bench' });
const plan = (env, { mode = 'balanced', obj = {}, scored = true, searchOpts = null } = {}) => {
  const a = makeAdapter();
  if (scored) a.scoreOf = scoreOf;
  if (searchOpts) a.searchOpts = searchOpts;
  return { a, res: planLeague(a, { objective: normaliseObjective({ risk_mode: mode, ...obj }), env }) };
};
const ON = { GRIDIRON_GETS_FLOOR: '1' };
const finalTargets = res => [...res.deck.map(c => c.plan), res.best].filter(Boolean).map(p => String(p.target));

test('on: every final get is 83+, below-floor targets are replaced before the top-N slice', () => {
  for (const mode of ['safe', 'balanced', 'all_in']) {
    const { res } = plan(ON, { mode });
    assert.deepEqual(res.targets.map(String), ['11', '22'], `${mode}: the two Blue chips are the targets`);
    for (const t of finalTargets(res)) assert.ok(SCORES[t] >= 83, `${mode}: final get ${t} scores ${SCORES[t]}`);
    for (const s of res.suggestions) assert.ok(SCORES[s.player] >= 83, `${mode}: suggestion ${s.player} passes the floor`);
    assert.equal(res.gets_floor.mode, 'on');
    assert.equal(res.gets_floor.floor, 83);
    assert.equal(res.gets_floor.source, 'player_score');
    assert.ok(res.gets_floor.dropped >= 2, 'at least 12 and 13 were dropped');
    assert.ok(res.gets_floor.below.some(r => r.player === '12' && r.score === 75 && r.why === 'below_floor'));
  }
  // The floor never applies to what Nick gives: a sub-83 player of his is still spendable.
  const { res } = plan(ON, { mode: 'all_in' });
  assert.ok(res.best, 'a plan clears with the floor on');
});

test('shadow: served plans are byte-identical to off, and the would-drop count is printed', () => {
  for (const mode of ['balanced', 'all_in']) {
    const off = plan({}, { mode }).res;
    const shadow = plan({ GRIDIRON_GETS_FLOOR: 'shadow' }, { mode }).res;
    assert.equal(off.gets_floor.mode, 'off');
    assert.equal(shadow.gets_floor.mode, 'shadow');
    const served = r => JSON.stringify({ targets: r.targets, best: r.best, deck: r.deck, suggestions: r.suggestions });
    assert.equal(served(shadow), served(off), `${mode}: shadow moves nothing served`);
    assert.deepEqual(shadow.targets.map(String), ['11', '12', '13']);
    const on = plan(ON, { mode }).res;
    assert.ok(shadow.gets_floor.would_drop >= 2, '12 and 13 at least would be dropped');
    assert.equal(shadow.gets_floor.would_drop, on.gets_floor.dropped, 'shadow counts what on drops, no fewer');
    assert.equal(shadow.gets_floor.dropped, 0);
    assert.equal(off.gets_floor.would_drop, 0, 'off reads nothing');
  }
});

test('on with no score source: fails closed, no target searched, and the card says why', () => {
  const { a, res } = plan(ON, { scored: false });
  assert.deepEqual(res.targets, []);
  assert.equal(res.best, null);
  assert.equal(res.gets_floor.source, 'none');
  const entry = toEntry(res, { names: a.names(), as_of: '2026-09-24T00:00:00Z' });
  assert.equal(entry.next_move.status, 'unknown');
  assert.match(entry.next_move.reason, /Blue chip floor \(83\+\)/);
  assert.match(entry.next_move.reason, /no player score/);
  assert.deepEqual(validateLeague(entry).errors, []);
});

test('on: a below-floor player Nick asked for is refused as a target, and named', () => {
  const { a, res } = plan(ON, { obj: { kind: 'player', target: '12' } });
  assert.ok(!res.targets.map(String).includes('12'));
  assert.ok(res.gets_floor.refused.some(r => r.player === '12' && r.why === 'below_floor'));
  assert.equal(res.best, null, 'the objective is 12; nothing else is served for a player objective');
  const entry = toEntry(res, { names: a.names(), as_of: '2026-09-24T00:00:00Z' });
  assert.match(entry.next_move.reason, /P12 \(QB\) scores 75, under the Blue chip floor \(83\+\)/);
});

test('the floored plan still validates against the contract', () => {
  for (const env of [ON, { GRIDIRON_GETS_FLOOR: 'shadow' }, {}]) {
    const { a, res } = plan(env);
    const entry = toEntry(res, { names: a.names(), as_of: '2026-09-24T00:00:00Z' });
    assert.deepEqual(validateLeague(entry).errors, []);
    const doc = plansFile([entry], { generated_at: '2026-09-24T00:00:00Z' });
    assert.equal(validatePlans(doc).ok, true, JSON.stringify(validatePlans(doc).errors));
  }
});

/* --------------------------------- every final get: flip leg 2 and fillers */

const WIDE = { flipLegs: true, twoForOne: true, fillers: 4 };
const legB = res => res.flip.realised.filter(f => f.legs).flatMap(f => f.legs.get_b_ids ?? [f.legs.get_b]).map(String);
const finalGets = res => [...res.deck.map(c => c.plan), res.best].filter(Boolean).flatMap(p => p.steps[p.steps.length - 1].get).map(String);
const score = id => SCORES[id] ?? 20;

test('flip legs: the player Nick ends a flip holding (leg 2) passes the floor', () => {
  // Off, the fixture's flips end with Nick holding 12 (75) and 32 (70): the test has teeth.
  assert.ok(legB(plan({}, { searchOpts: WIDE }).res).some(id => score(id) < 83));
  for (const mode of ['safe', 'balanced', 'all_in']) {
    const { res } = plan(ON, { mode, searchOpts: WIDE });
    for (const id of legB(res)) assert.ok(score(id) >= 83, `${mode}: flip leg 2 gives Nick ${id} (${score(id)})`);
    const floored = res.flip.realised.filter(f => f.why_code === 'no_leg_floor');
    assert.ok(floored.length > 0, `${mode}: a flip the floor emptied says so`);
    assert.match(floored[0].why, /under your get floor/);
  }
});

test('2-for-1 fillers: every player in the final leg passes the floor, not only the target', () => {
  // Off, safe mode's final leg takes filler 15 (score 20) with the target.
  assert.ok(finalGets(plan({}, { mode: 'safe', searchOpts: WIDE }).res).some(id => score(id) < 83));
  for (const mode of ['safe', 'balanced', 'all_in']) {
    const gets = finalGets(plan(ON, { mode, searchOpts: WIDE }).res);
    assert.ok(gets.length > 0, `${mode}: something is served`);
    for (const id of gets) assert.ok(score(id) >= 83, `${mode}: final get ${id} (${score(id)})`);
  }
});

test('2-for-1 fillers: the search never adds a below-floor filler to the final leg', () => {
  const a = makeAdapter();
  a.searchOpts = { twoForOne: true, fillers: 4 };
  const S = makeScorer(a.world(a.seed), a);
  const obj = normaliseObjective({ risk_mode: 'safe' });
  const vals = playerValues(S, a, obj);
  const fills = getOk => searchTarget(S, a, vals, obj, 22, { getOk }).map(p => p.steps[p.steps.length - 1].get.map(String))
    .filter(g => g.length > 1).flat().filter(id => id !== '22');
  assert.ok(fills(null).some(id => score(id) < 83), 'unfloored, target 22 comes with fillers 24 / 25 (score 20)');
  assert.deepEqual(fills(id => score(id) >= 83), [], 'floored, no filler under 83 rides the final leg');
});

/* ------------------------------------------------ never give 160, 80, 277 */

const withIds = ids => {
  const players = makePlayers();
  const add = (id, value, power) => players.set(id, { id, name: `P${id}`, position: 'WR', value, power, ros_ppg: power, injury: 0, bye: null, trend_kind: null });
  add(ids[0], 4700, 22); add(ids[1], 5700, 20); add(ids[2], 2300, 12);
  const a = makeAdapter({ players });
  a.rosters.get('1').push(...ids);
  a.searchOpts = WIDE;
  return a;
};
const givenAnywhere = res => new Set([
  ...res.deck.flatMap(c => [...c.plan.steps.flatMap(s => s.give), ...(c.playbook?.walk_away?.give ?? [])]),
  ...res.flip.realised.filter(f => f.legs).flatMap(f => f.legs.give_a_ids ?? [f.legs.give_a]),
].map(String));

test('never give: Nico Collins (160), Chase Brown (80) and A.J. Brown (277) are pinned, with no notes at all', () => {
  assert.deepEqual([...PINNED_NEVER_GIVE], ['160', '80', '277']);
  // The same three players under other ids are given away: the pin is what protects them.
  const open = [161, 81, 278];
  const openGiven = [...givenAnywhere(planLeague(withIds(open), { objective: normaliseObjective({ risk_mode: 'all_in' }), env: {} }))];
  assert.ok(openGiven.some(id => open.map(String).includes(id)), `unpinned ids are given: ${openGiven}`);
  for (const mode of ['safe', 'balanced', 'all_in']) {
    for (const env of [{}, ON]) {
      const a = withIds([160, 80, 277]);
      assert.equal(a.untouchable?.size ?? 0, 0, 'no notes: the adapter protects nothing itself');
      const res = planLeague(a, { objective: normaliseObjective({ risk_mode: mode }), env });
      const given = givenAnywhere(res);
      for (const id of PINNED_NEVER_GIVE) assert.ok(!given.has(id), `${mode}: ${id} is never given`);
      for (const id of PINNED_NEVER_GIVE) assert.ok(res.untouchable.ids.includes(id), `${mode}: ${id} is listed untouchable`);
    }
  }
});
