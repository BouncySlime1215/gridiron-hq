/**
 * P&L attribution — three numbers that must never become one, plus a fourth-way
 * decomposition of what actually happened.
 *
 * The plan is explicit and this module exists because of exactly one sentence
 * in it: "Reject 'line shopping is proven profit'. Better odds relative to a
 * median/worst book are price improvement, not absolute positive expectation."
 * `nfl-execution.js`'s `rankBooks()` measures the first thing extremely well —
 * it is the only measured positive in this project — and it has never once
 * been the same number as "is this bet good," because it compares one book to
 * other books, never to an independent estimate of the truth. Conflating them
 * is precisely the mistake the plan's independent-conclusions section rejects.
 *
 * So three numbers, reported side by side and never blended:
 *
 *   PRICE IMPROVEMENT   this book vs the field, in win-rate points — reuses
 *                        `rankBooks()` unchanged, because that math is already
 *                        correct and already validated.
 *   FAIR-PRICE EV        this price vs an independent no-vig fair probability
 *                        (Shin's method, `nfl-devig.js` — already the
 *                        established pattern via `nfl-prop-clv.js`), which
 *                        says nothing about which book was used.
 *   REALIZED RESULT       what actually happened: won, lost, pushed, voided.
 *
 * `attributePnl` goes one step further and splits the realized result itself
 * into four contributors — price selection, timing, prediction quality, and
 * luck — via an algebraic identity that is exact by construction (luck is
 * defined as whatever the first three terms do not explain). See
 * test/nfl-execution-attribution.test.js for the reconciliation test.
 */
import { payoutPerUnit, impliedProbability, rankBooks } from './nfl-execution.js';
import { shinNoVig } from './nfl-devig.js';

const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/* --------------------------------------------------------- fair price */

/**
 * An independent fair probability for one side, via Shin's no-vig method when
 * the opposite side's price is known, falling back to the raw implied
 * probability (vig included, clearly labeled) when it is not.
 */
export function fairPriceProbability(ownPrice, oppositePrice = null) {
  if (!Number.isFinite(ownPrice)) return { probability: null, method: 'invalid_price' };
  if (Number.isFinite(oppositePrice)) {
    return { probability: r4(shinNoVig(ownPrice, oppositePrice)), method: 'shin_no_vig' };
  }
  return { probability: r4(impliedProbability(ownPrice)), method: 'implied_only_no_opposite_quote_available' };
}

/** Expected value per unit staked, at an independent fair probability. */
export function fairPriceEv(price, fairProbability, stakeUnits = 1) {
  if (!Number.isFinite(price) || !Number.isFinite(fairProbability)) return null;
  return r4(stakeUnits * (fairProbability * payoutPerUnit(price) - (1 - fairProbability)));
}

/* --------------------------------------------------------- suspect prices */

/**
 * Fair EV this far beyond anything measured elsewhere in this project should
 * be challenged as a probable bad join or stale feed FIRST, per the plan.
 * 0.15 is deliberately generous — this project's one measured positive
 * (book-hold routing, nfl-execution.js) is worth roughly 1-2% of unit EV, so
 * 15% is an order of magnitude beyond it, not a tight false-positive trap.
 */
export const EXTREME_EV_THRESHOLD = 0.15;

export function challengeExtremePrice({ price, fairProbability }) {
  const ev = fairPriceEv(price, fairProbability, 1);
  const suspect = ev != null && ev > EXTREME_EV_THRESHOLD;
  return {
    fair_price_ev_per_unit: ev, threshold: EXTREME_EV_THRESHOLD, suspect,
    reason: suspect
      ? `fair-price EV of ${ev} per unit is far beyond any edge this project has ever measured — the ` +
        'book-hold routing module is the only proven positive here and it is worth roughly 1-2% of unit ' +
        'EV. Treat this as a probable bad join or stale feed before treating it as free money.'
      : null
  };
}

/* --------------------------------------------------------- price improvement */

/**
 * How the ACCEPTED book compares to the field, at the same instant. Thin
 * wrapper over `rankBooks()` that pulls out one specific book's numbers
 * rather than only the winner — the book actually used at acceptance time may
 * not be the one that ranked best (a refresh can have moved the field).
 */
export function priceImprovement(quotesAtInstant, { market = 'spreads', takingPoints = true, book }) {
  const ranked = rankBooks(quotesAtInstant, { market, takingPoints });
  if (!ranked) return null;
  const mine = ranked.all.find(q => q.book === book);
  if (!mine) return null;
  return {
    book, price: mine.price, line: mine.line,
    edge_vs_median_winrate_pts: mine.edge_vs_median,
    edge_vs_worst_winrate_pts: r4((mine.edge_vs_median ?? 0) - (ranked.worst.edge_vs_median ?? 0)),
    median_price: ranked.median_price, median_line: ranked.median_line,
    worst_book: ranked.worst.book, worst_price: ranked.worst.price,
    books_compared: ranked.books_compared
  };
}

/* --------------------------------------------------------- the three-way report */

/**
 * The three numbers, reported together and explicitly never combined.
 * `opportunity` is a lifecycle ledger row from `nfl-execution-lifecycle.js`
 * (via `getOpportunity`), already carrying its ACCEPTED and, if graded,
 * SETTLED events.
 */
export function threeWayAttribution({ opportunity, quotesAtAccepted = null, fairProbability = null,
  market = 'spreads', takingPoints = true }) {
  const accepted = opportunity?.events?.find(e => e.state === 'accepted');
  if (!accepted) return { error: 'opportunity was never accepted; there is nothing to attribute yet' };
  const settled = opportunity.events.find(e => e.state === 'settled');

  return {
    opportunity_id: opportunity.id,
    price_improvement: quotesAtAccepted
      ? priceImprovement(quotesAtAccepted, { market, takingPoints, book: accepted.book })
      : { unavailable: 'no simultaneous multi-book quote set supplied for the acceptance instant' },
    fair_price_ev: Number.isFinite(fairProbability)
      ? { fair_probability: r4(fairProbability), stake_units: accepted.stake_units,
        expected_value_units: fairPriceEv(accepted.price, fairProbability, accepted.stake_units) }
      : { unavailable: 'no independent fair probability supplied' },
    realized_result: settled
      ? { result: settled.result, realized_pnl_units: settled.realized_pnl_units }
      : { unavailable: 'not yet settled' },
    note: 'Three different questions, three different numbers, never blended: price improvement asks ' +
      'whether this book beat the field; fair-price EV asks whether the bet is good at an independent ' +
      'fair price regardless of book; realized result is what actually happened, luck included.'
  };
}

/* --------------------------------------------------------- four-factor decomposition */

/**
 * Split a realized result into four contributors via an exact algebraic
 * identity: baseline + price_selection + timing + prediction_quality + luck
 * == the realized per-unit result, always, by construction — `luck` is
 * defined as the residual the first three terms leave unexplained. This is
 * the standard shape of a performance-attribution decomposition (compare
 * Brinson-style attribution in portfolio management): a tautological identity
 * is the point, not a weakness, because it is what makes the split auditable
 * rather than a second unverifiable model.
 *
 *   baseline_fair_ev_at_median   what a no-opinion bettor gets at the field's
 *                                own median book, at the independent fair
 *                                probability — the do-nothing reference point.
 *   price_selection              value of picking the best book AT DECISION
 *                                TIME over the median (nfl-execution.js's
 *                                proven edge, expressed in EV rather than
 *                                win-rate points here).
 *   timing                       value or cost of the gap between DECISION and
 *                                ACCEPTED — this is where delay, refreshes and
 *                                slippage show up.
 *   prediction_quality           value of believing something different from
 *                                the fair/market price. Exactly zero whenever
 *                                no model probability is supplied — matching
 *                                nfl-execution.js's own stance of having no
 *                                opinion about which side is right.
 *   luck                         the residual: what the outcome did beyond
 *                                what the first three terms expected.
 */
export function attributePnl({ modelProbability = null, fairProbability, decisionPrice, medianPrice = null,
  acceptedPrice, stakeUnits, result }) {
  if (!Number.isFinite(fairProbability) || fairProbability <= 0 || fairProbability >= 1) {
    throw new Error('fairProbability must be a probability strictly between 0 and 1');
  }
  if (!Number.isFinite(decisionPrice) || !Number.isFinite(acceptedPrice)) {
    throw new Error('decisionPrice and acceptedPrice are required American prices');
  }
  if (!Number.isFinite(stakeUnits) || stakeUnits <= 0) throw new Error('stakeUnits must be positive');
  if (!['won', 'lost', 'push', 'void'].includes(result)) throw new Error('result must be won/lost/push/void');

  const evAt = price => fairProbability * payoutPerUnit(price) - (1 - fairProbability);
  const modelEvAt = price => (modelProbability == null ? null : modelProbability * payoutPerUnit(price) - (1 - modelProbability));

  const referencePrice = Number.isFinite(medianPrice) ? medianPrice : decisionPrice;
  const baseline = evAt(referencePrice);
  const priceSelection = evAt(decisionPrice) - baseline;
  const timing = evAt(acceptedPrice) - evAt(decisionPrice);
  const predictionQuality = modelProbability == null ? 0 : modelEvAt(acceptedPrice) - evAt(acceptedPrice);
  const expected = baseline + priceSelection + timing + predictionQuality;

  const realizedPerUnit = result === 'won' ? payoutPerUnit(acceptedPrice) : result === 'lost' ? -1 : 0;
  const luck = realizedPerUnit - expected;
  const reconciled = baseline + priceSelection + timing + predictionQuality + luck;

  const scale = v => r4(v * stakeUnits);
  return {
    stake_units: stakeUnits,
    per_unit: { baseline_fair_ev_at_median: r4(baseline), price_selection: r4(priceSelection),
      timing: r4(timing), prediction_quality: r4(predictionQuality), luck: r4(luck),
      realized: r4(realizedPerUnit) },
    total_units: { baseline_fair_ev_at_median: scale(baseline), price_selection: scale(priceSelection),
      timing: scale(timing), prediction_quality: scale(predictionQuality), luck: scale(luck),
      realized: scale(realizedPerUnit) },
    identity_holds: Math.abs(reconciled - realizedPerUnit) < 1e-9,
    note: 'baseline + price_selection + timing + prediction_quality + luck sums to exactly the realized ' +
      'per-unit result by construction — luck is deliberately the residual, not a separately estimated ' +
      'quantity, which is what makes this decomposition auditable rather than a second model to trust.'
  };
}
