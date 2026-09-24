#!/usr/bin/env node
// PROJ-03-a-v2 calibration of the shared game-path sampler.
// Pre-registration: docs/tdd/2026-09-23-proj-03a-v2-game-path.tdd.md section 3.
// The Normal CRPS closed form, the teamGames query shape and the weekly-cluster grading
// are carried over from PR #215's v1 script, which main keeps at scripts/proj03a-calibration.mjs;
// the v1 bucketed Gamma parts are dropped. Both scripts first landed at that one path.
// Read-only. Run on a local copy:
//   SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=.local-db/data.sqlite node scripts/proj03a-calibration.mjs
// Fit 2021-22; grade 2023 and 2024 separately. 2025 is never opened.
import { fitGamePath, gamePathKey, pearson, residuals, sampleGamePath, scoredGames } from './proj03a/game-path-v2.mjs';
import { normalCdf, quantile, random, weeklyClusterBootstrap, withRandomSeed } from '../server/services/stats-util.js';

const FIT = [2021, 2022];
const GRADE = [2023, 2024];
const M = Number(process.env.PROJ03A_DRAWS) || 4000;
const SQRT_PI = Math.sqrt(Math.PI);
const r = (v, d = 4) => (v == null ? null : +v.toFixed(d));

/** CRPS of Normal(mu, sigma) at y (Gneiting & Raftery 2007). From PR #215. */
export function crpsNormal(mu, sigma, y) {
  const z = (y - mu) / sigma;
  return sigma * (z * (2 * normalCdf(z) - 1) + 2 * Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI) - 1 / SQRT_PI);
}

/** Sample CRPS / energy score: E|X - y| - 0.5 E|X - X'|, X' = the draw half a sample away. */
function sampleScore(xs, y, dist) {
  const n = xs.length, h = n >> 1;
  let a = 0, b = 0;
  for (let i = 0; i < n; i++) a += dist(xs[i], y);
  for (let i = 0; i < h; i++) b += dist(xs[i], xs[i + h]);
  return a / n - 0.5 * b / h;
}
const abs1 = (x, y) => Math.abs(x - y);
const eucl = (x, y) => Math.hypot(x[0] - y[0], x[1] - y[1]);

/** Week-cluster bootstrap CI of the home/away residual correlation. */
function correlationCI(games, level = 0.9, iterations = 4000, seed = 20260923) {
  const byWeek = new Map();
  for (const g of games) (byWeek.get(g.week) ?? byWeek.set(g.week, []).get(g.week)).push(g);
  const weeks = [...byWeek.keys()], draws = [];
  withRandomSeed(seed, () => {
    for (let t = 0; t < iterations; t++) {
      const s = [];
      for (let i = 0; i < weeks.length; i++) s.push(...byWeek.get(weeks[Math.floor(random() * weeks.length)]));
      const { h, a } = residuals(s);
      draws.push(pearson(h, a));
    }
  });
  const tail = (1 - level) / 2;
  return [quantile(draws, tail), quantile(draws, 1 - tail)];
}

function grade(season, params) {
  const games = scoredGames(season, season);
  let crpsNorm = 0, crpsPath = 0, n = 0;
  const dRows = [], simH = [], simA = [];
  for (const g of games) {
    const pathDraws = [], indDraws = [];
    for (let m = 0; m < M; m++) {
      const key = gamePathKey(g.season, g.week, g.home, g.away, m);
      const p = sampleGamePath(g, key, params), q = sampleGamePath(g, key, params, 0);
      pathDraws.push([p.points.home, p.points.away]);
      indDraws.push([q.points.home, q.points.away]);
      if (m < 200) { simH.push(p.z.home); simA.push(p.z.away); }
    }
    const y = [g.home_pts, g.away_pts];
    for (const side of [0, 1]) {
      const implied = side ? g.total / 2 + g.spread / 2 : g.total / 2 - g.spread / 2;
      crpsNorm += crpsNormal(implied, params.sd, y[side]);
      crpsPath += sampleScore(pathDraws.map(x => x[side]), y[side], abs1);
      n++;
    }
    const d = sampleScore(pathDraws, y, eucl) - sampleScore(indDraws, y, eucl);
    dRows.push({ season: g.season, week: g.week, units: d, es_path: sampleScore(pathDraws, y, eucl) });
  }
  const boot = weeklyClusterBootstrap(dRows);
  const { h, a } = residuals(games);
  const hist = pearson(h, a), ci = correlationCI(games);
  const sim = pearson(simH, simA);
  const esPath = dRows.reduce((s, x) => s + x.es_path, 0) / dRows.length;
  const meanD = dRows.reduce((s, x) => s + x.units, 0) / dRows.length;
  return {
    season, games: games.length, team_games: n,
    crps: { normal_pooled: r(crpsNorm / n), path_sampler: r(crpsPath / n),
      pass: crpsPath / n <= crpsNorm / n + 0.01 },
    energy: { path: r(esPath), independent: r(esPath - meanD), mean_d: r(meanD, 5),
      d_ci95_week_cluster: boot.roi_95, clusters: boot.clusters,
      pass: boot.roi_95[1] != null && boot.roi_95[1] < 0, sign: 'negative d = path better' },
    team_pair_rho: { historical: r(hist), ci90_week_cluster: ci.map(v => r(v)), simulated: r(sim),
      pass: sim >= ci[0] && sim <= ci[1] }
  };
}

const fitGames = scoredGames(...FIT);
const params = fitGamePath(fitGames);
const tests = GRADE.map(s => grade(s, params));
const out = {
  run_at: new Date().toISOString(), note: 'local copy, not production', draws_per_game: M,
  fit: { seasons: FIT, games: params.games, pooled_sd: r(params.sd, 3), rho: r(params.rho) },
  tests,
  crps_pass: tests.every(t => t.crps.pass),
  energy_pass: tests.every(t => t.energy.pass),
  rho_pass: tests.every(t => t.team_pair_rho.pass)
};
out.preregistered_pass = out.crps_pass && out.energy_pass && out.rho_pass;
out.verdict = out.energy_pass ? (out.preregistered_pass ? 'BUILD' : 'HOLD') : 'DECLINE (kill rule: energy score)';
console.log(JSON.stringify(out, null, 2));
