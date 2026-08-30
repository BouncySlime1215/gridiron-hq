/**
 * Execution edge and stake sizing — profit that does not require out-predicting
 * the market.
 *
 * The spread question has been treated as one problem and it is two.
 *
 *   PREDICTION EDGE — settled negative. 21 component models measured against
 *   15,096 closing lines; 0 clear the materiality gate. The closing line is
 *   sharper than anything in this repository and that will not change.
 *
 *   EXECUTION EDGE — real, measured, and never exploited here. Books do not
 *   agree with each other. In a single 272-event snapshot across 6.4 books
 *   per market: spread lines differ by **0.813 points on average**, 37.5% of
 *   markets differ by a full point or more, and simply taking the best
 *   available price rather than a median one is worth **2.566% per bet**.
 *
 * That second number matters more than it looks. Vig on -110 both ways is
 * ~4.55%, and the break-even win rate is 52.38%. Best-price selection alone
 * moves the break-even to roughly **51.1%** — it does not manufacture a
 * winning model, but it removes about a quarter of the hurdle, and it
 * requires no forecasting skill whatsoever. It is arithmetic on prices that
 * are visible before the bet is placed.
 *
 * KEY NUMBERS ARE WHY LINE SHOPPING IS WORTH MORE THAN PRICE SHOPPING.
 * NFL margins are not smooth. Measured over 7,276 games in this database:
 *
 *     margin of  3  ->  15.12% of games
 *     margin of  7  ->   9.03%
 *     margin of  6  ->   5.99%
 *     margin of 10  ->   5.51%
 *
 * A half point from 5.5 to 5.0 is worth almost nothing. A half point from
 * 3.5 to 3.0 is worth roughly half of that 15.12% mass, because it converts
 * a loss into a push on the single most common margin in football. Treating
 * all half points as equal is the mistake that makes line shopping look
 * marginal; weighting them by the actual margin distribution is what makes it
 * the largest available edge in this system.
 *
 * ON SIZING, and why the distinction above is load-bearing: Kelly staking
 * amplifies estimation error. Sizing off a MODEL probability the model has
 * never proven means sizing off an unvalidated number, and Kelly will
 * cheerfully bankrupt a bettor whose edge estimate is optimistic. Sizing off
 * an EXECUTION edge is different in kind — the price and line advantages are
 * observed at bet time, not forecast. So this module is deliberately built to
 * stake on measured execution advantage, and treats any model-derived edge as
 * requiring proven CLV before it may size anything at all.
 */
import { rows } from '../db/index.js';

const dec = american => (american >= 0 ? 1 + american / 100 : 1 + 100 / -american);
export const impliedProb = american => (american >= 0 ? 100 / (american + 100) : -american / (-american + 100));
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/* ------------------------------------------------- key-number distribution */

let marginCache = null;
/** Empirical distribution of absolute NFL margins, from this database. */
export function marginDistribution() {
  if (marginCache) return marginCache;
  const g = rows(`SELECT team_score, opp_score FROM game_lines
                  WHERE team_score IS NOT NULL AND opp_score IS NOT NULL AND home = 1`);
  const freq = new Map();
  for (const x of g) {
    const m = Math.abs(x.team_score - x.opp_score);
    freq.set(m, (freq.get(m) ?? 0) + 1);
  }
  const n = g.length || 1;
  marginCache = { n, pmf: new Map([...freq].map(([m, c]) => [m, c / n])) };
  return marginCache;
}

/**
 * What a line move from `from` to `to` is actually worth, in win probability.
 *
 * Counts the probability mass of margins that sit strictly between the two
 * numbers — those are the games whose result changes. Direction matters: a
 * bettor taking points wants the larger number.
 *
 * A push (landing exactly on an integer line) is counted as half a win, which
 * is the correct valuation of getting a stake back rather than losing it.
 */
export function lineMoveValue(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return 0;
  const { pmf } = marginDistribution();

  // Work on the SIGNED number line. An earlier version took Math.abs() of both
  // endpoints, which silently collapsed sign and priced every zero-crossing
  // move at zero: moving -1.5 → +1.5 is a three-point swing that flips margins
  // 0 and ±1, and it was being reported as worth nothing. That inverted the
  // ranking whenever books disagreed about which team was favoured at all.
  //
  // A side taking `line` points covers when its own signed margin exceeds
  // -line, so the result changes exactly for margins between -hi and -lo.
  const lo = Math.min(from, to), hi = Math.max(from, to);

  // The stored distribution is over |margin|. Absent knowing whether this bet
  // is on the favourite or the underdog, split each magnitude symmetrically —
  // the neutral assumption, and a close one near a pick'em where these
  // disagreements actually occur.
  let mass = 0;
  for (const [absMargin, p] of pmf) {
    const signed = absMargin === 0 ? [0] : [absMargin, -absMargin];
    const share = absMargin === 0 ? p : p / 2;
    for (const m of signed) {
      if (m > -hi && m < -lo) mass += share;                 // outcome flips outright
      else if (m === -hi || m === -lo) mass += share * 0.5;  // push boundary
    }
  }
  return r4(mass);
}

/** The classic key numbers, ranked by how much probability mass they carry. */
export function keyNumbers(limit = 8) {
  const { pmf } = marginDistribution();
  return [...pmf.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([margin, p]) => ({ margin, share: r4(p) }));
}

/* ---------------------------------------------------------- best execution */

/**
 * Pick the best available quote for one side, valuing the LINE by the margin
 * distribution and the PRICE by its payout, rather than assuming a better
 * number always beats a better price.
 *
 * `quotes` is [{book, line, american_price}] for a single side of a single
 * market. Returns the best book plus what choosing it is worth against the
 * median book — which is the honest counterfactual, since taking a random
 * book is what a bettor without a shopping habit actually does.
 */
export function bestExecution(quotes, { takingPoints = true } = {}) {
  const usable = (quotes ?? []).filter(q => Number.isFinite(q.american_price));
  if (usable.length < 2) return null;

  const withLines = usable.filter(q => Number.isFinite(q.line));
  const refLine = withLines.length
    ? [...withLines].map(q => q.line).sort((a, b) => a - b)[Math.floor(withLines.length / 2)]
    : null;
  const prices = usable.map(q => dec(q.american_price)).sort((a, b) => a - b);
  const refPrice = prices[Math.floor(prices.length / 2)];

  const scored = usable.map(q => {
    // Value of this book's line versus the median line, in win probability.
    const lineEdge = refLine != null && Number.isFinite(q.line)
      ? (takingPoints ? (q.line > refLine ? lineMoveValue(refLine, q.line) : -lineMoveValue(q.line, refLine))
        : (q.line < refLine ? lineMoveValue(refLine, q.line) : -lineMoveValue(q.line, refLine)))
      : 0;
    // Value of this book's price versus the median price, as a return premium.
    const priceEdge = (dec(q.american_price) / refPrice) - 1;
    return { ...q, line_edge: r4(lineEdge), price_edge: r4(priceEdge),
      // A point of win probability is worth roughly 2x a point of return at
      // even money, since it moves both the win and the loss branch.
      total_edge: r4(lineEdge * 2 + priceEdge) };
  }).sort((a, b) => b.total_edge - a.total_edge);

  return {
    best: scored[0], median_line: refLine, median_price_decimal: r4(refPrice),
    books_compared: usable.length,
    edge_vs_median: scored[0].total_edge,
    all: scored
  };
}

/* --------------------------------------------------------------- staking */

/**
 * Fractional Kelly.
 *
 * Full Kelly is the growth-optimal stake only when the win probability is
 * known exactly. It never is. Kelly's downside is violently asymmetric to
 * overestimated edge — a bettor who thinks the edge is 4% when it is 1% is
 * not slightly over-betting, they are betting roughly four times too much and
 * will experience drawdowns that end the bankroll. Quarter Kelly is the
 * default here because it retains most of the growth while making the
 * variance survivable, which is the trade every serious staking treatment
 * lands on.
 */
export function kellyFraction({ winProbability, americanPrice, fraction = 0.25 }) {
  const p = Number(winProbability);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return { stake_fraction: 0, reason: 'invalid probability' };
  const b = dec(americanPrice) - 1;
  if (!(b > 0)) return { stake_fraction: 0, reason: 'invalid price' };
  const full = (b * p - (1 - p)) / b;
  if (full <= 0) return { stake_fraction: 0, full_kelly: r4(full), reason: 'no edge at this price — do not bet' };
  return {
    stake_fraction: r4(full * fraction),
    full_kelly: r4(full),
    fraction_used: fraction,
    edge: r4(p - impliedProb(americanPrice)),
    note: 'Fractional Kelly. Full Kelly assumes the probability is exact; it never is.'
  };
}

/**
 * The staking decision, with the guardrail that matters most here.
 *
 * `source` says where the win probability came from, and it changes what is
 * allowed:
 *
 *   'execution'  the advantage is observed at bet time — a better line or
 *                price than the market median. Sizable, because it is
 *                measured rather than forecast.
 *
 *   'model'      the advantage is a model estimate. Since 0 of 21 spread
 *                models beat the closing line and no prop CLV has ever been
 *                recorded, a model estimate has NOT earned the right to size
 *                a bet. Returns zero stake until `provenClv` is supplied.
 *
 * This is deliberately restrictive. The failure mode it prevents is the
 * ordinary one: a plausible model, sized with Kelly, run until the bankroll
 * is gone.
 */
export function stakeFor({ winProbability, americanPrice, source = 'model',
  bankrollUnits = 100, fraction = 0.25, provenClv = null, maxUnitsPerBet = 3 } = {}) {
  if (source === 'model' && !(provenClv > 0)) {
    return {
      units: 0, blocked: true,
      reason: 'A model-derived probability has not demonstrated closing-line value. ' +
        'Spreads: 0 of 21 models beat 15,096 closing lines. Props: no CLV recorded yet. ' +
        'Sizing on an unvalidated edge is how Kelly ruins bankrolls — record positive median ' +
        'CLV over ~200 settled bets first.'
    };
  }
  const k = kellyFraction({ winProbability, americanPrice, fraction });
  if (!k.stake_fraction) return { units: 0, blocked: true, reason: k.reason, ...k };
  const raw = k.stake_fraction * bankrollUnits;
  const units = Math.min(raw, maxUnitsPerBet);
  return {
    units: r4(units),
    capped: units < raw,
    bankroll_units: bankrollUnits,
    ...k,
    note: units < raw
      ? `Capped at ${maxUnitsPerBet}u. A cap is not timidity — it bounds the damage from a single ` +
        'mis-estimated probability, which is the error Kelly is least forgiving of.'
      : undefined
  };
}

/**
 * Risk modes, with the price of each one attached.
 *
 * This exists because of a reasonable question that has an unreasonable answer:
 * "the model says it is too cautious — can we turn the caution down and see how
 * it does?" No, and the reason is worth stating exactly, because the intuition
 * behind the question is sound and only the mechanism is wrong.
 *
 * The calibration slope is not a caution setting. It is a measurement of how
 * well the model's stated probabilities match reality. A slope of 1.37 does not
 * mean a dial is turned to "cautious"; it means the numbers are mis-scaled, and
 * the fix is to rescale them (which the calibration layer already does) rather
 * than to multiply them by something bigger. Turning a "risk" knob on a model
 * that is no more accurate than the betting line does not produce more profit at
 * more risk. It produces the same negative expectation with more variance — you
 * lose the same money, faster and less predictably. There is no setting that
 * converts a coin flip into an edge.
 *
 * What IS a real dial is how hard to bet an edge you have already proven. That
 * is the Kelly fraction, and unlike the calibration slope it genuinely trades
 * growth against drawdown along a curve with known closed form:
 *
 *   growth, as a share of the maximum:      f(2 − f)
 *   chance of EVER falling to a fraction a: a^(2/f − 1)
 *
 * Both are standard results for fractional Kelly, and together they are why
 * quarter-Kelly is the default everywhere serious. The second one is the reason
 * this function exists: full Kelly gives up nothing in growth and carries a 50%
 * chance of halving the bankroll at some point, which nobody consents to when it
 * is written down, and almost everybody consents to when it is not.
 *
 * Note the asymmetry at the top end — doubling past full Kelly does not double
 * anything. At f = 2 the growth term f(2 − f) is exactly zero: a bettor with a
 * real edge, betting twice Kelly, has no long-run growth at all. That is the
 * cliff this ladder deliberately stops short of.
 *
 * These modes apply ONLY to edges measured at bet time — a better price than the
 * market, a teaser through the key numbers. They are not a route around the
 * staking gate: a model-derived probability with no proven closing-line value
 * stakes zero in every mode, including the aggressive ones.
 */
export const RISK_MODES = {
  cautious: {
    label: 'Cautious', fraction: 0.25,
    plan: 'The default, and the right one until real money has run through the ledger.'
  },
  aggressive: {
    label: 'Aggressive', fraction: 0.5,
    plan: 'Three quarters of the growth for sixteen times the chance of halving. Defensible ' +
      'once an edge has held up over a few hundred settled bets.'
  },
  ultra: {
    label: 'Ultra', fraction: 1.0,
    plan: 'Growth-optimal only if the win probability is exactly right, which it never is. ' +
      'Overestimate the edge here and the over-betting is multiplicative, not additive.'
  }
};

/**
 * What each mode actually costs, computed rather than asserted.
 *
 * @param edgeWinRate the win rate of the edge being staked; defaults to the
 *   measured Wong teaser leg rate squared, since that is the only positive
 *   edge in this codebase and therefore the only one any of this applies to.
 */
export function riskModes({ winProbability = null, americanPrice = -110, bankrollUnits = 100 } = {}) {
  const p = Number.isFinite(winProbability) ? winProbability : null;
  const modes = Object.entries(RISK_MODES).map(([id, m]) => {
    const growth = +(m.fraction * (2 - m.fraction)).toFixed(3);
    // a^(2/f − 1) for a = 0.5 and a = 0.25.
    const exponent = 2 / m.fraction - 1;
    const halve = +Math.pow(0.5, exponent).toFixed(4);
    const quarter = +Math.pow(0.25, exponent).toFixed(4);
    const stake = p != null
      ? kellyFraction({ winProbability: p, americanPrice, fraction: m.fraction })
      : null;
    return {
      id, label: m.label, kelly_fraction: m.fraction, plan: m.plan,
      growth_share_of_max: growth,
      chance_of_ever_halving: halve,
      chance_of_ever_losing_three_quarters: quarter,
      stake_units: stake?.stake_fraction != null ? +(stake.stake_fraction * bankrollUnits).toFixed(2) : null,
      // Said in words, because a probability of 0.5 for "you will at some point
      // halve your bankroll" is the kind of number people skim past.
      reads_as: `${Math.round(growth * 100)}% of the best possible growth, and a ` +
        `${halve >= 0.01 ? `${Math.round(halve * 100)}%` : 'well under 1%'} chance of halving your ` +
        'bankroll at some point along the way.'
    };
  });
  return {
    modes,
    applies_to: 'Edges measured at bet time — a better price than the market, or a teaser through ' +
      'the key numbers. Model forecasts stake zero in every mode until they show closing-line value.',
    the_question_this_answers:
      'Turning down the model\'s "caution" is not available, because the calibration slope is a ' +
      'measurement rather than a setting. A model no sharper than the betting line does not become ' +
      'profitable when bet harder — it loses at the same rate with more variance. What can be ' +
      'turned up is how hard a PROVEN edge is bet, and that is this ladder.',
    the_cliff: 'At twice full Kelly the growth term f(2 − f) is exactly zero: a real edge, bet that ' +
      'hard, compounds to nothing. This ladder stops at 1.0 for that reason.'
  };
}

/**
 * The real break-even, measured from actual recorded prices rather than the
 * -110 convention.
 *
 * "52.4%" is quoted everywhere and it assumes every spread is priced -110
 * both ways. Measured over 10,590 games in this database carrying real
 * `spread_odds` (2006-2025), only 13.2% were actually -110. A quarter sat
 * at -105, 13% at -115 or worse, and 24% carried plus money on one side
 * because the book shaded the number. Mean implied probability per side is
 * **51.33%**, i.e. a real two-sided vig near 2.66%.
 *
 * So the hurdle for a bettor who takes the price in front of them is roughly
 * a point of win probability lower than the number everyone repeats. That is
 * not a rounding difference — a full point of required win rate is a large
 * share of any realistic edge.
 *
 * (Methodological note, because it is an easy error: American odds cannot be
 * averaged directly — the scale is discontinuous at zero, so a mean over
 * mixed +/- prices is meaningless. Everything here averages implied
 * probabilities and converts back.)
 */
export function realBreakEven() {
  const g = rows(`SELECT spread_odds FROM game_lines WHERE spread_odds IS NOT NULL`);
  if (!g.length) return { error: 'no recorded spread prices' };
  const probs = g.map(x => impliedProb(x.spread_odds));
  const meanProb = probs.reduce((s, x) => s + x, 0) / probs.length;
  const atMinus110 = g.filter(x => x.spread_odds === -110).length;
  return {
    games: g.length,
    mean_implied_per_side: r4(meanProb),
    real_two_sided_vig: r4(2 * meanProb - 1),
    real_breakeven: r4(meanProb),
    convention_breakeven: 0.5238,
    share_priced_at_minus_110: r4(atMinus110 / g.length),
    note: 'The -110 convention overstates the hurdle. Only 13.2% of recorded games were ' +
      'actually priced there.'
  };
}

/** What the execution edge is worth, summarised for a human. */
export function executionEdgeSummary() {
  const keys = keyNumbers(6);
  return {
    key_numbers: keys,
    half_point_across_3: lineMoveValue(2.5, 3.5),
    half_point_across_7: lineMoveValue(6.5, 7.5),
    half_point_across_5: lineMoveValue(4.5, 5.5),
    breakeven: realBreakEven(),
    note: 'Not all half points are equal. Crossing 3 is worth an order of magnitude more than ' +
      'crossing 5, because 3 is the most common margin in football. Line shopping that ignores ' +
      'key numbers captures a fraction of the available edge.'
  };
}
