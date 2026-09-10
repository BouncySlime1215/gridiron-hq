/**
 * The one place spread probabilities and spread economics are defined.
 *
 * Codex plan section 5.1 states the invariant mathematics; section 10.3 asks
 * for a single module that owns it, consumed by model adapters, policy,
 * shopping and reports, with the explicit instruction to "extract/reuse
 * current economics, do not maintain two formulas." Correction C05 exists
 * because two formulas is precisely what the project had: `nfl-policy.js`
 * computed a correct expected return while `nfl-execution-edge.js` ranked on
 * an older points/price heuristic and derived probabilities from a
 * `0.5 + line_edge` shortcut that could return a NEGATIVE win probability.
 *
 * THE CONVENTION, stated once.
 *
 *   M = home score - away score.
 *
 * For a bet on the home side at signed handicap `s`:
 *
 *   win   M + s > 0
 *   push  M + s = 0
 *   loss  M + s < 0
 *
 * An away bet is converted into this convention explicitly rather than by
 * flipping a sign somewhere downstream and hoping every caller agrees.
 *
 * WHAT A PROBABILITY MUST SATISFY. Every triple this module accepts or
 * produces is validated: each component in [0,1], summing to one within
 * tolerance, with a push mass that is exactly zero at a half-point handicap
 * (integer final scores cannot land on a half). An integer handicap needs a
 * real push estimate or an explicit `unavailable` status -- C15's "an
 * integer-line unknown push estimate cannot silently become zero."
 *
 * Invalid probabilities FAIL. They are not clipped. The plan is explicit:
 * "Invalid probabilities must fail validation; clipping them is not an
 * adequate statistical repair." A clipped -0.125 win probability still means
 * the model that produced it is broken, and clipping only hides which bets
 * were priced by it.
 */

/**
 * Half-point handicaps cannot push, because NFL scores are integers.
 *
 * The test is that the fractional part is exactly one half -- NOT that
 * `handicap * 2` is a whole number, which is equally true of -3 and would
 * classify every integer line as unable to push. Handicaps arrive as halves
 * or whole numbers only, so anything else is a parsing failure and is treated
 * as not-a-half-point, which is the conservative answer: it demands a push
 * estimate rather than assuming none is needed.
 */
export function isHalfPoint(handicap) {
  if (!Number.isFinite(handicap)) return false;
  return Math.abs(Math.abs(handicap % 1) - 0.5) < 1e-9;
}

const TOLERANCE = 1e-9;

/**
 * Profit per one unit risked, at an American price.
 *
 *   -110 -> 100/110 = 0.909…      +120 -> 1.2
 *
 * Prices strictly between -100 and +100 do not exist; `Math.abs(price) < 100`
 * is a parsing failure, not a very short price, and returning null for it is
 * how a malformed feed stops rather than silently becoming a huge edge.
 */
export function profitMultiple(americanPrice) {
  if (americanPrice == null) return null;
  const price = Number(americanPrice);
  if (!Number.isFinite(price) || Math.abs(price) < 100) return null;
  return price > 0 ? price / 100 : 100 / Math.abs(price);
}

/**
 * The break-even win probability at a price, for a DECIDED bet (no push).
 * At -110 this is 0.5238…, not 0.5 -- the number a "better than a coin flip"
 * intuition gets wrong by four and a half points.
 */
export function breakEvenProbability(americanPrice) {
  const b = profitMultiple(americanPrice);
  return b == null ? null : 1 / (1 + b);
}

/**
 * The price's own implied probability, vig included.
 *
 * Deliberately NOT de-vigged here. Section 5.3: vig may be removed only from
 * compatible PAIRED quotes, and a single price is not a pair. Callers that
 * want a fair probability must supply both sides and say so.
 */
export function impliedProbability(americanPrice) {
  const b = profitMultiple(americanPrice);
  return b == null ? null : 1 / (1 + b);
}

/**
 * Convert an American price to decimal return, so prices can be AVERAGED.
 *
 * Codex correction C14: American odds are not a linear scale and are
 * discontinuous across the -100/+100 boundary. -105 and +105 are adjacent in
 * value and 210 apart numerically, so a mean or median of raw American prices
 * is meaningless -- and `nfl-execution-clv.js` was taking exactly that median
 * across books to define a closing price. Convert first, aggregate second.
 */
export function decimalReturn(americanPrice) {
  const b = profitMultiple(americanPrice);
  return b == null ? null : 1 + b;
}

/** Decimal return back to an American price, for display only. */
export function americanFromDecimal(decimal) {
  if (!Number.isFinite(decimal) || decimal <= 1) return null;
  const b = decimal - 1;
  return b >= 1 ? Math.round(b * 100) : -Math.round(100 / b);
}

/**
 * Validate a win/push/loss triple for a specific handicap.
 *
 * Returns `{ ok: true, probabilities }` or `{ ok: false, reason }`. Callers
 * are expected to branch on `ok` rather than to receive a repaired triple:
 * this module never returns a "fixed" version of an invalid input.
 */
export function validateSpreadProbabilities({ win, push, loss, handicap } = {}) {
  for (const [name, value] of Object.entries({ win, push, loss })) {
    if (!Number.isFinite(value)) return { ok: false, reason: `${name}_probability_not_finite` };
    if (value < -TOLERANCE || value > 1 + TOLERANCE) {
      return { ok: false, reason: `${name}_probability_outside_unit_interval`, value };
    }
  }
  const total = win + push + loss;
  if (Math.abs(total - 1) > 1e-6) return { ok: false, reason: 'probabilities_do_not_sum_to_one', total };
  if (isHalfPoint(handicap) && push > 1e-9) {
    return { ok: false, reason: 'half_point_handicap_cannot_push', push };
  }
  return { ok: true, probabilities: { win, push, loss } };
}

/**
 * Build a valid triple from a conditional classifier.
 *
 * `q = P(win | not push)` is what this project's cover calibrator actually
 * produces -- it discards pushes when building its binary labels -- so the
 * push mass has to be supplied separately and applied, never assumed to be
 * zero. On an integer handicap with no push estimate this returns an explicit
 * `unavailable` status rather than silently pricing the bet as if pushes were
 * impossible, which is C15's exact complaint about the policy gate.
 */
export function fromConditional({ conditionalWin, pushProbability = null, handicap } = {}) {
  if (!Number.isFinite(conditionalWin) || conditionalWin < 0 || conditionalWin > 1) {
    return { ok: false, reason: 'conditional_win_probability_invalid' };
  }
  let push = pushProbability;
  if (isHalfPoint(handicap)) {
    // Not an assumption: integer scores cannot land on a half-point.
    if (push != null && push > 1e-9) return { ok: false, reason: 'half_point_handicap_cannot_push' };
    push = 0;
  } else if (push == null) {
    return { ok: false, reason: 'integer_handicap_requires_a_push_estimate',
      detail: 'an unknown push mass on an integer handicap is unavailable, not zero' };
  }
  if (!Number.isFinite(push) || push < 0 || push > 1) return { ok: false, reason: 'push_probability_invalid' };
  const decided = 1 - push;
  return validateSpreadProbabilities({
    win: decided * conditionalWin, push, loss: decided * (1 - conditionalWin), handicap });
}

/**
 * Expected net return per one unit risked, at the ACTUAL offered price.
 *
 *   EV = p_win * b - p_loss          (a push returns the stake: zero profit)
 *
 * Note what is NOT here: no haircut, no clipping, no default push of zero.
 * The probability haircut is a conservative POLICY parameter and belongs to
 * the policy that chooses it, not to the arithmetic.
 */
export function expectedNetReturn({ win, loss, americanPrice } = {}) {
  const b = profitMultiple(americanPrice);
  if (b == null || !Number.isFinite(win) || !Number.isFinite(loss)) return null;
  return win * b - loss;
}

/**
 * The two sides of one game must agree.
 *
 * A home bet at `s` and an away bet at `-s` partition the same outcome space:
 * the home side's win is the away side's loss, and they share a push. A pair
 * that does not reconcile is two different opinions wearing one contract's
 * name.
 */
export function reconcileOppositeSides(home, away) {
  const problems = [];
  if (Math.abs(home.win - away.loss) > 1e-6) problems.push('home_win_does_not_match_away_loss');
  if (Math.abs(home.loss - away.win) > 1e-6) problems.push('home_loss_does_not_match_away_win');
  if (Math.abs(home.push - away.push) > 1e-6) problems.push('push_mass_differs_between_sides');
  return problems.length ? { ok: false, problems } : { ok: true };
}

/**
 * Win/push/loss from a discrete distribution over integer home-minus-away
 * margins, which is the preferred form: one distribution answers every
 * handicap coherently, and monotonicity in the handicap falls out of it
 * instead of having to be asserted.
 *
 * `margins` is a Map or plain object of margin -> probability mass. Mass that
 * does not sum to one is refused rather than renormalized: silently
 * truncating a tail is how a distribution acquires confidence it never had.
 */
export function fromMarginDistribution(margins, handicap, { side = 'home' } = {}) {
  if (!Number.isFinite(handicap)) return { ok: false, reason: 'handicap_not_finite' };
  const entries = margins instanceof Map ? [...margins.entries()]
    : Object.entries(margins ?? {}).map(([m, p]) => [Number(m), p]);
  if (!entries.length) return { ok: false, reason: 'empty_margin_distribution' };

  let total = 0;
  for (const [margin, mass] of entries) {
    if (!Number.isFinite(margin) || !Number.isInteger(margin)) {
      return { ok: false, reason: 'non_integer_margin', margin };
    }
    if (!Number.isFinite(mass) || mass < 0) return { ok: false, reason: 'negative_or_invalid_mass', margin };
    total += mass;
  }
  if (Math.abs(total - 1) > 1e-6) return { ok: false, reason: 'margin_mass_does_not_sum_to_one', total };

  // An away bet is converted into the home convention explicitly.
  //
  // The distribution is over M = home - away. The away side's own margin is
  // therefore -M, and its bet at its own signed handicap `s` wins when
  // -M + s > 0. Only the MARGIN flips; the handicap is already expressed from
  // the backed side's point of view, so negating it too would evaluate the
  // wrong contract entirely -- an away +3 would be scored as an away -3.
  let win = 0, push = 0, loss = 0;
  for (const [margin, mass] of entries) {
    const value = (side === 'away' ? -margin : margin) + handicap;
    if (value > 0) win += mass; else if (value === 0) push += mass; else loss += mass;
  }
  return validateSpreadProbabilities({ win, push, loss, handicap });
}
