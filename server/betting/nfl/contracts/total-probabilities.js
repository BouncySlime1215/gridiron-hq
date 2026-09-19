/**
 * The one place TOTALS probabilities and totals economics are defined.
 *
 * Codex finding C12: "the declared forecast contract and current packet-board
 * path are spread oriented; totals appear in research but are not
 * automatically supported by this contract," with the explicit instruction for
 * WP13/WP15-17 to "version market-discriminated spread/total schemas ... do
 * not pass totals through by renaming one field."
 *
 * This module is that separate path. It exists because a total is NOT a spread
 * with different words, and the differences are exactly the kind that survive a
 * rename and then price a bet wrongly:
 *
 *   1. THE LINE IS NOT SIDE-RELATIVE. A spread handicap is expressed from the
 *      backed side's own point of view -- home -3 and away +3 are two different
 *      numbers for one game, and `spread-probabilities.js` converts an away bet
 *      into the home convention by negating the MARGIN. A total line is the
 *      SAME number for both sides: Over 47.5 and Under 47.5. The side chooses
 *      the DIRECTION OF COMPARISON, not the number. Negating a total line the
 *      way an away spread negates a margin would evaluate a contract nobody
 *      offered.
 *   2. THE OUTCOME VARIABLE IS A SUM, NOT A DIFFERENCE. T = home + away, which
 *      is bounded below by zero and skewed right; M = home - away is roughly
 *      symmetric about a small positive number. Nothing here assumes a shape,
 *      but a caller reusing a margin distribution for a total would.
 *   3. THE KEY NUMBERS ARE DIFFERENT. Margins pile up on 3 and 7; totals pile
 *      up on different integers entirely. This module makes no use of either --
 *      it is deliberately distribution-free -- but that is the reason a totals
 *      push mass must come from totals history and never from a spread's.
 *
 * THE CONVENTION, stated once.
 *
 *   T = home score + away score.
 *
 * For a bet on OVER at line `L`:        For a bet on UNDER at line `L`:
 *   win   T > L                          win   T < L
 *   push  T = L                          push  T = L
 *   loss  T < L                          loss  T > L
 *
 * WHAT A PROBABILITY MUST SATISFY. Same discipline as the spread contract, and
 * for the same reasons: every triple is validated, components in [0,1] summing
 * to one, push mass exactly zero at a half-point line (integer scores sum to
 * integers, so a 47.5 total cannot land on the number), and an integer line
 * with no push estimate returns an explicit `unavailable` rather than silently
 * pricing the bet as if pushes were impossible. Invalid probabilities FAIL;
 * they are never clipped.
 *
 * WHAT IS DELIBERATELY REUSED. The price arithmetic -- profit multiple,
 * break-even, implied probability, decimal conversion, expected net return --
 * is market-agnostic: -110 pays the same on a total as on a spread. It is
 * imported from `spread-probabilities.js` rather than re-derived here, because
 * a second copy of the economics is the exact failure C05 already recorded
 * once ("extract/reuse current economics, do not maintain two formulas"). Only
 * the probability and push SEMANTICS are separate, because only those are
 * genuinely different. (The price helpers arguably want a market-neutral home
 * of their own; moving them would touch every existing importer, so they are
 * imported from where they already live rather than relocated as a side effect
 * of adding totals.)
 */
import {
  isHalfPoint, profitMultiple, breakEvenProbability, impliedProbability,
  decimalReturn, americanFromDecimal, expectedNetReturn
} from './spread-probabilities.js';

export {
  isHalfPoint, profitMultiple, breakEvenProbability, impliedProbability,
  decimalReturn, americanFromDecimal, expectedNetReturn
};

const TOLERANCE = 1e-9;
const SIDES = new Set(['over', 'under']);

/**
 * Validate an over/push/under triple for a specific total line.
 *
 * Returns `{ ok: true, probabilities }` or `{ ok: false, reason }`. Never
 * returns a repaired triple: a total whose masses do not sum to one describes
 * a model that is broken, and renormalising it only hides which bets it priced.
 */
export function validateTotalProbabilities({ over, push, under, line } = {}) {
  for (const [name, value] of Object.entries({ over, push, under })) {
    if (!Number.isFinite(value)) return { ok: false, reason: `${name}_probability_not_finite` };
    if (value < -TOLERANCE || value > 1 + TOLERANCE) {
      return { ok: false, reason: `${name}_probability_outside_unit_interval`, value };
    }
  }
  const total = over + push + under;
  if (Math.abs(total - 1) > 1e-6) return { ok: false, reason: 'probabilities_do_not_sum_to_one', total };
  if (isHalfPoint(line) && push > 1e-9) {
    return { ok: false, reason: 'half_point_total_cannot_push', push };
  }
  return { ok: true, probabilities: { over, push, under } };
}

/**
 * Build a valid triple from a conditional classifier.
 *
 * `q = P(over | not push)` is the shape a cover-style calibrator produces --
 * it drops pushes when building binary labels -- so the push mass arrives
 * separately and is applied here, never assumed. On an integer line with no
 * push estimate this returns an explicit unavailable status: C15's "an
 * integer-line unknown push estimate cannot silently become zero," which is
 * every bit as true of a total of 44 as of a spread of -3.
 */
export function fromConditional({ conditionalOver, pushProbability = null, line } = {}) {
  if (!Number.isFinite(conditionalOver) || conditionalOver < 0 || conditionalOver > 1) {
    return { ok: false, reason: 'conditional_over_probability_invalid' };
  }
  let push = pushProbability;
  if (isHalfPoint(line)) {
    // Not an assumption: two integer scores sum to an integer, which cannot
    // equal a half-point line.
    if (push != null && push > 1e-9) return { ok: false, reason: 'half_point_total_cannot_push' };
    push = 0;
  } else if (push == null) {
    return { ok: false, reason: 'integer_total_requires_a_push_estimate',
      detail: 'an unknown push mass on an integer total is unavailable, not zero' };
  }
  if (!Number.isFinite(push) || push < 0 || push > 1) return { ok: false, reason: 'push_probability_invalid' };
  const decided = 1 - push;
  return validateTotalProbabilities({
    over: decided * conditionalOver, push, under: decided * (1 - conditionalOver), line });
}

/**
 * Over/push/under from a discrete distribution over integer game totals.
 *
 * The preferred form, for the same reason the spread contract prefers a margin
 * distribution: one distribution answers every line coherently, and
 * monotonicity in the line falls out instead of having to be asserted.
 *
 * `totals` is a Map or plain object of total -> probability mass. Mass that
 * does not sum to one is refused rather than renormalized. A negative total is
 * refused outright -- unlike a margin, which is signed and may legitimately be
 * negative, a game total is a sum of two non-negative scores, so a negative
 * entry is a sign that a margin distribution was passed to the totals path.
 * That is precisely the "renamed spread" mistake this module exists to stop,
 * and it is worth catching loudly rather than pricing.
 */
export function fromTotalDistribution(totals, line, { side = 'over' } = {}) {
  if (!Number.isFinite(line)) return { ok: false, reason: 'line_not_finite' };
  if (!SIDES.has(side)) return { ok: false, reason: 'unknown_side', side };
  const entries = totals instanceof Map ? [...totals.entries()]
    : Object.entries(totals ?? {}).map(([t, p]) => [Number(t), p]);
  if (!entries.length) return { ok: false, reason: 'empty_total_distribution' };

  let mass = 0;
  for (const [total, p] of entries) {
    if (!Number.isFinite(total) || !Number.isInteger(total)) {
      return { ok: false, reason: 'non_integer_total', total };
    }
    if (total < 0) {
      return { ok: false, reason: 'negative_total',
        detail: 'a game total is a sum of two non-negative scores; a negative entry means a ' +
          'margin distribution was supplied to the totals path', total };
    }
    if (!Number.isFinite(p) || p < 0) return { ok: false, reason: 'negative_or_invalid_mass', total };
    mass += p;
  }
  if (Math.abs(mass - 1) > 1e-6) return { ok: false, reason: 'total_mass_does_not_sum_to_one', mass };

  // The side chooses the direction of the comparison. The LINE is never
  // negated or otherwise transformed: both sides are quoted the same number,
  // which is the structural difference from a spread handicap.
  let over = 0, push = 0, under = 0;
  for (const [total, p] of entries) {
    if (total > line) over += p; else if (total === line) push += p; else under += p;
  }
  const triple = validateTotalProbabilities({ over, push, under, line });
  if (!triple.ok) return triple;
  return { ...triple, side };
}

/**
 * Map an over/push/under triple onto the win/push/loss frame a price is
 * evaluated in, for one side.
 *
 * Kept explicit rather than folded into the EV call so that "which side is
 * this price for" is a decision a caller makes once, visibly, instead of a
 * sign convention buried inside an arithmetic helper.
 */
export function sideProbabilities({ over, push, under } = {}, side = 'over') {
  if (!SIDES.has(side)) return { ok: false, reason: 'unknown_side', side };
  return side === 'over'
    ? { ok: true, win: over, push, loss: under }
    : { ok: true, win: under, push, loss: over };
}

/**
 * The two sides of one total must agree -- checked in each side's OWN
 * win/push/loss frame, which is the only level at which the check means
 * anything for a total.
 *
 * This is where the difference from the spread contract is sharpest, and it is
 * worth stating because the obvious port of `spread-probabilities.js`'s
 * version is vacuous. There, the two sides genuinely produce DIFFERENT triples:
 * home -3 and away +3 are two contracts, so checking home.win === away.loss is
 * a real constraint. Here, the over/push/under partition is side-NEUTRAL --
 * both sides are quoted 47.5 and read the same three masses -- so comparing two
 * over/push/under triples would be asserting that a thing equals itself and
 * would pass on any input at all.
 *
 * The real check is one level down: map each side into the win/push/loss frame
 * its own price is evaluated in (`sideProbabilities`), then confirm the Over's
 * win is the Under's loss and that they share a push. A pair that fails this
 * was built from two different distributions, or two different lines, wearing
 * one contract's name.
 */
export function reconcileOppositeSides(overSide, underSide) {
  const problems = [];
  if (Math.abs(overSide.win - underSide.loss) > 1e-6) problems.push('over_win_does_not_match_under_loss');
  if (Math.abs(overSide.loss - underSide.win) > 1e-6) problems.push('over_loss_does_not_match_under_win');
  if (Math.abs(overSide.push - underSide.push) > 1e-6) problems.push('push_mass_differs_between_sides');
  return problems.length ? { ok: false, problems } : { ok: true };
}
