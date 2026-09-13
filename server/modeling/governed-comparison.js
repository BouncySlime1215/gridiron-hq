/**
 * One comparison every model challenge has to pass, with the statistics
 * attached to it rather than left to the caller.
 *
 * `ModelRegistry.compare()` was, until this file existed:
 *
 *     compare(ids) { return ids.map(id => this.store.get(id)).filter(Boolean); }
 *
 * a fetch loop. Whatever decided whether a challenger was better than an
 * incumbent, it was not the registry — so every stage of every build has
 * graded its own homework with whatever test it chose after seeing its own
 * numbers. That is the failure mode behind both of the expensive results this
 * project has already paid for: an ensemble whose 31 components were reported
 * as 31 independent signals when the correlation matrix says 2-3 (GATE 6
 * below would have refused the comparison outright), and a CLV decline that
 * was inspected repeatedly against a fixed-sample p-value until it looked
 * acceptable (GATE 5).
 *
 * Both primitives this needs already exist here and are tested:
 * `pairedBootstrapDiff` (block bootstrap, clustered, from
 * backtest-significance.js) and `alwaysValidPValue` (Johari-Pekelis-Walsh
 * mSPRT, same file). Neither is new. What is new is that they are composed
 * into a single verdict with preregistration and multiplicity rules around
 * them, so that passing is a property of the challenger rather than of the
 * analyst.
 *
 * ---------------------------------------------------------------- the gates
 *
 * 1. PREREGISTERED PRIMARY METRIC. Exactly one metric decides. Without one
 *    declared the result is advisory and cannot promote, whatever it shows.
 *    This is the gate that stops a challenger winning on the metric it turned
 *    out to be best at.
 *
 * 2. MULTIPLICITY. Every metric examined enters a Holm-corrected family. A
 *    challenger that clears 0.05 on a secondary metric only because five were
 *    looked at does not promote. (Holm is uniformly more powerful than
 *    Bonferroni and, unlike Šidák, needs no independence assumption — which
 *    matters here because the metrics are computed on the same games and are
 *    heavily dependent.)
 *
 * 3. CONTRADICTION. If the primary says better while any secondary says
 *    significantly worse after correction, that is not a win, it is a trade-off
 *    a human has to price. Blocked.
 *
 * 4. EFFECT FLOOR. Statistical significance is not the bar; the point estimate
 *    must also exceed a declared minimum effect. A large sample makes any
 *    difference significant eventually, including one too small to be worth a
 *    deployment.
 *
 * 5. LOOK COUNT / ANYTIME VALIDITY. A sequence checked more than once needs an
 *    anytime-valid p-value, which needs sigma declared in advance. Checking a
 *    fixed-sample p-value repeatedly and stopping when it looks good is
 *    p-hacking with extra steps, and `alwaysValidPValue` already refuses to
 *    call itself anytime-valid without a declared sigma. This gate reads that
 *    flag and blocks the second look that relies on it.
 *
 * 6. INDEPENDENT EVIDENCE. The comparison reports how many independent
 *    clusters the sample really has, not how many rows. Fifty-one weeks of
 *    408 games is 51 pieces of evidence for anything correlated within a week,
 *    and the naive-to-clustered inflation ratio says how badly a per-row test
 *    would have overstated it.
 *
 * 7. DISTINGUISHABILITY. If the challenger's per-observation losses are
 *    essentially the incumbent's — correlation at the ceiling and a mean
 *    difference tiny against the loss scale — then it is not a different model
 *    in any way this data can see. It is a relabelling, and it is refused
 *    BEFORE the p-values are read, because a relabelling with a large enough
 *    sample will eventually produce a significant difference from rounding.
 *    This is the gate the ensemble's "31 independent components" needed.
 *
 * Verdicts are `promote`, `reject`, or `inconclusive`. There is deliberately
 * no fourth value that means "promote anyway."
 */
import { pairedBootstrapDiff, alwaysValidPValue } from '../services/backtest-significance.js';

export const GOVERNED_COMPARISON_VERSION = 'governed-comparison/1.0.0';

const isNum = Number.isFinite;
const r4 = x => (isNum(x) ? +x.toFixed(4) : null);
const r6 = x => (isNum(x) ? +x.toFixed(6) : null);
const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    sab += da * db; saa += da * da; sbb += db * db;
  }
  if (saa <= 0 || sbb <= 0) return null;
  return sab / Math.sqrt(saa * sbb);
}

/**
 * Holm-Bonferroni step-down over a family of p-values.
 *
 * Returns, per entry, the adjusted p-value and whether it clears alpha. Holm
 * controls the family-wise error rate under arbitrary dependence, which is the
 * situation here: RMSE, MAE, CRPS and Brier on the same games move together.
 */
export function holmAdjust(entries, alpha = 0.05) {
  const usable = entries.filter(e => isNum(e.p));
  const sorted = [...usable].sort((x, y) => x.p - y.p);
  const m = sorted.length;
  let running = 0;
  const adjusted = new Map();
  sorted.forEach((e, i) => {
    const adj = Math.min(1, (m - i) * e.p);
    running = Math.max(running, adj);   // step-down monotonicity
    adjusted.set(e.key, running);
  });
  return entries.map(e => ({
    ...e,
    p_adjusted: isNum(e.p) ? r6(adjusted.get(e.key)) : null,
    significant_adjusted: isNum(e.p) ? adjusted.get(e.key) < alpha : false,
    family_size: m
  }));
}

/**
 * Compare one challenger against one incumbent on aligned per-observation
 * losses, and return a governed verdict.
 *
 * Losses are LOWER-IS-BETTER throughout (squared error, absolute error, CRPS,
 * Brier, negative log score). Arrays must be aligned observation-for-
 * observation across every metric and both models; `alignLosses` below is the
 * safe way to build them.
 *
 * @param {object} opts
 * @param {object} opts.incumbent        {label, losses: {metric: number[]}}
 * @param {object} opts.challenger       {label, losses: {metric: number[]}}
 * @param {string} opts.primaryMetric    REQUIRED for a promotable verdict
 * @param {Array}  [opts.groups]         cluster key per observation (e.g. season|week)
 * @param {number} [opts.alpha]
 * @param {object} [opts.minEffect]      per-metric minimum improvement worth having
 * @param {object} [opts.sigma]          per-metric sigma DECLARED IN ADVANCE
 * @param {object} [opts.tau]            per-metric mSPRT prior scale. Left to
 *   `alwaysValidPValue`'s own weakly-informative default (tau = sigma) unless
 *   declared, for a reason worth stating: the mSPRT's power is a BAND around
 *   tau, and the two errors are not symmetric. A prior far too wide costs only
 *   an additive 0.5*log(n*tau^2/sigma^2) penalty; a prior far too narrow
 *   collapses the likelihood ratio and cannot detect anything, including large
 *   effects. Erring wide is therefore correct, and tau = sigma is the
 *   conventional choice.
 *
 *   That choice still moves answers, so it is not left to whoever is running
 *   the comparison. GATE 8 recomputes the primary metric across a tau grid and
 *   blocks any verdict that depends on where in that grid it landed.
 * @param {number} [opts.looks]          how many times this sequence has been checked
 * @param {number} [opts.minClusters]
 * @param {number} [opts.iterations] [opts.seed]
 */
export function governedComparison({
  incumbent, challenger,
  primaryMetric = null,
  groups = null,
  alpha = 0.05,
  minEffect = {},
  sigma = {},
  tau = {},
  looks = 1,
  minClusters = 20,
  identicalCorrelation = 0.999,
  identicalRelativeEffect = 1e-3,
  iterations = 4000,
  seed = 1
} = {}) {
  if (!incumbent?.losses || !challenger?.losses) {
    return { error: 'both incumbent and challenger need a losses map' };
  }
  const metrics = Object.keys(incumbent.losses).filter(m => Array.isArray(challenger.losses[m]));
  if (!metrics.length) return { error: 'no metric is present on both models' };

  const blockers = [];
  const notes = [];

  /* ---- gate 1: preregistration ---- */
  const preregistered = Boolean(primaryMetric) && metrics.includes(primaryMetric);
  if (!primaryMetric) {
    blockers.push('no_primary_metric_declared: a comparison without one preregistered metric is advisory only');
  } else if (!metrics.includes(primaryMetric)) {
    blockers.push(`primary_metric_absent: '${primaryMetric}' is not present on both models`);
  }

  /* ---- per-metric statistics ---- */
  const perMetric = {};
  for (const m of metrics) {
    const a = incumbent.losses[m].filter(isNum);
    const b = challenger.losses[m].filter(isNum);
    const n = Math.min(incumbent.losses[m].length, challenger.losses[m].length);
    if (a.length !== incumbent.losses[m].length || b.length !== challenger.losses[m].length) {
      notes.push(`${m}: non-finite losses were present and dropped, which breaks pairing — check alignment`);
    }

    const boot = pairedBootstrapDiff(incumbent.losses[m], challenger.losses[m],
      { iterations, seed, groups: groups ?? undefined });

    // The paired difference sequence, in chronological order, is what the
    // sequential test consumes: positive = challenger worse on this row.
    const diffs = [];
    for (let i = 0; i < n; i++) {
      const d = challenger.losses[m][i] - incumbent.losses[m][i];
      if (isNum(d)) diffs.push(d);
    }
    const declaredSigma = isNum(sigma[m]) && sigma[m] > 0 ? sigma[m] : undefined;
    const declaredTau = isNum(tau[m]) && tau[m] > 0 ? tau[m] : undefined;
    const av = alwaysValidPValue(diffs, { sigma: declaredSigma, tau: declaredTau });
    const pSeq = av.error ? null : (av.p_always_valid ?? av.p_fixed_sample_only);

    const incumbentMean = mean(a);
    const challengerMean = mean(b);
    const improvement = isNum(incumbentMean) && isNum(challengerMean) ? incumbentMean - challengerMean : null;
    const relative = isNum(improvement) && incumbentMean ? improvement / Math.abs(incumbentMean) : null;

    perMetric[m] = {
      n: diffs.length,
      incumbent_mean: r6(incumbentMean),
      challenger_mean: r6(challengerMean),
      improvement: r6(improvement),          // positive = challenger better
      relative_improvement: r4(relative),
      bootstrap: boot,
      sequential: av.error ? { error: av.error } : {
        p: r6(pSeq), anytime_valid: av.anytime_valid,
        variance_source: av.variance_source, n: av.n, mean: av.mean, sigma: av.sigma,
        tau: av.tau, tau_source: declaredTau != null ? 'declared' : 'weakly_informative_default'
      },
      // Kept as working state for the tau grid below, stripped before return.
      diffs,
      loss_correlation: r4(pearson(a, b))
    };
  }

  /* ---- gate 8: does the verdict survive the choice of prior scale? ----
   *
   * tau is the one knob in this procedure an analyst could quietly turn until a
   * result appeared, and it is not a knob the data constrains. So it is turned
   * here, across a grid spanning three orders of decision-relevant scale, and a
   * primary-metric significance that is not stable across it is refused. The
   * grid is fixed in code rather than passed in, so it cannot be tuned either.
   */
  const primaryForTau = preregistered ? perMetric[primaryMetric] : null;
  let tauGrid = null;
  if (primaryForTau?.diffs?.length >= 5) {
    const sigmaHere = isNum(sigma[primaryMetric]) && sigma[primaryMetric] > 0 ? sigma[primaryMetric] : undefined;
    const floor = isNum(minEffect[primaryMetric]) && minEffect[primaryMetric] > 0 ? minEffect[primaryMetric] : null;
    const observedSigma = primaryForTau.sequential?.sigma ?? null;
    const candidates = [
      floor != null ? { label: 'minimum_effect', tau: floor } : null,
      floor != null ? { label: '3x_minimum_effect', tau: 3 * floor } : null,
      observedSigma ? { label: 'sigma', tau: observedSigma } : null,
      observedSigma ? { label: '3x_sigma', tau: 3 * observedSigma } : null
    ].filter(Boolean);
    tauGrid = candidates.map(c => {
      const r = alwaysValidPValue(primaryForTau.diffs, { sigma: sigmaHere, tau: c.tau });
      const p = r.error ? null : (r.p_always_valid ?? r.p_fixed_sample_only);
      // Holm is applied at the same family size the headline used, so the grid
      // is compared on the same footing rather than against a raw p.
      const adj = p == null ? null : Math.min(1, metrics.length * p);
      return { ...c, tau: r6(c.tau), p: r6(p), p_adjusted: r6(adj), significant: adj != null && adj < alpha };
    });
    const outcomes = new Set(tauGrid.map(g => g.significant));
    if (outcomes.size > 1) {
      blockers.push('verdict_depends_on_prior_scale: the primary metric is significant at some mSPRT ' +
        'prior scales and not others (' +
        tauGrid.map(g => `${g.label}=${g.significant ? 'sig' : 'ns'}`).join(', ') +
        '), so the conclusion is a property of the prior rather than of the models');
    }
  }

  /* ---- gate 7: is the challenger distinguishable at all? ---- */
  const primary = preregistered ? perMetric[primaryMetric] : null;
  const identityMetric = primary ?? perMetric[metrics[0]];
  if (identityMetric) {
    const corr = identityMetric.loss_correlation;
    const rel = Math.abs(identityMetric.relative_improvement ?? 0);
    if (isNum(corr) && corr >= identicalCorrelation && rel <= identicalRelativeEffect) {
      blockers.push(`indistinguishable_from_incumbent: per-observation losses correlate at ${corr} ` +
        `with a relative effect of ${rel} — this is the same model wearing a different label, and ` +
        'no p-value computed on it means anything');
    }
  }

  /* ---- gate 6: independent evidence ---- */
  const clusterCount = groups ? new Set(groups).size : null;
  if (groups && clusterCount != null && clusterCount < minClusters) {
    blockers.push(`too_few_independent_clusters: ${clusterCount} clusters (< ${minClusters}); ` +
      'the row count overstates how much independent evidence this is');
  }
  if (!groups) {
    notes.push('no cluster keys supplied, so the bootstrap resampled rows independently — if the rows ' +
      'are correlated (same game, same week) the interval below is too narrow');
  }

  /* ---- gate 2: multiplicity across the family actually examined ---- */
  const family = holmAdjust(metrics.map(m => ({
    key: m,
    p: perMetric[m].sequential?.p ?? null,
    direction: (perMetric[m].improvement ?? 0) > 0 ? 'challenger_better' : 'challenger_worse'
  })), alpha);
  for (const f of family) {
    perMetric[f.key].p_adjusted = f.p_adjusted;
    perMetric[f.key].significant_adjusted = f.significant_adjusted;
    perMetric[f.key].family_size = f.family_size;
  }

  /* ---- gate 5: look count vs anytime validity ---- */
  const primaryAnytimeValid = primary?.sequential?.anytime_valid === true;
  if (looks > 1 && !primaryAnytimeValid) {
    blockers.push(`repeated_look_without_anytime_validity: this is look ${looks} and sigma was not ` +
      'declared in advance, so the p-value is valid at one endpoint only. Declare sigma from a ' +
      'hold-out sample, or freeze the sample.');
  }

  /* ---- gate 3: contradiction ---- */
  if (primary) {
    const primaryBetter = (primary.improvement ?? 0) > 0 && primary.significant_adjusted;
    const contradictions = metrics.filter(m => m !== primaryMetric &&
      perMetric[m].significant_adjusted && (perMetric[m].improvement ?? 0) < 0);
    if (primaryBetter && contradictions.length) {
      blockers.push(`contradictory_evidence: the primary metric improves while ${contradictions.join(', ')} ` +
        'significantly worsen — this is a trade-off, not a win');
    }
  }

  /* ---- gate 4: effect floor ---- */
  if (primary) {
    const floor = isNum(minEffect[primaryMetric]) ? minEffect[primaryMetric] : null;
    if (floor != null && (primary.improvement ?? 0) < floor) {
      blockers.push(`below_effect_floor: improvement ${r6(primary.improvement)} on ${primaryMetric} ` +
        `does not reach the declared minimum of ${floor}`);
    }
    if (floor == null) {
      notes.push(`no minimum effect declared for ${primaryMetric}; significance alone is being used, ` +
        'which a large enough sample will always eventually supply');
    }
  }

  /* ---- verdict ---- */
  let verdict, reason;
  if (!primary) {
    verdict = 'inconclusive';
    reason = 'advisory only: no preregistered primary metric';
  } else if (blockers.length) {
    // A blocked comparison is not a rejection of the model — it is a refusal
    // to answer the question on this evidence. The distinction matters: a
    // rejection ends a line of work, a block says fix the evidence.
    const rejecting = (primary.improvement ?? 0) <= 0 && primary.significant_adjusted;
    verdict = rejecting ? 'reject' : 'inconclusive';
    reason = rejecting
      ? `the challenger is significantly WORSE on ${primaryMetric}, and separately: ${blockers[0]}`
      : `blocked: ${blockers[0]}`;
  } else if ((primary.improvement ?? 0) > 0 && primary.significant_adjusted && primary.bootstrap?.significant) {
    verdict = 'promote';
    reason = `challenger improves ${primaryMetric} by ${r6(primary.improvement)} ` +
      `(Holm-adjusted p ${primary.p_adjusted}, bootstrap CI90 [${primary.bootstrap.ci90}] excludes zero)`;
  } else if ((primary.improvement ?? 0) < 0 && primary.significant_adjusted) {
    verdict = 'reject';
    reason = `challenger is significantly worse on ${primaryMetric} ` +
      `(Holm-adjusted p ${primary.p_adjusted})`;
  } else {
    verdict = 'inconclusive';
    reason = primary.bootstrap?.significant === false
      ? `the ${primaryMetric} difference is inside sampling noise (bootstrap CI90 ` +
        `[${primary.bootstrap.ci90}] straddles zero)`
      : `the ${primaryMetric} difference does not survive multiplicity correction ` +
        `(adjusted p ${primary.p_adjusted})`;
  }

  return {
    version: GOVERNED_COMPARISON_VERSION,
    incumbent: incumbent.label ?? 'incumbent',
    challenger: challenger.label ?? 'challenger',
    primary_metric: primaryMetric,
    preregistered,
    alpha, looks,
    tau_policy: 'tau is left at the weakly-informative default and the verdict is required to be ' +
      'stable across a fixed grid of prior scales (gate 8)',
    observations: primary?.n ?? perMetric[metrics[0]]?.n ?? 0,
    independent_clusters: clusterCount,
    metrics: Object.fromEntries(Object.entries(perMetric).map(([k, v]) => {
      const { diffs: _dropped, ...rest } = v;   // the raw sequence is working state, not output
      return [k, rest];
    })),
    tau_grid: tauGrid,
    metric_family: family.map(f => f.key),
    blockers,
    notes,
    verdict,
    reason,
    promotable: verdict === 'promote'
  };
}

/**
 * Build aligned loss arrays from two lists of per-observation records.
 *
 * Alignment is by KEY, never by position. Two models that survived different
 * listwise deletions can end up with equal-length arrays describing different
 * games, and a positional pairing would compare them anyway and report the
 * difference as model skill. Ordering is chronological, which the sequential
 * test assumes.
 *
 * @param {Array} a - incumbent records
 * @param {Array} b - challenger records
 * @param {object} opts
 * @param {function} opts.key      record -> alignment key
 * @param {function} [opts.order]  record -> sortable number (default: insertion)
 * @param {function} [opts.cluster] record -> cluster key
 * @param {object} opts.losses     {metricName: record => number}
 */
export function alignLosses(a, b, { key, order = null, cluster = null, losses = {} } = {}) {
  if (typeof key !== 'function') throw new Error('alignLosses needs a key function');
  const mapB = new Map();
  for (const r of b) mapB.set(key(r), r);
  let pairs = [];
  for (const ra of a) {
    const k = key(ra);
    const rb = mapB.get(k);
    if (rb) pairs.push({ k, ra, rb });
  }
  if (order) pairs = pairs.sort((x, y) => order(x.ra) - order(y.ra));

  const metricNames = Object.keys(losses);
  const outA = Object.fromEntries(metricNames.map(m => [m, []]));
  const outB = Object.fromEntries(metricNames.map(m => [m, []]));
  const groups = [];
  const keys = [];
  let dropped = 0;

  for (const { k, ra, rb } of pairs) {
    const va = metricNames.map(m => losses[m](ra));
    const vb = metricNames.map(m => losses[m](rb));
    // One metric missing on one model would desynchronise every array, so the
    // whole observation is dropped and counted.
    if (va.some(v => !isNum(v)) || vb.some(v => !isNum(v))) { dropped++; continue; }
    metricNames.forEach((m, i) => { outA[m].push(va[i]); outB[m].push(vb[i]); });
    groups.push(cluster ? cluster(ra) : k);
    keys.push(k);
  }
  return { a: outA, b: outB, groups, keys, matched: keys.length, dropped,
    unmatched_a: a.length - pairs.length, unmatched_b: b.length - pairs.length };
}
