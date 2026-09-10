/**
 * The shared spread probability and price contract (Codex plan section 5.1,
 * module required by section 10.3).
 *
 * Section 5.2 asks for "bounded property tests with an independent arithmetic
 * oracle for normalization, spread signs, 2.5/3/3.5 and 6.5/7/7.5 thresholds,
 * extreme lines, missing tails, +100/-100 boundaries and opposite sides."
 * That is what this file is. The oracle is deliberately a second, naive
 * implementation written from the plan's prose rather than from the module's
 * code, so that a shared misunderstanding cannot pass both.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

const {
  profitMultiple, breakEvenProbability, impliedProbability, decimalReturn, americanFromDecimal,
  isHalfPoint, validateSpreadProbabilities, fromConditional, expectedNetReturn,
  reconcileOppositeSides, fromMarginDistribution
} = await import('../server/betting/nfl/contracts/spread-probabilities.js');

/** Real American prices only: nothing strictly between -100 and +100 exists. */
const americanPrice = () => fc.oneof(
  fc.integer({ min: 100, max: 2000 }),
  fc.integer({ min: -2000, max: -100 }));

/** Half-point and integer handicaps across the range that actually occurs. */
const handicap = () => fc.integer({ min: -60, max: 60 }).map(h => h / 2);

/* --------------------------------------------------------------- prices */

test('the profit multiple matches the plan\'s worked examples exactly', () => {
  assert.equal(profitMultiple(-110), 100 / 110);
  assert.equal(profitMultiple(120), 1.2);
  assert.equal(profitMultiple(100), 1);
  assert.equal(profitMultiple(-100), 1);
});

test('break-even at -110 is 52.38%, not 50%', () => {
  assert.ok(Math.abs(breakEvenProbability(-110) - 0.5238095) < 1e-6,
    'the four-and-a-half point gap a coin-flip intuition misses');
  assert.equal(breakEvenProbability(100), 0.5);
});

test('a price strictly inside the +/-100 boundary is a parsing failure, not a short price', () => {
  for (const price of [0, 1, 99, -99, -1, 50, -50]) {
    assert.equal(profitMultiple(price), null, `${price} is not a real American price`);
    assert.equal(impliedProbability(price), null);
  }
  for (const price of [null, undefined, Number.NaN, Infinity, 'x']) {
    assert.equal(profitMultiple(price), null);
  }
});

test('decimal conversion round-trips every real price', () => {
  fc.assert(fc.property(americanPrice(), price => {
    const back = americanFromDecimal(decimalReturn(price));
    // +100 and -100 are the same contract expressed two ways; the round trip
    // is allowed to settle on either spelling of even money.
    if (Math.abs(price) === 100) return Math.abs(back) === 100;
    return back === price;
  }), { numRuns: 500 });
});

test('implied probability is monotone: a shorter price implies a higher probability', () => {
  fc.assert(fc.property(americanPrice(), americanPrice(), (a, b) => {
    const ba = profitMultiple(a), bb = profitMultiple(b);
    if (ba === bb) return true;
    // Less profit per unit risked must mean a higher implied probability.
    return (ba < bb) === (impliedProbability(a) > impliedProbability(b));
  }), { numRuns: 500 });
});

/* -------------------------------------------------------- probabilities */

test('a half-point handicap can never push; an integer one may', () => {
  for (const h of [-3.5, -2.5, 0.5, 7.5, -0.5]) assert.equal(isHalfPoint(h), true);
  for (const h of [-3, 0, 7, -14]) assert.equal(isHalfPoint(h), false);

  assert.equal(validateSpreadProbabilities({ win: 0.5, push: 0.02, loss: 0.48, handicap: -3.5 }).ok, false);
  assert.equal(validateSpreadProbabilities({ win: 0.5, push: 0.02, loss: 0.48, handicap: -3 }).ok, true);
});

test('an invalid probability FAILS — it is never clipped into range', () => {
  // The exact defect C05 reports: coverProbabilities(3, -10.5) returned
  // win -0.125, loss 1.125, push 0. Clipping that to [0,1] would hide which
  // bets a broken model priced.
  const impossible = validateSpreadProbabilities({ win: -0.125, push: 0, loss: 1.125, handicap: -10.5 });
  assert.equal(impossible.ok, false);
  assert.match(impossible.reason, /outside_unit_interval/);

  assert.equal(validateSpreadProbabilities({ win: 0.6, push: 0, loss: 0.6, handicap: -3.5 }).ok, false,
    'mass that does not sum to one is refused');
});

test('a conditional classifier needs a push estimate on an integer handicap', () => {
  const half = fromConditional({ conditionalWin: 0.55, handicap: -3.5 });
  assert.equal(half.ok, true);
  assert.equal(half.probabilities.push, 0);
  assert.ok(Math.abs(half.probabilities.win - 0.55) < 1e-12);

  const integerWithout = fromConditional({ conditionalWin: 0.55, handicap: -3 });
  assert.equal(integerWithout.ok, false,
    'an unknown push mass on an integer line is unavailable, not zero');
  assert.match(integerWithout.reason, /requires_a_push_estimate/);

  const integerWith = fromConditional({ conditionalWin: 0.55, pushProbability: 0.09, handicap: -3 });
  assert.equal(integerWith.ok, true);
  // Independent oracle: decided mass 0.91, split 55/45.
  assert.ok(Math.abs(integerWith.probabilities.win - 0.91 * 0.55) < 1e-12);
  assert.ok(Math.abs(integerWith.probabilities.loss - 0.91 * 0.45) < 1e-12);
});

test('expected net return matches an independent oracle at every real price', () => {
  fc.assert(fc.property(
    fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 0.2, noNaN: true }), americanPrice(),
    (q, push, price) => {
      const built = fromConditional({ conditionalWin: q, pushProbability: push, handicap: -3 });
      if (!built.ok) return true;
      const { win, loss } = built.probabilities;
      const ev = expectedNetReturn({ win, loss, americanPrice: price });
      // Oracle, written straight from the plan: EV = p_win * b - p_loss.
      const b = price > 0 ? price / 100 : 100 / Math.abs(price);
      return Math.abs(ev - (win * b - loss)) < 1e-9;
    }), { numRuns: 500 });
});

/* ------------------------------------------------ the margin distribution */

/** A normalized distribution over integer margins in [-40, 40]. */
const marginDistribution = () => fc.array(
  fc.tuple(fc.integer({ min: -40, max: 40 }), fc.double({ min: 0.01, max: 1, noNaN: true })),
  { minLength: 3, maxLength: 25 }
).map(pairs => {
  const merged = new Map();
  for (const [m, w] of pairs) merged.set(m, (merged.get(m) ?? 0) + w);
  const total = [...merged.values()].reduce((s, w) => s + w, 0);
  return new Map([...merged.entries()].map(([m, w]) => [m, w / total]));
});

test('a margin distribution produces a valid triple at every handicap', () => {
  fc.assert(fc.property(marginDistribution(), handicap(), (margins, h) => {
    const result = fromMarginDistribution(margins, h);
    if (!result.ok) return false;
    const { win, push, loss } = result.probabilities;
    return win >= 0 && push >= 0 && loss >= 0 && Math.abs(win + push + loss - 1) < 1e-9;
  }), { numRuns: 400 });
});

test('giving the same side MORE points can never reduce its win probability', () => {
  fc.assert(fc.property(marginDistribution(), handicap(), (margins, h) => {
    const less = fromMarginDistribution(margins, h);
    const more = fromMarginDistribution(margins, h + 1);
    if (!less.ok || !more.ok) return true;
    return more.probabilities.win >= less.probabilities.win - 1e-12;
  }), { numRuns: 400 });
});

test('the key numbers behave: 2.5 / 3 / 3.5 and 6.5 / 7 / 7.5', () => {
  // A realistic lump of mass on the field goal and touchdown margins.
  const margins = new Map([[-7, 0.06], [-3, 0.09], [-1, 0.05], [0, 0.02], [1, 0.05],
    [3, 0.30], [4, 0.08], [6, 0.05], [7, 0.22], [10, 0.08]]);
  const at = h => fromMarginDistribution(margins, h).probabilities;

  // Only the integer lines can push, and they push by exactly the mass sitting
  // on that margin -- the independent oracle here is the input itself.
  assert.equal(at(-2.5).push, 0);
  assert.equal(at(-3.5).push, 0);
  assert.ok(Math.abs(at(-3).push - 0.30) < 1e-12, 'a -3 line pushes on exactly the 3-point mass');
  assert.ok(Math.abs(at(-7).push - 0.22) < 1e-12, 'a -7 line pushes on exactly the 7-point mass');

  // Crossing a key number is where a half point is worth the most.
  const across3 = at(-2.5).win - at(-3.5).win;
  const across5 = at(-4.5).win - at(-5.5).win;
  assert.ok(across3 > across5, 'the 3 is worth more than a half point around 5');
});

test('opposite sides of one game reconcile', () => {
  fc.assert(fc.property(marginDistribution(), handicap(), (margins, h) => {
    // A home bet at s and an away bet at -s are the two sides of one contract:
    // the away side's handicap is the mirror of the home side's.
    const home = fromMarginDistribution(margins, h, { side: 'home' });
    const away = fromMarginDistribution(margins, -h, { side: 'away' });
    if (!home.ok || !away.ok) return true;
    return reconcileOppositeSides(home.probabilities, away.probabilities).ok;
  }), { numRuns: 400 });
});

test('extreme handicaps saturate rather than escaping the unit interval', () => {
  const margins = new Map([[-7, 0.2], [0, 0.2], [3, 0.3], [10, 0.3]]);
  const huge = fromMarginDistribution(margins, 60);
  const tiny = fromMarginDistribution(margins, -60);
  assert.equal(huge.probabilities.win, 1);
  assert.equal(huge.probabilities.loss, 0);
  assert.equal(tiny.probabilities.win, 0);
  assert.equal(tiny.probabilities.loss, 1);
});

test('a truncated tail is refused, never quietly renormalized', () => {
  // Mass summing to 0.8: the missing fifth of the distribution is exactly the
  // tail that decides extreme handicaps. Renormalizing would invent
  // confidence the model never had.
  const truncated = new Map([[0, 0.4], [3, 0.4]]);
  const result = fromMarginDistribution(truncated, -3.5);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'margin_mass_does_not_sum_to_one');

  assert.equal(fromMarginDistribution(new Map([[0.5, 1]]), -3.5).reason, 'non_integer_margin');
  assert.equal(fromMarginDistribution(new Map(), -3.5).reason, 'empty_margin_distribution');
  assert.equal(fromMarginDistribution(new Map([[0, -0.5], [3, 1.5]]), -3.5).reason,
    'negative_or_invalid_mass');
});
