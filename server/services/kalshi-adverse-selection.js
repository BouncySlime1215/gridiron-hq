/**
 * Discount a Kalshi leg by what it costs to be on the wrong side of an
 * informed counterparty, before anything treats its quote as a clean price.
 *
 * `prediction-markets.js` already does the honest half of this. `kalshiFee()`
 * prices the exchange's published 0.07·N·p·(1−p) trading fee, and
 * `venueCostComparison()` uses it to show that a two-cent Kalshi spread is a
 * 4.15% all-in cost once the fee lands — worse than lowvig's 3.09%. What
 * neither does is price the OTHER cost of trading on an exchange, which is
 * larger than both and does not appear on any fee schedule: the resting order
 * you lift was left there by someone, and at long-shot prices that someone is
 * systematically better informed than you are.
 *
 * `exchangeVsBook()` is where this bites. It computes
 *
 *     const gap = q.yes_price - bookProb;
 *
 * and reports anything past `minGap` as a divergence worth a look. That
 * subtraction treats `yes_price` as an unbiased estimate of the true
 * probability. At five cents it is not: a five-cent contract is a lottery
 * ticket, its buyers are paying for variance, and the published measurement is
 * that sub-ten-cent Kalshi contracts return about −60% of stake on average.
 * Feeding that price into a gap calculation manufactures "edges" of exactly
 * the size and sign the bias guarantees, on the cheapest contracts, which are
 * also the ones a scanner sorted by percentage gap will surface first.
 *
 * ------------------------------------------------------------------ the curve
 *
 * The object built here is a calibration map C: quoted YES price -> true YES
 * probability, and every other number is derived from it. Doing it as a map
 * rather than as a per-side haircut is what keeps it self-consistent. A naive
 * "haircut whatever you bought" rule is incoherent: buying YES at 0.05 with a
 * 60% haircut implies a true probability of 0.02, while buying NO at 0.95 with
 * no haircut on the favourite implies a true YES probability of 0.05. Same
 * market, two different truths. A single map cannot contradict itself, because
 * the NO side is defined as 1 − C(p) rather than priced separately.
 *
 * The map is written as a distortion g(p) = C(p) − p, required to be
 * antisymmetric about a coin flip, g(1−p) = −g(p), which is precisely the
 * condition that makes YES and NO agree. The family used is
 *
 *     g(p) = −A · p · (1−p) · (1−2p)^c        (c odd)
 *
 * antisymmetric by construction for odd c, zero at p = 0.5, negative below it
 * (long shots are overpriced) and positive above it (favourites are
 * underpriced by the mirror amount). The haircut as a fraction of stake on the
 * long-shot side is then
 *
 *     h(p) = −g(p)/p = A · (1−p) · (1−2p)^c
 *
 * A is not a magic constant: `solveScale()` derives it from the published
 * anchor, so changing the anchor changes the curve reproducibly.
 *
 * ------------------------------------------------------------------ honesty
 *
 * WHAT IS MEASURED: nothing here. One published number is the only empirical
 * input — the ~60% mean loss on sub-ten-cent contracts — and this module fits
 * a one-parameter curve through it. c, the shape exponent, is a CHOICE about
 * how fast the bias decays toward even money, and no data in this repository
 * constrains it. `haircutSensitivity()` exists so the size of that choice is
 * visible: at a 20-cent contract the same anchor supports a haircut anywhere
 * from 6% (c=5) to 34% (c=1). The default c=3 concentrates the damage in the
 * deep long shots the anchor actually describes, and is the conservative
 * reading in the sense that matters — it does not spread an extreme-price
 * finding across prices the finding says nothing about.
 *
 * The right use of this module is as a PRIOR that a cheap Kalshi leg must
 * overcome, not as a measurement of this project's own fills. It would be
 * replaced, not supplemented, by a realised-return curve fitted on settled
 * Kalshi positions once enough of them exist.
 */

export const KALSHI_ADVERSE_SELECTION_VERSION = 'kalshi-adverse-selection/1.0.0';

/**
 * The single empirical anchor. Sub-ten-cent contracts lose, on average, this
 * fraction of stake. Everything else in the module is arithmetic on top.
 */
export const ANCHOR = Object.freeze({
  band: [0, 0.10],
  mean_loss_fraction: 0.60,
  source: 'published finding on Kalshi sub-$0.10 contracts: mean realised return on stake worse than -60%',
  is_measured_here: false
});

const DEFAULT_EXPONENT = 3;
const MAX_HAIRCUT = 0.95;   // a haircut of 1 would mean the contract is worthless
const isNum = Number.isFinite;
const r4 = x => (isNum(x) ? +x.toFixed(4) : null);
const r6 = x => (isNum(x) ? +x.toFixed(6) : null);

const shape = (p, c) => (1 - p) * Math.pow(1 - 2 * p, c);

/**
 * Solve the scale A so the MEAN haircut across the anchor band equals the
 * published mean loss. Midpoint rule; the integrand is smooth and bounded, so
 * a few thousand points is exact to well past the precision of the anchor
 * itself.
 */
export function solveScale({ exponent = DEFAULT_EXPONENT, anchor = ANCHOR, points = 20000 } = {}) {
  const [lo, hi] = anchor.band;
  let sum = 0;
  for (let i = 0; i < points; i++) {
    const p = lo + (hi - lo) * (i + 0.5) / points;
    sum += shape(p, exponent);
  }
  const basis = sum / points;
  if (!(basis > 0)) throw new Error('degenerate anchor band: the shape integrates to zero');
  return anchor.mean_loss_fraction / basis;
}

// Cached per exponent — solveScale is deterministic and the exponent is
// essentially always the default.
const scaleCache = new Map();
function scaleFor(exponent) {
  if (!scaleCache.has(exponent)) scaleCache.set(exponent, solveScale({ exponent }));
  return scaleCache.get(exponent);
}

/**
 * Expected fraction of stake lost to adverse selection when BUYING at `price`.
 *
 * Zero at and above a coin flip: the bias this prices is a long-shot bias, and
 * the favourite side of the same market is the mirror image of it, which the
 * calibration map handles rather than this function.
 */
export function kalshiAdverseSelectionHaircut(price, { exponent = DEFAULT_EXPONENT } = {}) {
  if (!isNum(price) || price <= 0 || price >= 1) return null;
  if (price >= 0.5) return 0;
  const raw = scaleFor(exponent) * shape(price, exponent);
  return Math.min(MAX_HAIRCUT, Math.max(0, raw));
}

/**
 * The calibration map itself: quoted YES price -> adverse-selection-adjusted
 * true YES probability.
 *
 * Self-consistent by construction — `adjustedYesProbability(1 - p)` is exactly
 * `1 - adjustedYesProbability(p)` — so a caller can adjust either side of a
 * market and get the same view of it.
 */
export function adjustedYesProbability(yesPrice, { exponent = DEFAULT_EXPONENT } = {}) {
  if (!isNum(yesPrice) || yesPrice <= 0 || yesPrice >= 1) return null;
  if (yesPrice === 0.5) return 0.5;
  if (yesPrice < 0.5) {
    const h = kalshiAdverseSelectionHaircut(yesPrice, { exponent });
    return yesPrice * (1 - h);
  }
  // Mirror: the favourite is worth what the long shot on the other side is not.
  const noPrice = 1 - yesPrice;
  const h = kalshiAdverseSelectionHaircut(noPrice, { exponent });
  return 1 - noPrice * (1 - h);
}

/**
 * Discount one Kalshi leg to what it should be treated as, all in.
 *
 * Three costs, kept separate because they behave differently and a reader
 * needs to see which one is doing the work:
 *
 *   spread      crossing the book, if a two-sided quote is supplied
 *   fee         the exchange's published fee, peaking at even money
 *   adverse     this module's long-shot haircut, peaking at the extremes
 *
 * Note the shapes are opposites. The fee is worst exactly where the haircut is
 * zero, and the haircut is worst exactly where the fee rounds to nothing. A
 * venue comparison that prices only the fee therefore looks best precisely
 * where this module says it is worst, which is the reason a cheap contract has
 * been able to present itself as the cheapest thing on the board.
 *
 * @param {object} leg
 * @param {number} leg.price      the price PAID per contract (0,1)
 * @param {'yes'|'no'} [leg.side] which outcome is being bought (default 'yes')
 * @param {number} [leg.contracts]
 * @param {number} [leg.bid] [leg.ask] optional two-sided quote for spread cost
 * @param {number} [leg.fairValue] the caller's own probability for the SIDE
 *   being bought; when supplied, the edge is restated net of every cost.
 */
export function applyKalshiHaircut(leg = {}, { exponent = DEFAULT_EXPONENT, feeFn = null } = {}) {
  const price = Number(leg.price);
  if (!isNum(price) || price <= 0 || price >= 1) return { error: 'price must lie strictly inside (0,1)' };
  const contracts = isNum(leg.contracts) && leg.contracts > 0 ? leg.contracts : 1;

  const haircut = kalshiAdverseSelectionHaircut(price, { exponent });
  const adjustedValue = price * (1 - haircut);

  const fee = feeFn ? Number(feeFn(price, contracts)) : defaultKalshiFee(price, contracts);
  const feePerContract = fee / contracts;

  const spreadCost = isNum(leg.bid) && isNum(leg.ask) && leg.ask > leg.bid
    ? (leg.ask - leg.bid) / 2 : null;   // half-spread: the cost of crossing once

  const allInPerContract = price + feePerContract + (spreadCost ?? 0);
  const effectiveCostFraction = (haircut * price + feePerContract + (spreadCost ?? 0)) / price;

  const out = {
    version: KALSHI_ADVERSE_SELECTION_VERSION,
    side: leg.side === 'no' ? 'no' : 'yes',
    price: r6(price), contracts,
    haircut_fraction: r4(haircut),
    adverse_selection_cost_per_contract: r6(haircut * price),
    adverse_selection_cost: r6(haircut * price * contracts),
    fee, fee_per_contract: r6(feePerContract),
    spread_cost_per_contract: r6(spreadCost),
    adjusted_value_per_contract: r6(adjustedValue),
    all_in_cost_per_contract: r6(allInPerContract),
    // Every cost, as a fraction of stake. This is the number comparable to a
    // sportsbook hold and to polymarketCost()'s cost_fraction.
    all_in_cost_fraction: r4(effectiveCostFraction),
    exponent,
    anchor: ANCHOR,
    measured_here: false
  };

  if (isNum(leg.fairValue) && leg.fairValue > 0 && leg.fairValue < 1) {
    const rawEdge = leg.fairValue - price;
    // The haircut is not subtracted twice. A caller whose fair value already
    // came from the exchange's own quote has no independent view, and this
    // says so rather than netting a number against itself.
    const netEdge = leg.fairValue - allInPerContract - haircut * price;
    out.raw_edge_per_contract = r6(rawEdge);
    out.net_edge_per_contract = r6(netEdge);
    out.edge_survives = netEdge > 0;
    out.edge_eaten_fraction = rawEdge > 0 ? r4(Math.min(1, (rawEdge - netEdge) / rawEdge)) : null;
  }
  return out;
}

/** Kalshi's published fee, duplicated here so this module stays free of DB imports. */
export function defaultKalshiFee(price, contracts = 1) {
  if (!isNum(price) || price <= 0 || price >= 1) return 0;
  // Same .toFixed(9) guard as prediction-markets.js kalshiFee: without it a fee
  // landing exactly on a cent is pushed up one by floating-point residue.
  return Math.ceil(+(0.07 * contracts * price * (1 - price) * 100).toFixed(9)) / 100;
}

/**
 * How much of this curve is the anchor and how much is the shape choice.
 *
 * Reported rather than hidden, because the honest summary of this module is
 * "one published number and one unconstrained exponent." A reader who sees a
 * 20-cent contract haircut between 6% and 34% depending on c knows exactly how
 * much weight the default deserves.
 */
export function haircutSensitivity({ prices = [0.02, 0.05, 0.10, 0.15, 0.20, 0.30, 0.40, 0.50],
  exponents = [1, 3, 5] } = {}) {
  return {
    version: KALSHI_ADVERSE_SELECTION_VERSION,
    anchor: ANCHOR,
    default_exponent: DEFAULT_EXPONENT,
    rows: prices.map(p => ({
      price: p,
      ...Object.fromEntries(exponents.map(c => [`c${c}`, r4(kalshiAdverseSelectionHaircut(p, { exponent: c }))]))
    })),
    note: 'Every column honours the same published sub-$0.10 anchor. The spread ACROSS columns at a ' +
      'given price is the part of this curve that is a modelling choice rather than a measurement.'
  };
}

/**
 * Re-score a divergence from `exchangeVsBook()` with the quote no longer
 * treated as clean.
 *
 * The gap it reports is `yes_price − bookProb`. This recomputes it as
 * `adjustedYesProbability(yes_price) − bookProb` and says whether the
 * divergence was the bias or survived it.
 */
export function haircutDivergence(divergence = {}, { exponent = DEFAULT_EXPONENT, minGap = 0.02 } = {}) {
  const p = Number(divergence.exchange_probability);
  const bookProb = Number(divergence.book_probability);
  if (!isNum(p) || !isNum(bookProb)) return { error: 'divergence needs exchange_probability and book_probability' };
  const adjusted = adjustedYesProbability(p, { exponent });
  const rawGap = p - bookProb;
  const adjustedGap = adjusted - bookProb;
  return {
    ...divergence,
    adjusted_exchange_probability: r6(adjusted),
    raw_gap: r4(rawGap),
    adjusted_gap: r4(adjustedGap),
    // The haircut belongs to the LONG-SHOT side of the market, whichever that
    // is; the favourite is its mirror and carries no haircut of its own.
    haircut_fraction: r4(kalshiAdverseSelectionHaircut(Math.min(p, 1 - p), { exponent })),
    survives_haircut: Math.abs(adjustedGap) >= minGap && Math.sign(adjustedGap) === Math.sign(rawGap),
    flipped_sign: Math.sign(adjustedGap) !== Math.sign(rawGap),
    note: Math.abs(adjustedGap) < minGap
      ? 'The divergence does not survive the long-shot haircut: it is the size the bias predicts.'
      : null
  };
}
