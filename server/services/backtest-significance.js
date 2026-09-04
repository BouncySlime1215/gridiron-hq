/**
 * Is a backtest improvement real, or did we just get a lucky held-out season?
 *
 * The 1.1 fit compared two models on ~150-382 players and one CRPS number
 * each. A single number invites exactly the mistake the Build Order warns
 * against elsewhere ("never loosen a gate to let a model through") in its
 * quieter form: treating a difference that's well within sampling noise as a
 * real result, in either direction — wrongly adopting a fit that only looked
 * better by chance, or wrongly rejecting one that only looked worse by chance.
 *
 * The fix is a paired bootstrap over players, which is standard practice for
 * comparing two forecasters on the same test cases (used the same way in
 * meteorology CRPS-skill comparisons): resample which players are in the test
 * set, with replacement, thousands of times, and see how much the *difference*
 * between the two models moves around. If the resulting interval straddles
 * zero, the observed gap is not distinguishable from noise at this sample
 * size — full stop, regardless of which side of zero the point estimate fell
 * on. Both models are graded on identical players and identical Monte Carlo
 * draws per resample (only which players are IN the resample changes), so
 * simulation randomness is not a confound — it is exactly cancelled out
 * player-by-player before the resampling ever happens.
 */
import { random, withRandomSeed } from './stats-util.js';
import { crps } from './backtest.js';

/**
 * Generic paired bootstrap: given per-unit values for two models over the
 * SAME units (players), in the SAME order, estimate how much `mean(b) -
 * mean(a)` would move under resampling of which units were tested.
 *
 * When units cluster into groups whose members are not independent (e.g.
 * several player-weeks drawn from the same NFL game share weather, game
 * script, and pace), plain per-unit resampling understates the true
 * sampling variance: correlated units move together in reality but are
 * shuffled independently by the resample, which inflates the effective
 * sample size and makes the reported CI too narrow (Brill, Yurko & Wyner,
 * "Exploring the Difficulty of Estimating Win Probability: A Simulation
 * Study," arXiv:2406.16171, 2024 — NFL play-by-play bootstraps at 60%
 * actual coverage vs 90% nominal for exactly this reason). Passing `groups`
 * (same length as valuesA/valuesB, one cluster key per unit) switches to a
 * block bootstrap: whole groups are resampled with replacement instead of
 * individual units, preserving within-group correlation.
 *
 * @param {number[]} valuesA
 * @param {number[]} valuesB
 * @param {object} [opts]
 * @param {number} [opts.iterations]
 * @param {number} [opts.seed]
 * @param {Array} [opts.groups] - per-unit cluster key (e.g. game id). When
 *   given, resampling draws whole groups rather than individual units.
 * @returns {mean_diff, ci90:[lo,hi], p_b_better, significant, n, iterations}
 *   `significant` is true only when the 90% interval excludes zero — i.e. the
 *   direction of the difference would survive a different, similarly-drawn
 *   test set. `p_b_better` is the fraction of resamples where b <= a (b
 *   better-or-tied on a lower-is-better metric like CRPS or absolute error).
 */
export function pairedBootstrapDiff(valuesA, valuesB, { iterations = 2000, seed = 1, groups } = {}) {
  const n = Math.min(valuesA.length, valuesB.length);
  if (n < 10) return { error: `too few paired observations (${n}) to bootstrap meaningfully` };

  const diffs = new Array(iterations);
  if (groups && groups.length >= n) {
    const byGroup = new Map();
    for (let i = 0; i < n; i++) {
      const key = groups[i];
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(i);
    }
    const groupIndexLists = [...byGroup.values()];
    const numGroups = groupIndexLists.length;
    withRandomSeed(seed, () => {
      for (let it = 0; it < iterations; it++) {
        let sumA = 0, sumB = 0, count = 0;
        for (let g = 0; g < numGroups; g++) {
          const idxs = groupIndexLists[Math.floor(random() * numGroups)];
          for (const idx of idxs) {
            sumA += valuesA[idx]; sumB += valuesB[idx]; count++;
          }
        }
        diffs[it] = (sumB - sumA) / count;
      }
    });
  } else {
    withRandomSeed(seed, () => {
      for (let it = 0; it < iterations; it++) {
        let sumA = 0, sumB = 0;
        for (let i = 0; i < n; i++) {
          const idx = Math.floor(random() * n);
          sumA += valuesA[idx]; sumB += valuesB[idx];
        }
        diffs[it] = (sumB - sumA) / n;
      }
    });
  }
  diffs.sort((x, y) => x - y);
  const mean_diff = diffs.reduce((s, x) => s + x, 0) / iterations;
  const lo = diffs[Math.floor(iterations * 0.05)];
  const hi = diffs[Math.floor(iterations * 0.95)];
  const p_b_better = diffs.filter(d => d <= 0).length / iterations;
  return {
    mean_diff: +mean_diff.toFixed(4), ci90: [+lo.toFixed(4), +hi.toFixed(4)],
    p_b_better: +p_b_better.toFixed(3),
    significant: !(lo <= 0 && hi >= 0),
    n, iterations
  };
}

/**
 * Aligns two prediction maps against the same truth (same player set, same
 * order both models see), returning per-player absolute errors for each —
 * exactly what gradePoint's MAE averages, but kept per-player for bootstrapping.
 */
export function alignedAbsErrors(predsA, predsB, truth, { field = 'points', minGames = 4 } = {}) {
  const ids = [...predsA.keys()].filter(id =>
    predsB.has(id) && truth.get(Number(id))?.games >= minGames);
  const errA = [], errB = [];
  for (const id of ids) {
    const act = truth.get(Number(id))[field];
    errA.push(Math.abs(predsA.get(id) - act));
    errB.push(Math.abs(predsB.get(id) - act));
  }
  return { ids, errA, errB };
}

/**
 * Aligns two per-player sample sets against the same truth, returning
 * per-player CRPS for each model — what gradeDistribution's `crps` field
 * averages, kept per-player for bootstrapping.
 */
export function alignedCrps(samplesA, samplesB, truth, { field = 'points', minGames = 4 } = {}) {
  const ids = [...samplesA.keys()].filter(id =>
    samplesB.has(id) && truth.get(Number(id))?.games >= minGames);
  const crpsA = [], crpsB = [];
  for (const id of ids) {
    const act = truth.get(Number(id))[field];
    crpsA.push(crps(samplesA.get(id), act));
    crpsB.push(crps(samplesB.get(id), act));
  }
  return { ids, crpsA, crpsB };
}

/**
 * Always-valid p-value via a Gaussian-mixture sequential probability ratio
 * test (mSPRT).
 *
 * Ramesh Johari, Leo Pekelis, David Walsh, "Always Valid Inference:
 * Continuous Monitoring of A/B Tests," Operations Research, 2022
 * (originally arXiv:1512.04922, 2015).
 *
 * `pairedBootstrapDiff` and audit-registry.js's Šidák correction answer a
 * different question than this function does. Šidák corrects across a
 * FIXED, already-decided set of hypotheses — it says "given that N audits
 * were filed, here is the threshold any one of them must beat." It says
 * nothing about a single hypothesis whose own evidence keeps growing (more
 * settled games arrive every week) being checked more than once as that
 * evidence accumulates. A fixed-N test's false-positive guarantee holds only
 * at the ONE sample size it was computed for; checking it at several sample
 * sizes as data arrives and stopping the first time it clears 0.05 inflates
 * the true false-positive rate well above 0.05, even though each individual
 * check looked correct in isolation. That is the same p-hacking failure mode
 * the audit registry exists to prevent, just inside one hypothesis instead
 * of across many — and the Šidák correction is not built to catch it.
 *
 * The mSPRT closes that gap. For n i.i.d.-ish paired observations with true
 * mean θ, tested against H0: θ=0, under a N(0, τ²) mixing prior on θ and a
 * (known or plugin) per-observation variance σ², the mixture likelihood
 * ratio has the closed form:
 *
 *   Λ_n = sqrt(σ² / (σ² + nτ²)) · exp( n²τ²X̄ₙ² / (2σ²(σ² + nτ²)) )
 *
 * Λ_n is a nonnegative martingale under H0 with E[Λ_n] = 1, so by Ville's
 * maximal inequality, P(sup_n Λ_n ≥ 1/α) ≤ α — the false-positive rate is
 * controlled AT ANY STOPPING TIME n, not only at one sample size fixed in
 * advance. The always-valid p-value at the current look is min(1, 1/Λ_n),
 * and — unlike a fixed-N p-value — it stays honest even if this same
 * sequence gets checked again next week with more games appended.
 *
 * `sigma`/`tau` should be fixed in advance (estimated from a hold-out
 * sample, not the sequence under test) whenever the same sequence will be
 * checked more than once as it grows; audit-registry.js only ever calls
 * this once per sealed audit (audits are sealed on first run and never
 * re-run), so a plug-in estimate from the sequence at hand is acceptable
 * there. Tests below use a fixed, known sigma to verify the anytime-validity
 * property against ground truth rather than this practical shortcut.
 */
export function alwaysValidPValue(sequence, { tau, sigma } = {}) {
  const xs = sequence.filter(Number.isFinite);
  const n = xs.length;
  if (n < 5) return { error: `too few observations (${n}) for an always-valid sequential test` };
  const mean_ = xs.reduce((s, x) => s + x, 0) / n;
  const sigma2 = Number.isFinite(sigma) && sigma > 0 ? sigma * sigma
    : Math.max(1e-9, xs.reduce((s, x) => s + (x - mean_) ** 2, 0) / Math.max(1, n - 1));
  // Default prior scale: "a plausible true effect is on the order of one
  // observation's own noise" — a weakly-informative default, overridable.
  const tau2 = Number.isFinite(tau) && tau > 0 ? tau * tau : sigma2;
  const denom = sigma2 + n * tau2;
  const logLambda = 0.5 * Math.log(sigma2 / denom) + (n * n * tau2 * mean_ * mean_) / (2 * sigma2 * denom);
  const p = Math.min(1, Math.exp(-logLambda));
  return {
    n, mean: +mean_.toFixed(4), sigma: +Math.sqrt(sigma2).toFixed(4), tau: +Math.sqrt(tau2).toFixed(4),
    log_lambda: +logLambda.toFixed(4), p_always_valid: +p.toFixed(6),
    note: 'Valid to check at this or any other sample size within the same growing sequence without ' +
      "inflating the false-positive rate (Johari, Pekelis & Walsh 2022's mSPRT construction)."
  };
}

/**
 * The always-valid p-value recomputed at every prefix length 5..n. Exists
 * only to demonstrate/verify the anytime-validity property in tests — real
 * callers should call `alwaysValidPValue` once, on the full sequence
 * available right now, exactly as audit-registry.js does.
 */
export function alwaysValidPath(sequence, opts = {}) {
  const xs = sequence.filter(Number.isFinite);
  const path = [];
  for (let n = 5; n <= xs.length; n++) {
    const r = alwaysValidPValue(xs.slice(0, n), opts);
    path.push(r.error ? null : r.p_always_valid);
  }
  return path;
}
