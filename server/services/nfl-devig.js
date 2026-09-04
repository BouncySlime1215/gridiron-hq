/**
 * De-vigging two-sided prices into a fair probability pair.
 *
 * Every no-vig computation in this codebase used to be the same naive
 * formula, reimplemented independently in nfl-market.js, nfl-auto-picks.js,
 * nfl-props.js, nfl-clv.js and nfl-replay.js: take each side's raw implied
 * probability and split the bookmaker's margin proportionally between them
 * (`a / (a + b)`). That is a real de-vig — it does remove the margin and the
 * two outputs do sum to one — but it is not the *correct* one. It implicitly
 * assumes both sides carry an equal share of the vig, which is false for a
 * skewed line: a big favorite's moneyline packs more of the bookmaker's
 * margin onto the favorite than the underdog (the "favorite-longshot bias"
 * documented across decades of betting-market research), and proportional
 * splitting misprices exactly that case.
 *
 * Shin's method (Hyun Song Shin, "Prices of State Contingent Claims with
 * Insider Traders, and the Favourite-Longshot Bias", The Economic Journal,
 * 1992) corrects for this. It models the bookmaker's overround as coming in
 * part from a fraction `z` of informed ("insider") money that always bets
 * the winning side, and solves for both `z` and the fair probabilities `p_i`
 * simultaneously from the constraint that they reproduce the quoted implied
 * probabilities and sum to one:
 *
 *   p_i = [ sqrt(z^2 + 4(1-z) * pi_i^2 / S) - z ] / (2 * (1-z))
 *
 * where `pi_i` is side i's raw implied probability (vig included), S is the
 * sum of all sides' raw implied probabilities (S = 1 + overround), and `z`
 * is chosen so that sum_i p_i = 1. This is the same closed-form relation
 * used by the widely-cited R "implied" package's `shin` method and by
 * Jullien & Salanie (1994)'s treatment of Shin's model. For the two-outcome
 * case there is no simpler closed form for `z` once both raw probabilities
 * differ, so it is solved by bisection here — the standard approach used for
 * the general n-outcome case too, and exact to well beyond any price's
 * real precision.
 *
 * For a near-even line (e.g. -110/-110) Shin's method and the naive
 * proportional split agree exactly, because symmetry forces p_A = p_B = 0.5
 * under either method. They diverge as the line gets more skewed — see
 * test/nfl-devig.test.js for a worked example on a heavy favorite's
 * moneyline.
 */

export const americanToProb = odds => {
  if (!Number.isFinite(odds)) return null;
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
};

/** The naive/legacy method: split the vig proportionally between both sides. */
export function proportionalDevig(oddsA, oddsB) {
  const a = americanToProb(oddsA), b = americanToProb(oddsB);
  if (a == null || b == null || !(a + b > 0)) return null;
  return { probA: a / (a + b), probB: b / (a + b) };
}

/**
 * Shin's method for a two-outcome market. Returns both fair probabilities and
 * the fitted insider-money fraction `z`, or null if either price is missing.
 *
 * Falls back to the proportional split when there is no real overround to
 * correct for (S <= 1 — a fair or arbitrage-priced pair, where Shin's own
 * model has nothing to solve) or in the degenerate case where bisection's
 * bracket does not have opposite-signed endpoints (never observed on a real
 * two-sided price pair in testing, but guarded rather than assumed away).
 */
export function shinDevig(oddsA, oddsB, { tol = 1e-14, maxIter = 200 } = {}) {
  const piA = americanToProb(oddsA), piB = americanToProb(oddsB);
  if (piA == null || piB == null) return null;
  const S = piA + piB;
  if (!(S > 0)) return null;

  // Exact symmetric fast path: equal raw implied probabilities (e.g. -110/-110)
  // must devig to exactly 0.5/0.5 under any sane method, and this sidesteps any
  // bisection floating-point residue for the single most common real line shape.
  if (piA === piB) return { probA: 0.5, probB: 0.5, z: null };

  if (S <= 1) return { probA: piA / S, probB: piB / S, z: 0 };

  const probsAt = z => {
    if (z >= 1) return [piA * piA / S, piB * piB / S];
    const denom = 2 * (1 - z);
    const p = pi => (Math.sqrt(z * z + 4 * (1 - z) * pi * pi / S) - z) / denom;
    return [p(piA), p(piB)];
  };
  const g = z => { const [a, b] = probsAt(z); return a + b - 1; };

  let lo = 0, hi = 1 - 1e-12;
  const glo = g(lo), ghi = g(hi);
  // g(0) > 0 and g(1^-) < 0 for every real overround pair (verified against
  // published reference cases); if that bracket does not hold, the proportional
  // split is a safe, still-valid fallback rather than an unguarded solve.
  if (!(glo > 0 && ghi < 0)) return { probA: piA / S, probB: piB / S, z: null };

  let z = (lo + hi) / 2;
  for (let i = 0; i < maxIter; i++) {
    z = (lo + hi) / 2;
    const gm = g(z);
    if (Math.abs(gm) < tol || hi - lo < tol) break;
    if (gm > 0) lo = z; else hi = z;
  }
  const [pA, pB] = probsAt(z);
  const sum = pA + pB;
  if (!(sum > 0)) return { probA: piA / S, probB: piB / S, z: null };
  // Renormalize the last bit of bisection residue so the pair sums to exactly
  // one — a cosmetic correction of a few parts in 1e-13, not a methodology change.
  return { probA: pA / sum, probB: pB / sum, z };
}

/** Shin's fair probability of side A, given both sides' real American prices. */
export function shinNoVig(oddsA, oddsB) {
  return shinDevig(oddsA, oddsB)?.probA ?? null;
}

/** The legacy proportional-split fair probability of side A. Kept for comparison. */
export function proportionalNoVig(oddsA, oddsB) {
  return proportionalDevig(oddsA, oddsB)?.probA ?? null;
}

/** The project's default no-vig method: Shin's, as of this change. */
export const noVig = shinNoVig;

export const __test = { probsAt: shinDevig };
