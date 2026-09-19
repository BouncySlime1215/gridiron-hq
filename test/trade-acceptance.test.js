/**
 * trade-acceptance: how likely is THIS manager to say yes to THIS deal, as a
 * band, never as a number we cannot back.
 *
 * Master plan D4: "P(accept) - too few decided proposals (6 accepts, 24
 * declines) to fit a model, so it is a band from the heuristic (their perceived
 * value delta, need fit, receptiveness, profile) with the observed accept rate
 * as the anchor, labelled as a band."
 *
 * Gates pre-registered in docs/tdd/value-and-acceptance.tdd.md BEFORE this file
 * was written (G1-G7). Nothing here is fitted: every term is a named, capped
 * adjustment, so the guarantees are caps, provenance, honest degradation and
 * the edge test - not a season split.
 *
 *  G1 band, never a point: low/mid/high, fitted:false, a named basis, no path
 *    that returns a bare probability.
 *  G2 the anchor is real and carries its n; no decided offers widens the band
 *    and says so instead of inventing a prior.
 *  G3 the same evidence is never charged twice: perception_delta is the ONLY
 *    price term, because need fit and the profile roster read are already
 *    inside it (playerValuation factors 5 and 2).
 *  G4 honest degradation: no counterparty data returns "no information" with
 *    its reason, not a confident midpoint.
 *  G5 the edge test still gates: a deal that fails it never receives an
 *    acceptance number at all.
 *  G6 ablation: zeroing a source really moves the band.
 *  G7 monotonicity: a deal that reads better on his numbers cannot produce a
 *    lower midpoint, all else equal.
 *
 * No database is touched: the band is a pure function of a deal's counterparty
 * block, its edge result and the manager's negotiation profile.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { acceptanceBand, ACCEPTANCE_SOURCES } from '../server/services/trade-acceptance.js';

/* ------------------------------------------------------------- fixtures */

/** The counterparty block the trade engine already puts on every idea. */
const informed = (over = {}) => ({
  counterparty_data: true,
  perception_informed: true,
  perception_delta: 0,
  receptiveness: 1,
  chat_msgs: 40,
  accept_rate: 0.25,
  accept_rate_n: 30,
  ...over,
});

/** A league with no chat corpus: readDeal's own no-information shape. */
const uninformed = () => ({
  counterparty_data: false,
  perception_informed: false,
  perception_delta: null,
  perception_shift: null,
  perception_reasons: [],
  receptiveness: 1,
  chat_msgs: 0,
  accept_rate: null,
  accept_rate_n: 0,
});

const profileWith = no_hold => ({ says_no: { does_his_no_hold: no_hold }, confidence: 'high' });

const passes = { passes: true, failed: [], checks: {} };
const fails = { passes: false, failed: ['not_only_perception'], checks: {} };

/* ------------------------------------------------- G1 band, never a point */

test('G1 every result is a band with a named basis, and is never presented as fitted', () => {
  const r = acceptanceBand({ counterparty: informed(), edge: passes });
  assert.ok(r.band, 'a passing deal gets a band');
  for (const k of ['low', 'mid', 'high']) {
    assert.equal(typeof r.band[k], 'number', `${k} is a number`);
    assert.ok(r.band[k] >= 0 && r.band[k] <= 1, `${k} is a probability`);
  }
  assert.ok(r.band.low <= r.band.mid && r.band.mid <= r.band.high, 'ordered low <= mid <= high');
  assert.ok(r.band.high > r.band.low, 'a band has width; a point estimate would be a lie here');
  assert.equal(r.fitted, false, 'nothing here is fitted');
  assert.equal(typeof r.basis, 'string');
  assert.ok(r.why && r.why.length > 0, 'it says in words what it is');
});

/* ----------------------------------------------------------- G2 the anchor */

test('G2 the observed accept rate anchors the band and carries its own n', () => {
  const r = acceptanceBand({ counterparty: informed({ accept_rate: 0.25, accept_rate_n: 30 }),
    edge: passes });
  assert.equal(r.anchor.accept_rate, 0.25);
  assert.equal(r.anchor.n, 30);
  assert.equal(r.anchor.calibrated, false);
  assert.equal(r.anchor.fitted, false);
  assert.match(r.anchor.why, /30/, 'the sample size is stated, not just carried');
});

test('G2 no decided offers widens the band and says so, rather than inventing a prior', () => {
  const anchored = acceptanceBand({ counterparty: informed({ accept_rate: 0.25, accept_rate_n: 30 }),
    edge: passes });
  const none = acceptanceBand({ counterparty: informed({ accept_rate: null, accept_rate_n: 0 }),
    edge: passes });
  assert.equal(none.anchor.accept_rate, null);
  assert.equal(none.anchor.n, 0);
  assert.match(none.anchor.why, /no decided offers/i);
  const width = b => b.band.high - b.band.low;
  assert.ok(width(none) > width(anchored),
    'an unanchored band must be wider than an anchored one, not equally confident');
});

test('G2 a thin anchor is wider than a thick one', () => {
  const thin = acceptanceBand({ counterparty: informed({ accept_rate: 0.25, accept_rate_n: 4 }),
    edge: passes });
  const thick = acceptanceBand({ counterparty: informed({ accept_rate: 0.25, accept_rate_n: 60 }),
    edge: passes });
  assert.ok((thin.band.high - thin.band.low) > (thick.band.high - thick.band.low),
    'four decided offers cannot buy the same confidence as sixty');
});

/* ------------------------------------------- G3 never charge evidence twice */

test('G3 perception_delta is the only price term: need fit is not re-added on top', () => {
  // Need fit reaches this function ONLY through perception_delta, because
  // playerValuation already priced it (factor 5, positional_need). A fixture
  // that also declares the need must not move the band a second time.
  const base = acceptanceBand({ counterparty: informed({ perception_delta: 12 }), edge: passes });
  const alsoDeclaresNeed = acceptanceBand({
    counterparty: informed({ perception_delta: 12, needs: ['RB'], surplus: [] }),
    edge: passes,
  });
  assert.deepEqual(alsoDeclaresNeed.band, base.band,
    'the same need cannot be charged once in the delta and again in the band');
});

test('G3 the profile roster read is not re-added either, for the same reason', () => {
  const base = acceptanceBand({ counterparty: informed({ perception_delta: 8 }), edge: passes });
  const withRosterRead = acceptanceBand({
    counterparty: informed({ perception_delta: 8 }),
    edge: passes,
    profile: { ...profileWith('unknown'), roster_read: { overvalues: ['Some Player'] } },
  });
  assert.deepEqual(withRosterRead.band, base.band,
    'roster_read is priced inside perception_delta; it is explanation here, not a second term');
});

test('G3 every factor that DID move the band names a declared source with its cap', () => {
  const r = acceptanceBand({
    counterparty: informed({ perception_delta: 15, receptiveness: 1.2 }),
    edge: passes,
    profile: profileWith('rarely'),
  });
  assert.ok(r.factors.length > 0, 'something moved it');
  for (const f of r.factors) {
    assert.ok(ACCEPTANCE_SOURCES[f.source], `${f.source} is a declared source`);
    assert.equal(typeof f.cap, 'number');
    assert.ok(Math.abs(f.effect) <= f.cap + 1e-9, `${f.source} respects its own cap`);
    assert.equal(f.fitted, false);
    assert.ok(f.why && f.why.length > 0, `${f.source} says why`);
  }
});

/* ------------------------------------------------- G4 honest degradation */

test('G4 a league with no counterparty data says "no information", not a confident midpoint', () => {
  const r = acceptanceBand({ counterparty: uninformed(), edge: passes });
  assert.equal(r.basis, 'no_information');
  assert.match(r.why, /no counterparty data/i);
  assert.ok(r.inert.length > 0, 'the sources it could not read are listed');
  for (const i of r.inert) assert.ok(i.reason && i.reason.length > 0, 'each with its reason');
  if (r.band) {
    assert.ok(r.band.high - r.band.low >= 0.5,
      'with no information the band must be nearly useless-wide, which is the honest answer');
  }
});

test('G4 a missing negotiation profile is reported inert rather than silently skipped', () => {
  const r = acceptanceBand({ counterparty: informed(), edge: passes, profile: null });
  assert.ok(r.inert.some(i => i.source === 'says_no_holds'),
    'the profile signal is named as unavailable');
});

/* ----------------------------------------------------- G5 the edge test */

test('G5 a deal that fails the edge test gets no acceptance number at all', () => {
  const r = acceptanceBand({ counterparty: informed({ perception_delta: 40 }), edge: fails });
  assert.equal(r.band, null, 'a gift does not become sendable because he would say yes');
  assert.equal(r.basis, 'edge_failed');
  assert.match(r.why, /edge test/i);
});

test('G5 a missing edge result is refused, not treated as a pass', () => {
  const r = acceptanceBand({ counterparty: informed() });
  assert.equal(r.band, null, 'no edge result means no claim; fail closed');
  assert.equal(r.basis, 'edge_unknown');
});

/* ---------------------------------------------------------- G6 ablation */

test('G6 zeroing a source really removes it from the band', () => {
  const on = acceptanceBand({ counterparty: informed({ receptiveness: 1.3 }), edge: passes });
  const off = acceptanceBand({ counterparty: informed({ receptiveness: 1.3 }), edge: passes,
    zero: ['receptiveness'] });
  assert.notDeepEqual(off.band, on.band, 'the ablation is a measurement, not a formality');
  assert.ok(!off.factors.some(f => f.source === 'receptiveness'),
    'the zeroed source contributes no factor');
});

/* ------------------------------------------------------ G7 monotonicity */

test('G7 a deal that reads better on his numbers cannot lower the midpoint', () => {
  const worse = acceptanceBand({ counterparty: informed({ perception_delta: -10 }), edge: passes });
  const even = acceptanceBand({ counterparty: informed({ perception_delta: 0 }), edge: passes });
  const better = acceptanceBand({ counterparty: informed({ perception_delta: 20 }), edge: passes });
  assert.ok(worse.band.mid <= even.band.mid, 'a deal that is bad for him is not more likely');
  assert.ok(even.band.mid <= better.band.mid, 'a deal that is good for him is not less likely');
  assert.ok(better.band.mid > worse.band.mid, 'the direction is real, not flat');
});

test('G7 a manager whose no never holds is not less likely to accept than one whose no is final', () => {
  const firm = acceptanceBand({ counterparty: informed(), edge: passes, profile: profileWith('yes') });
  const soft = acceptanceBand({ counterparty: informed(), edge: passes, profile: profileWith('rarely') });
  assert.ok(soft.band.mid >= firm.band.mid,
    'a no that does not hold means more room, not less');
});

/* ------------------------------------------------------------ the caps */

test('the band stays inside [0,1] under the most extreme inputs on both sides', () => {
  const hot = acceptanceBand({
    counterparty: informed({ perception_delta: 500, receptiveness: 1.3, accept_rate: 1, accept_rate_n: 99 }),
    edge: passes, profile: profileWith('rarely'),
  });
  const cold = acceptanceBand({
    counterparty: informed({ perception_delta: -500, receptiveness: 0.7, accept_rate: 0, accept_rate_n: 99 }),
    edge: passes, profile: profileWith('yes'),
  });
  for (const r of [hot, cold]) {
    assert.ok(r.band.low >= 0 && r.band.high <= 1, 'a probability cannot leave [0,1]');
    assert.ok(r.band.low <= r.band.mid && r.band.mid <= r.band.high, 'still ordered');
  }
  assert.ok(hot.band.mid < 1, 'certainty is never claimed');
  assert.ok(cold.band.mid > 0, 'impossibility is never claimed either');
});
