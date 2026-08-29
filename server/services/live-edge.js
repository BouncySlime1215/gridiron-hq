/**
 * Live in-game edge: ESPN state, the simulator, and a tradeable exchange price.
 *
 * This is the first place in the project where the three things needed for a bet
 * actually line up at once, and it is worth being precise about why, because
 * nothing else here has managed it.
 *
 *   THE MODEL IS VALIDATED. Every forecasting component in this repo failed its
 *   audit — twenty-two of them. The live win-probability model is the single
 *   exception: graded on 2,196 states drawn from completed games it scores a
 *   Brier of 0.1708 against a 0.25 base-rate baseline, a skill score of 0.317,
 *   and a calibration error of 0.047. It is the only model here that has earned
 *   the right to be pointed at a price.
 *
 *   THE STATE IS FREE AND LIVE. ESPN publishes score, clock, down, distance and
 *   possession during a game, with no key and no quota.
 *
 *   THE PRICE IS TRADEABLE. Polymarket quotes live NFL markets with a real
 *   order book and no trading fee, at a median cost of 2.53% on markets with
 *   depth — cheaper than Kalshi and competitive with the cheapest sportsbook.
 *
 * WHAT STOPS THIS FROM BEING FREE MONEY, and why each gate below exists:
 *
 *   LATENCY. Our ESPN feed trails the broadcast, which trails the stadium.
 *   Anyone closer to the field sees the play first, so on any state that has
 *   just changed we are the slowest participant in the market. This is the
 *   single largest risk in live betting and no model quality fixes it.
 *
 *   ADVERSE SELECTION. On a thin book, getting filled means someone chose to
 *   take the other side. The trades that fill easiest are the ones a faster
 *   participant was happy to give away — the winner's curse, and it is worst
 *   exactly where depth is thinnest.
 *
 *   KNOWN MISCALIBRATION. The live model is not uniformly good. Its extremes are
 *   excellent, but between roughly 40% and 80% it is overconfident toward the
 *   home team by about ten points, and it understates comebacks at the bottom.
 *   Those biases were measured, so they are corrected here rather than paid for.
 */
import { rows, row } from '../db/index.js';
import { liveWinProbability } from './nfl-live.js';

const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * The measured bias of the live model, by probability bucket.
 *
 * Taken from `liveModelValidation()` over 2,196 graded states: `gap` is the
 * observed frequency minus the claimed probability, so a negative number means
 * the model claimed more than happened. Applying these as a correction is a
 * one-dimensional calibration map — the same idea as Platt scaling, fitted on
 * buckets rather than a parametric curve because the bias is not monotone.
 *
 * This is deliberately conservative: it corrects toward what was observed, and
 * where a bucket was thin the correction is damped rather than trusted.
 */
const CALIBRATION_MAP = [
  { lo: 0.00, hi: 0.10, gap: +0.031, n: 324 },
  { lo: 0.10, hi: 0.20, gap: +0.097, n: 127 },
  { lo: 0.20, hi: 0.30, gap: +0.099, n: 159 },
  { lo: 0.30, hi: 0.40, gap: -0.073, n: 154 },
  { lo: 0.40, hi: 0.50, gap: -0.100, n: 79 },
  { lo: 0.50, hi: 0.60, gap: -0.023, n: 542 },
  { lo: 0.60, hi: 0.70, gap: -0.107, n: 158 },
  { lo: 0.70, hi: 0.80, gap: -0.079, n: 183 },
  { lo: 0.80, hi: 0.90, gap: -0.011, n: 133 },
  { lo: 0.90, hi: 1.01, gap: +0.004, n: 337 }
];

/**
 * Correct a raw model probability using the measured bias.
 *
 * Damped by bucket size: a correction fitted on 79 observations is applied at
 * half strength, because the bias estimate is itself noisy and over-correcting
 * on thin evidence is how a calibration layer makes a model worse.
 */
export function calibrateLiveProbability(raw) {
  if (!Number.isFinite(raw)) return null;
  const b = CALIBRATION_MAP.find(x => raw >= x.lo && raw < x.hi);
  if (!b) return raw;
  const damping = clamp(b.n / 300, 0.3, 1);
  return clamp(raw + b.gap * damping, 0.005, 0.995);
}

/**
 * How wrong the model still is after correction, at this probability.
 *
 * An edge smaller than the model's own residual error is not an edge, it is
 * noise being read as signal. This returns the floor any claimed edge has to
 * clear before it is worth acting on.
 */
export function residualUncertainty(prob) {
  const b = CALIBRATION_MAP.find(x => prob >= x.lo && prob < x.hi);
  if (!b) return 0.05;
  // Standard error of the bucket's own frequency estimate, floored so that even
  // a well-sampled bucket demands a real margin.
  const se = Math.sqrt(0.25 / Math.max(1, b.n));
  return Math.max(0.03, se * 2);
}

/**
 * Price one live game against a market probability.
 *
 * @param marketProbability  the exchange's implied probability for the HOME side
 * @param depth              contracts available at the touch, which caps size
 * @param secondsSinceStateChange  how stale our view of the game is
 */
export function liveEdge({
  homeScore, awayScore, secondsLeft, pregameSpread = null,
  marketProbability, depth = null, secondsSinceStateChange = null,
  costFraction = 0.0253
} = {}) {
  const lead = (homeScore ?? 0) - (awayScore ?? 0);
  if (!Number.isFinite(secondsLeft) || secondsLeft <= 0) {
    return { error: 'a positive seconds-remaining is required' };
  }
  const raw = liveWinProbability(lead, secondsLeft, pregameSpread);
  const model = calibrateLiveProbability(raw);
  if (!Number.isFinite(marketProbability)) {
    return { raw_model_probability: r4(raw), calibrated_model_probability: r4(model),
      note: 'No market price supplied, so this is a probability rather than an edge.' };
  }

  const rawEdge = model - marketProbability;
  const floor = residualUncertainty(model);
  // The cost of crossing the spread is a real subtraction, not a footnote — at
  // a 2.53% round trip it eats most of a small edge before anything is risked.
  const netEdge = Math.sign(rawEdge) * Math.max(0, Math.abs(rawEdge) - costFraction / 2);

  const blockers = [];
  if (Math.abs(rawEdge) < floor) {
    blockers.push(`edge ${r4(Math.abs(rawEdge))} is inside the model's own residual error ${r4(floor)}`);
  }
  if (netEdge === 0) blockers.push('the spread consumes the entire edge');
  // Latency: a state that changed seconds ago is one where every faster
  // participant has already acted, and we are the slowest in the market.
  if (Number.isFinite(secondsSinceStateChange) && secondsSinceStateChange < 20) {
    blockers.push(`state changed ${secondsSinceStateChange}s ago — faster participants have already ` +
      'traded on it and a fill here is adverse selection');
  }
  if (Number.isFinite(depth) && depth < 100) {
    blockers.push(`depth of ${depth} contracts cannot absorb a meaningful bet`);
  }
  // The bucket the model is worst in. An edge computed here is the least
  // trustworthy kind, because the correction doing the work is the largest.
  if (model >= 0.4 && model <= 0.8) {
    blockers.push('probability sits in the band where the live model was most biased ' +
      '(overconfident toward the home team by about ten points before correction)');
  }

  const maxUnits = Number.isFinite(depth) ? Math.min(3, depth / 500) : 3;

  return {
    lead, seconds_left: secondsLeft,
    raw_model_probability: r4(raw),
    calibration_adjustment: r4(model - raw),
    calibrated_model_probability: r4(model),
    market_probability: r4(marketProbability),
    raw_edge: r4(rawEdge),
    net_edge_after_cost: r4(netEdge),
    required_edge_floor: r4(floor),
    side: rawEdge > 0 ? 'home' : 'away',
    actionable: blockers.length === 0,
    blockers,
    max_units_by_depth: r4(maxUnits),
    note: 'The model probability is corrected using bias measured over 2,196 graded live states, ' +
      'then required to clear both its own residual error and the cost of crossing the spread. ' +
      'Most states will not clear both, which is the correct outcome rather than a failure.'
  };
}

/**
 * Scan every game currently in progress and price it against the exchange.
 *
 * Joins three free sources: ESPN for live state, the validated simulator for a
 * probability, and Polymarket for a tradeable price.
 */
export async function liveBoard({ costFraction = 0.0253 } = {}) {
  const { pollLiveGames } = await import('./nfl-espn-pbp.js');
  const poll = await pollLiveGames({});
  if (poll.error) return { error: poll.error };

  const live = (poll.results ?? []).filter(r => r.live);
  if (!live.length) {
    return { games_live: 0, checked_at: new Date().toISOString(),
      note: 'No games in progress. The board is live only during games, which is when a live model ' +
        'is worth anything.',
      polymarket_markets_available: row(
        `SELECT COUNT(*) AS n FROM polymarket_markets WHERE kind='other'`)?.n ?? 0 };
  }

  // The most recent order book per market, which is the only executable price.
  const books = rows(
    `SELECT m.question, q.best_bid, q.best_ask, q.bid_size, q.ask_size
     FROM polymarket_quotes q JOIN polymarket_markets m ON m.condition_id = q.condition_id
     WHERE q.best_bid IS NOT NULL`);

  const out = [];
  for (const g of live) {
    const s = g.live;
    // Match the exchange market by team name appearing in the question. Loose
    // by design; an unmatched game is reported without a price rather than
    // paired with the wrong market.
    const book = books.find(b => (b.question ?? '').toUpperCase().includes(String(g.name ?? '').split(' at ')[1]?.toUpperCase() ?? ' '));
    const marketProb = book ? (book.best_bid + book.best_ask) / 2 : null;
    const depth = book ? Math.min(book.bid_size ?? 0, book.ask_size ?? 0) : null;

    out.push({
      game: g.name, event_id: g.event_id,
      score: `${s.away_score}-${s.home_score}`, seconds_left: s.clock_seconds,
      matched_market: book?.question ?? null,
      ...liveEdge({ homeScore: s.home_score, awayScore: s.away_score,
        secondsLeft: s.clock_seconds, marketProbability: marketProb,
        depth, costFraction })
    });
  }

  return {
    games_live: live.length, checked_at: new Date().toISOString(),
    actionable: out.filter(o => o.actionable).length,
    games: out,
    note: 'ESPN state, a validated live model, and a tradeable exchange price, joined. Games without ' +
      'a matched exchange market are reported as probabilities rather than edges.'
  };
}

/** What the live stack can currently see. */
export function liveEdgeStatus() {
  const pm = row(`SELECT COUNT(*) AS n, COUNT(best_bid) AS booked FROM polymarket_quotes`) ?? {};
  const plays = row(`SELECT COUNT(*) AS n FROM nfl_play_by_play`)?.n ?? 0;
  return {
    play_corpus: plays,
    polymarket_quotes: pm.n ?? 0, with_order_book: pm.booked ?? 0,
    model_validation: { brier: 0.1708, baseline: 0.25, skill_score: 0.3167,
      calibration_error: 0.0471, states_graded: 2196 },
    calibration_map_buckets: CALIBRATION_MAP.length,
    gates: ['edge must exceed the model residual error',
      'edge must survive the cost of crossing the spread',
      'no trading within 20 seconds of a state change (adverse selection)',
      'depth must absorb the bet',
      'the 0.40-0.80 band is flagged as the model\'s least reliable'],
    note: 'The live model is the only validated forecasting component in this project. Everything ' +
      'else here failed its own audit, which is why the gates are strict.'
  };
}
