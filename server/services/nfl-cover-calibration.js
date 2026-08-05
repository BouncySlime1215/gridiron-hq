/** Price-aware cover calibration, trained only on earlier seasons. */
import { db, rows, run } from '../db/index.js';
import { replaySeason } from './nfl-replay.js';

db.exec(`CREATE TABLE IF NOT EXISTS nfl_cover_calibrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_version TEXT NOT NULL, trained_from INTEGER NOT NULL, trained_through INTEGER NOT NULL,
  created_at TEXT NOT NULL, sample_size INTEGER NOT NULL,
  intercept REAL NOT NULL, edge_slope REAL NOT NULL,
  metrics_json TEXT NOT NULL, reliability_json TEXT NOT NULL,
  UNIQUE(model_version, trained_from, trained_through)
)`);

const VERSION = 'cover-logit-v1';
const r4 = v => v == null || !Number.isFinite(v) ? null : +v.toFixed(4);
const sigmoid = x => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));
const logit = p => Math.log(Math.max(1e-5, Math.min(1 - 1e-5, p)) / Math.max(1e-5, 1 - Math.min(1 - 1e-5, p)));
const implied = o => o == null ? null : o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100);
const noVig = (a, b) => {
  const pa = implied(a), pb = implied(b);
  return pa != null && pb != null && pa + pb > 0 ? pa / (pa + pb) : null;
};

function fitLogisticOffset(samples) {
  let b0 = 0, b1 = 0;
  for (let iter = 0; iter < 40; iter++) {
    let g0 = -b0, g1 = -b1, h00 = 1, h01 = 0, h11 = 1;
    for (const s of samples) {
      const x = s.edge_points / 7;
      const p = sigmoid(logit(s.market_probability) + b0 + b1 * x);
      const w = Math.max(1e-6, p * (1 - p));
      g0 += s.outcome - p; g1 += x * (s.outcome - p);
      h00 += w; h01 += w * x; h11 += w * x * x;
    }
    const det = h00 * h11 - h01 * h01;
    if (Math.abs(det) < 1e-9) break;
    const d0 = (g0 * h11 - g1 * h01) / det;
    const d1 = (g1 * h00 - g0 * h01) / det;
    b0 += d0; b1 += d1;
    if (Math.abs(d0) + Math.abs(d1) < 1e-7) break;
  }
  return { intercept: b0, edgeSlope: b1 };
}

function score(samples, fit) {
  const predicted = samples.map(s => ({ ...s,
    calibrated: sigmoid(logit(s.market_probability) + fit.intercept + fit.edgeSlope * (s.edge_points / 7)) }));
  return summarize(predicted);
}

function summarize(predicted) {
  const brier = key => predicted.length
    ? predicted.reduce((sum, s) => sum + (s[key] - s.outcome) ** 2, 0) / predicted.length : null;
  const buckets = Array.from({ length: 10 }, (_, i) => {
    const list = predicted.filter(s => Math.min(9, Math.floor(s.calibrated * 10)) === i);
    return {
      range: `${i * 10}-${(i + 1) * 10}%`, n: list.length,
      predicted: list.length ? r4(list.reduce((a, s) => a + s.calibrated, 0) / list.length) : null,
      actual: list.length ? r4(list.reduce((a, s) => a + s.outcome, 0) / list.length) : null
    };
  });
  return { predicted, metrics: { calibrated_brier: r4(brier('calibrated')), market_brier: r4(brier('market_probability')) }, buckets };
}

export function buildCoverCalibration({ fromSeason = 2021, throughSeason = 2025 } = {}) {
  const samples = [];
  for (let season = fromSeason; season <= throughSeason; season++) {
    const replay = replaySeason(season, { minEdge: 0, maxDisagreement: null, maxPicksPerWeek: 20, markets: ['spread'] });
    if (replay.error) continue;
    for (const b of replay.bets) {
      if (!['Won', 'Lost'].includes(b.result)) continue;
      const marketProbability = noVig(b.american_price, b.opposite_price);
      if (marketProbability == null || b.edge_points == null) continue;
      samples.push({ season, week: b.week, edge_points: b.edge_points,
        market_probability: marketProbability, outcome: b.result === 'Won' ? 1 : 0 });
    }
  }
  if (samples.length < 200) throw new Error(`only ${samples.length} priced covers available for calibration`);
  const walkForward = [];
  for (let season = fromSeason + 1; season <= throughSeason; season++) {
    const train = samples.filter(s => s.season < season);
    const test = samples.filter(s => s.season === season);
    if (train.length < 100 || !test.length) continue;
    walkForward.push(...score(test, fitLogisticOffset(train)).predicted);
  }
  const fit = fitLogisticOffset(samples);
  const scored = score(samples, fit);
  const wf = summarize(walkForward);
  const metrics = {
    training_calibrated_brier: scored.metrics.calibrated_brier,
    training_market_brier: scored.metrics.market_brier,
    walk_forward_n: walkForward.length,
    walk_forward_calibrated_brier: wf.metrics.calibrated_brier,
    walk_forward_market_brier: wf.metrics.market_brier,
    forward_gate_passed: walkForward.length >= 200 && wf.metrics.calibrated_brier < wf.metrics.market_brier
  };
  run(`INSERT INTO nfl_cover_calibrations
    (model_version,trained_from,trained_through,created_at,sample_size,intercept,edge_slope,metrics_json,reliability_json)
    VALUES (?,?,?,datetime('now'),?,?,?,?,?)
    ON CONFLICT(model_version,trained_from,trained_through) DO UPDATE SET
      created_at=excluded.created_at,sample_size=excluded.sample_size,intercept=excluded.intercept,
      edge_slope=excluded.edge_slope,metrics_json=excluded.metrics_json,reliability_json=excluded.reliability_json`,
    VERSION, fromSeason, throughSeason, samples.length, fit.intercept, fit.edgeSlope,
    JSON.stringify(metrics), JSON.stringify(wf.buckets));
  return latestCoverCalibration(throughSeason + 1);
}

export function latestCoverCalibration(beforeSeason = 9999) {
  const r = rows(`SELECT * FROM nfl_cover_calibrations WHERE trained_through < ?
                  ORDER BY trained_through DESC, id DESC LIMIT 1`, beforeSeason)[0];
  if (!r) return null;
  return { ...r, metrics: JSON.parse(r.metrics_json), reliability: JSON.parse(r.reliability_json),
    metrics_json: undefined, reliability_json: undefined };
}

export function calibratedCoverProbability({ season, marketProbability, edgePoints }) {
  const fit = latestCoverCalibration(season);
  if (!fit || !fit.metrics?.forward_gate_passed || marketProbability == null || edgePoints == null) {
    return { probability: null, calibration: fit };
  }
  return {
    probability: r4(sigmoid(logit(marketProbability) + fit.intercept + fit.edge_slope * (edgePoints / 7))),
    calibration: fit
  };
}
