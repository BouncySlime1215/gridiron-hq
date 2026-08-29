/**
 * Gradient-boosted trees on the residual the market leaves behind.
 *
 * Every model in this project so far is linear: ratings differenced, features
 * differenced and scaled, components averaged. Twenty-two of them, all beaten
 * by the closing line. The obvious objection is that the relationship might not
 * be linear — that some interaction between rest, weather, pace and efficiency
 * matters in a way no weighted average can express — and that objection
 * deserves a real answer rather than a shrug.
 *
 * So this is a different model class entirely: gradient-boosted regression
 * trees, which fit interactions and non-linearities automatically and are the
 * standard tool for exactly this kind of tabular problem.
 *
 * THE TARGET IS THE POINT. It does not predict the margin. It predicts the
 * RESIDUAL — actual margin minus what the market implied — which is the only
 * quantity that can pay. A model predicting the margin can look excellent by
 * learning to copy the spread, and this project has been fooled by softer
 * versions of that before. Predicting the residual removes the hiding place: if
 * the market is efficient the best achievable prediction is zero, and any model
 * that consistently finds structure there has found something real.
 *
 * Implemented directly rather than pulled in, because the whole point is that
 * every step is inspectable — the split criterion, the shrinkage, the depth cap
 * and the walk-forward boundary are all visible here.
 */
import { rows } from '../db/index.js';

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/**
 * One regression tree, fitted greedily on squared error.
 *
 * Depth is capped hard and leaves require a minimum sample. Both matter more
 * than usual here: the signal being hunted is at most a fraction of a point, so
 * a tree given freedom will fit noise beautifully and generalise not at all.
 */
function fitTree(X, residuals, indices, { depth, maxDepth, minLeaf, featureSubset }) {
  const value = mean(indices.map(i => residuals[i]));
  if (depth >= maxDepth || indices.length < minLeaf * 2) return { leaf: true, value };

  let best = null;
  const baseSse = indices.reduce((s, i) => s + (residuals[i] - value) ** 2, 0);

  for (const f of featureSubset) {
    // Candidate thresholds from quantiles rather than every value — far cheaper
    // and, on noisy data, no worse.
    const vals = indices.map(i => X[i][f]).filter(Number.isFinite).sort((a, b) => a - b);
    if (vals.length < minLeaf * 2) continue;
    for (const q of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      const thr = vals[Math.floor(vals.length * q)];
      const left = [], right = [];
      for (const i of indices) ((X[i][f] ?? 0) <= thr ? left : right).push(i);
      if (left.length < minLeaf || right.length < minLeaf) continue;
      const lv = mean(left.map(i => residuals[i])), rv = mean(right.map(i => residuals[i]));
      const sse = left.reduce((s, i) => s + (residuals[i] - lv) ** 2, 0)
        + right.reduce((s, i) => s + (residuals[i] - rv) ** 2, 0);
      if (!best || sse < best.sse) best = { feature: f, threshold: thr, sse, left, right };
    }
  }

  // No split improved on the leaf, so stop rather than manufacture structure.
  if (!best || best.sse >= baseSse - 1e-9) return { leaf: true, value };

  return {
    leaf: false, feature: best.feature, threshold: best.threshold,
    left: fitTree(X, residuals, best.left, { depth: depth + 1, maxDepth, minLeaf, featureSubset }),
    right: fitTree(X, residuals, best.right, { depth: depth + 1, maxDepth, minLeaf, featureSubset })
  };
}

function predictTree(tree, x) {
  let node = tree;
  while (!node.leaf) node = (x[node.feature] ?? 0) <= node.threshold ? node.left : node.right;
  return node.value;
}

/**
 * Fit the ensemble.
 *
 * Shrinkage is deliberately small and the tree count modest. On a target this
 * noisy, a high learning rate simply memorises the training seasons.
 */
export function fitGbm(X, y, {
  trees = 60, learningRate = 0.05, maxDepth = 3, minLeaf = 40, featureFraction = 0.6, seed = 42
} = {}) {
  const n = X.length;
  if (!n) return { error: 'no training rows' };
  const nFeatures = X[0].length;
  const base = mean(y);
  const preds = new Array(n).fill(base);
  const model = { base, trees: [], learningRate };

  // Deterministic feature sampling, so a refit reproduces exactly.
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };

  for (let t = 0; t < trees; t++) {
    const residuals = y.map((v, i) => v - preds[i]);
    const featureSubset = [];
    for (let f = 0; f < nFeatures; f++) if (rand() < featureFraction) featureSubset.push(f);
    if (!featureSubset.length) featureSubset.push(Math.floor(rand() * nFeatures));

    const tree = fitTree(X, residuals, [...Array(n).keys()],
      { depth: 0, maxDepth, minLeaf, featureSubset });
    model.trees.push(tree);
    for (let i = 0; i < n; i++) preds[i] += learningRate * predictTree(tree, X[i]);
  }
  return model;
}

export function predictGbm(model, x) {
  if (model?.error) return 0;
  let p = model.base;
  for (const t of model.trees) p += model.learningRate * predictTree(t, x);
  return p;
}

/**
 * Build the training matrix.
 *
 * Features are home-minus-away differentials of the team-week feature table,
 * averaged over the season to date, plus the situational fields the market is
 * known to price. Everything is strictly prior to the game being predicted.
 */
function buildDataset({ fromSeason = 2018, throughSeason = 2025 } = {}) {
  const games = rows(`
    SELECT season, week, team AS home, opponent AS away, spread, total,
           team_score, opp_score, temp, wind, roof, div_game, rest_days
    FROM game_lines
    WHERE home = 1 AND season BETWEEN ? AND ?
      AND spread IS NOT NULL AND team_score IS NOT NULL AND opp_score IS NOT NULL
    ORDER BY season, week`, fromSeason, throughSeason);

  const feat = rows(`SELECT season, week, team, features FROM nfl_team_week_features
                     WHERE season BETWEEN ? AND ?`, fromSeason, throughSeason);

  // Season-to-date means per team, computed once per (season, week).
  const byTeamSeason = new Map();
  for (const f of feat) {
    let parsed; try { parsed = JSON.parse(f.features); } catch { continue; }
    const k = `${f.season}|${f.team}`;
    if (!byTeamSeason.has(k)) byTeamSeason.set(k, []);
    byTeamSeason.get(k).push({ week: f.week, f: parsed });
  }

  const KEYS = ['off_epa_per_play', 'def_epa_per_play', 'off_success_rate', 'def_success_rate',
    'off_explosive_play_rate', 'def_explosive_play_rate', 'off_turnover_rate', 'def_turnover_rate',
    'off_sack_rate', 'def_sack_rate', 'off_yards_per_play', 'def_yards_per_play',
    'off_third_down_rate', 'def_third_down_rate', 'off_red_zone_td_rate', 'def_red_zone_td_rate',
    'off_drive_td_rate', 'def_drive_td_rate', 'off_plays_per_drive', 'off_seconds_per_drive',
    'off_pass_rate', 'off_proe', 'off_epa_volatility', 'off_early_down_epa', 'def_early_down_epa',
    'off_pressure_epa', 'def_pressure_epa', 'off_havoc_rate', 'def_havoc_rate'];

  const priorMean = (season, team, week, key) => {
    const list = byTeamSeason.get(`${season}|${team}`);
    if (!list) return null;
    const vals = list.filter(x => x.week < week).map(x => x.f[key]).filter(Number.isFinite);
    return vals.length ? mean(vals) : null;
  };

  const X = [], y = [], meta = [];
  for (const g of games) {
    const row = [];
    let usable = true;
    for (const k of KEYS) {
      const h = priorMean(g.season, g.home, g.week, k);
      const a = priorMean(g.season, g.away, g.week, k);
      if (h == null || a == null) { usable = false; break; }
      row.push(h - a);
    }
    if (!usable) continue;
    // Situational fields, and the market number itself so the model can learn
    // where the market is systematically off rather than only what a team is.
    row.push(g.spread ?? 0, g.total ?? 44, g.temp ?? 60, g.wind ?? 5,
      g.roof === 'dome' || g.roof === 'closed' ? 1 : 0, g.div_game ?? 0, g.rest_days ?? 7);

    const actualMargin = g.team_score - g.opp_score;
    const marketMargin = -g.spread;
    X.push(row);
    // THE TARGET: what the market missed, not what happened.
    y.push(actualMargin - marketMargin);
    meta.push({ season: g.season, week: g.week, home: g.home, away: g.away,
      spread: g.spread, actualMargin, marketMargin });
  }
  return { X, y, meta, featureNames: [...KEYS, 'spread', 'total', 'temp', 'wind', 'dome', 'div', 'rest'] };
}

/**
 * Walk-forward: can a non-linear model find what the market missed?
 *
 * Trains on every season before the test season and predicts the residual on
 * it. Three numbers decide the question:
 *
 *   RESIDUAL MAE vs ZERO   the market's own error. A model that cannot beat
 *                          predicting zero has found nothing.
 *   ATS                    whether acting on its residual would have won.
 *   MEAN PREDICTION        a model that has learned there is nothing to find
 *                          will predict close to zero, which is itself a result.
 */
export function gbmWalkForward({
  fromSeason = 2018, throughSeason = 2025, testSeasons = [2023, 2024, 2025], ...opts
} = {}) {
  const data = buildDataset({ fromSeason, throughSeason });
  if (data.X.length < 500) {
    return { error: `only ${data.X.length} usable games — feature coverage is too thin` };
  }

  const perSeason = [];
  let allAtsW = 0, allAtsL = 0, sumAbsPred = 0, nPred = 0;
  let modelErr = 0, zeroErr = 0;

  for (const season of testSeasons) {
    const trainIdx = data.meta.map((m, i) => (m.season < season ? i : -1)).filter(i => i >= 0);
    const testIdx = data.meta.map((m, i) => (m.season === season ? i : -1)).filter(i => i >= 0);
    if (trainIdx.length < 300 || !testIdx.length) continue;

    const model = fitGbm(trainIdx.map(i => data.X[i]), trainIdx.map(i => data.y[i]), opts);
    if (model.error) continue;

    let mErr = 0, zErr = 0, w = 0, l = 0, absPred = 0;
    for (const i of testIdx) {
      const pred = predictGbm(model, data.X[i]);
      const truth = data.y[i];
      mErr += Math.abs(pred - truth);
      zErr += Math.abs(truth);
      absPred += Math.abs(pred);
      // Acting on it: the residual says which side of the number to take.
      if (Math.abs(truth) > 1e-9 && Math.abs(pred) > 0.5) {
        if (Math.sign(pred) === Math.sign(truth)) w++; else l++;
      }
    }
    const n = testIdx.length;
    perSeason.push({ season, games: n, train_games: trainIdx.length,
      model_mae: r2(mErr / n), market_mae: r2(zErr / n),
      beats_market: mErr < zErr,
      mean_abs_prediction: r2(absPred / n),
      ats: `${w}-${l}`, ats_rate: w + l ? r4(w / (w + l)) : null });
    allAtsW += w; allAtsL += l; modelErr += mErr; zeroErr += zErr;
    sumAbsPred += absPred; nPred += n;
  }

  if (!perSeason.length) return { error: 'no test season had enough training history' };

  const atsN = allAtsW + allAtsL;
  const atsRate = atsN ? allAtsW / atsN : null;
  const atsZ = atsN ? (atsRate - 0.5238) / Math.sqrt(0.25 / atsN) : null;

  return {
    model: 'gradient-boosted regression trees',
    target: 'residual (actual margin minus market-implied margin)',
    features: data.featureNames.length,
    total_games: data.X.length,
    hyperparameters: { trees: opts.trees ?? 60, learning_rate: opts.learningRate ?? 0.05,
      max_depth: opts.maxDepth ?? 3, min_leaf: opts.minLeaf ?? 40 },
    per_season: perSeason,
    pooled: {
      model_mae: r2(modelErr / nPred), market_mae: r2(zeroErr / nPred),
      improvement: r4((zeroErr - modelErr) / zeroErr),
      beats_market: modelErr < zeroErr,
      mean_abs_prediction: r2(sumAbsPred / nPred),
      ats: `${allAtsW}-${allAtsL}`, ats_rate: r4(atsRate),
      ats_z_vs_break_even: r2(atsZ),
      profitable: atsRate != null && atsRate > 0.5238
    },
    verdict: modelErr < zeroErr && atsRate > 0.5238
      ? `The trees find structure the market missed: residual MAE ${r2(modelErr / nPred)} against ` +
        `${r2(zeroErr / nPred)} for predicting zero, and ${allAtsW}-${allAtsL} against the spread ` +
        `(z=${r2(atsZ)}). That is a real result and needs a forward test before it is sized.`
      : `No structure found. Residual MAE ${r2(modelErr / nPred)} against ${r2(zeroErr / nPred)} for ` +
        `simply predicting zero, and ${allAtsW}-${allAtsL} against the spread (z=${r2(atsZ)}). The ` +
        `mean absolute prediction is ${r2(sumAbsPred / nPred)} points — a non-linear model with ` +
        `${data.featureNames.length} features, given every interaction it could want, still finds ` +
        `essentially nothing the closing line has not already priced.`,
    note: 'Trained on the residual rather than the margin, deliberately. A model predicting the ' +
      'margin can look excellent by learning to copy the spread; predicting what the spread MISSED ' +
      'removes that hiding place. Walk-forward: every test season is predicted by a model trained ' +
      'only on earlier ones.'
  };
}
