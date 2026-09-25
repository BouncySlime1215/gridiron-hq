/**
 * FLIP-STRANDED (Batch D item 1): GETS-FLOOR checked only what Nick holds at the END of a path. A
 * chained path (get a chip in leg 1, spend it in leg 2) or a flip (buy from A, sell to B) leaves him
 * holding the leg-1 player if leg 2 is turned down. Nick 2026-09-25: every holding after each executed
 * leg must also pass the 83+ floor (and, per leg, no buy-back and no overpay: those are already
 * per-step checks, pinned here so they stay that way).
 *
 * Flag GRIDIRON_FLIP_STRANDED: on by default (Nick's hard rule, like GRIDIRON_GETS_FLOOR); 'shadow'
 * counts only; an explicit '0' turns it off with a loud warning. Made-up leagues only
 * (test/fixtures/rule-fuzz-league.mjs); the oracle (test/fixtures/nick-rules.mjs) shares no code with it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { heldAfterEachLeg, strandedHolds, isFlipPieceClaim, flipStrandedFlag, FLIP_STRANDED_ENV, FLIP_STRANDED_OFF_WARNING, heldAtEnd } =
  await import('../server/services/campaign/gets-floor.js');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { makeFuzzLeague } = await import('./fixtures/rule-fuzz-league.mjs');
const { ruleViolations, strandedAfterLegs } = await import('./fixtures/nick-rules.mjs');

/* ---------------------------------------------------------------- the rule, pure */

test('heldAfterEachLeg: what Nick holds (gets minus later gives) after every leg; the last is heldAtEnd', () => {
  const steps = [{ give: [1], get: [50] }, { give: [50, 2], get: [99] }];
  assert.deepEqual(heldAfterEachLeg(steps).map(s => [...s].sort()), [['50'], ['99']]);
  assert.deepEqual([...heldAfterEachLeg(steps).at(-1)], [...heldAtEnd(steps)]);
  assert.deepEqual(heldAfterEachLeg([]), []);
});

test('strandedHolds: only the legs before the last; ids are strings; the end is GETS-FLOOR\'s', () => {
  const passes = id => ['99', '60'].includes(String(id));
  // Leg 1 picks up 50 (fails), leg 2 spends it: stranded at leg 1.
  assert.deepEqual(strandedHolds([{ give: [1], get: [50] }, { give: [50, 2], get: [99] }], passes), [{ leg: 0, player: '50' }]);
  // A chip that passes is no strand.
  assert.deepEqual(strandedHolds([{ give: [1], get: [60] }, { give: [60, 2], get: [99] }], passes), []);
  // A single leg has no "in between" (its end is GETS-FLOOR's check, not this one).
  assert.deepEqual(strandedHolds([{ give: [1], get: [50] }], passes), []);
  // Three legs: each hold before the last is read once per leg it is held after.
  assert.deepEqual(strandedHolds([{ give: [1], get: [50] }, { give: [2], get: [51] }, { give: [50, 51], get: [99] }], passes),
    [{ leg: 0, player: '50' }, { leg: 1, player: '50' }, { leg: 1, player: '51' }]);
});

test('flip claims (Nick 2026-09-25): a waiver claim traded away later in the same path is exempt between legs', () => {
  const passes = id => String(id) === '99';
  const claim = { team: 'free_agent', claim: true, give: [3], get: [70] };
  const flipped = [claim, { team: '2', give: [70, 1], get: [99] }];
  assert.equal(isFlipPieceClaim(claim, flipped), true);
  assert.deepEqual(strandedHolds(flipped, passes), [], 'a claim flipped later passes');
  // A claim never traded away is held at the end: no exemption (and GETS-FLOOR checks the end).
  const kept = [claim, { team: '2', give: [1], get: [99] }];
  assert.equal(isFlipPieceClaim(claim, kept), false);
  assert.deepEqual(strandedHolds(kept, passes), [{ leg: 0, player: '70' }], 'a claim held at the end fails');
  // The same player got by TRADE is not exempt: only the claim source is.
  const traded = [{ ...claim, team: '4', claim: undefined }, flipped[1]];
  assert.equal(isFlipPieceClaim(traded[0], traded), false);
  assert.deepEqual(strandedHolds(traded, passes), [{ leg: 0, player: '70' }], 'a traded-for sub-83 intermediate fails');
  // A step outside the path is never a flip piece.
  assert.equal(isFlipPieceClaim(claim, [flipped[1]]), false);
});

test('the flag: on by default, shadow counts, only an explicit 0 turns it off, loudly', () => {
  assert.equal(FLIP_STRANDED_ENV, 'GRIDIRON_FLIP_STRANDED');
  assert.equal(flipStrandedFlag({}), 'on');
  assert.equal(flipStrandedFlag(undefined), 'on');
  assert.equal(flipStrandedFlag({ GRIDIRON_FLIP_STRANDED: '1' }), 'on');
  assert.equal(flipStrandedFlag({ GRIDIRON_FLIP_STRANDED: 'shadow' }), 'shadow');
  assert.equal(flipStrandedFlag({ GRIDIRON_FLIP_STRANDED: '0' }), 'off');
  // The preview switch is not this unit's flag (Nick 2026-09-25: own flag only).
  assert.equal(flipStrandedFlag({ GRIDIRON_PREVIEW_UNCONFIRMED: '1', GRIDIRON_FLIP_STRANDED: '0' }), 'off');
  assert.match(FLIP_STRANDED_OFF_WARNING, /^WARNING: GRIDIRON_FLIP_STRANDED=0 turns OFF/);
});

test('the oracle reads the same thing independently', () => {
  assert.deepEqual(strandedAfterLegs([{ give: [1], get: [50] }, { give: [50, 2], get: [99] }], [1, 2, 3]), [{ leg: 0, player: '50' }]);
});

/* ---------------------------------------------------------------- the planner */

const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);
const MODES = ['safe', 'balanced', 'all_in'];
const runs = new Map();
function sweep(env) {
  const k = JSON.stringify(env);
  if (runs.has(k)) return runs.get(k);
  const out = [];
  for (const mode of MODES) for (const seed of SEEDS) {
    const a = makeFuzzLeague(seed);
    const res = planLeague(a, { objective: normaliseObjective({ risk_mode: mode }), env });
    out.push({ seed, mode, a, res, stranded: ruleViolations(a, res).filter(v => v.rule === 'stranded_hold') });
  }
  runs.set(k, out);
  return out;
}
const OFF = { GRIDIRON_FLIP_STRANDED: '0' };
const SHADOW = { GRIDIRON_FLIP_STRANDED: 'shadow' };

test('off (=0): main\'s behaviour, a path can strand Nick (the case is real on these seeds)', () => {
  const bad = sweep(OFF).flatMap(r => r.stranded);
  assert.ok(bad.length > 0, 'the sweep never produced a stranded hold: the on test below would pass vacuously');
  const off = sweep(OFF)[0].res.flip_stranded;
  assert.equal(off.mode, 'off');
  assert.match(off.warning, /^WARNING: GRIDIRON_FLIP_STRANDED=0/);
});

test('on (default): no plan, flip or ladder served holds a sub-83 player between legs, in any mode', () => {
  const rs = sweep({});
  const bad = rs.flatMap(r => r.stranded.map(v => `seed ${r.seed} ${r.mode} ${v.surface} ${v.detail}`));
  assert.deepEqual(bad.slice(0, 5), []);
  assert.equal(rs[0].res.flip_stranded.mode, 'on');
  assert.equal(rs[0].res.flip_stranded.warning, undefined);
  const dropped = rs.reduce((s, r) => s + r.res.flip_stranded.paths_dropped, 0);
  assert.ok(dropped > 0, 'the filter dropped stranded paths on this sweep');
  // It serves decks still (the non-vacuity bar RULE-FUZZ holds the full sweep to).
  for (const mode of MODES) assert.ok(rs.filter(r => r.mode === mode && r.res.deck.length).length > 0, `${mode} serves no deck`);
});

test('on: a flip whose leg-1 player is under the floor is not served (leg 2 may be turned down)', () => {
  const rs = sweep({});
  for (const r of rs) {
    for (const f of r.res.flip.realised) if (f.legs) assert.ok(Number(r.a.scoreOf(f.player)?.score) >= 83, `seed ${r.seed} ${r.mode}: flip ${f.player}`);
    for (const f of r.res.flip.top) assert.ok(Number(r.a.scoreOf(f.player)?.score) >= 83, `seed ${r.seed} ${r.mode}: flip idea ${f.player}`);
  }
  assert.ok(rs.reduce((s, r) => s + r.res.flip_stranded.flips_dropped, 0) > 0, 'the sweep had a sub-83 flip to drop');
});

test('shadow: served output equals off; the sink counts what on would drop', () => {
  const sh = sweep(SHADOW), off = sweep(OFF), on = sweep({});
  for (const [i, r] of sh.entries()) {
    assert.deepEqual(r.res.best, off[i].res.best, `seed ${r.seed} ${r.mode}: best moved in shadow`);
    assert.deepEqual(r.res.deck, off[i].res.deck, `seed ${r.seed} ${r.mode}: deck moved in shadow`);
    assert.equal(r.res.flip_stranded.paths_would_drop, on[i].res.flip_stranded.paths_dropped);
    assert.equal(r.res.flip_stranded.flips_would_drop, on[i].res.flip_stranded.flips_dropped);
  }
});

test('per leg: no leg of a served plan gives a pinned player, overpays or buys back (each leg is an offer)', () => {
  for (const r of sweep({})) {
    const v = ruleViolations(r.a, r.res).filter(x => ['never_give', 'overpay', 'no_buyback', 'no_undo'].includes(x.rule));
    assert.deepEqual(v.slice(0, 3), [], `seed ${r.seed} ${r.mode}`);
  }
});

test('the run summary names ids only and says what it read', () => {
  const s = sweep({}).find(r => r.res.flip_stranded.paths_dropped > 0).res.flip_stranded;
  assert.equal(s.floor, 83);
  assert.ok(Array.isArray(s.examples) && s.examples.length > 0 && s.examples.length <= 10);
  for (const e of s.examples) {
    assert.match(e.player, /^\d+$/);
    assert.ok(Number.isInteger(e.leg) && e.leg >= 1);
    assert.ok(['below_floor', 'unscored', 'no_score_source'].includes(e.why));
  }
});
