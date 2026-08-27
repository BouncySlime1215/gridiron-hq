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
 * @returns {mean_diff, ci90:[lo,hi], p_b_better, significant, n, iterations}
 *   `significant` is true only when the 90% interval excludes zero — i.e. the
 *   direction of the difference would survive a different, similarly-drawn
 *   test set. `p_b_better` is the fraction of resamples where b <= a (b
 *   better-or-tied on a lower-is-better metric like CRPS or absolute error).
 */
export function pairedBootstrapDiff(valuesA, valuesB, { iterations = 2000, seed = 1 } = {}) {
  const n = Math.min(valuesA.length, valuesB.length);
  if (n < 10) return { error: `too few paired observations (${n}) to bootstrap meaningfully` };

  const diffs = new Array(iterations);
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
