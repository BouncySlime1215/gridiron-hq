/**
 * WP13 / C12: totals get their own complete probability path, not a renamed
 * spread.
 *
 * The spread contract is already tested in `spread-probabilities.test.js`, and
 * this file deliberately does NOT re-test the arithmetic both share (profit
 * multiple, break-even, EV) -- that math is imported from the spread module
 * precisely so there is one implementation of it, and testing it twice would
 * imply there are two.
 *
 * What is tested here is the part that is genuinely different, which is also
 * the part a "rename one field" port gets wrong: the line is the same number
 * for both sides rather than side-relative, the push condition is T = L, the
 * outcome variable is a non-negative sum rather than a signed difference, and
 * reconciliation happens at the SAME line for both sides.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  validateTotalProbabilities, fromConditional, fromTotalDistribution,
  sideProbabilities, reconcileOppositeSides, expectedNetReturn, breakEvenProbability
} = await import('../server/betting/nfl/contracts/total-probabilities.js');

/* ----------------------------------------------------------------- validation */

test('a valid triple passes and is returned unchanged', () => {
  const r = validateTotalProbabilities({ over: 0.5, push: 0.04, under: 0.46, line: 44 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.probabilities, { over: 0.5, push: 0.04, under: 0.46 });
});

test('a triple that does not sum to one FAILS rather than being renormalised', () => {
  const r = validateTotalProbabilities({ over: 0.5, push: 0.1, under: 0.5, line: 44 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'probabilities_do_not_sum_to_one');
});

test('a negative probability fails and is never clipped to zero', () => {
  const r = validateTotalProbabilities({ over: 1, push: 0, under: -0.2, line: 44.5 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'under_probability_outside_unit_interval');
  // And a mass above one fails on its own terms too, rather than being capped.
  assert.equal(validateTotalProbabilities({ over: 1.2, push: 0, under: -0.2, line: 44.5 }).reason,
    'over_probability_outside_unit_interval');
});

test('a half-point total cannot push: two integer scores sum to an integer', () => {
  const r = validateTotalProbabilities({ over: 0.5, push: 0.02, under: 0.48, line: 47.5 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'half_point_total_cannot_push');
  // The same masses on an INTEGER line are fine.
  assert.equal(validateTotalProbabilities({ over: 0.5, push: 0.02, under: 0.48, line: 47 }).ok, true);
});

/* ---------------------------------------------------------------- conditional */

test('an integer total with no push estimate is unavailable, never silently zero', () => {
  const r = fromConditional({ conditionalOver: 0.55, line: 44 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'integer_total_requires_a_push_estimate');
});

test('a half-point total needs no push estimate and gets exactly zero push', () => {
  const r = fromConditional({ conditionalOver: 0.6, line: 44.5 });
  assert.equal(r.ok, true);
  assert.equal(r.probabilities.push, 0);
  assert.ok(Math.abs(r.probabilities.over - 0.6) < 1e-12);
  assert.ok(Math.abs(r.probabilities.under - 0.4) < 1e-12);
});

test('a supplied push mass is applied to the decided masses, not added alongside them', () => {
  const r = fromConditional({ conditionalOver: 0.5, pushProbability: 0.06, line: 44 });
  assert.equal(r.ok, true);
  const { over, push, under } = r.probabilities;
  assert.equal(push, 0.06);
  assert.ok(Math.abs(over - 0.47) < 1e-12, `over was ${over}`);
  assert.ok(Math.abs(under - 0.47) < 1e-12, `under was ${under}`);
  assert.ok(Math.abs(over + push + under - 1) < 1e-12);
});

/* --------------------------------------------------------------- distribution */

/** A small, exactly-specified distribution over integer totals. */
const TOTALS = { 40: 0.1, 44: 0.2, 47: 0.3, 51: 0.25, 55: 0.15 };

test('the line is the SAME number for both sides — the structural difference from a spread', () => {
  const over = fromTotalDistribution(TOTALS, 47, { side: 'over' });
  const under = fromTotalDistribution(TOTALS, 47, { side: 'under' });
  assert.equal(over.ok, true);
  assert.equal(under.ok, true);
  // Both sides see the identical partition; only the reading of it differs.
  assert.deepEqual(over.probabilities, under.probabilities);
  // 51 and 55 are over; 47 pushes; 40 and 44 are under.
  assert.ok(Math.abs(over.probabilities.over - 0.4) < 1e-12);
  assert.ok(Math.abs(over.probabilities.push - 0.3) < 1e-12);
  assert.ok(Math.abs(over.probabilities.under - 0.3) < 1e-12);
});

test('a half-point line splits the same distribution with no push at all', () => {
  const r = fromTotalDistribution(TOTALS, 47.5, { side: 'over' });
  assert.equal(r.ok, true);
  assert.equal(r.probabilities.push, 0);
  assert.ok(Math.abs(r.probabilities.over - 0.4) < 1e-12);
  assert.ok(Math.abs(r.probabilities.under - 0.6) < 1e-12);
});

test('over probability is monotone in the line: a higher total is never easier to go over', () => {
  let previous = 1.1;
  for (const line of [39.5, 43.5, 46.5, 50.5, 54.5, 60.5]) {
    const r = fromTotalDistribution(TOTALS, line, { side: 'over' });
    assert.equal(r.ok, true);
    assert.ok(r.probabilities.over <= previous + 1e-12,
      `over rose from ${previous} to ${r.probabilities.over} when the line rose to ${line}`);
    previous = r.probabilities.over;
  }
});

test('mass that does not sum to one is refused, not quietly renormalised', () => {
  const r = fromTotalDistribution({ 44: 0.5, 47: 0.3 }, 45.5);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'total_mass_does_not_sum_to_one');
});

test('THE RENAMED-SPREAD TRAP: a margin distribution handed to the totals path is refused', () => {
  // Margins are signed and routinely negative; a game total cannot be. This is
  // the concrete mistake C12 warns about, so it fails loudly instead of
  // pricing a contract from the wrong outcome variable.
  const margins = { '-7': 0.25, '-3': 0.25, 3: 0.25, 7: 0.25 };
  const r = fromTotalDistribution(margins, 0.5, { side: 'over' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'negative_total');
  assert.match(r.detail, /margin distribution/);
});

test('a non-integer total in the distribution is refused', () => {
  const r = fromTotalDistribution({ 44.5: 0.5, 47: 0.5 }, 45.5);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'non_integer_total');
});

test('an unknown side is refused rather than defaulting to over', () => {
  assert.equal(fromTotalDistribution(TOTALS, 47, { side: 'home' }).reason, 'unknown_side');
});

/* ------------------------------------------------------------------ economics */

test('sideProbabilities maps the triple into the win/push/loss frame per side', () => {
  const triple = { over: 0.4, push: 0.3, under: 0.3 };
  assert.deepEqual(sideProbabilities(triple, 'over'), { ok: true, win: 0.4, push: 0.3, loss: 0.3 });
  assert.deepEqual(sideProbabilities(triple, 'under'), { ok: true, win: 0.3, push: 0.3, loss: 0.4 });
});

test('EV uses the shared price arithmetic and treats a push as a returned stake', () => {
  const triple = { over: 0.5, push: 0.1, under: 0.4 };
  const { win, loss } = sideProbabilities(triple, 'over');
  const ev = expectedNetReturn({ win, loss, americanPrice: -110 });
  // 0.5 * (100/110) - 0.4
  assert.ok(Math.abs(ev - (0.5 * (100 / 110) - 0.4)) < 1e-12);
  // The push mass contributes nothing either way, which is what "stake
  // returned" means -- it is neither profit nor loss.
  const noPush = expectedNetReturn({ win: 0.5, loss: 0.4, americanPrice: -110 });
  assert.equal(ev, noPush);
});

test('a push-heavy integer total is NOT the same bet as the half-point beside it', () => {
  // The economic point of carrying push mass at all: at -110 the break-even on
  // a decided bet is 0.5238, but push mass removes stake from risk entirely,
  // so the same conditional opinion prices differently on 44 than on 44.5.
  const integer = fromConditional({ conditionalOver: 0.54, pushProbability: 0.08, line: 44 });
  const half = fromConditional({ conditionalOver: 0.54, line: 44.5 });
  assert.equal(integer.ok, true);
  assert.equal(half.ok, true);
  const evInteger = expectedNetReturn({
    ...sideProbabilities(integer.probabilities, 'over'), americanPrice: -110 });
  const evHalf = expectedNetReturn({
    ...sideProbabilities(half.probabilities, 'over'), americanPrice: -110 });
  assert.notEqual(evInteger, evHalf);
  // Both are positive-EV at this conditional edge, but the integer line's push
  // mass shrinks the magnitude toward zero rather than changing its sign.
  assert.ok(evInteger > 0 && evHalf > 0);
  assert.ok(Math.abs(evInteger) < Math.abs(evHalf));
  assert.ok(0.54 > breakEvenProbability(-110));
});

/* -------------------------------------------------------------- reconciliation */

test('the two sides reconcile in their own win/push/loss frames, at the SAME line', () => {
  // The partition itself is side-neutral, so reconciliation has to happen one
  // level down -- see the function's own note on why comparing two
  // over/push/under triples would pass on anything.
  const triple = fromTotalDistribution(TOTALS, 47, { side: 'over' }).probabilities;
  const overSide = sideProbabilities(triple, 'over');
  const underSide = sideProbabilities(triple, 'under');
  assert.deepEqual(reconcileOppositeSides(overSide, underSide), { ok: true });
  // The Over's win really is the Under's loss, not a copy of the same number.
  assert.equal(overSide.win, underSide.loss);
  assert.notEqual(overSide.win, overSide.loss);
});

test('two sides built at different lines do not reconcile, and say which part disagrees', () => {
  const at47 = fromTotalDistribution(TOTALS, 47, { side: 'over' }).probabilities;
  const at51 = fromTotalDistribution(TOTALS, 51, { side: 'under' }).probabilities;
  const r = reconcileOppositeSides(sideProbabilities(at47, 'over'), sideProbabilities(at51, 'under'));
  assert.equal(r.ok, false);
  assert.ok(r.problems.includes('over_win_does_not_match_under_loss'));
});
