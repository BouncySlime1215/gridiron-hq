/**
 * How good is the prop model, measured more than one way?
 *
 * `propAccuracy` reports MAE/RMSE/bias against the truth. That is one question
 * ("how far off is it on average") asked once, and it is not enough to trust a
 * verdict either way:
 *
 *  - MAE alone hides WHY a model is better. Beating a baseline on average
 *    while ranking players worse is a real failure mode — it already happened
 *    here: `structural_75_last3_25` had lower prop MAE than production and was
 *    correctly rejected because its rank quality was worse.
 *  - One baseline is one opinion. Season-to-date average is a fair comparator,
 *    but "beats his own average" and "beats his last game" and "beats the
 *    positional average" are different claims with different difficulty.
 *  - A pooled four-season number can hide that the edge came entirely from one
 *    lucky season. The user's own framing: consistent value, so we know it is
 *    not fake wins.
 *
 * So every predictor (the model and each baseline) is scored on the same
 * player-weeks with the same metrics, per season and pooled, plus a paired
 * bootstrap of the model against each baseline.
 *
 * Metric choices, and why each earns its place:
 *   mae        - average miss. The headline, comparable across predictors.
 *   median_ae  - typical miss. MAE is dragged by blowup games; a model can
 *                look worse on MAE while being better on most weeks.
 *   rmse       - punishes big misses. Diverges from MAE exactly when errors
 *                are fat-tailed, which is the interesting case here.
 *   bias       - systematic over/under-projection. Zero-bias is not accuracy,
 *                but persistent bias is a fixable defect rather than noise.
 *   spearman   - do we get the ORDER right? For start/sit and for picking
 *                which prop to bet, rank matters more than absolute yards.
 *   r2         - share of variance explained, vs just predicting the mean.
 *                Negative means worse than a constant guess.
 *   directional- given a line (the baseline's own number), does the model pick
 *                the correct side? This is the closest available proxy for the
 *                actual betting question without historical book lines.
 *   hit_within - share of predictions inside a tolerance band. Plain-language
 *                accuracy: "how often is it roughly right".
 */
import { propReplayRows } from './nfl-props.js';
import { pairedBootstrapDiff } from './backtest-significance.js';
import { spearman } from './backtest.js';

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const median = a => {
  if (!a.length) return null;
  const x = [...a].sort((p, q) => p - q), i = x.length >> 1;
  return x.length % 2 ? x[i] : (x[i - 1] + x[i]) / 2;
};
const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));

/** Tolerance band per metric for the plain-language "roughly right" rate. */
const TOLERANCE = { pass_yds: 40, rush_yds: 20, rec_yds: 20, receptions: 1.5 };

const ELIGIBLE = {
  pass_yds: v => v.attempts > 2,
  rush_yds: v => v.carries > 0.5,
  rec_yds: v => v.targets > 0.5,
  receptions: v => v.targets > 0.5
};

/**
 * Baselines, weakest to strongest. Each takes the per-row history the replay
 * already carries. `null` means "no opinion for this row" and the row is
 * dropped from every predictor's score so all are compared on identical rows.
 */
const BASELINES = {
  constant: 'league-wide mean for this metric (no player knowledge at all)',
  position_mean: 'league mean for this position (walk-forward, prior seasons)',
  last1: 'what he did in his most recent game',
  last3: 'his average over his last three games',
  season_to_date: 'his own season-to-date average'
};

function scorePredictor(preds, actuals, tolerance) {
  const n = preds.length;
  if (!n) return { n: 0 };
  const err = preds.map((p, i) => p - actuals[i]);
  const abs = err.map(Math.abs);
  const actMean = mean(actuals);
  const ssTot = actuals.reduce((s, a) => s + (a - actMean) ** 2, 0);
  const ssRes = err.reduce((s, e) => s + e * e, 0);
  return {
    n,
    mae: r3(mean(abs)),
    median_ae: r3(median(abs)),
    rmse: r3(Math.sqrt(mean(err.map(e => e * e)))),
    bias: r3(mean(err)),
    spearman: r3(spearman(preds.map((p, i) => ({ pred: p, act: actuals[i] })))),
    r2: ssTot > 0 ? r3(1 - ssRes / ssTot) : null,
    hit_within: r3(abs.filter(e => e <= tolerance).length / n)
  };
}

/**
 * Full grade for one metric: every predictor on identical rows, pooled and
 * per season, plus a paired bootstrap of model vs each baseline.
 */
export function propGradeReport(metricKey, seasons, { reconciliationStrength = 0, useCache = true } = {}) {
  if (!ELIGIBLE[metricKey]) throw new Error(`no grading config for ${metricKey}`);
  const tolerance = TOLERANCE[metricKey];
  const replay = propReplayRows(seasons, { reconciliationStrength, useCache });

  /*
   * Positional and global means from PRIOR seasons only, so even the weakest
   * baselines are cutoff-safe. Building a "league average" over the same
   * seasons being graded would let every baseline peek at its own answers,
   * which would flatter the model by making its comparators artificially good
   * — the mirror image of the leak this pipeline normally guards against.
   */
  const eligibleRows = replay.rows.filter(r => ELIGIBLE[metricKey](r.broad.volume));
  const priorSums = new Map(); // `${season}|${position}` and `${season}|ALL` -> {sum, n}
  for (const r of eligibleRows) {
    const v = r.actual[metricKey];
    for (const key of [`${r.season}|${r.position}`, `${r.season}|ALL`]) {
      const acc = priorSums.get(key) ?? { sum: 0, n: 0 };
      acc.sum += v; acc.n++;
      priorSums.set(key, acc);
    }
  }
  const priorMean = (season, position) => {
    let sum = 0, n = 0;
    for (const [key, acc] of priorSums) {
      const [s, p] = key.split('|');
      if (Number(s) >= season || p !== position) continue;
      sum += acc.sum; n += acc.n;
    }
    return n ? sum / n : null;
  };

  const rows = [];
  for (const r of eligibleRows) {
    const hist = r.history?.[metricKey] ?? [];
    const b = {
      constant: priorMean(r.season, 'ALL'),
      position_mean: priorMean(r.season, r.position),
      last1: hist.length ? hist.at(-1) : null,
      last3: hist.length ? mean(hist.slice(-3)) : null,
      season_to_date: r.baseline?.[metricKey] ?? null
    };
    // Identical-rows rule: every predictor must have an opinion, or nobody is scored on it.
    if (!Number.isFinite(r.broad[metricKey])) continue;
    if (Object.values(b).some(v => !Number.isFinite(v))) continue;
    rows.push({ season: r.season, actual: r.actual[metricKey], model: r.broad[metricKey], baselines: b });
  }

  const names = ['model', ...Object.keys(BASELINES)];
  const predsOf = (subset, name) => subset.map(x => (name === 'model' ? x.model : x.baselines[name]));
  const actualsOf = subset => subset.map(x => x.actual);

  const pooled = Object.fromEntries(names.map(name =>
    [name, scorePredictor(predsOf(rows, name), actualsOf(rows), tolerance)]));

  const seasonList = [...new Set(rows.map(x => x.season))].sort();
  const bySeason = Object.fromEntries(seasonList.map(season => {
    const subset = rows.filter(x => x.season === season);
    return [season, Object.fromEntries(names.map(name =>
      [name, scorePredictor(predsOf(subset, name), actualsOf(subset), tolerance)]))];
  }));

  // Does the model beat each baseline in EVERY season, or just on average?
  // A pooled win driven by one season is the "fake win" case.
  const consistency = Object.fromEntries(Object.keys(BASELINES).map(name => {
    const wins = seasonList.filter(s => bySeason[s].model.mae < bySeason[s][name].mae);
    return [name, { seasons_won: wins.length, seasons: seasonList.length,
      every_season: wins.length === seasonList.length, won_in: wins }];
  }));

  const vsBaseline = Object.fromEntries(Object.keys(BASELINES).map(name => {
    const modelErr = rows.map(x => Math.abs(x.model - x.actual));
    const baseErr = rows.map(x => Math.abs(x.baselines[name] - x.actual));
    const test = pairedBootstrapDiff(baseErr, modelErr, { iterations: 2000, seed: 7 });
    // Directional: using the baseline's number as the line, does the model pick the right side?
    const directional = rows.filter(x => x.model !== x.baselines[name]);
    const correct = directional.filter(x =>
      (x.model > x.baselines[name]) === (x.actual > x.baselines[name])).length;
    return [name, {
      description: BASELINES[name],
      model_mae: pooled.model.mae, baseline_mae: pooled[name].mae,
      skill: pooled[name].mae > 0 ? r3(1 - pooled.model.mae / pooled[name].mae) : null,
      bootstrap: test,
      beats_it: test.significant === true && test.mean_diff < 0,
      directional_accuracy: directional.length ? r3(correct / directional.length) : null,
      consistency: consistency[name]
    }];
  }));

  return {
    metric: metricKey, seasons: seasonList, n: rows.length, tolerance,
    pooled, by_season: bySeason, vs_baseline: vsBaseline,
    verdict: summarize(metricKey, pooled, vsBaseline),
    note: 'Every predictor scored on identical player-weeks. Baselines are cutoff-safe ' +
      '(positional/global means use prior seasons only). A pooled win that does not repeat ' +
      'every season is flagged in `consistency` rather than reported as settled.'
  };
}

function summarize(metricKey, pooled, vsBaseline) {
  const beaten = Object.entries(vsBaseline).filter(([, v]) => v.beats_it).map(([k]) => k);
  const lost = Object.entries(vsBaseline).filter(([, v]) => !v.beats_it).map(([k]) => k);
  const inconsistent = Object.entries(vsBaseline)
    .filter(([, v]) => v.beats_it && !v.consistency.every_season).map(([k]) => k);
  const parts = [];
  parts.push(beaten.length
    ? `beats ${beaten.length}/${Object.keys(vsBaseline).length} baselines significantly (${beaten.join(', ')})`
    : 'beats no baseline significantly');
  if (lost.length) parts.push(`does not beat: ${lost.join(', ')}`);
  if (inconsistent.length) parts.push(`WINS NOT REPEATED EVERY SEASON vs: ${inconsistent.join(', ')}`);
  if (pooled.model.r2 != null && pooled.model.r2 < 0) parts.push('r2 is NEGATIVE — worse than predicting the mean');
  return parts.join('; ');
}

export function allPropGrades(seasons, opts = {}) {
  return Object.fromEntries(Object.keys(ELIGIBLE).map(k => [k, propGradeReport(k, seasons, opts)]));
}
