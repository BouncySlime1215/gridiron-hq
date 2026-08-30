/**
 * The brain's claims, tested as claims.
 *
 * Each of these encodes a bug that was actually found while building it, so a
 * regression here is not hypothetical — every one of them shipped at least once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptProbability, TRADEABILITY } from '../server/services/league-brain.js';

test('a manager who never trades never gets a meaningful acceptance probability', () => {
  // Even handed a deal that is enormously in their favour.
  const p = acceptProbability('never', { theirEdgePct: 60, theirPpgDelta: 6 });
  assert.ok(p <= TRADEABILITY.never.responsiveness,
    `never-trades ceiling exceeded: ${p} > ${TRADEABILITY.never.responsiveness}`);
});

test('acceptance falls when the deal makes their lineup worse', () => {
  // The original bug: probability keyed only on market value, so a package that
  // handed over more "value" while costing their starting lineup a point a week
  // scored 62% — a number no manager's behaviour has ever produced.
  const same = { theirEdgePct: 6 };
  const good = acceptProbability('fair', { ...same, theirPpgDelta: 1.5 });
  const flat = acceptProbability('fair', { ...same, theirPpgDelta: 0 });
  const bad = acceptProbability('fair', { ...same, theirPpgDelta: -1.5 });
  assert.ok(good > flat, `lineup gain should raise acceptance (${good} vs ${flat})`);
  assert.ok(flat > bad, `lineup loss should lower acceptance (${bad} vs ${flat})`);
});

test('no tier accepts a clearly bad deal at a high rate', () => {
  // The additive floor this replaced guaranteed a "fair" manager accepted at
  // least 35% of everything, including deals that made their team worse.
  for (const tier of Object.keys(TRADEABILITY)) {
    const p = acceptProbability(tier, { theirEdgePct: -25, theirPpgDelta: -2 });
    assert.ok(p < 0.25, `${tier} accepts a fleece at ${p}`);
  }
});

test('tiers are ordered: fair > hard > never at every offer quality', () => {
  for (const offer of [
    { theirEdgePct: -10, theirPpgDelta: -1 },
    { theirEdgePct: 0, theirPpgDelta: 0 },
    { theirEdgePct: 20, theirPpgDelta: 2 }
  ]) {
    const fair = acceptProbability('fair', offer);
    const hard = acceptProbability('hard', offer);
    const never = acceptProbability('never', offer);
    assert.ok(fair > hard && hard > never,
      `ordering broken at ${JSON.stringify(offer)}: ${fair}/${hard}/${never}`);
  }
});

test('acceptance is monotonic in how good the offer is', () => {
  let prev = -1;
  for (const edge of [-40, -20, -5, 0, 5, 20, 40, 80]) {
    const p = acceptProbability('fair', { theirEdgePct: edge, theirPpgDelta: 0 });
    assert.ok(p >= prev, `not monotonic at edge=${edge}: ${p} < ${prev}`);
    prev = p;
  }
});

test('probabilities stay inside (0, 1) at absurd inputs', () => {
  for (const v of [-1e6, 1e6, 0]) {
    for (const tier of Object.keys(TRADEABILITY)) {
      const p = acceptProbability(tier, { theirEdgePct: v, theirPpgDelta: v });
      assert.ok(p > 0 && p < 1, `${tier} at ${v} produced ${p}`);
      assert.ok(Number.isFinite(p), `${tier} at ${v} produced ${p}`);
    }
  }
});

test('an unknown tier falls back to fair rather than throwing', () => {
  const p = acceptProbability('nonsense', { theirEdgePct: 0, theirPpgDelta: 0 });
  assert.equal(p, acceptProbability('fair', { theirEdgePct: 0, theirPpgDelta: 0 }));
});

test('missing fields are treated as a dead-even deal, not as NaN', () => {
  const p = acceptProbability('fair');
  assert.ok(Number.isFinite(p) && p > 0, `empty offer produced ${p}`);
});

test('expected value can rank a smaller deal above a bigger one', () => {
  // This is the entire thesis of the module, stated as arithmetic: a large gain
  // from someone who does not trade is worth less than a small gain from
  // someone who does.
  const bigFromRefuser = 4.0 * acceptProbability('never', { theirEdgePct: 10, theirPpgDelta: 0 });
  const smallFromDealer = 0.8 * acceptProbability('fair', { theirEdgePct: 10, theirPpgDelta: 0.5 });
  assert.ok(smallFromDealer > bigFromRefuser,
    `EV ordering failed: ${smallFromDealer} should beat ${bigFromRefuser}`);
});
