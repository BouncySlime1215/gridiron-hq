/**
 * Walk-forward bake-off: the score-driven joint scoring model against the
 * champion blend, on seasons neither of them trained on.
 *
 * Measurement only. Nothing here is wired into a route, a weight or a forecast.
 *
 * ===========================================================================
 * THE FAIRNESS RULES, WHICH MATTER MORE THAN THE NUMBERS
 * ===========================================================================
 *
 * A bake-off that quietly handicaps the incumbent produces a flattering number
 * and no information. Four things are done specifically to prevent that.
 *
 * 1. THE INCUMBENT KEEPS ITS PRODUCTION CADENCE. It is replayed through
 *    `walkForwardCombination` at WEEKLY refit, which is what `ensembleLine`
 *    really does. The challenger's static parameters are refit only at season
 *    boundaries — a coarser cadence — because its team strengths are FILTERED
 *    every game and so already carry everything up to kickoff. Neither side is
 *    given staler information than it would have in production.
 *
 * 2. THE INCUMBENT KEEPS THE MARKET. It is a market-residual blend and the
 *    market is the best single forecast in this or any NFL dataset. The
 *    challenger is deliberately market-blind, because structural independence
 *    from the ensemble is the entire reason it was built. That is not a fair
 *    fight and it is not meant to be one: the standalone comparison answers
 *    "is this a better forecaster than the champion" (it will not be), and the
 *    anchored comparison below answers the question that actually decides
 *    whether it ships — "does it know anything the market does not".
 *
 * 3. THE INCUMBENT GETS A GENEROUS PREDICTIVE DISTRIBUTION. To score CRPS and
 *    log-score, a point forecast has to become a distribution. The incumbent's
 *    is built by recentring the EMPIRICAL distribution of (actual - market)
 *    over training games onto its point forecast. That construction hands it
 *    the true historical error spread and, because real margins are integers,
 *    the true key-number lattice at 3 and 7 — so the challenger gets no free
 *    win from being lattice-aware. It is the same empirical-error convention
 *    `forecast-combination.js` already uses for cover probabilities.
 *
 * 4. EVERY COMPARISON IS ON THE INTERSECTION. Both sides are scored only on
 *    games where both produced a forecast, so no result comes from one side
 *    having quietly been graded on an easier subset.
 *
 * Significance is Diebold-Mariano with the Harvey-Leybourne-Newbold correction,
 * clustered by week, exactly as in stage 2 — sixteen games sharing one week of
 * market state are not sixteen independent observations.
 */
import { rows } from '../db/index.js';
import {
  fitJointScoreModel, runFilter, jointScorePmf, jointSummary,
  coverProbabilityFromMargin, unpackParams, SEVERITY_VALUES
} from './nfl-joint-score.js';
import { ensembleReplayInputs, componentPredictionStream, componentIds } from './nfl-ensemble.js';
import { walkForwardCombination } from './forecast-combination.js';
import { dieboldMariano } from './forecast-comparison.js';

export const JOINT_BACKTEST_VERSION = 'nfl-joint-score-backtest-v1';

const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
const r5 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(5));

/* ------------------------------------------------------------------- data */

/**
 * One row per game with both scores, chronological.
 *
 * Deliberately the same source and the same home-side convention as
 * `nfl-ensemble.js#games`, so the two models are replaying the same league.
 * Unlike the ensemble's query this does NOT require a posted spread, because
 * the joint model has no use for one — but the harness filters to games with a
 * market quote before scoring anything, since the incumbent needs it.
 */
export function loadJointGames({ minSeason = 2015 } = {}) {
  return rows(`
    SELECT season, week, team AS home, opponent AS away,
           team_score AS home_score, opp_score AS away_score,
           spread AS home_spread, total, neutral_site
    FROM game_lines
    WHERE home = 1 AND team_score IS NOT NULL AND opp_score IS NOT NULL
      AND season >= ?
    ORDER BY season, week
  `, minSeason).map(g => ({ ...g, neutral: Boolean(g.neutral_site) }));
}

/* ------------------------------------------------------- scoring rules */

/**
 * Discrete CRPS (the ranked probability score) for an integer-valued forecast.
 *
 *   CRPS = sum_k ( F(k) - 1{y <= k} )^2
 *
 * This is the proper form for a lattice-valued quantity and is what lets a
 * distribution with mass ON 3 and 7 be rewarded for it. A continuous CRPS
 * computed against a smoothed density would blur exactly the feature that
 * distinguishes the two models here.
 */
export function discreteCrps(pmf, offset, observed) {
  let cdf = 0, crps = 0;
  for (let i = 0; i < pmf.length; i++) {
    cdf += pmf[i];
    const indicator = (i - offset) >= observed ? 1 : 0;
    const d = cdf - indicator;
    crps += d * d;
  }
  return crps;
}

/** Log score of one cell of a joint score matrix, renormalised over the grid. */
export function jointCellLogScore(joint, mass, homeScore, awayScore, grid) {
  const inside = homeScore >= 0 && awayScore >= 0 && homeScore <= grid && awayScore <= grid;
  const p = inside && mass > 0 ? joint.at(homeScore, awayScore) / mass : 0;
  return -Math.log(Math.max(p, 1e-12));
}

/** Log score of an integer outcome under a pmf, with a floor for impossibles. */
export function logScore(pmf, offset, observed) {
  const i = observed + offset;
  const p = i >= 0 && i < pmf.length ? pmf[i] : 0;
  return -Math.log(Math.max(p, 1e-12));
}

/**
 * The incumbent's predictive margin law: the empirical distribution of
 * (actual - market) over training games, recentred on a point forecast.
 *
 * See fairness rule 3 in the header for why this is the construction chosen and
 * why it is generous rather than stingy.
 *
 * @param {number[]} trainingErrors  actual - market, integer valued.
 * @param {number}   forecast        The point forecast to centre on.
 * @param {number}   support         Half-width of the returned pmf.
 */
export function empiricalMarginPmf(trainingErrors, forecast, support = 80) {
  const size = 2 * support + 1;
  const pmf = new Float64Array(size);
  // The forecast is continuous and the errors are integers, so the recentred
  // law lands off-lattice. Splitting each error between the two adjacent
  // integers preserves the mean and keeps the lattice spikes intact rather
  // than smearing them across a rounding.
  const lo = Math.floor(forecast), frac = forecast - lo;
  let placed = 0;
  for (const e of trainingErrors) {
    const a = lo + e + support, b = a + 1;
    if (a >= 0 && a < size) { pmf[a] += (1 - frac); placed += (1 - frac); }
    if (b >= 0 && b < size) { pmf[b] += frac; placed += frac; }
  }
  if (placed <= 0) return null;
  for (let i = 0; i < size; i++) pmf[i] /= placed;
  return { pmf, offset: support };
}

/** RMSE / MAE / bias / CRPS / log-score / cover-Brier for one method. */
export function scoreSet(predictions) {
  if (!predictions.length) return { n: 0 };
  const errs = predictions.map(p => p.forecast - p.actual);
  const crps = predictions.map(p => p.crps).filter(Number.isFinite);
  const ls = predictions.map(p => p.log_score).filter(Number.isFinite);
  const graded = predictions.filter(p => p.cover_outcome != null && p.cover_probability != null);
  return {
    n: predictions.length,
    rmse: r4(Math.sqrt(mean(errs.map(e => e ** 2)))),
    mae: r4(mean(errs.map(e => Math.abs(e)))),
    bias: r4(mean(errs)),
    crps: crps.length ? r4(mean(crps)) : null,
    crps_n: crps.length,
    log_score: ls.length ? r4(mean(ls)) : null,
    cover_n: graded.length,
    cover_brier: graded.length
      ? r5(mean(graded.map(p => (p.cover_probability - p.cover_outcome) ** 2)))
      : null
  };
}

/* -------------------------------------------------- the challenger's walk-forward */

/**
 * Walk the joint model forward across held-out seasons.
 *
 * For each test season: fit the statics on every game strictly before it, run
 * the filter through that history to reach the season-opening state, then step
 * through the season one game at a time — forecasting from the state BEFORE
 * kickoff and updating with the result afterwards. No game contributes to its
 * own forecast and no test season contributes to its own parameters.
 *
 * `jointGrid` caps the score grid used for the full joint matrix. 60 covers
 * every NFL score bar a handful of historical outliers and quarters the cost of
 * the 61x61 sweep versus the model's 81-point support.
 */
export function walkForwardJointScore({
  games, testSeasons, minTrainGames = 400, maxIterations = 700, jointGrid = 75,
  onSeason = null
} = {}) {
  const chronological = [...games].sort((a, b) => a.season - b.season || a.week - b.week);
  const predictions = [];
  const independencePredictions = [];
  const anchoredPredictions = [];
  const seasonReports = [];

  for (const season of [...testSeasons].sort((a, b) => a - b)) {
    const train = chronological.filter(g => g.season < season);
    const test = chronological.filter(g => g.season === season);
    if (train.length < minTrainGames || !test.length) {
      seasonReports.push({ season, skipped: `only ${train.length} training games` });
      continue;
    }

    const model = fitJointScoreModel(train, { maxIterations });
    // Replay the filter over training history to land on the state that a
    // forecaster standing at the start of this season would actually hold, and
    // record what it forecast along the way.
    //
    // Those training-block forecasts are what the market anchor's single weight
    // is fitted on. They are genuinely one-step-ahead — the filter predicts each
    // game from the state before it — and the only thing about them that is not
    // out of sample is that the eight static parameters were chosen using the
    // same games. That is precisely the contamination the incumbent's own
    // residual-gate slope carries, so the two sides are even. Fitting the anchor
    // on held-out seasons instead would leave the first two test seasons with no
    // weight at all and shrink the shipping gate to one season.
    const trainForecasts = [];
    const warm = runFilter(train, model.theta, model.severity, {
      scaling: model.scaling,
      onPredict: (g, { lambdaHome, lambdaAway, severity }) => {
        if (g.home_spread == null) return;
        // The expected margin is exact in closed form — (lambda_h - lambda_a)
        // times the mean value of a scoring event, since the shared shock
        // contributes equally to both sides and cancels. Building the full joint
        // matrix for a quantity with an analytic mean would be pure waste.
        trainForecasts.push({
          market: -g.home_spread,
          forecast: (lambdaHome - lambdaAway) * expectedSeverity(severity),
          actual: g.home_score - g.away_score
        });
      }
    });
    const states = warm.states;
    const anchor = fitAnchorWeight(trainForecasts);
    const p = unpackParams(model.theta);
    // Offseason regression applies once on the way into the test season.
    for (const [k, v] of states.attack) states.attack.set(k, v * p.seasonCarry);
    for (const [k, v] of states.defence) states.defence.set(k, v * p.seasonCarry);

    let seasonPredictions = 0;
    runFilter(test, model.theta, model.severity, {
      scaling: model.scaling,
      states,
      onPredict: (g, { lambdaHome, lambdaAway, lambdaC, severity }) => {
        const joint = jointScorePmf(lambdaHome, lambdaAway, lambdaC, severity, { maxScore: jointGrid });
        const s = jointSummary(joint);
        const actualMargin = g.home_score - g.away_score;
        const market = g.home_spread == null ? null : -g.home_spread;
        const record = {
          season: g.season, week: g.week, week_key: `${g.season}|${g.week}`,
          home: g.home, away: g.away,
          actual: actualMargin,
          actual_total: g.home_score + g.away_score,
          home_score: g.home_score, away_score: g.away_score,
          market,
          forecast: s.margin_mean,
          margin_sd: s.margin_sd,
          correlation: s.correlation,
          total_mean: s.total_mean,
          crps: discreteCrps(s.margin_pmf, s.margin_offset, actualMargin),
          log_score: logScore(s.margin_pmf, s.margin_offset, actualMargin),
          // Divided by the grid's own mass for the same reason jointSummary
          // renormalises: a log score read off an improper distribution is not
          // comparable with one read off a proper one.
          joint_log_score: jointCellLogScore(joint, s.mass, g.home_score, g.away_score, jointGrid),
          cover_outcome: market == null ? null : (actualMargin > market ? 1 : actualMargin < market ? 0 : null),
          cover_probability: market == null ? null
            : coverProbabilityFromMargin(s.margin_pmf, s.margin_offset, market)
        };
        predictions.push(record);
        seasonPredictions++;

        // The same forecast shrunk onto the market by the single weight fitted
        // above. This is the entrant the shipping gate is about.
        if (market != null && anchor.weight != null) {
          const forecast = market + anchor.weight * (s.margin_mean - market);
          const law = empiricalMarginPmf(anchor.errors, forecast, 80);
          anchoredPredictions.push({
            season: g.season, week: g.week, week_key: `${g.season}|${g.week}`,
            home: g.home, away: g.away, actual: actualMargin, market, forecast,
            crps: law ? discreteCrps(law.pmf, law.offset, actualMargin) : null,
            log_score: law ? logScore(law.pmf, law.offset, actualMargin) : null,
            cover_outcome: record.cover_outcome,
            cover_probability: law ? coverProbabilityFromMargin(law.pmf, law.offset, market) : null
          });
        }

        // The same model with the shared scoring-event shock switched off. The
        // marginals are untouched, so the ONLY difference is whether the two
        // scoreboards are allowed to be dependent. Its joint log-score against
        // the record above is a direct, held-out measurement of whether
        // same-game correlation is real in this data.
        const indep = jointScorePmf(lambdaHome, lambdaAway, 1e-9, severity, { maxScore: jointGrid });
        const si = jointSummary(indep);
        independencePredictions.push({
          season: g.season, week: g.week, week_key: `${g.season}|${g.week}`,
          home: g.home, away: g.away, actual: actualMargin,
          forecast: si.margin_mean,
          correlation: si.correlation,
          crps: discreteCrps(si.margin_pmf, si.margin_offset, actualMargin),
          log_score: logScore(si.margin_pmf, si.margin_offset, actualMargin),
          joint_log_score: jointCellLogScore(indep, si.mass, g.home_score, g.away_score, jointGrid),
          cover_outcome: market == null ? null : (actualMargin > market ? 1 : actualMargin < market ? 0 : null),
          cover_probability: market == null ? null
            : coverProbabilityFromMargin(si.margin_pmf, si.margin_offset, market)
        });
      }
    });

    const report = {
      season,
      train_games: train.length,
      test_games: seasonPredictions,
      scaling: model.scaling,
      params: model.params,
      severity: model.severity.map(v => +v.toFixed(4)),
      severity_fit_n: model.severity_fit?.n ?? null,
      market_anchor_weight: anchor.weight == null ? null : r4(anchor.weight),
      market_anchor_train_n: anchor.n,
      train_log_lik_per_game: r4(model.train_log_lik_per_game),
      optimiser: model.optimiser
    };
    seasonReports.push(report);
    if (onSeason) onSeason(report);
  }

  return { predictions, independencePredictions, anchoredPredictions, seasons: seasonReports };
}

/* ------------------------------------------------------- the market anchor */

/**
 * Mean points per scoring event, from a fitted severity distribution.
 *
 * Exported because the expected margin has a closed form, `(lambda_home -
 * lambda_away) * E[V]`, and several callers want it without paying for a joint
 * matrix.
 */
export function expectedSeverity(severity) {
  let acc = 0;
  for (let i = 0; i < SEVERITY_VALUES.length; i++) acc += SEVERITY_VALUES[i] * severity[i];
  return acc;
}

/**
 * The one weight that blends the model's margin onto the market, plus the
 * blend's own training residuals.
 *
 * The weight is the OLS slope of (actual - market) on (model - market): the
 * minimum-variance shrinkage of the model's DEPARTURE from the market. A slope
 * of 0 says the departure is noise and the market should be left alone; a slope
 * of 1 says the departure should be taken at face value. It is the same
 * quantity the incumbent's residual gate estimates per component, which is what
 * makes this a like-for-like way of asking whether the model knows anything the
 * market does not.
 *
 * No intercept. An intercept here would fit a constant lean against the market,
 * which is a market-bias finding rather than a model finding, and would flatter
 * the model with skill that is not its own.
 */
export function fitAnchorWeight(trainForecasts, { minTrain = 150 } = {}) {
  const usable = trainForecasts.filter(t =>
    Number.isFinite(t.market) && Number.isFinite(t.forecast) && Number.isFinite(t.actual));
  if (usable.length < minTrain) return { weight: null, n: usable.length, errors: [] };
  let sxx = 0, sxy = 0;
  for (const t of usable) {
    const x = t.forecast - t.market;
    sxx += x * x;
    sxy += x * (t.actual - t.market);
  }
  const weight = sxx > 0 ? sxy / sxx : 0;
  const errors = usable
    .map(t => Math.round(t.actual - (t.market + weight * (t.forecast - t.market))))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return { weight, n: usable.length, errors };
}

/* ------------------------------------------------------------- the incumbent */

/**
 * Replay the champion blend and the raw market, and give both a predictive
 * margin law built the way fairness rule 3 describes.
 */
export function championPredictions({ games, testSeasons, evalFrom = 2022, minSeason = 2015, reduction = {} } = {}) {
  const inputs = ensembleReplayInputs({ evalFrom, minSeason });
  const records = [...componentPredictionStream(inputs)];
  const ids = componentIds().filter(c => !c.challenger_only).map(c => c.id);
  const wf = walkForwardCombination({
    records, componentIdList: ids, testSeasons,
    methods: ['market_only', 'incumbent_market_residual'],
    reduction, refit: 'week'
  });
  if (wf.error) return { error: wf.error };

  // Cutoff-safe error law: the market's realised errors on games strictly
  // before the test season. Integer valued, so the lattice comes for free.
  const marketErrors = new Map();
  for (const season of [...testSeasons].sort((a, b) => a - b)) {
    const errs = games
      .filter(g => g.season < season && g.home_spread != null)
      .map(g => Math.round((g.home_score - g.away_score) - (-g.home_spread)))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    marketErrors.set(season, errs);
  }

  const dress = list => list.map(p => {
    const errs = marketErrors.get(p.season) ?? [];
    const law = errs.length ? empiricalMarginPmf(errs, p.forecast, 80) : null;
    return {
      ...p,
      crps: law ? discreteCrps(law.pmf, law.offset, p.actual) : null,
      log_score: law ? logScore(law.pmf, law.offset, p.actual) : null
    };
  });

  // `walkForwardCombination` returns `predictions` as a Map keyed by method.
  return {
    market: dress(wf.predictions.get('market_only') ?? []),
    incumbent: dress(wf.predictions.get('incumbent_market_residual') ?? []),
    seasons: wf.seasons,
    pooled: wf.pooled
  };
}

/* ------------------------------------------------------------ the comparison */

const key = p => `${p.season}|${p.week}|${p.home}|${p.away}`;

/** Restrict every entrant to the games all of them forecast. */
export function intersect(sets) {
  const names = Object.keys(sets);
  if (!names.length) return {};
  let common = new Set(sets[names[0]].map(key));
  for (const n of names.slice(1)) {
    const here = new Set(sets[n].map(key));
    common = new Set([...common].filter(k => here.has(k)));
  }
  const out = {};
  for (const n of names) {
    const seen = new Set();
    out[n] = sets[n].filter(p => {
      const k = key(p);
      if (!common.has(k) || seen.has(k)) return false;
      seen.add(k); return true;
    }).sort((a, b) => a.season - b.season || a.week - b.week || (a.home < b.home ? -1 : 1));
  }
  return out;
}

/**
 * Diebold-Mariano on a named loss between two aligned prediction sets, with two
 * degeneracy guards that this harness needs and a bare DM call does not give.
 *
 * Both guards exist because the first run of this bake-off produced two
 * "significant" results that were nothing of the kind, and a reader had to go
 * into the JSON to find that out.
 *
 * GUARD 1 — A DIFFERENCE OF SIZE ZERO. With the shared shock fitted to 0.0013
 * on one fixture, switching it off changes every loss in the ninth decimal. The
 * sign of that change is perfectly consistent across games, so the clustered DM
 * statistic reached -3.54 (p = 0.0009) on a mean loss difference that rounds to
 * zero. The test was not wrong — the two forecasts really do differ, always in
 * the same direction — but calling it "better" is. Any difference below a
 * relative tolerance against the loss's own scale is reported as numerically
 * identical instead.
 *
 * GUARD 2 — A DIFFERENCE LIVING IN ONE WEEK. The incumbent's residual gate
 * opens rarely, so on one fixture it departed from the market in exactly one of
 * 51 weekly clusters. A clustered DM over 50 zeroes and one number is a
 * one-observation t-test wearing a cluster-robust hat, and it returns |DM*| =
 * 1.000 on every loss — the tell that gave it away. Fewer than three clusters
 * carrying the difference means the statistic has no sampling distribution
 * worth reading, so it is labelled rather than reported.
 */
export function compareOn(a, b, loss, { horizon = 1, relativeTolerance = 1e-6, minInformativeClusters = 3 } = {}) {
  const lossOf = {
    squared: p => (p.forecast - p.actual) ** 2,
    absolute: p => Math.abs(p.forecast - p.actual),
    crps: p => p.crps,
    log_score: p => p.log_score,
    joint_log_score: p => p.joint_log_score,
    cover_brier: p => (p.cover_outcome == null || p.cover_probability == null
      ? null : (p.cover_probability - p.cover_outcome) ** 2)
  }[loss];
  const lossA = [], lossB = [], clusters = [];
  for (let i = 0; i < a.length; i++) {
    const la = lossOf(a[i]), lb = lossOf(b[i]);
    if (!Number.isFinite(la) || !Number.isFinite(lb)) continue;
    lossA.push(la); lossB.push(lb); clusters.push(a[i].week_key);
  }
  if (lossA.length < 10) return { n: lossA.length, error: 'too few paired observations' };
  const dm = dieboldMariano(lossA, lossB, { horizon, clusters });
  if (!dm?.ok) return dm;

  // Guard 1: is the difference big enough to be worth a p-value at all?
  const scale = Math.max(
    Math.abs(lossA.reduce((s, v) => s + v, 0) / lossA.length),
    Math.abs(lossB.reduce((s, v) => s + v, 0) / lossB.length), 1e-12);
  const negligible = Math.abs(dm.meanLossDiff) < relativeTolerance * scale;

  // Guard 2: how many clusters actually carry any difference?
  const perCluster = new Map();
  for (let i = 0; i < lossA.length; i++) {
    const k = clusters[i];
    perCluster.set(k, (perCluster.get(k) ?? 0) + (lossA[i] - lossB[i]));
  }
  const informativeClusters = [...perCluster.values()]
    .filter(v => Math.abs(v) > relativeTolerance * scale).length;

  return {
    ...dm,
    relative_effect: dm.meanLossDiff / scale,
    informative_clusters: informativeClusters,
    degenerate: negligible ? 'difference below numerical tolerance'
      : informativeClusters < minInformativeClusters
        ? `difference confined to ${informativeClusters} of ${perCluster.size} clusters`
        : null
  };
}
