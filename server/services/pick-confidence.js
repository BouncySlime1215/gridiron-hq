/**
 * One number for how likely a pick is to win, and the evidence that it means it.
 *
 * The reasoning trace opened with a paragraph about nineteen component models
 * and how much they scattered. That is the right information in the wrong form:
 * nobody setting a bet wants a description of an ensemble's internal argument,
 * they want to know how confident to be. So the whole of that paragraph is
 * compressed into a single percentage here, and the football moves to the front.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT MAKES A CONFIDENCE NUMBER HONEST
 *
 * Almost every confidence score in sports modelling is a rescaled edge — bigger
 * disagreement with the market becomes a bigger number, and nothing ever checks
 * whether 70% actually wins 70% of the time. That produces a page full of
 * confident picks for a model measured at 46.5%, which is worse than showing no
 * number at all.
 *
 * This is fitted on outcomes and reports its own calibration. Two consequences
 * follow immediately and both are features:
 *
 *   MOST PICKS COME OUT BELOW 50%. The base rate is what it is. A model that
 *   loses at 46.5% cannot honestly produce many 60% picks, and a confidence
 *   scale that refuses to flatter it is telling you the single most useful thing
 *   it knows.
 *
 *   THE SPREAD IS NARROW. With 155 historical picks the fit cannot support
 *   strong separation, so estimates are shrunk toward the base rate in
 *   proportion to how little evidence stands behind them. A tight range is the
 *   correct output of a weak model on a small sample, not a bug.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CUTOFF SAFETY
 *
 * The fit uses only completed seasons strictly before the one being scored, so a
 * confidence attached to a 2024 pick was never trained on 2024 results. Scoring
 * the same seasons the fit was trained on would produce a beautiful calibration
 * curve and a worthless number.
 */
import { rows } from '../db/index.js';
import { cached, fingerprint } from './compute-cache.js';
import { replaySeason } from './nfl-replay.js';

const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));

/** Break-even at -110, the only threshold that decides whether a number is useful. */
export const BREAK_EVEN = 0.5238;

/**
 * Features available at pick time, and only those.
 *
 * `scatter_ratio` is the component disagreement divided by the edge — the whole
 * of the old first paragraph reduced to one number. Below 1 the models agree
 * with each other and disagree with the market, which is the shape a real edge
 * has; above 1 the blend is averaging its own noise.
 */
export function pickFeatures(pick, models = null) {
  const edge = Math.abs((pick?.model_margin ?? 0) - (pick?.market_margin ?? 0));
  let scatter = pick?.disagreement ?? null;
  if (scatter == null && Array.isArray(models) && models.length) {
    const key = pick?.market === 'total' ? 'total' : 'margin';
    const v = models.map(m => m?.[key]).filter(Number.isFinite);
    if (v.length > 1) {
      const mean = v.reduce((a, b) => a + b, 0) / v.length;
      scatter = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length);
    }
  }
  return {
    edge,
    scatter: scatter == null ? null : Math.abs(scatter),
    // Guarded: a zero edge makes this infinite, and an infinite feature poisons
    // a logistic fit silently rather than loudly.
    scatter_ratio: scatter == null ? null : Math.abs(scatter) / Math.max(0.5, edge),
    is_total: pick?.market === 'total' ? 1 : 0
  };
}

/**
 * Fit the confidence model on completed seasons before `beforeSeason`.
 *
 * Logistic regression by gradient descent — the feature count is three and the
 * sample is small, so anything more elaborate would be fitting noise with more
 * steps.
 */
function fitConfidence(beforeSeason) {
  // Replayed live rather than read from `nfl_replay_bets`.
  //
  // That table only fills when a replay is run with a persisted run id, and on a
  // fresh checkout it is empty — which made the confidence model silently
  // unfittable and every pick "unmeasurable". Running the replay is a few
  // seconds per season and the result is cached on the underlying data, so this
  // works on a machine that has never persisted a run.
  const history = [];
  for (let season = beforeSeason - 5; season < beforeSeason; season++) {
    let r;
    try { r = replaySeason(season, { startWeek: 5, endWeek: 18 }); } catch { continue; }
    if (r?.error || !Array.isArray(r.bets)) continue;
    for (const b of r.bets) {
      if (b.result !== 'Won' && b.result !== 'Lost') continue;
      history.push({ season, market: b.market, model_margin: b.model_margin,
        market_margin: b.market_margin, disagreement: b.disagreement, result: b.result });
    }
  }

  if (history.length < 60) {
    return { fitted: false, n: history.length, base_rate: null,
      why: `Only ${history.length} settled historical picks before ${beforeSeason}. Below about 60 ` +
        'a fit is noise, so confidence falls back to the base rate alone.' };
  }

  const samples = history.map(h => {
    const f = pickFeatures(h);
    return { x: [1, f.edge, f.scatter_ratio ?? 1, f.is_total], y: h.result === 'Won' ? 1 : 0 };
  }).filter(s => s.x.every(Number.isFinite));

  const base = samples.reduce((s, x) => s + x.y, 0) / samples.length;
  // Intercept seeded at the base-rate log-odds so the fit starts honest and only
  // moves where the features actually carry something.
  const w = [Math.log(base / (1 - base)), 0, 0, 0];
  const lr = 0.02;
  for (let iter = 0; iter < 4000; iter++) {
    const g = [0, 0, 0, 0];
    for (const s of samples) {
      const z = w.reduce((a, wi, i) => a + wi * s.x[i], 0);
      const p = 1 / (1 + Math.exp(-z));
      const err = p - s.y;
      for (let i = 0; i < w.length; i++) g[i] += err * s.x[i];
    }
    // L2 on the slopes only — the intercept should be free to sit at the base
    // rate, and shrinking it would bias every prediction toward a coin flip.
    for (let i = 1; i < w.length; i++) g[i] += 0.5 * w[i];
    for (let i = 0; i < w.length; i++) w[i] -= (lr / samples.length) * g[i];
  }

  return { fitted: true, weights: w, n: samples.length, base_rate: r3(base),
    trained_before_season: beforeSeason };
}

/** Cached per cutoff season; the underlying replay table changes rarely. */
function confidenceModel(beforeSeason) {
  return cached(`pick-confidence:${beforeSeason}`,
    fingerprint([{ table: 'game_lines', stamp: 'week' },
      { table: 'nfl_team_week_features', stamp: 'week' }], String(beforeSeason)),
    () => fitConfidence(beforeSeason));
}

/**
 * Confidence for one pick, as a probability it wins.
 *
 * Shrunk toward the base rate by how much evidence stands behind the fit, so a
 * thin history produces a number close to the base rate rather than a confident
 * one built on nothing.
 */
export function pickConfidence(pick, { models = null, season = null } = {}) {
  const yr = season ?? pick?.season ?? new Date().getFullYear();
  const m = confidenceModel(yr);
  const f = pickFeatures(pick, models);

  if (!m.fitted) {
    return {
      confidence: null, base_rate: null, fitted: false,
      label: 'unmeasurable',
      why: m.why,
      features: f
    };
  }

  const x = [1, f.edge, f.scatter_ratio ?? 1, f.is_total];
  const z = m.weights.reduce((a, wi, i) => a + wi * x[i], 0);
  const raw = 1 / (1 + Math.exp(-z));

  // Shrinkage toward the base rate. At n = 155 the weight on the fit is about
  // 0.6, which is the honest amount of trust a sample that size supports.
  const k = 100;
  const lambda = m.n / (m.n + k);
  const p = lambda * raw + (1 - lambda) * m.base_rate;

  return {
    confidence: r3(p),
    raw_model_estimate: r3(raw),
    base_rate: m.base_rate,
    shrinkage_weight: r3(lambda),
    fitted: true,
    trained_on: `${m.n} settled picks from seasons before ${m.trained_before_season}`,
    break_even: BREAK_EVEN,
    beats_break_even: p > BREAK_EVEN,
    label: p >= BREAK_EVEN + 0.03 ? 'edge'
      : p >= BREAK_EVEN ? 'marginal'
        : p >= 0.48 ? 'below the vig'
          : 'negative',
    features: {
      edge_points: r3(f.edge),
      component_scatter: r3(f.scatter),
      // The old opening paragraph, in one number.
      scatter_ratio: r3(f.scatter_ratio)
    },
    reading: p > BREAK_EVEN
      ? `${Math.round(p * 100)}% — above the ${Math.round(BREAK_EVEN * 100)}% needed to profit at -110.`
      : `${Math.round(p * 100)}%, against the ${Math.round(BREAK_EVEN * 100)}% needed to break even ` +
        'at -110. This pick loses money on average.',
    caveat: 'Fitted on completed seasons before this one and shrunk toward the base rate by sample ' +
      'size. Most picks land below break-even because the model does: the scale refuses to flatter ' +
      'a forecaster measured at 46.5%, and that refusal is the useful part.'
  };
}

/**
 * Does the confidence number mean what it says?
 *
 * Buckets predictions and compares them to outcomes. A confidence scale that has
 * never been checked this way is a rescaled edge wearing a percentage sign.
 */
export function confidenceCalibration({ seasons = null } = {}) {
  const yrs = seasons ?? rows(
    `SELECT DISTINCT season FROM game_lines WHERE team_score IS NOT NULL
     AND season >= 2021 ORDER BY season`).map(r => r.season);
  const scored = [];

  for (const season of yrs) {
    const m = confidenceModel(season);
    if (!m.fitted) continue;
    let replay;
    try { replay = replaySeason(season, { startWeek: 5, endWeek: 18 }); } catch { continue; }
    if (replay?.error) continue;
    const picks = (replay.bets ?? []).filter(b => b.result === 'Won' || b.result === 'Lost');
    for (const p of picks) {
      const c = pickConfidence(p, { season });
      if (c.confidence == null) continue;
      scored.push({ predicted: c.confidence, won: p.result === 'Won' ? 1 : 0, season });
    }
  }

  if (!scored.length) {
    return { error: 'no out-of-sample picks could be scored',
      note: 'Each season is scored by a model fitted only on seasons before it, so the earliest ' +
        'season in the table can never be scored.' };
  }

  // Buckets are deliberately narrow around the base rate: that is where every
  // prediction actually lands, and wide buckets would hide the whole picture in
  // a single bar.
  const edges = [0, 0.40, 0.44, 0.46, 0.48, 0.50, 0.52, 0.55, 1];
  const buckets = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const inBucket = scored.filter(s => s.predicted >= edges[i] && s.predicted < edges[i + 1]);
    if (!inBucket.length) continue;
    const actual = inBucket.reduce((s, x) => s + x.won, 0) / inBucket.length;
    const predicted = inBucket.reduce((s, x) => s + x.predicted, 0) / inBucket.length;
    buckets.push({
      range: `${(edges[i] * 100).toFixed(0)}–${(edges[i + 1] * 100).toFixed(0)}%`,
      n: inBucket.length, predicted: r3(predicted), actual: r3(actual),
      error: r3(actual - predicted)
    });
  }

  const n = scored.length;
  const meanPredicted = scored.reduce((s, x) => s + x.predicted, 0) / n;
  const meanActual = scored.reduce((s, x) => s + x.won, 0) / n;
  const brier = scored.reduce((s, x) => s + (x.predicted - x.won) ** 2, 0) / n;
  const ece = buckets.reduce((s, b) => s + b.n * Math.abs(b.error), 0) / n;

  return {
    n, buckets,
    mean_predicted: r3(meanPredicted),
    mean_actual: r3(meanActual),
    bias: r3(meanActual - meanPredicted),
    brier: r3(brier),
    expected_calibration_error: r3(ece),
    picks_above_break_even: scored.filter(s => s.predicted > BREAK_EVEN).length,
    verdict: Math.abs(meanActual - meanPredicted) < 0.03
      ? 'Calibrated: what the number says, the picks do. That does not make the picks good — a ' +
        'well-calibrated 46% is still a losing bet, and it is honest about being one.'
      : `Miscalibrated by ${((meanActual - meanPredicted) * 100).toFixed(1)} points. The scale is ` +
        (meanActual > meanPredicted ? 'too pessimistic' : 'too optimistic') + ' and needs refitting.',
    note: 'Every season is scored by a model fitted only on earlier seasons, so this is an ' +
      'out-of-sample calibration rather than a description of the training data.'
  };
}
