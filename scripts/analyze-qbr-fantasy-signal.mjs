#!/usr/bin/env node
/**
 * Does trailing ESPN Total QBR explain any of the QB structural model's
 * remaining error, walk-forward and out of sample?
 *
 * Mirrors the coordinator's validated-gain-gated shrinkage
 * (nfl-expert-coordinator.js's shrinkageScales): fit k = cov(qbr, error) /
 * (var(qbr) + ridge) capped to [0,1] on TRAIN weeks only, gate it on a real
 * t-stat (t > 2) AND a genuine cross-half walk-forward gain (fit on one half
 * of train weeks, must still reduce error on the other half). If either gate
 * fails, k is reported as 0 (no signal) rather than adopted.
 *
 * Then, and only then, apply the frozen k to TEST and HOLDOUT seasons the fit
 * never saw, and report real before/after MAE, bias, and PIT calibration
 * error for QB.
 *
 * Usage: node scripts/analyze-qbr-fantasy-signal.mjs
 */
import { rows } from '../server/db/index.js';
import { buildProjections, sampleWeeks } from '../server/services/projections.js';
import { actuals } from '../server/services/backtest.js';
import { qbrTrailingForPlayer } from '../server/services/nfl-qbr.js';
import { pairedBootstrapDiff } from '../server/services/backtest-significance.js';
import { random, withRandomSeed } from '../server/services/stats-util.js';
import { PPR } from '../server/services/scoring.js';

const TRAIN_SEASONS = [2021, 2022, 2023];
const TEST_SEASON = 2024;
const HOLDOUT_SEASON = 2025;
const START_WEEK = 5, END_WEEK = 18;
const RIDGE = 8; // same order of magnitude as SHRINK_RIDGE in the coordinator, scaled for QBR's ~0-100 range
const WINDOW = 8;

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// League-mean QBR, computed from the QBR table's own distribution (not from
// fantasy outcomes, so this centering cannot leak the thing being predicted).
const qualified = rows(`SELECT qbr_total FROM nfl_qbr_weekly WHERE qb_plays >= 5 AND qbr_total IS NOT NULL`);
const qbrRaw = qualified.map(r => r.qbr_total);
const QBR_CENTER = mean(qbrRaw);
console.log(`League QBR center (qualified starts, n=${qbrRaw.length}): ${QBR_CENTER.toFixed(2)}`);

/** One pass over a season range: structural error and trailing-QBR anomaly per QB player-week. */
function collect(seasons) {
  const out = [];
  for (const season of seasons) {
    const truth = actuals(season, PPR);
    for (let week = START_WEEK; week <= END_WEEK; week++) {
      const proj = buildProjections({ through: season, throughWeek: week - 1, scoring: PPR });
      for (const [pid, p] of proj) {
        if (p.position !== 'QB') continue;
        const t = truth.get(pid);
        const act = t?.weeks?.get(week);
        if (act == null) continue;
        const qbrInfo = qbrTrailingForPlayer(p.espn_id, season, week - 1, { window: WINDOW });
        out.push({
          season, week, pid, structural: p.ppg, actual: act,
          qbrAnomaly: qbrInfo ? qbrInfo.qbr - QBR_CENTER : null, qbrStarts: qbrInfo?.starts ?? 0,
          params: p.params
        });
      }
    }
  }
  return out;
}

console.log('Collecting TRAIN rows (2021-2023, weeks 5-18)...');
const train = collect(TRAIN_SEASONS);
const trainWithQbr = train.filter(r => r.qbrAnomaly != null);
console.log(`TRAIN: ${train.length} QB player-weeks, ${trainWithQbr.length} with a qualifying trailing QBR read.`);

function fitK(sampleRows) {
  const pairs = sampleRows.map(r => [r.qbrAnomaly, r.actual - r.structural]);
  if (pairs.length < 30) return { k: 0, reason: 'too few paired observations' };
  const mf = mean(pairs.map(([f]) => f)), my = mean(pairs.map(([, y]) => y));
  const cov = mean(pairs.map(([f, y]) => (f - mf) * (y - my)));
  const vf = mean(pairs.map(([f]) => (f - mf) ** 2));
  const vy = mean(pairs.map(([, y]) => (y - my) ** 2));
  const r = vf && vy ? cov / Math.sqrt(vf * vy) : 0;
  const t = Math.abs(r) * Math.sqrt(Math.max(1, pairs.length - 2)) / Math.sqrt(Math.max(1e-9, 1 - r * r));
  const k = clamp(cov / (vf + RIDGE), 0, 1);
  const gainOf = (list, kk, mff) => Math.sqrt(mean(list.map(([, y]) => y * y)))
    - Math.sqrt(mean(list.map(([f, y]) => (y - kk * (f - mff)) ** 2)));
  const a = pairs.filter((_, i) => i % 2 === 0), b = pairs.filter((_, i) => i % 2 === 1);
  const scaleOf = list => {
    const mfl = mean(list.map(([f]) => f)), myl = mean(list.map(([, y]) => y));
    const covl = mean(list.map(([f, y]) => (f - mfl) * (y - myl))), vfl = mean(list.map(([f]) => (f - mfl) ** 2));
    return { k: clamp(covl / (vfl + RIDGE), 0, 1), mf: mfl };
  };
  const crossGain = mean([gainOf(b, scaleOf(a).k, scaleOf(a).mf), gainOf(a, scaleOf(b).k, scaleOf(b).mf)]);
  const passes = t > 2 && crossGain > 0 && k > 0;
  return { k: passes ? k : 0, raw_k: k, r: +r.toFixed(4), t: +t.toFixed(3), cross_gain: +crossGain.toFixed(4),
    n: pairs.length, reason: passes ? null : 'shrunk to zero: no walk-forward gain' };
}

const fit = fitK(trainWithQbr);
console.log('\nFitted QBR shrinkage (TRAIN 2021-2023):', fit);

function grade(sampleRows, k) {
  const withZeroFallback = sampleRows.map(r => ({
    ...r, adjusted: r.structural + (k && r.qbrAnomaly != null ? k * r.qbrAnomaly : 0)
  }));
  const errBase = withZeroFallback.map(r => r.actual - r.structural);
  const errAdj = withZeroFallback.map(r => r.actual - r.adjusted);
  const mae = a => mean(a.map(Math.abs));
  const bias = a => mean(a);
  return {
    n: sampleRows.length,
    base: { mae: +mae(errBase).toFixed(3), bias: +bias(errBase).toFixed(3) },
    adjusted: { mae: +mae(errAdj).toFixed(3), bias: +bias(errAdj).toFixed(3) },
    absErrBase: errBase.map(Math.abs), absErrAdjusted: errAdj.map(Math.abs)
  };
}

function calibrationError(sampleRows, k, seed) {
  const bins = new Array(10).fill(0);
  let n = 0;
  withRandomSeed(seed, () => {
    for (const r of sampleRows) {
      const shift = k && r.qbrAnomaly != null ? k * r.qbrAnomaly : 0;
      const samples = sampleWeeks(r.params, 200, PPR, 1, 1).map(v => Math.max(0, v + shift));
      const sorted = [...samples].sort((a, b) => a - b);
      let below = 0, equal = 0;
      for (const s of sorted) { if (s < r.actual) below++; else if (s === r.actual) equal++; }
      const u = (below + random() * equal) / sorted.length;
      bins[Math.min(9, Math.floor(u * 10))]++;
      n++;
    }
  });
  const expected = n / 10;
  return +(mean(bins.map(b => Math.abs(b - expected))) / expected).toFixed(3);
}

for (const [label, season] of [['TEST (2024, first held-out season)', TEST_SEASON], ['HOLDOUT (2025, never touched during fit)', HOLDOUT_SEASON]]) {
  console.log(`\n=== ${label} ===`);
  const testRows = collect([season]);
  const testWithQbr = testRows.filter(r => r.qbrAnomaly != null);
  console.log(`${testRows.length} QB player-weeks, ${testWithQbr.length} with a qualifying trailing QBR read.`);
  const g = grade(testRows, fit.k);
  console.log('MAE  base -> adjusted:', g.base.mae, '->', g.adjusted.mae);
  console.log('Bias base -> adjusted:', g.base.bias, '->', g.adjusted.bias);
  const bootstrap = pairedBootstrapDiff(g.absErrBase, g.absErrAdjusted, { seed: 20260826 });
  console.log('Paired bootstrap (adjusted - base MAE), 90% CI:', bootstrap.mean_diff, bootstrap.ci90,
    bootstrap.significant ? '-- SIGNIFICANT' : '-- not distinguishable from noise');
  const calBase = calibrationError(testRows, 0, 20260826);
  const calAdj = calibrationError(testRows, fit.k, 20260826);
  console.log('Calibration error base -> adjusted:', calBase, '->', calAdj);
}
