/**
 * Anytime-valid inference for a bounded mean: a confidence sequence (CS).
 *
 * WHY NOT A FIXED n. A grader that waits for n = 50 and then runs one test
 * wastes every offer before the 50th, and one that peeks at a bootstrap CI
 * after every new offer and stops the first time it looks good is running a
 * test whose real error rate is far above its label. A confidence sequence is
 * the interval that stays valid under that exact peeking: with probability at
 * least 1 - alpha it covers the true mean at EVERY n simultaneously, so the
 * report card may be read after any offer and act on whatever it says.
 *
 * Method: the hedged betting capital process with predictable plug-in bets
 * (Waudby-Smith & Ramdas, "Estimating means of bounded random variables by
 * betting", JRSS-B 2024, Thm 3 / "PrPl-EB" bets). For each candidate mean m a
 * gambler bets on x > m and another on x < m; Ville's inequality says neither
 * one's wealth reaches 1/alpha with probability above alpha while m is true.
 * The CS is every m whose hedged wealth has never reached 1/alpha.
 *
 * The values must lie in a range [lo, hi] fixed BEFORE the data is seen; a
 * range read off the data would void the guarantee. Pure, no clock, no dice.
 */

const GRID = 1000;
const MAX_BET = 0.5;

/**
 * Predictable bet sizes for x already scaled to [0, 1]: bet t is computed from
 * x[0..t-1] only. Start from mean 1/2, variance 1/4 (the worst case).
 */
function predictableBets(x, alpha) {
  const lam = new Array(x.length);
  let sum = 0.5;
  let sq = 0.25;
  for (let t = 0; t < x.length; t += 1) {
    const i = t + 1;
    const mu = sum / i;
    const v = sq / i;
    lam[t] = Math.sqrt((2 * Math.log(2 / alpha)) / (Math.max(v, 1e-6) * i * Math.log(i + 1)));
    sum += x[t];
    sq += (x[t] - mu) ** 2;
  }
  return lam;
}

/**
 * Wealth of the two one-sided gamblers against candidate mean m (scaled),
 * running intersection over t: `excludedAt` is the first t where the hedged
 * wealth reached 1/alpha, or -1.
 */
function wealth(x, lam, m, alpha) {
  let up = 1; let down = 1; let excludedAt = -1;
  const capUp = MAX_BET / Math.max(m, 1e-9);
  const capDown = MAX_BET / Math.max(1 - m, 1e-9);
  for (let t = 0; t < x.length; t += 1) {
    up *= 1 + Math.min(lam[t], capUp) * (x[t] - m);
    down *= 1 - Math.min(lam[t], capDown) * (x[t] - m);
    if (excludedAt < 0 && 0.5 * up + 0.5 * down >= 1 / alpha) excludedAt = t;
  }
  return { up, down, excludedAt };
}

/**
 * The CS for the mean of `values` (each in [lo, hi]) at the last n, plus the
 * e-values against "mean <= ref" (up) and "mean >= ref" (down).
 *
 * Returns { lower, upper, mean, n, e_above, e_below } in the original units.
 * `e_above` large = evidence the mean is ABOVE ref; `e_below` = below it.
 * lower/upper are null when n = 0 (no interval yet — not a zero-width one).
 */
export function confidenceSequence(values, { lo, hi, alpha = 0.05, ref = 0 } = {}) {
  if (!(hi > lo)) throw new Error('confidenceSequence needs a fixed range lo < hi');
  const n = values.length;
  const span = hi - lo;
  const x = values.map(v => {
    if (!(v >= lo - 1e-12 && v <= hi + 1e-12)) throw new Error(`confidenceSequence: value ${v} outside the declared range [${lo}, ${hi}]`);
    return Math.min(1, Math.max(0, (v - lo) / span));
  });
  const meanX = n ? x.reduce((a, b) => a + b, 0) / n : null;
  if (!n) return { lower: null, upper: null, mean: null, n: 0, e_above: 1, e_below: 1 };
  const lam = predictableBets(x, alpha);
  let lowerX = null;
  let upperX = null;
  for (let k = 0; k <= GRID; k += 1) {
    const m = k / GRID;
    if (wealth(x, lam, m, alpha).excludedAt >= 0) continue;
    if (lowerX == null) lowerX = m;
    upperX = m;
  }
  const refX = Math.min(1 - 1e-9, Math.max(1e-9, (ref - lo) / span));
  const atRef = wealth(x, lam, refX, alpha);
  const back = m => lo + m * span;
  // Every m excluded can only happen through numerical edge effects around a
  // degenerate sample; report the point estimate as a zero-width interval then.
  if (lowerX == null) lowerX = upperX = meanX;
  return {
    lower: back(Math.max(0, lowerX - 1 / GRID)),
    upper: back(Math.min(1, upperX + 1 / GRID)),
    mean: back(meanX), n, e_above: atRef.up, e_below: atRef.down,
  };
}

/**
 * The fewest values that could possibly exclude `ref` if every one of them
 * were as far from it as the range allows. Below this n no data can decide,
 * so "needs N more" is never smaller than this.
 */
export function minDecisiveN({ lo, hi, alpha = 0.05, ref = 0, cap = 1000 } = {}) {
  const extreme = hi - ref >= ref - lo ? hi : lo;
  const xs = [];
  for (let n = 1; n <= cap; n += 1) {
    xs.push(extreme);
    const cs = confidenceSequence(xs, { lo, hi, alpha, ref });
    if (cs.lower > ref || cs.upper < ref) return n;
  }
  return cap;
}
