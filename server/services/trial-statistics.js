/**
 * Effective trial count, deflated Sharpe ratio, and probability of backtest
 * overfitting (PBO) -- Giant Plan Step 2c/2d, sitting on top of the real
 * trial history `research-trials.js` backfills.
 *
 * The problem all three functions here answer, in one sentence each:
 *
 *   effectiveTrialCount  -- 21 (or 52, counting every real trial this stage
 *     reconstructed) is the number of ATTEMPTS, not the number of
 *     INDEPENDENT looks at the data. Each attempt in this project's real
 *     history was informed by the one before it (a candidate that looked
 *     weak got a variant tried next, not an unrelated fresh idea), so the
 *     naive multiple-comparisons correction (Sidak/Holm treating N as
 *     independent, exactly what `audit-registry.js` already does for ITS OWN
 *     ledger) OVERSTATES how much independent evidence N trials represent.
 *     Geyer's (1992) integrated-autocorrelation-time estimator, borrowed
 *     from MCMC effective-sample-size theory, turns a correlated sequence of
 *     N attempts into an effective count of independent-equivalent attempts.
 *
 *   deflatedSharpeRatio  -- the best Sharpe ratio observed across N trials is
 *     a biased estimate of that strategy's TRUE skill, because picking the
 *     max of N noisy draws is itself a source of upward bias even under pure
 *     luck (extreme value theory). Bailey & López de Prado (2014) correct
 *     for exactly this, using the effective trial count above instead of the
 *     naive one so the correction is not itself overstated.
 *
 *   probabilityOfBacktestOverfitting -- did the configuration that looked
 *     best in-sample simply get lucky in a way that does not survive
 *     splitting the same data a different way? Combinatorially Symmetric
 *     Cross-Validation (Bailey, Borwein, López de Prado & Zhu 2015) answers
 *     this directly from real sub-period performance, no strategy-count
 *     correction needed -- a genuinely different question from the two above.
 *
 * All three are pure functions of arrays/numbers the caller supplies. Nothing
 * here reads the database; `scripts/run-purged-evaluation.mjs` is what feeds
 * these from `research-trials.js`'s real, backfilled history.
 */
import { probit, normalCdf } from './stats-util.js';

/* ------------------------------------------------------- autocorrelation */

function meanOf(x) { return x.reduce((s, v) => s + v, 0) / x.length; }

export function autocovariance(x, lag, mu = meanOf(x)) {
  const n = x.length;
  let s = 0;
  for (let i = 0; i + lag < n; i++) s += (x[i] - mu) * (x[i + lag] - mu);
  return s / n;
}

/**
 * Geyer's (1992) initial monotone sequence estimator of the integrated
 * autocorrelation time tau = 1 + 2*sum_{k>=1} rho(k), truncated the moment
 * the paired sum Gamma_m = rho(2m)+rho(2m+1) would go non-monotone or
 * non-positive -- the standard, conservative choice among Geyer's three
 * variants (initial positive / initial monotone / initial convex), because
 * it never lets a single noisy negative dip cut the sum short too early
 * while still guaranteeing termination.
 *
 * `sequence` is the REAL trial outcomes in the REAL order they happened
 * (chronological, not sorted by value) -- autocorrelation is meaningless
 * computed on any other ordering.
 */
export function geyerIntegratedAutocorrelationTime(sequence, { maxLag } = {}) {
  const n = sequence.length;
  if (n < 8) {
    return { tau: 1, n, m_pairs_used: 0, gamma0: null,
      note: `sequence too short (n=${n}) to estimate autocorrelation reliably; tau defaults to 1 ` +
        '(trials treated as independent, i.e. no correction applied rather than an unstable one)' };
  }
  const cap = Math.max(1, Math.min(maxLag ?? Math.floor(n / 3), Math.floor((n - 1) / 2)));
  const mu = meanOf(sequence);
  const gamma0 = autocovariance(sequence, 0, mu);
  if (!(gamma0 > 1e-12)) {
    return { tau: 1, n, m_pairs_used: 0, gamma0, note: 'zero-variance trial sequence; tau defaults to 1' };
  }
  const maxK = Math.min(2 * cap + 1, n - 1);
  const gamma = [gamma0];
  for (let k = 1; k <= maxK; k++) gamma.push(autocovariance(sequence, k, mu));

  const bigGamma = [];
  for (let m = 0; 2 * m + 1 < gamma.length; m++) bigGamma.push(gamma[2 * m] + gamma[2 * m + 1]);

  let M = -1;
  for (let m = 0; m < bigGamma.length; m++) {
    if (bigGamma[m] > 0) M = m; else break;
  }
  if (M < 0) {
    return { tau: 1, n, m_pairs_used: 0, gamma0,
      note: 'no positive paired autocovariance beyond lag 0 (initial-positive-sequence test fails immediately); ' +
        'trials show no detectable serial dependence at this sample size, so tau=1 (no correction)' };
  }
  let runningMin = Infinity;
  const monotone = [];
  for (let m = 0; m <= M; m++) { runningMin = Math.min(runningMin, bigGamma[m]); monotone.push(runningMin); }
  const sumGamma = monotone.reduce((s, v) => s + v, 0);
  const tau = Math.max(1, 2 * sumGamma / gamma0 - 1);
  return { tau, n, m_pairs_used: monotone.length, gamma0,
    note: `Geyer initial monotone sequence estimator; ${monotone.length} paired lag-block(s) used (cap ${cap})` };
}

/** n_effective = n_raw / tau. Never exceeds n_raw (tau is floored at 1). */
export function effectiveTrialCount(sequence, opts = {}) {
  const g = geyerIntegratedAutocorrelationTime(sequence, opts);
  const n_effective = Math.max(1, g.n / g.tau);
  return {
    n_raw: g.n,
    n_effective,
    tau_integrated_autocorrelation_time: g.tau,
    m_pairs_used: g.m_pairs_used,
    note: g.note,
  };
}

/* ------------------------------------------------------------- DSR / PSR */

const EULER_MASCHERONI = 0.5772156649015329;

/**
 * E[max of N draws of a Sharpe ratio under the null of zero skill], via the
 * Gumbel-type extreme-value approximation Bailey & López de Prado (2014)
 * use: sharpeStd is the CROSS-SECTIONAL standard deviation of the Sharpe
 * ratios actually observed across the N trials (a real, computable quantity
 * from this project's own trial history, not a theoretical input).
 */
export function expectedMaxSharpeUnderNull({ nTrials, sharpeStd }) {
  if (!(nTrials >= 1) || !(sharpeStd >= 0)) return null;
  if (nTrials <= 1) return 0;
  const invN = probit(1 - 1 / nTrials);
  const invNe = probit(1 - 1 / (nTrials * Math.E));
  return sharpeStd * ((1 - EULER_MASCHERONI) * invN + EULER_MASCHERONI * invNe);
}

/**
 * Probabilistic Sharpe Ratio (Bailey & López de Prado 2012): the probability
 * that the TRUE Sharpe ratio exceeds `benchmark`, given an observed Sharpe
 * over `n` return observations with the given (raw, not excess -- normal
 * distribution scores kurtosis=3 here) skewness/kurtosis, via Mertens'
 * (2002) asymptotic variance of the Sharpe-ratio estimator.
 */
export function probabilisticSharpeRatio({ sharpe, benchmark = 0, n, skewness = 0, kurtosis = 3 }) {
  if (!(n > 1)) return null;
  const denom = Math.sqrt(Math.max(1e-12, 1 - skewness * sharpe + ((kurtosis - 1) / 4) * sharpe ** 2));
  const z = (sharpe - benchmark) * Math.sqrt(n - 1) / denom;
  return normalCdf(z);
}

/**
 * Deflated Sharpe Ratio: the Probabilistic Sharpe Ratio evaluated against
 * SR0 (the expected best-of-N Sharpe under the null) instead of against 0 --
 * "how likely is it that this best-observed result is real skill, once the
 * benchmark accounts for how many (effective) chances it had to look good by
 * luck alone."
 */
export function deflatedSharpeRatio({ sharpe, n, skewness = 0, kurtosis = 3, nTrialsEffective, sharpeStdAcrossTrials }) {
  const sr0 = expectedMaxSharpeUnderNull({ nTrials: nTrialsEffective, sharpeStd: sharpeStdAcrossTrials });
  const dsr = sr0 == null ? null : probabilisticSharpeRatio({ sharpe, benchmark: sr0, n, skewness, kurtosis });
  return {
    sr0_expected_max_sharpe_under_null: sr0,
    dsr,
    inputs: { sharpe, n, skewness, kurtosis, nTrialsEffective, sharpeStdAcrossTrials },
  };
}

/* -------------------------------------------------- per-bet return proxy */

/**
 * These audit tables only persisted the AGGREGATE outcome of each trial
 * (bets/wins/losses/units), never the per-bet return series. This
 * reconstructs a return series consistent with that real aggregate --
 * flat -1 unit per loss (this project's own "flat" staking convention,
 * `docs/evidence/historical/nfl-model-status-through-2026-08-30.md`), a
 * single calibrated per-win payout solved so the series' own mean reproduces
 * the REAL recorded total units exactly -- so T (sample size) and the mean
 * (ROI) are exactly the real recorded values, and only the higher moments
 * (variance/skew/kurtosis, hence the Sharpe ratio itself) are an
 * approximation of the true, unrecorded per-bet variance. Documented as an
 * approximation everywhere it's used, never presented as the real per-bet
 * series.
 */
export function reconstructBetReturns({ bets, wins, losses, units }) {
  if (!(bets > 0) || !Number.isFinite(wins) || !Number.isFinite(losses) || !Number.isFinite(units)) return null;
  const pushes = Math.max(0, bets - wins - losses);
  const returns = new Array(losses).fill(-1).concat(new Array(pushes).fill(0));
  if (wins > 0) {
    const avgWin = (units + losses) / wins; // wins*avgWin - losses*1 + pushes*0 = units
    returns.push(...new Array(wins).fill(avgWin));
  }
  return { returns, approximated: true,
    note: 'per-bet returns are not persisted by these audit tables; reconstructed at a single calibrated ' +
      'per-win payout (flat -1/loss) so mean and T exactly match the real recorded ROI and bet count -- only ' +
      'variance/skew/kurtosis are approximate' };
}

/** Sample moments of a return series, using population (n, not n-1) denominators throughout for internal consistency between sd/skew/kurtosis. */
export function sharpeStatsFromReturns(returns) {
  const n = returns.length;
  if (n < 2) return null;
  const mu = meanOf(returns);
  const variance = returns.reduce((s, x) => s + (x - mu) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  if (!(sd > 1e-9)) return { n, mean: mu, sd: 0, sharpe: 0, skewness: 0, kurtosis: 3 };
  const m3 = returns.reduce((s, x) => s + (x - mu) ** 3, 0) / n;
  const m4 = returns.reduce((s, x) => s + (x - mu) ** 4, 0) / n;
  return { n, mean: mu, sd, sharpe: mu / sd, skewness: m3 / sd ** 3, kurtosis: m4 / sd ** 4 };
}

/* ---------------------------------------------------------------- CSCV */

function combinations(arr, k) {
  const out = [], combo = [];
  (function go(start) {
    if (combo.length === k) { out.push([...combo]); return; }
    for (let i = start; i < arr.length; i++) { combo.push(arr[i]); go(i + 1); combo.pop(); }
  })(0);
  return out;
}

/**
 * Combinatorially Symmetric Cross-Validation (Bailey, Borwein, López de
 * Prado & Zhu, 2015): splits `periods` time periods into `subsets` equal
 * contiguous blocks, forms every way of picking half the blocks as
 * in-sample (IS) and the rest as out-of-sample (OOS), and for each split
 * checks whether the strategy that looked best IS also ranked above the OOS
 * median. PBO is the fraction of splits where it did not -- direct evidence
 * of overfitting to that data, independent of how many strategies were
 * tried (unlike the effective-N/DSR pair above, which corrects for trial
 * count instead).
 *
 * `strategies`: [{ id, periods: number[] }], one performance value per
 * period, all strategies sharing the same period count and ordering.
 */
export function probabilityOfBacktestOverfitting(strategies, { subsets = 4 } = {}) {
  const N = strategies.length;
  if (N < 2) return { error: 'CSCV needs at least 2 strategies to compare' };
  const T = strategies[0].periods.length;
  if (!strategies.every(s => s.periods.length === T)) return { error: 'every strategy must share the same number of periods' };
  if (subsets % 2 !== 0 || subsets < 2) return { error: 'subsets must be a positive even integer' };
  if (T < subsets) return { error: `need at least ${subsets} periods to form ${subsets} subsets (have ${T})` };

  const groupSize = Math.floor(T / subsets);
  const groups = Array.from({ length: subsets }, (_, g) => ({
    start: g * groupSize, end: g === subsets - 1 ? T : (g + 1) * groupSize,
  }));
  const groupIdx = groups.map((_, i) => i);
  const isCombos = combinations(groupIdx, subsets / 2);

  const meanOverGroups = (strategy, groupIds) => {
    const vals = [];
    for (const g of groupIds) for (let i = groups[g].start; i < groups[g].end; i++) vals.push(strategy.periods[i]);
    return vals.length ? meanOf(vals) : 0;
  };

  const logits = [];
  for (const isGroups of isCombos) {
    const oosGroups = groupIdx.filter(g => !isGroups.includes(g));
    const isPerf = strategies.map(s => meanOverGroups(s, isGroups));
    const oosPerf = strategies.map(s => meanOverGroups(s, oosGroups));
    let bestIs = 0;
    for (let i = 1; i < N; i++) if (isPerf[i] > isPerf[bestIs]) bestIs = i;
    const bestOos = oosPerf[bestIs];
    let below = 0, tied = 0;
    for (let i = 0; i < N; i++) { if (oosPerf[i] < bestOos) below++; else if (oosPerf[i] === bestOos) tied++; }
    const rank = (below + 0.5 * tied) / N; // fraction of strategies the IS-best beats OOS, in (0,1)
    const omega = Math.min(Math.max(rank, 1 / (2 * N)), 1 - 1 / (2 * N));
    logits.push(Math.log(omega / (1 - omega)));
  }
  const pbo = logits.filter(l => l <= 0).length / logits.length;
  return {
    method: 'combinatorially symmetric cross-validation (Bailey, Borwein, López de Prado & Zhu 2015)',
    subsets, combinations_evaluated: logits.length, strategies: N, periods: T,
    pbo, logits_mean: meanOf(logits),
  };
}
