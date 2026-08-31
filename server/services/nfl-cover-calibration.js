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

const VERSION = 'cover-logit-v2';
const r4 = v => v == null || !Number.isFinite(v) ? null : +v.toFixed(4);
const sigmoid = x => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));
const logit = p => Math.log(Math.max(1e-5, Math.min(1 - 1e-5, p)) / Math.max(1e-5, 1 - Math.min(1 - 1e-5, p)));
const implied = o => o == null ? null : o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100);
const noVig = (a, b) => {
  const pa = implied(a), pb = implied(b);
  return pa != null && pb != null && pa + pb > 0 ? pa / (pa + pb) : null;
};

/**
 * Fit the market-anchored offset, with the shrinkage strength as a parameter.
 *
 * The model is `sigmoid(logit(market) + b0 + b1 * edge/7)`, which means b0 = b1 = 0
 * reproduces the market EXACTLY. That has an important consequence: this model
 * can only lose to the market out of sample by fitting noise. If it does, the
 * answer is more shrinkage, not a different model.
 *
 * `lambda` is an L2 penalty pulling both coefficients toward zero — that is,
 * toward the market. It used to be hardcoded at 1, which against a thousand
 * samples is no shrinkage at all, and the walk-forward result was a model very
 * slightly WORSE than the line it was anchored to. `selectLambda` now chooses it
 * on training data instead of leaving it at a number nobody tuned.
 */
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

/**
 * Choose the shrinkage strength by walk-forward cross-validation INSIDE the
 * training data.
 *
 * This is the honest way to ask "how much should we trust the model over the
 * market?" — and it can answer "not at all". A selected lambda at the top of the
 * grid means every candidate edge was noise and the correct blend is the market
 * itself. That is a real finding, not a failure, and it is much better than
 * shipping a model that quietly loses to the line it was anchored to.
 *
 * Cutoff-safe: only seasons strictly before the evaluation season are ever seen.
 */
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

  // The one-standard-error rule. With only two or three inner folds the CV
  // estimate is itself noisy, and picking its raw minimum is a second, quieter
  // way to overfit — it is what selected no shrinkage at all for two of the four
  // evaluation seasons, and those were the seasons the model lost to the market
  // on. Taking the STRONGEST shrinkage whose loss is within one standard error
  // of the best breaks the tie toward the market, which is the correct default
  // when the evidence cannot separate them.
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
  // How precisely can the probability-scale slope be estimated at all? On a
  // spread market the no-vig probability sits within a hair of 0.500 by
  // construction, so logit(market) barely varies and the slope regression has
  // almost no predictor variance to work with. Reporting the standard error
  // makes an unusable estimate visible instead of letting it read as a finding.
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
    // A slope test is only meaningful when the window it is judged against is
    // narrower than the noise on the estimate.
    calibration_slope_estimable: slopeSe != null && slopeSe < 0.3,
    // The same question — is the model overconfident? — asked on the edge scale,
    // where the predictor actually varies and the estimate is roughly five times
    // more precise.
    edge_slope: r4(edgeFit.slope), edge_slope_se: r4(edgeFit.se),
    edge_slope_z: r4(edgeFit.z),
    edge_predicts_covers: edgeFit.z != null && edgeFit.z > 1.96,
    base_rate: predicted.length ? r4(predicted.reduce((s, x) => s + x.outcome, 0) / predicted.length) : null
  }, buckets };
}

/**
 * Does the model's claimed edge actually predict covers?
 *
 * This replaces the probability-scale slope as the overconfidence test, for one
 * concrete reason: on a spread market the no-vig probability has a standard
 * deviation near 0.014, so `logit(market)` barely moves and the slope estimated
 * against it carries a standard error close to 1.0. A gate demanding that slope
 * land inside [0.7, 1.3] therefore rejects a PERFECTLY calibrated model about
 * three quarters of the time — it is measuring noise, not calibration.
 *
 * Claimed edge in points has a standard deviation near 1.9, which is real
 * variance, so the same question can be asked with roughly five times the
 * precision here. A slope significantly above zero means bigger claimed edges
 * really do win more often; a slope indistinguishable from zero means the edge
 * column is decoration.
 */
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
  // Standard error from the observed information for the slope term.
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

/**
 * Sweep the model's weight against the market and report what each level is worth.
 *
 * This is the single most decisive diagnostic in the calibration file, because
 * the blend is market-anchored: at infinite shrinkage it IS the market, so the
 * sweep brackets the entire space of "how much should we trust the model".
 *
 * If any interior lambda beats the market, the model carries real orthogonal
 * signal and the only question is how much. If the curve is monotone — every
 * unit of model weight strictly worse, converging to parity only by discarding
 * the model — then there is no edge to calibrate, and no staking policy, prior,
 * or reweighting can manufacture one. That is a much stronger statement than a
 * single failed gate, and it is worth being able to re-run rather than trust.
 */
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
  const lambdaLog = [];
  for (let season = fromSeason + 1; season <= throughSeason; season++) {
    const train = samples.filter(s => s.season < season);
    const test = samples.filter(s => s.season === season);
    if (train.length < 100 || !test.length) continue;
    // Shrinkage chosen on the training seasons only, so the evaluation season is
    // never used to decide how much to trust the model.
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
    walk_forward_edge_predicts_covers: wf.metrics.edge_predicts_covers,
    /**
     * The gate, rebuilt around tests that are actually estimable on this market.
     *
     * The previous version required the PROBABILITY-scale calibration slope to
     * land in [0.7, 1.3]. On a spread market that condition is unpassable by
     * construction: the no-vig probability has a standard deviation near 0.014
     * because a spread is set to make both sides 50/50, so the slope carries a
     * standard error near 1.0 against a window of 0.6. A perfectly calibrated
     * model cleared it roughly a quarter of the time, at random. It was
     * rejecting on noise, and it is now applied only when the estimate is
     * precise enough to mean something.
     *
     * In its place the same question is asked where the data can answer it: does
     * a bigger claimed edge actually win more often? That predictor has real
     * variance, and the estimate is about five times more precise.
     */
    forward_gate_passed: walkForward.length >= 200 &&
      // Market-anchored: the model must not be WORSE than the line it is built on.
      wf.metrics.calibrated_brier <= wf.metrics.market_brier &&
      wf.metrics.calibrated_log_loss <= wf.metrics.market_log_loss &&
      Math.abs(wf.metrics.calibration_intercept ?? Infinity) <= 0.2 &&
      // The real test: claimed edge must demonstrably predict covers.
      wf.metrics.edge_predicts_covers === true &&
      // Only judged when the estimate is precise enough to be judged.
      (!wf.metrics.calibration_slope_estimable ||
        ((wf.metrics.calibration_slope ?? 0) >= 0.7 && (wf.metrics.calibration_slope ?? Infinity) <= 1.3)) &&
      (wf.metrics.expected_calibration_error ?? Infinity) <= 0.05
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

export function latestCoverCalibration(beforeSeason = 9999, modelVersion = null) {
  const r = rows(`SELECT * FROM nfl_cover_calibrations WHERE trained_through < ?
      AND (? IS NULL OR model_version=?) ORDER BY trained_through DESC, id DESC LIMIT 1`,
  beforeSeason, modelVersion, modelVersion)[0];
  if (!r) return null;
  return { ...r, metrics: JSON.parse(r.metrics_json), reliability: JSON.parse(r.reliability_json),
    metrics_json: undefined, reliability_json: undefined };
}

export function calibratedCoverProbability({ season, marketProbability, edgePoints, modelVersion = VERSION }) {
  const fit = latestCoverCalibration(season, modelVersion);
  if (!fit || !fit.metrics?.forward_gate_passed || marketProbability == null || edgePoints == null) {
    return { probability: null, calibration: fit };
  }
  return {
    probability: r4(sigmoid(logit(marketProbability) + fit.intercept + fit.edge_slope * (edgePoints / 7))),
    calibration: fit
  };
}
