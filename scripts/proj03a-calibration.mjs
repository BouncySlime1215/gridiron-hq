#!/usr/bin/env node
// PROJ-03-a calibration of the game-script sampler's team-points distribution.
// Pre-registration: docs/tdd/2026-09-23-proj-03a-game-script-sampler.tdd.md section 2.
// Read-only. Run on a local copy:
//   SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=.local-db/data.sqlite node scripts/proj03a-calibration.mjs
// Test seasons 2023 (fit 2021-22) and 2024 (fit 2021-23); forward 2026 (fit 2021-25).
// 2025 is never scored here.
import { rows } from '../server/db/index.js';
import { scoreModelAt, teamPointsDistribution, spreadBucket, regularizedGammaP } from '../server/services/gamescript.js';
import { normalCdf, weeklyClusterBootstrap, withRandomSeed, random } from '../server/services/stats-util.js';

const BUCKETS = ['lt3', '3to7', 'gt7'];
const SQRT_PI = Math.sqrt(Math.PI);

function teamGames(season) {
  return rows(`SELECT season, week, team, COALESCE(closing_spread, spread) AS spread,
                      COALESCE(closing_total, total) AS total, team_score AS y
                 FROM game_lines
                WHERE season = ? AND team_score IS NOT NULL AND opp_score IS NOT NULL
                  AND COALESCE(closing_spread, spread) IS NOT NULL AND COALESCE(closing_total, total) IS NOT NULL
                ORDER BY week, team`, season);
}

/** CRPS of Gamma(k, theta) at y (Scheuerer & Moller 2015, Ann. Appl. Stat. 9:1328, eq. 9). */
function crpsGamma(k, theta, y) {
  const F = (a, x) => (x <= 0 ? 0 : regularizedGammaP(a, x / theta));
  const logB = lg(0.5) + lg(k) - lg(k + 0.5);
  return y * (2 * F(k, y) - 1) - k * theta * (2 * F(k + 1, y) - 1) - k * theta * Math.exp(Math.log(2) - Math.log(k) - logB) / 2;
}
function lg(x) { // Lanczos, for the Beta function only
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lg(1 - x);
  x -= 1; let a = c[0]; const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
/** CRPS of Normal(mu, sigma) at y (Gneiting & Raftery 2007). */
function crpsNormal(mu, sigma, y) {
  const z = (y - mu) / sigma;
  return sigma * (z * (2 * normalCdf(z) - 1) + 2 * Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI) - 1 / SQRT_PI);
}
/** Numeric CRPS, used once as a check on the closed form. */
function crpsNumeric(cdf, y, hi = 150, steps = 30000) {
  let s = 0; const h = hi / steps;
  for (let i = 0; i < steps; i++) { const x = (i + 0.5) * h; const d = cdf(x) - (x >= y ? 1 : 0); s += d * d * h; }
  return s;
}
const chiSqP = (x, df) => 1 - regularizedGammaP(df / 2, x / 2);
function ksStat(us) {
  const s = [...us].sort((a, b) => a - b); const n = s.length; let d = 0;
  s.forEach((u, i) => { d = Math.max(d, (i + 1) / n - u, u - i / n); });
  return d;
}
const wilson = (x, n, z = 1.96) => {
  const p = x / n, den = 1 + z * z / n, c = (p + z * z / (2 * n)) / den, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den;
  return [c - h, c + h];
};
const mde = n => 2.8 * Math.sqrt(0.8 * 0.2 / n); // coverage deviation at 80% power, alpha .05 two-sided
const r = (v, d = 3) => +v.toFixed(d);

function grade(season, label) {
  const params = scoreModelAt(season, 1);
  const tg = teamGames(season);
  const cells = Object.fromEntries(BUCKETS.map(b => [b, { n: 0, cov: 0 }]));
  const pits = [], dRows = [];
  let crpsS = 0, crpsN = 0, checked = null;
  withRandomSeed(20260923, () => {
    for (const g of tg) {
      const mu = g.total / 2 - g.spread / 2;
      const dist = teamPointsDistribution(mu, g.spread, params);
      const b = spreadBucket(g.spread);
      const q10 = dist.quantile(0.1), q90 = dist.quantile(0.9);
      cells[b].n++; if (g.y >= q10 && g.y <= q90) cells[b].cov++;
      const lo = dist.cdf(g.y - 0.5), hi = dist.cdf(g.y + 0.5);
      pits.push(lo + random() * (hi - lo));
      const shape = (dist.mean / dist.sd) ** 2, theta = dist.sd ** 2 / dist.mean;
      const cs = crpsGamma(shape, theta, g.y), cn = crpsNormal(mu, params.pooled_sd, g.y);
      if (!checked) checked = { closed: r(cs, 4), numeric: r(crpsNumeric(dist.cdf, g.y), 4) };
      crpsS += cs; crpsN += cn;
      dRows.push({ season: g.season, week: g.week, units: cs - cn });
    }
  });
  const n = tg.length;
  const bins = Array(10).fill(0); pits.forEach(u => bins[Math.min(9, Math.floor(u * 10))]++);
  const chi = bins.reduce((s, o) => s + (o - n / 10) ** 2 / (n / 10), 0);
  const boot = weeklyClusterBootstrap(dRows);
  const meanD = (crpsS - crpsN) / n;
  const cov = Object.fromEntries(BUCKETS.map(b => {
    const c = cells[b], rate = c.cov / c.n;
    return [b, { n: c.n, coverage: r(rate), pass: rate >= 0.77 && rate <= 0.83, mde_at_80pct_power: r(mde(c.n)) }];
  }));
  const pooledCov = BUCKETS.reduce((s, b) => s + cells[b].cov, 0);
  return {
    label, season, fitted_through: params.fitted_through, training_games: params.games, team_games: n,
    bucket_params: Object.fromEntries(BUCKETS.map(b => [b, { n: params.buckets[b].n, sd: r(params.buckets[b].sd, 2), margin_sd: r(params.buckets[b].margin_sd, 2), rho: r(params.buckets[b].rho) }])),
    pooled_sd: r(params.pooled_sd, 2),
    coverage_80: cov, coverage_pooled: r(pooledCov / n), coverage_pooled_wilson95: wilson(pooledCov, n).map(v => r(v)),
    pit: { bins, chi_square: r(chi, 2), df: 9, p: r(chiSqP(chi, 9), 4), pass: chiSqP(chi, 9) >= 0.01, ks_d: r(ksStat(pits), 4) },
    crps: { sampler: r(crpsS / n), normal_pooled: r(crpsN / n), mean_d: r(meanD), d_ci95_week_cluster: boot.roi_95, clusters: boot.clusters,
      pass: boot.roi_95[1] != null && boot.roi_95[1] <= 0.05, sign: 'negative d = sampler better' },
    crps_closed_form_check: checked
  };
}

const out = { run_at: new Date().toISOString(), note: 'local copy, not production', tests: [grade(2023, 'test'), grade(2024, 'test')] };
const fwd = teamGames(2026);
out.forward = fwd.length ? grade(2026, 'forward 2026 (anecdote-sized)') : null;
const t = out.tests;
out.preregistered_pass = t.every(x => Object.values(x.coverage_80).every(c => c.pass) && x.pit.pass && x.crps.pass);
if (out.forward) {
  const f = out.forward;
  out.forward_holds = f.coverage_pooled_wilson95[0] <= 0.8 && f.coverage_pooled_wilson95[1] >= 0.8 && f.crps.mean_d <= 0.05;
}
console.log(JSON.stringify(out, null, 2));
