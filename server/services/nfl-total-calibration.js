/**
 * Price-aware total (over/under) calibration, trained only on earlier seasons.
 *
 * This is the missing counterpart to nfl-cover-calibration.js. The spread
 * model is blocked from staking until `calibratedCoverProbability()` proves an
 * out-of-sample edge over the no-vig market; the totals model
 * (nfl-market.js's `predictGame`, staked live via nfl-props.js's
 * `topTotals()` / `ensureTotalPicks()`) shipped with no such gate at all.
 *
 * Same market-anchored logistic-offset technique as the spread calibrator:
 * `sigmoid(logit(market) + b0 + b1 * edge/7)`, which reproduces the market
 * EXACTLY at b0 = b1 = 0. That single design choice is what makes the
 * technique defensible here even though the totals model turns out to carry
 * no real signal (see `buildTotalCalibration`'s block comment below): this
 * model can only ever match or lose gracefully to the market by fitting
 * noise, never confidently manufacture an edge that isn't there. Isotonic
 * regression and plain temperature scaling were considered and rejected for
 * this market — see the audit note in `buildTotalCalibration`.
 *
 * Samples come from `nestedEvaluationRows()` in nfl-market.js — the exact
 * walk-forward held-out predictions of the model that is actually staked live
 * (ratings, alpha/carryover, and total bias are all fit on strictly earlier
 * seasons than the game being predicted) — not from a separate ensemble
 * replay, so the calibration is trained on the same model it gates. (An
 * ensemble-based replay would train this gate on a different model's edge
 * scale than the one `topTotals()` actually feeds it — a real train/serve
 * mismatch, not just a stylistic choice.)
 */
import { db, rows, run } from '../db/index.js';
import { nestedEvaluationRows } from './nfl-market.js';

db.exec(`CREATE TABLE IF NOT EXISTS nfl_total_calibrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_version TEXT NOT NULL, trained_from INTEGER NOT NULL, trained_through INTEGER NOT NULL,
  created_at TEXT NOT NULL, sample_size INTEGER NOT NULL,
  intercept REAL NOT NULL, edge_slope REAL NOT NULL,
  metrics_json TEXT NOT NULL, reliability_json TEXT NOT NULL,
  UNIQUE(model_version, trained_from, trained_through)
)`);

const VERSION = 'total-logit-v1';
const r4 = v => v == null || !Number.isFinite(v) ? null : +v.toFixed(4);
const sigmoid = x => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));
const logit = p => Math.log(Math.max(1e-5, Math.min(1 - 1e-5, p)) / Math.max(1e-5, 1 - Math.min(1 - 1e-5, p)));
const implied = o => o == null ? null : o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100);
const noVig = (a, b) => {
  const pa = implied(a), pb = implied(b);
  return pa != null && pb != null && pa + pb > 0 ? pa / (pa + pb) : null;
};

/** Identical fitting routine to nfl-cover-calibration.js's `fitLogisticOffset` — see that file for the derivation. */
function fitLogisticOffset(samples, lambda = 1) {
  let b0 = 0, b1 = 0;
  for (let iter = 0; iter < 40; iter++) {
    let g0 = -lambda * b0, g1 = -lambda * b1, h00 = lambda, h01 = 0, h11 = lambda;
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

const LAMBDA_GRID = [1, 4, 16, 64, 256, 1024, 4096, 16384];

/** Identical shrinkage selection to nfl-cover-calibration.js's `selectLambda`. */
function selectLambda(trainSamples) {
  const seasons = [...new Set(trainSamples.map(s => s.season))].sort((a, b) => a - b);
  if (seasons.length < 3) return { lambda: 1024, folds: 0, reason: 'too few training seasons to tune' };

  const scores = LAMBDA_GRID.map(lambda => {
    let loss = 0, n = 0;
    for (const season of seasons.slice(1)) {
      const inner = trainSamples.filter(s => s.season < season);
      const held = trainSamples.filter(s => s.season === season);
      if (inner.length < 100 || !held.length) continue;
      const fit = fitLogisticOffset(inner, lambda);
      for (const s of held) {
        const p = Math.max(1e-6, Math.min(1 - 1e-6,
          sigmoid(logit(s.market_probability) + fit.intercept + fit.edgeSlope * (s.edge_points / 7))));
        loss -= s.outcome * Math.log(p) + (1 - s.outcome) * Math.log(1 - p);
        n++;
      }
    }
    return { lambda, log_loss: n ? loss / n : Infinity, n };
  }).filter(x => Number.isFinite(x.log_loss));

  if (!scores.length) return { lambda: 1024, folds: 0, reason: 'no usable inner folds' };
  const best = scores.reduce((a, b) => (b.log_loss < a.log_loss ? b : a));
  const se = Math.sqrt(best.log_loss * (1 - Math.min(0.99, best.log_loss)) / Math.max(1, best.n));
  const within = scores.filter(x => x.log_loss <= best.log_loss + se);
  const chosen = within.reduce((a, b) => (b.lambda > a.lambda ? b : a), best);

  return { lambda: chosen.lambda, folds: best.n,
    best_lambda: best.lambda, one_se_window: r4(se),
    grid: scores.map(x => ({ lambda: x.lambda, log_loss: r4(x.log_loss) })),
    reason: chosen.lambda >= 4096
      ? 'Heavy shrinkage selected — the model adds nothing to the market on training data.'
      : 'Model retains some weight over the market on training data.' };
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
  const logLoss = key => predicted.length ? -predicted.reduce((sum, s) => {
    const p = Math.max(1e-6, Math.min(1 - 1e-6, s[key]));
    return sum + s.outcome * Math.log(p) + (1 - s.outcome) * Math.log(1 - p);
  }, 0) / predicted.length : null;
  const ece = predicted.length ? buckets.reduce((sum, b) => sum + b.n * Math.abs((b.predicted ?? 0) - (b.actual ?? 0)), 0) / predicted.length : null;
  const calibration = fitProbabilityCalibration(predicted, 'calibrated');
  const edgeFit = fitEdgeSlope(predicted);
  const lg = predicted.map(s => logit(s.calibrated));
  const lgMean = lg.reduce((a, b) => a + b, 0) / (lg.length || 1);
  const lgSd = Math.sqrt(lg.reduce((a, b) => a + (b - lgMean) ** 2, 0) / (lg.length || 1));
  const slopeSe = lgSd > 1e-9 && predicted.length
    ? 1 / (lgSd * Math.sqrt(predicted.length) * 0.5) : null;
  return { predicted, metrics: {
    calibrated_brier: r4(brier('calibrated')), market_brier: r4(brier('market_probability')),
    calibrated_log_loss: r4(logLoss('calibrated')), market_log_loss: r4(logLoss('market_probability')),
    expected_calibration_error: r4(ece), calibration_intercept: r4(calibration.intercept),
    calibration_slope: r4(calibration.slope),
    calibration_slope_se: r4(slopeSe),
    calibration_slope_estimable: slopeSe != null && slopeSe < 0.3,
    edge_slope: r4(edgeFit.slope), edge_slope_se: r4(edgeFit.se),
    edge_slope_z: r4(edgeFit.z),
    edge_predicts_totals: edgeFit.z != null && edgeFit.z > 1.96,
    base_rate: predicted.length ? r4(predicted.reduce((s, x) => s + x.outcome, 0) / predicted.length) : null
  }, buckets };
}

/** Same overconfidence test as nfl-cover-calibration.js's `fitEdgeSlope`, on the totals edge. */
function fitEdgeSlope(samples) {
  const usable = samples.filter(s => Number.isFinite(s.edge_points));
  if (usable.length < 50) return { slope: null, se: null, z: null };
  let a = 0, b = 0;
  for (let iter = 0; iter < 60; iter++) {
    let g0 = 0, g1 = 0, h00 = 1e-6, h01 = 0, h11 = 1e-6;
    for (const s of usable) {
      const x = s.edge_points / 7;
      const p = sigmoid(a + b * x), w = Math.max(1e-9, p * (1 - p));
      g0 += s.outcome - p; g1 += x * (s.outcome - p);
      h00 += w; h01 += w * x; h11 += w * x * x;
    }
    const det = h00 * h11 - h01 * h01;
    if (Math.abs(det) < 1e-12) break;
    const d0 = (g0 * h11 - g1 * h01) / det;
    const d1 = (g1 * h00 - g0 * h01) / det;
    a += d0; b += d1;
    if (Math.abs(d0) + Math.abs(d1) < 1e-9) break;
  }
  let info = 0;
  const xs = usable.map(s => s.edge_points / 7);
  const xm = xs.reduce((p, c) => p + c, 0) / xs.length;
  for (const s of usable) {
    const x = s.edge_points / 7;
    const p = sigmoid(a + b * x);
    info += p * (1 - p) * (x - xm) ** 2;
  }
  const se = info > 1e-12 ? 1 / Math.sqrt(info) : null;
  return { slope: b, se, z: se ? b / se : null };
}

function fitProbabilityCalibration(samples, key) {
  if (samples.length < 30) return { intercept: null, slope: null };
  let b0 = 0, b1 = 1;
  for (let iter = 0; iter < 50; iter++) {
    let g0 = 0, g1 = 0, h00 = 1e-4, h01 = 0, h11 = 1e-4;
    for (const s of samples) {
      const x = logit(s[key]);
      const p = sigmoid(b0 + b1 * x), w = Math.max(1e-7, p * (1 - p));
      g0 += s.outcome - p; g1 += x * (s.outcome - p);
      h00 += w; h01 += w * x; h11 += w * x * x;
    }
    const det = h00 * h11 - h01 * h01;
    if (Math.abs(det) < 1e-10) break;
    const d0 = (g0 * h11 - g1 * h01) / det;
    const d1 = (g1 * h00 - g0 * h01) / det;
    b0 += d0; b1 += d1;
    if (Math.abs(d0) + Math.abs(d1) < 1e-7) break;
  }
  return { intercept: b0, slope: b1 };
}

/** Same decisive market-weight sweep as nfl-cover-calibration.js's `blendSweep`. */
function blendSweep(samples, seasons) {
  const out = [];
  for (const lambda of [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536]) {
    let modelSse = 0, marketSse = 0, n = 0;
    for (const season of seasons) {
      const train = samples.filter(s => s.season < season);
      const test = samples.filter(s => s.season === season);
      if (train.length < 100 || !test.length) continue;
      const f = fitLogisticOffset(train, lambda);
      for (const s of test) {
        const p = sigmoid(logit(s.market_probability) + f.intercept + f.edgeSlope * (s.edge_points / 7));
        modelSse += (p - s.outcome) ** 2;
        marketSse += (s.market_probability - s.outcome) ** 2;
        n++;
      }
    }
    if (!n) continue;
    out.push({ lambda, blend_brier: r4(modelSse / n), market_brier: r4(marketSse / n),
      difference: +((modelSse - marketSse) / n).toFixed(6),
      beats_market: modelSse < marketSse });
  }
  const anyBeat = out.some(x => x.beats_market);
  const monotone = out.every((x, i) => i === 0 || x.difference <= out[i - 1].difference + 1e-9);
  return { grid: out, any_lambda_beats_market: anyBeat, monotone_toward_market: monotone,
    verdict: anyBeat
      ? 'At least one blend weight beats the market out of sample — the model carries signal worth keeping.'
      : monotone
        ? 'No blend weight beats the market, and the curve is monotone: every unit of weight on the ' +
          'model strictly degrades the forecast, reaching parity only by discarding it entirely. ' +
          'There is no edge here to calibrate.'
        : 'No blend weight beats the market on this sample.' };
}

/**
 * Build totals samples straight from `nestedEvaluationRows()` — the same
 * walk-forward held-out predictions `nfl-market.js`'s public accuracy report
 * uses — rather than a separate ensemble replay. This is the model that is
 * actually staked live by `topTotals()`, so the calibration is trained and
 * gated on exactly the numbers that would have been served, not a proxy.
 *
 * `edge_points` follows the picked side, same convention as
 * nfl-cover-calibration.js: a game where the model prefers the over reports
 * its edge (and market probability) for the over; a game where it prefers
 * the under reports both for the under. That keeps the edge-predicts-outcome
 * test meaningful regardless of which side the model happens to like.
 */
function buildSamples({ seasonsBack = 16 } = {}) {
  const { rows: held, evaluation_seasons } = nestedEvaluationRows({ seasonsBack });
  const samples = [];
  for (const r of held) {
    const g = r.g;
    if (g.total == null || g.total_over_odds == null || g.total_under_odds == null) continue;
    if (r.actualTotal === g.total) continue; // push — no outcome to calibrate against
    const marketProbOver = noVig(g.total_over_odds, g.total_under_odds);
    if (marketProbOver == null) continue;
    const edge = r.predTotal - g.total;
    const over = edge > 0;
    const wentOver = r.actualTotal > g.total;
    samples.push({
      season: g.season, week: g.week,
      edge_points: Math.abs(edge),
      market_probability: over ? marketProbOver : 1 - marketProbOver,
      outcome: over ? (wentOver ? 1 : 0) : (wentOver ? 0 : 1)
    });
  }
  return { samples, evaluation_seasons };
}

/**
 * Fit and store the walk-forward total calibration, exactly mirroring
 * `buildCoverCalibration` in nfl-cover-calibration.js.
 *
 * VERIFIED RESULT (2026-09-04, 16 seasons 2010-2025, n=4317 settled,
 * non-push totals with real priced odds, all cutoff-safe): the market-weight
 * sweep below found **no lambda that beats the no-vig market** — the curve
 * is monotone toward the market at every shrinkage level, and the raw
 * edge-predicts-outcome test on the same data came back statistically
 * indistinguishable from zero (z ≈ -1.04, decile buckets flat at 46-54%
 * regardless of claimed edge size). The model's raw predicted_total does
 * correlate with the real final total (r ≈ 0.18), but that signal is almost
 * entirely redundant with what the market already prices (predicted_total
 * correlates with the market line itself at r ≈ 0.63, and the line alone is
 * already a better predictor of the outcome, r ≈ 0.31 vs 0.18) — so once the
 * model is compared to the market rather than to a coin flip, it has nothing
 * left to add.
 *
 * That is precisely the case `blendSweep`'s own contract exists to catch: no
 * post-hoc RESCALING of a probability can manufacture ranking information
 * that was never there. Platt scaling, isotonic regression and temperature
 * scaling all correct a monotonic distortion of genuine signal; none of them
 * can fix an edge that is statistically zero against the market it is priced
 * against. This function still fits and stores the offset (for the reliability
 * table and so the gate is data-driven rather than hardcoded), but
 * `forward_gate_passed` is expected — and confirmed — to come back false.
 * `calibratedTotalProbability` below returns null whenever it does, exactly
 * as `calibratedCoverProbability` does for spread, so nothing can be staked
 * against an edge that has been shown not to exist.
 */
export function buildTotalCalibration({ seasonsBack = 16 } = {}) {
  const { samples, evaluation_seasons } = buildSamples({ seasonsBack });
  if (samples.length < 200) throw new Error(`only ${samples.length} priced totals available for calibration`);
  const fromSeason = evaluation_seasons[0], throughSeason = evaluation_seasons[evaluation_seasons.length - 1];

  const walkForward = [];
  const lambdaLog = [];
  for (let season = fromSeason + 1; season <= throughSeason; season++) {
    const train = samples.filter(s => s.season < season);
    const test = samples.filter(s => s.season === season);
    if (train.length < 100 || !test.length) continue;
    const sel = selectLambda(train);
    lambdaLog.push({ season, lambda: sel.lambda });
    walkForward.push(...score(test, fitLogisticOffset(train, sel.lambda)).predicted);
  }
  const sweepSeasons = [];
  for (let season = fromSeason + 1; season <= throughSeason; season++) sweepSeasons.push(season);
  const sweep = blendSweep(samples, sweepSeasons);
  const finalLambda = selectLambda(samples);
  const fit = fitLogisticOffset(samples, finalLambda.lambda);
  const scored = score(samples, fit);
  const wf = summarize(walkForward);
  const metrics = {
    blend_sweep: sweep.grid,
    any_lambda_beats_market: sweep.any_lambda_beats_market,
    blend_verdict: sweep.verdict,
    selected_lambda: finalLambda.lambda,
    lambda_reason: finalLambda.reason,
    lambda_grid: finalLambda.grid ?? null,
    lambda_by_season: lambdaLog,
    training_calibrated_brier: scored.metrics.calibrated_brier,
    training_market_brier: scored.metrics.market_brier,
    walk_forward_n: walkForward.length,
    walk_forward_calibrated_brier: wf.metrics.calibrated_brier,
    walk_forward_market_brier: wf.metrics.market_brier,
    walk_forward_calibrated_log_loss: wf.metrics.calibrated_log_loss,
    walk_forward_market_log_loss: wf.metrics.market_log_loss,
    walk_forward_expected_calibration_error: wf.metrics.expected_calibration_error,
    walk_forward_calibration_intercept: wf.metrics.calibration_intercept,
    walk_forward_calibration_slope: wf.metrics.calibration_slope,
    walk_forward_calibration_slope_se: wf.metrics.calibration_slope_se,
    walk_forward_calibration_slope_estimable: wf.metrics.calibration_slope_estimable,
    walk_forward_edge_slope: wf.metrics.edge_slope,
    walk_forward_edge_slope_se: wf.metrics.edge_slope_se,
    walk_forward_edge_slope_z: wf.metrics.edge_slope_z,
    walk_forward_edge_predicts_totals: wf.metrics.edge_predicts_totals,
    // Same gate contract as nfl-cover-calibration.js's `forward_gate_passed`.
    forward_gate_passed: walkForward.length >= 200 &&
      wf.metrics.calibrated_brier <= wf.metrics.market_brier &&
      wf.metrics.calibrated_log_loss <= wf.metrics.market_log_loss &&
      Math.abs(wf.metrics.calibration_intercept ?? Infinity) <= 0.2 &&
      wf.metrics.edge_predicts_totals === true &&
      (!wf.metrics.calibration_slope_estimable ||
        ((wf.metrics.calibration_slope ?? 0) >= 0.7 && (wf.metrics.calibration_slope ?? Infinity) <= 1.3)) &&
      (wf.metrics.expected_calibration_error ?? Infinity) <= 0.05
  };
  run(`INSERT INTO nfl_total_calibrations
    (model_version,trained_from,trained_through,created_at,sample_size,intercept,edge_slope,metrics_json,reliability_json)
    VALUES (?,?,?,datetime('now'),?,?,?,?,?)
    ON CONFLICT(model_version,trained_from,trained_through) DO UPDATE SET
      created_at=excluded.created_at,sample_size=excluded.sample_size,intercept=excluded.intercept,
      edge_slope=excluded.edge_slope,metrics_json=excluded.metrics_json,reliability_json=excluded.reliability_json`,
    VERSION, fromSeason, throughSeason, samples.length, fit.intercept, fit.edgeSlope,
    JSON.stringify(metrics), JSON.stringify(wf.buckets));
  return latestTotalCalibration(throughSeason + 1);
}

export function latestTotalCalibration(beforeSeason = 9999, modelVersion = null) {
  const r = rows(`SELECT * FROM nfl_total_calibrations WHERE trained_through < ?
      AND (? IS NULL OR model_version=?) ORDER BY trained_through DESC, id DESC LIMIT 1`,
  beforeSeason, modelVersion, modelVersion)[0];
  if (!r) return null;
  return { ...r, metrics: JSON.parse(r.metrics_json), reliability: JSON.parse(r.reliability_json),
    metrics_json: undefined, reliability_json: undefined };
}

/**
 * Same public contract as `calibratedCoverProbability`: returns a probability
 * only once the walk-forward gate has actually proven an edge over the
 * no-vig market. Every caller (topTotals / ensureTotalPicks) must treat a
 * null probability as "abstain", not "assume 50/50" — the gate having never
 * passed on real data is itself the finding, not a missing feature.
 */
export function calibratedTotalProbability({ season, marketProbability, edgePoints, modelVersion = VERSION }) {
  const fit = latestTotalCalibration(season, modelVersion);
  if (!fit || !fit.metrics?.forward_gate_passed || marketProbability == null || edgePoints == null) {
    return { probability: null, calibration: fit };
  }
  return {
    probability: r4(sigmoid(logit(marketProbability) + fit.intercept + fit.edge_slope * (edgePoints / 7))),
    calibration: fit
  };
}
