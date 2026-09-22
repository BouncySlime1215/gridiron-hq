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
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { acceptanceBand, ACCEPTANCE_SOURCES, BAND_FLOOR, BAND_CEILING }
  from '../server/services/trade-acceptance.js';
import { VALUATION_SOURCES } from '../server/services/counterparty-pricing.js';

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

test('G3 the accept rate is not charged twice, once as the anchor and again inside receptiveness', () => {
  // counterparty-pricing.js:180-182 blends tx_accept_rate INTO receptiveness,
  // with weight min(1, n/15). So at n>=15 receptiveness IS the accept rate,
  // and centring the band on the anchor while also adding receptiveness on top
  // counts one piece of evidence twice. Only the part of receptiveness the
  // anchor does not already carry may be charged.
  const fullyCarried = r => acceptanceBand({
    counterparty: informed({ accept_rate: 0.25, accept_rate_n: 30, receptiveness: r }),
    edge: passes,
  });
  assert.deepEqual(fullyCarried(1.3).band, fullyCarried(0.7).band,
    'at n=30 the anchor already carries receptiveness entirely; it cannot move the band again');

  const notCarried = r => acceptanceBand({
    counterparty: informed({ accept_rate: null, accept_rate_n: 0, receptiveness: r }),
    edge: passes,
  });
  assert.notDeepEqual(notCarried(1.3).band, notCarried(0.7).band,
    'with no anchor, receptiveness is the only thing carrying that evidence and must count');
});

test('G6 zeroing a source really removes it from the band', () => {
  // No anchor, so receptiveness is genuinely chargeable here (see the test above).
  const live = { accept_rate: null, accept_rate_n: 0, receptiveness: 1.3 };
  const on = acceptanceBand({ counterparty: informed(live), edge: passes });
  const off = acceptanceBand({ counterparty: informed(live), edge: passes,
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

/* ------------------------------------------------- independent verification */

test('the band EDGES never claim certainty or impossibility either, and keep their width', () => {
  // The module declares "a probability is never reported as certainty or
  // impossibility" — but that was enforced on the midpoint alone, while low and
  // high were clamped to [0, 1]. At the extremes the published band therefore
  // read 0.906-1.000 ("he might certainly accept") and 0.000-0.084 ("he might
  // certainly not"), and the clamp also silently ATE band width: 0.094 and 0.084
  // wide where the evidence bought 0.127. Narrower must mean more evidence, never
  // arithmetic running into a wall.
  const hot = acceptanceBand({
    counterparty: informed({ perception_delta: 500, receptiveness: 1.3, accept_rate: 1, accept_rate_n: 99 }),
    edge: passes, profile: profileWith('rarely'),
  });
  const cold = acceptanceBand({
    counterparty: informed({ perception_delta: -500, receptiveness: 0.7, accept_rate: 0, accept_rate_n: 99 }),
    edge: passes, profile: profileWith('yes'),
  });
  const mid = acceptanceBand({ counterparty: informed({ accept_rate: 0.5, accept_rate_n: 99 }), edge: passes });
  const width = b => b.band.high - b.band.low;
  for (const [name, r] of [['hot', hot], ['cold', cold]]) {
    assert.ok(r.band.high <= BAND_CEILING, `${name}: the top of the band is not certainty`);
    assert.ok(r.band.low >= BAND_FLOOR, `${name}: the bottom of the band is not impossibility`);
    assert.ok(r.band.low <= r.band.mid && r.band.mid <= r.band.high, `${name}: still ordered`);
    // Within one step of the 3-decimal rounding the published band uses: the
    // point is that the SAME 99 decided offers buy the same width wherever the
    // band sits, not that two independently rounded ends land on one number.
    assert.ok(Math.abs(width(r) - width(mid)) <= 0.001,
      `${name}: 99 decided offers bought ${width(mid).toFixed(3)} of width in the middle of the `
      + `range and only ${width(r).toFixed(3)} here — the clamp, not the evidence, set the width`);
  }
});

test('an accept rate resting on zero decided offers is not treated as an anchor', () => {
  // Today `manager-signals.js:206` withholds tx_accept_rate below five decisions,
  // so a rate with n=0 cannot come off a real league — but that gate lives in a
  // third module with nothing tying it to this one, and the band's own output
  // already contradicted itself when handed that shape: it centred on 0.9,
  // labelled itself `heuristic_anchored` and reported a band NARROWER (0.35) than
  // the honest unanchored one (0.45), while `anchor.why` said in the same breath
  // that there were "no decided offers ... so there is no accept rate to anchor on".
  const ghost = acceptanceBand({ counterparty: informed({ accept_rate: 0.9, accept_rate_n: 0 }),
    edge: passes });
  const none = acceptanceBand({ counterparty: informed({ accept_rate: null, accept_rate_n: 0 }),
    edge: passes });
  assert.equal(ghost.basis, 'heuristic_unanchored',
    'a rate with no sample behind it is not an observation, whatever it says');
  assert.equal(ghost.band.mid, none.band.mid, 'it cannot pull the centre it has not earned');
  assert.equal(ghost.band.high - ghost.band.low, none.band.high - none.band.low,
    'and it cannot buy a narrower band than knowing nothing');
  assert.ok(ghost.inert.some(i => i.source === 'anchor' && /0 decided offers|no decided offers/i.test(i.reason)),
    'the rate we were handed is reported inert with its reason, not silently dropped');
  assert.equal(ghost.anchor.accept_rate, 0.9, 'what we were handed is still reported');
  assert.equal(ghost.anchor.usable, false);
});

test('receptiveness is only withheld when the band is ACTUALLY centred on the anchor', () => {
  // The mirror of the case above. The skip reason asserts a fact — "his N decided
  // offers are already the anchor this band is centred on" — and that sentence was
  // printed whenever n >= 15, including when there was no usable rate and the band
  // was centred on the declared 0.30 instead. Dropping real evidence with a false
  // reason is worse than dropping it.
  const r = acceptanceBand({
    counterparty: informed({ accept_rate: null, accept_rate_n: 30, receptiveness: 1.3 }),
    edge: passes,
  });
  assert.equal(r.basis, 'heuristic_unanchored');
  assert.ok(r.factors.some(f => f.source === 'receptiveness'),
    'nothing is carrying this evidence but receptiveness, so it must count');
  assert.ok(!r.inert.some(i => i.source === 'receptiveness' && /centred on/.test(i.reason)),
    'the band cannot say it is centred on an anchor it does not have');
});

test('a source that was read but moved the band by nothing is reported, not silently dropped', () => {
  // counterparty-pricing.js\'s first rule: a source that does not fire is reported
  // INERT WITH ITS REASON. Below the 0.001 reporting threshold this module dropped
  // the source from `factors` AND from `inert`, so "we priced it and it read as
  // neutral" was indistinguishable from "nothing priced it at all".
  const flat = acceptanceBand({ counterparty: informed({ perception_delta: 0.1 }), edge: passes });
  const named = flat.factors.map(f => f.source).concat(flat.inert.map(i => i.source));
  assert.ok(named.includes('perception_delta'),
    'a delta that was read and rounded to nothing still has to appear somewhere');
  const why = flat.inert.find(i => i.source === 'perception_delta')?.reason ?? '';
  // Two halves, asserted separately because they are two claims: what was read,
  // and why a real reading still moved nothing. A single pattern matching either
  // one passes on a sentence that carries only half the fact.
  assert.match(why, /\+0\.1% on his own numbers/,
    `the reading itself has to be in the sentence, got ${JSON.stringify(why)}`);
  assert.match(why, /moves the band by less than 0\.001/,
    'and the threshold that held it out, so "read and negligible" cannot read as "not read"');

  const tiny = acceptanceBand({
    counterparty: informed({ receptiveness: 1.02, accept_rate: 0.25, accept_rate_n: 14 }),
    edge: passes,
  });
  assert.ok(tiny.factors.concat(tiny.inert).some(x => x.source === 'receptiveness'),
    'the same holds for a receptiveness nudge discounted away by the anchor');
});

test('ANCHOR_BLEND_N cannot drift away from the blend it mirrors', () => {
  // The band charges receptiveness only for the part the anchor does not already
  // carry, using a constant copied from counterparty-pricing.js. A copied constant
  // with nothing holding the two ends together is how the first double-charge got
  // in. If that file\'s blend divisor changes, this fails here rather than quietly
  // charging the accept rate twice again.
  const src = readFileSync(new URL('../server/services/counterparty-pricing.js', import.meta.url), 'utf8');
  const blend = src.match(/Math\.min\(1,\s*\(s\.samples\.tx_accept_rate \?\? 0\)\s*\/\s*(\d+)\)/);
  assert.ok(blend, 'the accept-rate blend in counterparty-pricing.js still looks the way this band assumes');
  const acceptance = readFileSync(new URL('../server/services/trade-acceptance.js', import.meta.url), 'utf8');
  const mirrored = acceptance.match(/ANCHOR_BLEND_N\s*=\s*(\d+)/);
  assert.ok(mirrored, 'the band still declares the constant it mirrors');
  assert.equal(mirrored[1], blend[1],
    'counterparty-pricing.js blends the accept rate into receptiveness over a different sample '
    + 'than this band discounts it over — one of them is now double-charging');
  // The discount also assumes 1.0 is receptiveness\'s no-information centre.
  const range = src.match(/RECEPTIVENESS_RANGE = \[([\d.]+), ([\d.]+)\]/);
  assert.ok(range && (Number(range[1]) + Number(range[2])) / 2 === 1,
    'receptiveness is still centred on 1.00, which is what this band measures its deviation from');
});

test('G3 no price term from the valuation map is ever a band source in its own right', () => {
  // positional_need and profile_roster_read are already inside perception_delta.
  // The two "byte-identical band" tests above cannot catch a future re-add, because
  // they only prove this function ignores fields it never reads. This does: the
  // moment anyone declares a valuation source as an acceptance source, it fails.
  for (const key of Object.keys(ACCEPTANCE_SOURCES)) {
    assert.ok(!VALUATION_SOURCES[key],
      `${key} is already priced into perception_delta; it cannot also be its own band term`);
  }
});
