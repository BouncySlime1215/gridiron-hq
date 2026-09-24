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

const { DEFAULT_GET_FLOOR, getsFloorFlag, getFloorOf, floorRead } = await import('../server/services/campaign/gets-floor.js');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry, plansFile } = await import('../server/services/campaign/view.js');
const { validateLeague, validatePlans } = await import('../server/services/campaign/plans-schema.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');

/* ---------------------------------------------------------------- the rule */

test('the floor: 83 by default, a destination may raise or lower it', () => {
  assert.equal(DEFAULT_GET_FLOOR, 83);
  assert.equal(getFloorOf({}), 83);
  assert.equal(getFloorOf(null), 83);
  assert.equal(getFloorOf({ min_get_score: 'x' }), 83);
  assert.equal(getFloorOf({ min_get_score: -1 }), 83);
  assert.equal(getFloorOf({ min_get_score: 74 }), 74);
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
const plan = (env, { mode = 'balanced', obj = {}, scored = true } = {}) => {
  const a = makeAdapter();
  if (scored) a.scoreOf = scoreOf;
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
    assert.equal(shadow.gets_floor.would_drop, 2, '12 and 13 would be dropped');
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
