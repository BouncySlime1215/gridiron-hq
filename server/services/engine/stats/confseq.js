/**
 * One anytime-valid confidence sequence on a stream of paired score differences
 * (ENGINE-ARCHITECTURE.md §7.4, ML I7): the monitor checks it every night, so the bound
 * must hold at every check at once, not at one pre-chosen n.
 *
 * The boundary is the two-sided normal-mixture bound (Robbins; Howard et al. 2021, eq. 14):
 *   |S_t - t*mu| < sqrt((V_t + rho) * ln((V_t + rho) / (rho * alpha^2)))
 * with S_t the running sum and V_t the accumulated variance. It holds for every t together
 * with probability >= 1 - alpha when each difference is sub-Gaussian with the variance used.
 *
 * The variance is predictable: observation i uses a variance built only from the prior
 * (`priorVar`, weight PRIOR_WEIGHT) and the observations before it, never from itself.
 * That plug-in is not covered by the theorem; `simulateNull` is how the false-flip rate is
 * checked instead (the pre-registration in docs/evidence/2026-09-24/monitor-preregistration.md).
 */

/** rho = RHO_WEEKS * priorVar: the mixture is tightest near RHO_WEEKS observations. */
export const RHO_WEEKS = 6;
/** How many observations the prior variance counts as. */
export const PRIOR_WEIGHT = 2;

/**
 * The sequence's bounds on the mean of `xs`, after all of them.
 * Returns {n, mean, lower, upper, radius, variance}; n = 0 gives infinite bounds.
 */
export function confidenceSequence(xs, { alpha, priorVar, rhoWeeks = RHO_WEEKS, priorWeight = PRIOR_WEIGHT } = {}) {
  if (!(alpha > 0 && alpha < 1)) throw new Error(`confidenceSequence: alpha must be in (0, 1), got ${alpha}`);
  if (!(priorVar > 0) || !Number.isFinite(priorVar)) throw new Error(`confidenceSequence: priorVar must be > 0, got ${priorVar}`);
  if (!Array.isArray(xs) || !xs.every(Number.isFinite)) throw new Error('confidenceSequence: xs must be finite numbers');
  const n = xs.length;
  if (!n) return { n: 0, mean: null, lower: -Infinity, upper: Infinity, radius: Infinity, variance: 0 };
  let sum = 0; let m = 0; let m2 = 0; let V = 0;
  for (let i = 0; i < n; i++) {
    // variance for observation i from the prior and observations 0..i-1 (Welford)
    V += (priorWeight * priorVar + m2) / (priorWeight + i);
    const x = xs[i];
    sum += x;
    const d = x - m;
    m += d / (i + 1);
    m2 += d * (x - m);
  }
  const rho = rhoWeeks * priorVar;
  const radiusSum = Math.sqrt((V + rho) * Math.log((V + rho) / (rho * alpha * alpha)));
  const mean = sum / n;
  const radius = radiusSum / n;
  return { n, mean, lower: mean - radius, upper: mean + radius, radius, variance: V };
}

/** Deterministic uniform generator (mulberry32) from a string seed. */
function rng(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normal(u) {
  let x = 0;
  while (x === 0) x = u();
  return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * u());
}

/**
 * The false-flip rate under the null: `seasons` seasons of `weeks` weekly differences
 * drawn N(shift, sd^2), checked after every week; a season "flips" the first time the
 * lower bound clears 0 at or after `floorWeeks`. `priorVar` is what the monitor would
 * assume (pass sd^2 for a well-specified prior, or a multiple to stress it).
 * Returns {seasons, flips, rate, first_flip_weeks}.
 */
export function simulateNull({ seasons = 2000, weeks = 20, alpha, sd = 1, priorVar = sd * sd, shift = 0,
  floorWeeks = 4, seed = 'confseq-null' } = {}) {
  const u = rng(seed);
  let flips = 0;
  const firstFlip = {};
  for (let s = 0; s < seasons; s++) {
    const xs = [];
    for (let w = 1; w <= weeks; w++) {
      xs.push(shift + sd * normal(u));
      if (w < floorWeeks) continue;
      if (confidenceSequence(xs, { alpha, priorVar }).lower > 0) {
        flips += 1;
        firstFlip[w] = (firstFlip[w] ?? 0) + 1;
        break;
      }
    }
  }
  return { seasons, flips, rate: flips / seasons, first_flip_weeks: firstFlip };
}
