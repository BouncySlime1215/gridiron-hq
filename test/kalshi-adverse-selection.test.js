/**
 * The haircut curve is one published anchor and one shape choice. These tests
 * pin both: that the anchor is honoured by construction (not by a hard-coded
 * constant that could drift away from it), that the calibration map cannot
 * contradict itself across the two sides of a market, and that the shape
 * choice's influence is reported rather than hidden.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ANCHOR, KALSHI_ADVERSE_SELECTION_VERSION, solveScale, kalshiAdverseSelectionHaircut,
  adjustedYesProbability, applyKalshiHaircut, defaultKalshiFee, haircutSensitivity, haircutDivergence
} from '../server/services/kalshi-adverse-selection.js';

const near = (a, b, tol, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} expected ${b}, got ${a}`);

test('the scale is SOLVED from the anchor, so the band mean reproduces it', () => {
  for (const exponent of [1, 3, 5]) {
    const A = solveScale({ exponent });
    // Recompute the band mean independently of solveScale's own quadrature.
    let sum = 0;
    const N = 50000;
    for (let i = 0; i < N; i++) {
      const p = ANCHOR.band[0] + (ANCHOR.band[1] - ANCHOR.band[0]) * (i + 0.5) / N;
      sum += A * (1 - p) * Math.pow(1 - 2 * p, exponent);
    }
    near(sum / N, ANCHOR.mean_loss_fraction, 1e-4,
      `mean haircut over the sub-$0.10 band at c=${exponent}`);
  }
});

test('the haircut is monotone decreasing in price and zero at and above a coin flip', () => {
  let last = Infinity;
  for (const p of [0.01, 0.02, 0.05, 0.08, 0.10, 0.15, 0.20, 0.30, 0.40, 0.49]) {
    const h = kalshiAdverseSelectionHaircut(p);
    assert.ok(h <= last + 1e-12, `haircut rose from ${last} to ${h} at price ${p}`);
    assert.ok(h >= 0 && h < 1, `haircut out of range at ${p}: ${h}`);
    last = h;
  }
  assert.equal(kalshiAdverseSelectionHaircut(0.5), 0);
  assert.equal(kalshiAdverseSelectionHaircut(0.8), 0);
  assert.equal(kalshiAdverseSelectionHaircut(0.99), 0);
});

test('a five-cent contract carries roughly the published sixty-percent loss', () => {
  near(kalshiAdverseSelectionHaircut(0.05), 0.589, 0.01, 'h(0.05) at the default exponent');
});

test('the calibration map cannot contradict itself across the two sides', () => {
  // The failure this prevents: haircut the long shot 60% and leave the
  // favourite alone, and the same market implies P(yes)=0.02 from one side and
  // P(yes)=0.05 from the other.
  for (const p of [0.02, 0.05, 0.12, 0.25, 0.37, 0.5, 0.63, 0.75, 0.88, 0.95]) {
    near(adjustedYesProbability(p) + adjustedYesProbability(1 - p), 1, 1e-12,
      `self-consistency at p=${p}`);
  }
});

test('long shots are marked down, favourites marked up by exactly the mirror amount', () => {
  const p = 0.05;
  const adjLong = adjustedYesProbability(p);
  const adjFav = adjustedYesProbability(1 - p);
  assert.ok(adjLong < p, 'a five-cent YES is worth less than five cents');
  assert.ok(adjFav > 1 - p, 'the ninety-five-cent side is worth more than it costs');
  near((p - adjLong), (adjFav - (1 - p)), 1e-12, 'the two markdowns are the same number');
});

test('the map is monotone in price, so it never reorders two markets', () => {
  let last = -1;
  for (let p = 0.01; p < 1; p += 0.01) {
    const q = adjustedYesProbability(p);
    assert.ok(q > last, `calibration map went backwards at ${p.toFixed(2)}`);
    last = q;
  }
});

test('the fee and the haircut peak in opposite places, which is the whole point', () => {
  const cheap = applyKalshiHaircut({ price: 0.05, contracts: 100 });
  const even = applyKalshiHaircut({ price: 0.50, contracts: 100 });
  assert.ok(cheap.fee_per_contract < even.fee_per_contract, 'the fee is largest at even money');
  assert.ok(cheap.adverse_selection_cost_per_contract > even.adverse_selection_cost_per_contract,
    'the haircut is largest at the extremes');
  assert.equal(even.haircut_fraction, 0);
  // And the all-in cost as a fraction of stake is far worse on the cheap one,
  // which is the ranking a fee-only comparison gets backwards.
  assert.ok(cheap.all_in_cost_fraction > even.all_in_cost_fraction * 3,
    `cheap ${cheap.all_in_cost_fraction} vs even ${even.all_in_cost_fraction}`);
});

test('the published fee formula is reproduced exactly, including the round-up', () => {
  // 0.07 * 1 * 0.5 * 0.5 = 0.0175 -> rounds up to 0.02
  assert.equal(defaultKalshiFee(0.5, 1), 0.02);
  // 0.07 * 100 * 0.5 * 0.5 = 1.75, already on the cent
  assert.equal(defaultKalshiFee(0.5, 100), 1.75);
  // 0.07 * 100 * 0.05 * 0.95 = 0.3325 -> 0.34
  assert.equal(defaultKalshiFee(0.05, 100), 0.34);
  assert.equal(defaultKalshiFee(0, 100), 0);
  assert.equal(defaultKalshiFee(1, 100), 0);
  // Regression: these are the cases the un-guarded Math.ceil over-charged by a
  // cent, because the product lands one ULP above an exact cent.
  assert.equal(defaultKalshiFee(0.5, 200), 3.50);
  assert.equal(defaultKalshiFee(0.2, 100), 1.12);
});

test('an edge on a cheap contract is eaten by the haircut before the fee is even read', () => {
  // A two-cent "edge" on a five-cent contract: fair 0.07 vs price 0.05.
  const leg = applyKalshiHaircut({ price: 0.05, contracts: 100, fairValue: 0.07 });
  near(leg.raw_edge_per_contract, 0.02, 1e-9, 'raw edge');
  assert.ok(leg.net_edge_per_contract < 0, 'the same edge is negative once adverse selection is priced');
  assert.equal(leg.edge_survives, false);
  assert.ok(leg.edge_eaten_fraction >= 1);
});

test('a large edge at even money survives, so the haircut is not a blanket veto', () => {
  const leg = applyKalshiHaircut({ price: 0.50, contracts: 100, fairValue: 0.58 });
  assert.equal(leg.haircut_fraction, 0);
  assert.ok(leg.edge_survives, 'an eight-point edge at even money beats a 1.75% fee');
  near(leg.net_edge_per_contract, 0.08 - leg.fee_per_contract, 1e-9);
});

test('a half-spread is charged when a two-sided quote is supplied', () => {
  const wide = applyKalshiHaircut({ price: 0.50, contracts: 1, bid: 0.48, ask: 0.52 });
  assert.equal(wide.spread_cost_per_contract, 0.02);
  const noQuote = applyKalshiHaircut({ price: 0.50, contracts: 1 });
  assert.equal(noQuote.spread_cost_per_contract, null);
  assert.ok(wide.all_in_cost_fraction > noQuote.all_in_cost_fraction);
});

test('the sensitivity table shows how much of the curve is a choice', () => {
  const s = haircutSensitivity();
  const twenty = s.rows.find(r => r.price === 0.20);
  assert.ok(twenty.c1 > twenty.c3 && twenty.c3 > twenty.c5,
    'a flatter exponent spreads the anchor across prices it says nothing about');
  assert.ok(twenty.c1 - twenty.c5 > 0.2,
    'and the spread at twenty cents is large enough that the default matters');
  const five = s.rows.find(r => r.price === 0.05);
  for (const c of ['c1', 'c3', 'c5']) {
    near(five[c], 0.60, 0.05, `every exponent honours the anchor near its middle (${c})`);
  }
  assert.equal(s.anchor.is_measured_here, false, 'the module never claims to have measured this');
});

test('a divergence that is the size of the bias does not survive it', () => {
  // exchangeVsBook would report a 3-point gap on a 6-cent contract as a
  // divergence. The bias predicts a gap of about that size and sign.
  const d = haircutDivergence({ matchup: 'X@Y', exchange_probability: 0.06, book_probability: 0.03 },
    { minGap: 0.02 });
  assert.equal(d.raw_gap, 0.03);
  assert.ok(d.adjusted_gap < d.raw_gap, 'adjusting shrinks the gap');
  assert.equal(d.survives_haircut, false);
  assert.match(d.note, /the size the bias predicts/);
});

test('a real divergence at a tradeable price survives the haircut untouched', () => {
  const d = haircutDivergence({ exchange_probability: 0.55, book_probability: 0.48 }, { minGap: 0.02 });
  // The curve is continuous, so the haircut near a coin flip is tiny rather
  // than identically zero -- small enough that the gap is unchanged to four
  // decimals, which is the resolution anything downstream reads it at.
  assert.ok(d.haircut_fraction < 0.001, `haircut at 0.55 should be negligible, got ${d.haircut_fraction}`);
  // 0.55 is the FAVOURITE side, so the map nudges it up rather than down -- and
  // by so little that the divergence is unchanged for any practical purpose.
  assert.ok(d.adjusted_gap >= d.raw_gap, 'a favourite is marked up, never down');
  near(d.adjusted_gap, d.raw_gap, 0.0005, 'the gap near even money is untouched in practice');
  assert.equal(d.survives_haircut, true);
});

test('invalid prices return null or an error rather than a number', () => {
  assert.equal(kalshiAdverseSelectionHaircut(0), null);
  assert.equal(kalshiAdverseSelectionHaircut(1), null);
  assert.equal(kalshiAdverseSelectionHaircut(NaN), null);
  assert.equal(adjustedYesProbability(1.4), null);
  assert.ok(applyKalshiHaircut({ price: 0 }).error);
  assert.equal(applyKalshiHaircut({ price: 0.3 }).version, KALSHI_ADVERSE_SELECTION_VERSION);
});
