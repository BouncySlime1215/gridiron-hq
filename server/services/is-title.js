/**
 * U6 IS-TITLE: importance sampling for one team's (Nick's) title odds.
 *
 * At 0.1-1% title odds a few thousand plain runs hold a handful of titles. The sim has
 * one once-per-season factor per team: the team-mean term (season-sim.js#teamOffsets,
 * AVAIL-HORIZON-3), a standard normal Z per run that moves every week of that team's
 * lineup by TEAM_MEAN_SD x Z. Nick's title is driven hard by his Z, so IS draws his Z
 * from a proposal that visits the good seasons more often and weights each run back.
 *
 * Proposal: a defensive mixture q(z) = eps f(z) + (1 - eps) sum_k pi_k N(z; mu_k, I),
 * f = N(0, I). Every run's weight is f/q over the FULL mixture (whichever component drew
 * it), so each weight is <= 1/eps. mu_k, pi_k come from a cross-entropy pilot on run
 * indices the main and check runs never use.
 *
 * Output: the weighted mean of each run's title value (an indicator, or RB-TITLE's
 * conditional probability), its independent-batch SE, and ESS_event.
 *
 * GRIDIRON_IS_TITLE: unset / '0' = off; 'shadow' = computed beside the served odds,
 * never served; '1' = served when the unweighted check agrees. Preview does NOT turn
 * it on: it moves a served number.
 */
import { keyedSeed, keyedNormal } from './stats-util.js';

export const IS_TITLE_ENV = 'GRIDIRON_IS_TITLE';

/** 'off' | 'shadow' | 'on', read per call. */
export function isTitleMode() {
  const v = process.env[IS_TITLE_ENV];
  if (v === '1' || v === 'on') return 'on';
  if (v === 'shadow') return 'shadow';
  return 'off';
}

/** Pre-registered settings (docs/tdd/2026-09-25-is-title.tdd.md). */
export const IS_DEFAULTS = Object.freeze({
  eps: 0.2, K: 2, pilotRounds: 2, pilotRuns: 1000, mainRuns: 8000, batches: 20,
  checkRuns: 10000, minEss: 200, checkSe: 2
});

/** Disjoint run-index windows: pilot, main and check never share a run's draws. */
export const RUN_BASE = Object.freeze({ pilot: 1 << 24, main: 2 << 24, check: 3 << 24 });

const uniform = (key, run) => keyedSeed(key, 'u', run) / 4294967296;

/**
 * The defensive mixture. `comps` [{ pi, mu: number[] }] with pi summing to 1; an empty
 * list (or eps = 1) is f itself and every weight is 1.
 */
export function mixture({ d, eps, comps }) {
  if (!(eps > 0 && eps <= 1)) throw new Error(`IS-TITLE: eps must be in (0, 1], got ${eps}`);
  const live = comps.length ? comps : [];
  const e = live.length ? eps : 1;
  const sq = live.map(c => c.mu.reduce((s, m) => s + m * m, 0));
  /** f(z) / q(z) = 1 / (eps + (1 - eps) sum_k pi_k exp(z.mu_k - |mu_k|^2 / 2)). */
  const weight = z => {
    let s = 0;
    for (let k = 0; k < live.length; k++) {
      let dot = 0;
      for (let j = 0; j < d; j++) dot += z[j] * live[k].mu[j];
      s += live[k].pi * Math.exp(dot - sq[k] / 2);
    }
    return 1 / (e + (1 - e) * s);
  };
  /** One draw addressed by (key, run): the same pair always gives the same z. */
  const sample = (key, run) => {
    const u = uniform(key, run);
    let mu = null;
    if (u >= e) {
      let acc = e;
      for (const c of live) { acc += (1 - e) * c.pi; if (u < acc) { mu = c.mu; break; } }
      mu = mu ?? live[live.length - 1].mu;
    }
    const z = new Float64Array(d);
    for (let j = 0; j < d; j++) z[j] = (mu ? mu[j] : 0) + keyedNormal(keyedSeed(key, 'z', j), run);
    return z;
  };
  return { d, eps: e, comps: live, weight, sample };
}

/**
 * Weighted EM for K unit-covariance Gaussians on points `zs` with non-negative
 * weights `om`: the cross-entropy update (argmax_q sum om_i log q(z_i)).
 */
export function fitComponents(zs, om, { d, K, iters = 30 }) {
  const total = om.reduce((s, v) => s + v, 0);
  if (!(total > 0)) return [];
  const mean = new Float64Array(d), sd = new Float64Array(d);
  zs.forEach((z, i) => { for (let j = 0; j < d; j++) mean[j] += om[i] * z[j] / total; });
  zs.forEach((z, i) => { for (let j = 0; j < d; j++) sd[j] += om[i] * (z[j] - mean[j]) ** 2 / total; });
  let comps = Array.from({ length: K }, (_, k) => ({
    pi: 1 / K,
    mu: Array.from(mean, (m, j) => m + (K > 1 ? (k / (K - 1) - 0.5) : 0) * Math.sqrt(sd[j]))
  }));
  const r = new Float64Array(K);
  for (let it = 0; it < iters; it++) {
    const piAcc = new Float64Array(K), muAcc = comps.map(() => new Float64Array(d));
    zs.forEach((z, i) => {
      if (!om[i]) return;
      let s = 0;
      for (let k = 0; k < K; k++) {
        let q = 0;
        for (let j = 0; j < d; j++) q += (z[j] - comps[k].mu[j]) ** 2;
        r[k] = comps[k].pi * Math.exp(-q / 2); s += r[k];
      }
      for (let k = 0; k < K; k++) {
        const w = s > 0 ? om[i] * r[k] / s : om[i] / K;
        piAcc[k] += w;
        for (let j = 0; j < d; j++) muAcc[k][j] += w * z[j];
      }
    });
    comps = comps.map((c, k) => piAcc[k] > 0
      ? { pi: piAcc[k] / total, mu: Array.from(muAcc[k], v => v / piAcc[k]) }
      : { pi: 0, mu: c.mu });
  }
  return comps.filter(c => c.pi > 1e-6).map(c => ({ pi: c.pi, mu: c.mu }))
    .map((c, _, all) => ({ pi: c.pi / all.reduce((s, x) => s + x.pi, 0), mu: c.mu }));
}

/**
 * Cross-entropy pilot. `evaluate(mix, base, n)` plays n runs at run indices
 * base..base+n-1 with Nick's z drawn from `mix` and returns { zs, values }. Round t
 * fits the next proposal to om_i = f/q_t(z_i) x value_i. Returns the final mixture
 * and each round's event count. No title in any pilot run leaves q = f.
 */
export function cePilot({ d, K, eps, rounds, runs, evaluate }) {
  let mix = mixture({ d, eps, comps: [] });
  const log = [];
  for (let t = 0; t < rounds; t++) {
    const { zs, values } = evaluate(mix, RUN_BASE.pilot + t * runs, runs);
    const om = values.map((v, i) => (v > 0 ? mix.weight(zs[i]) * v : 0));
    const events = values.filter(v => v > 0).length;
    log.push({ round: t, events });
    const comps = fitComponents(zs, om, { d, K });
    if (comps.length) mix = mixture({ d, eps, comps });
  }
  return { mix, rounds: log };
}

/**
 * The IS estimate from per-run values and weights: weighted mean, independent-batch SE
 * (contiguous batches of the i.i.d. runs), a normal 95% interval and ESS_event =
 * (sum w v)^2 / sum (w v)^2.
 */
export function isEstimate(values, weights, batches = IS_DEFAULTS.batches) {
  const n = values.length;
  let s = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const x = weights[i] * values[i]; s += x; s2 += x * x; }
  const mean = n ? s / n : null;
  const B = Math.min(batches, n);
  const size = Math.floor(n / B);
  const bm = [];
  for (let b = 0; b < B; b++) {
    let t = 0;
    for (let i = b * size; i < (b + 1) * size; i++) t += weights[i] * values[i];
    bm.push(t / size);
  }
  const bMean = bm.reduce((a, v) => a + v, 0) / B;
  const se = B > 1 ? Math.sqrt(bm.reduce((a, v) => a + (v - bMean) ** 2, 0) / (B - 1) / B) : null;
  return {
    mean, se, ess_event: s2 > 0 ? (s * s) / s2 : 0,
    ci: mean == null || se == null ? [null, null]
      : [+Math.max(0, mean - 1.96 * se).toFixed(4), +Math.min(1, mean + 1.96 * se).toFixed(4)]
  };
}

/**
 * Auto-off: the IS estimate is served only if it agrees with an unweighted check
 * within `checkSe` combined SEs and its ESS_event clears `minEss`.
 */
export function autoOffCheck(is, check, { checkSe = IS_DEFAULTS.checkSe, minEss = IS_DEFAULTS.minEss } = {}) {
  const se = Math.sqrt((is.se ?? 0) ** 2 + (check.se ?? 0) ** 2);
  const z = se > 0 ? Math.abs(is.mean - check.mean) / se : (is.mean === check.mean ? 0 : Infinity);
  if (!(is.ess_event >= minEss)) return { ok: false, z, reason: `too few effective title runs (${Math.round(is.ess_event)} < ${minEss})` };
  if (z > checkSe) return { ok: false, z, reason: `disagrees with the unweighted check by ${z.toFixed(2)} SE (> ${checkSe})` };
  return { ok: true, z, reason: null };
}

/**
 * One IS-TITLE estimate for team `meId` on a prepared season (season-sim.js calls this;
 * `playSeasons` and `teamOffsets` are passed in because that module imports this one).
 * Pilot (conditional title values: RB-TITLE's probability, a smoother CE target than
 * the indicator), main runs with the served title estimator (`rbMode` 'on' =
 * conditional, else the indicator), then the unweighted check, each on its own run
 * window. Returns the fields season-sim carries as `is_title`.
 */
export function isTitleRun({ prep, teams, meId, rawPointsFor, playSeasons, teamOffsets, rbMode, opts = {}, now = () => performance.now() }) {
  const o = { ...IS_DEFAULTS, ...opts };
  const sd = prep.teamMeanSd ?? 0;
  const base = { roster_id: meId, eps: o.eps, K: o.K };
  if (!(sd > 0)) return { ...base, status: 'inert', reason: 'no once-per-season factor to tilt: the team-mean term is off' };
  if (!teams.some(t => t.roster_id === meId)) return { ...base, status: 'inert', reason: 'that team is not in this league' };
  const ids = teams.map(t => t.roster_id);
  const key = keyedSeed(prep.world, 'is-title', meId);
  const served = rbMode === 'on' ? 'on' : 'off';

  /** n runs at indices start..start+n-1; Nick's z from `mix` (null: every team nominal). */
  const play = (mix, start, n, rb) => {
    const zs = new Array(n);
    const offsetsOf = run => {
      const m = teamOffsets(prep.world, ids, start + run, sd);
      if (mix) { const z = mix.sample(key, start + run); zs[run] = z; m.set(meId, sd * z[0]); }
      return m;
    };
    const out = playSeasons({ ...prep, rbTitle: rb, offsetsOf }, teams, n, true, (t, run, week) => rawPointsFor(t, start + run, week));
    const pr = out.per_run.get(meId);
    return { zs, values: Array.from(rb === 'shadow' ? pr.title_rb : pr.title) };
  };

  const t0 = now();
  const pilot = cePilot({ d: 1, K: o.K, eps: o.eps, rounds: o.pilotRounds, runs: o.pilotRuns,
    evaluate: (mix, start, n) => play(mix, start, n, 'shadow') });
  const t1 = now();
  const main = play(pilot.mix, RUN_BASE.main, o.mainRuns, served);
  const weights = main.zs.map(z => pilot.mix.weight(z));
  const est = isEstimate(main.values, weights, o.batches);
  const t2 = now();
  let check = null, verdict = null;
  if (o.checkRuns > 0) {
    const c = play(null, RUN_BASE.check, o.checkRuns, served);
    check = isEstimate(c.values, new Float64Array(c.values.length).fill(1), o.batches);
    verdict = autoOffCheck(est, check, o);
  }
  const t3 = now();
  return {
    ...base,
    status: verdict == null ? 'unchecked' : verdict.ok ? 'ok' : 'auto_off',
    reason: verdict?.reason ?? (verdict ? null : 'no unweighted check was run'),
    estimator: served === 'on' ? 'conditional' : 'indicator',
    estimate: est.mean, se: est.se, ci: est.ci, ess_event: +est.ess_event.toFixed(1),
    max_weight: +Math.max(...weights).toFixed(3),
    mixture: pilot.mix.comps.map(c => ({ pi: +c.pi.toFixed(3), mu: c.mu.map(v => +v.toFixed(3)) })),
    pilot_events: pilot.rounds.map(r => r.events),
    runs: { pilot: o.pilotRounds * o.pilotRuns, main: o.mainRuns, check: o.checkRuns },
    check: check ? { estimate: check.mean, se: check.se, z: +verdict.z.toFixed(2) } : null,
    ms: { pilot: Math.round(t1 - t0), main: Math.round(t2 - t1), check: Math.round(t3 - t2) }
  };
}
