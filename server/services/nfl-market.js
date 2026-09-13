/**
 * NFL game-level market model: win / cover / total probabilities, compared against
 * real sportsbook prices, the same "model vs. no-vig market" pattern used for the
 * MLB props board — just built on Gridiron HQ's own in-house data instead of a
 * proxied feed, since a football prediction engine already lives here.
 *
 * The model is one pair of ratings per team — offense and defense, both in points
 * relative to league average — updated after every game with an exponentially
 * weighted surprise, the same idea as Elo but in points instead of an abstract
 * scale, which is what lets one rating system drive both a margin prediction (for
 * moneyline/spread) and a total prediction (for over/under) instead of needing two
 * unrelated models.
 *
 * Ratings are updated in strict chronological order, so every prediction only ever
 * uses games that happened before it — there is no separate "backtest split" to
 * get wrong, the walk-forward process *is* the honest evaluation. Alpha (the
 * learning rate) and the between-season carryover are fit by grid search against
 * that same walk-forward Brier score rather than assumed, matching how gamescript's
 * regression coefficients are fit rather than guessed.
 */
import { rows } from '../db/index.js';
import { normalCdf, mean, stdev } from './stats-util.js';
import { shinNoVig } from './nfl-devig.js';
import { buildConformal, recencyWeights, weightedDraw } from './conformal.js';

const LEAGUE_MIN_SEASON = 1999;

/**
 * Mondrian bins for the conformal calibration (Giant Plan 7.3, fix #15).
 *
 * The binning feature is the MARKET's spread, not the model's own predicted
 * margin. Both are known before kickoff, so either is legal, but only one of
 * them carries information about how wrong the model is about to be: on the
 * 2022-2025 walk-forward residuals the margin-error SD is flat across the
 * model's own |predicted margin| (12.7 / 12.7 / 13.6 / 13.2 points) and rises
 * monotonically across the market's |spread| (12.1 / 12.4 / 14.2 / 14.4). Big
 * favourites really do produce more variable margins; the model's own guess at
 * who the big favourite is, is too noisy to sort games by.
 *
 * Totals bin on the market total for the same reason — a 51-point environment
 * misses by more than a 39-point one.
 */
const MARGIN_BIN_EDGES = [3, 6.5, 10];
const TOTAL_BIN_EDGES = [44, 48];
const MIN_BIN_CALIBRATION = 150;

/** Binning feature for a game's margin interval: the market spread when quoted. */
const marginBinKey = (game, predMargin) =>
  game?.home_spread != null ? Math.abs(game.home_spread) : Math.abs(predMargin ?? 0);
/** Binning feature for a game's total interval: the market total when quoted. */
const totalBinKey = (game, predTotal) => (game?.total != null ? game.total : predTotal);

/** One row per real game (not the doubled team-rows game_lines stores), chronological. */
function historicalGames() {
  return rows(`
    SELECT season, week, team AS home, opponent AS away,
           team_score AS home_score, opp_score AS away_score,
           spread AS home_spread, total, moneyline AS home_ml, spread_odds AS home_spread_odds,
           total_over_odds, total_under_odds, neutral_site
    FROM game_lines
    WHERE home = 1 AND team_score IS NOT NULL AND opp_score IS NOT NULL AND season >= ?
    ORDER BY season, week
  `, LEAGUE_MIN_SEASON);
}

/**
 * Runs the full walk-forward rating simulation once. Returns the final rating
 * state (for live prediction) plus every prediction's residual (for fitting /
 * reporting accuracy) — each residual only ever used ratings from strictly
 * earlier games, so this doubles as the evaluation.
 */
function simulate(games, { alpha, carryover, hfa, leagueAvg }) {
  const off = new Map(), def = new Map();
  const rating = (m, team) => m.get(team) ?? 0;
  let lastSeason = null;
  const results = [];

  for (const g of games) {
    if (lastSeason !== null && g.season !== lastSeason) {
      for (const m of [off, def]) for (const [team, v] of m) m.set(team, v * carryover);
    }
    lastSeason = g.season;

    const gameHfa = g.neutral_site ? 0 : hfa;
    const predHome = leagueAvg / 2 + rating(off, g.home) + rating(def, g.away) + gameHfa / 2;
    const predAway = leagueAvg / 2 + rating(off, g.away) + rating(def, g.home) - gameHfa / 2;
    const predMargin = predHome - predAway;
    const predTotal = predHome + predAway;
    const actualMargin = g.home_score - g.away_score;
    const actualTotal = g.home_score + g.away_score;

    results.push({ g, predHome, predAway, predMargin, predTotal, actualMargin, actualTotal });

    const homeSurprise = g.home_score - predHome;
    const awaySurprise = g.away_score - predAway;
    off.set(g.home, rating(off, g.home) + alpha * homeSurprise);
    def.set(g.away, rating(def, g.away) + alpha * homeSurprise);
    off.set(g.away, rating(off, g.away) + alpha * awaySurprise);
    def.set(g.home, rating(def, g.home) + alpha * awaySurprise);
  }
  return { off, def, results };
}

/**
 * Ranks a hyperparameter choice by margin MAE on the walk-forward predictions,
 * skipping the cold-start seasons. Margin MAE (not a probability score) is what's
 * used here so ranking alpha/carryover doesn't need an assumed probability scale
 * before one has been fitted — that scale (marginStd) is only computed afterward,
 * from the winning combination's own residuals.
 */
function gridScore(results, warmupSeasons) {
  const usable = results.filter(r => r.g.season >= LEAGUE_MIN_SEASON + warmupSeasons);
  if (!usable.length) return Infinity;
  return mean(usable.map(r => Math.abs(r.actualMargin - r.predMargin)));
}

let _cache = null;
let _nestedCache = new Map();
export function clearNflMarketCache() { _cache = null; _nestedCache = new Map(); }

/**
 * Fits alpha/carryover by grid search, computes home-field advantage and the two
 * residual standard deviations empirically, and returns everything needed to both
 * predict future games and report how good the model actually is.
 */
export function fitModel() {
  if (_cache) return _cache;
  const fit = fitRatings({});
  if (!fit.error) _cache = fit;
  return fit;
}

/**
 * Uncached fit with an explicit hyperparameter selection window. `selectionThrough`
 * caps the seasons alpha/carryover may be chosen on, so a study holding out
 * 2024–2025 can select on ≤ 2023 and keep its holdout clean; the ratings walk
 * itself is always walk-forward.
 */
export function fitRatings({ selectionThrough = null } = {}) {
  const games = historicalGames();
  if (games.length < 500) return { error: `only ${games.length} completed games with scores — sync game lines first` };

  const hfa = 2 * mean(games.map(g => (g.home_score - g.away_score) / 2));
  const leagueAvg = mean(games.flatMap(g => [g.home_score, g.away_score]));

  const ALPHAS = [0.05, 0.08, 0.1, 0.13, 0.16, 0.2];
  const CARRYOVERS = [0.5, 0.65, 0.75, 0.85, 1.0];
  // Hyperparameters are selected on every season before the last completed
  // one and the last completed season is held out, so the grid search never
  // grades itself on the games it tuned on (PROFITABILITY_PLAN Priority 0).
  // The ratings themselves are then walked over the full history with the
  // selected pair, because serving wants the newest ratings, not the
  // selection window's. The held-out score is reported next to the
  // in-hindsight best on that season so the gap is visible.
  const lastSeason = games[games.length - 1].season;
  const selectionCap = selectionThrough == null ? lastSeason - 1 : Math.min(selectionThrough, lastSeason - 1);
  const selection = games.filter(g => g.season <= selectionCap);
  const holdout = games.filter(g => g.season === lastSeason);
  const selectOn = selection.length >= 500 ? selection : games;
  let best = null;
  let holdoutBest = null;
  for (const alpha of ALPHAS) {
    for (const carryover of CARRYOVERS) {
      const { results } = simulate(selectOn, { alpha, carryover, hfa, leagueAvg });
      const score = gridScore(results, 5);
      if (!best || score < best.score) best = { alpha, carryover, score };
      if (holdout.length && selectOn !== games) {
        const full = simulate(games, { alpha, carryover, hfa, leagueAvg });
        const hs = gridScore(full.results.filter(r => r.g.season === lastSeason), 5);
        if (!holdoutBest || hs < holdoutBest.score) holdoutBest = { alpha, carryover, score: hs };
        if (alpha === best.alpha && carryover === best.carryover) best.holdoutScore = hs;
      }
    }
  }
  if (holdout.length && selectOn !== games && best.holdoutScore == null) {
    const full = simulate(games, { alpha: best.alpha, carryover: best.carryover, hfa, leagueAvg });
    best.holdoutScore = gridScore(full.results.filter(r => r.g.season === lastSeason), 5);
  }
  const fitWindow = {
    selection_seasons: selectOn === games ? [games[0].season, lastSeason] : [selection[0].season, selectionCap],
    holdout_season: selectOn === games ? null : lastSeason,
    selected: { alpha: best.alpha, carryover: best.carryover, selection_score: +best.score.toFixed(4),
      holdout_score: best.holdoutScore == null ? null : +best.holdoutScore.toFixed(4) },
    holdout_best_in_hindsight: holdoutBest ? { alpha: holdoutBest.alpha, carryover: holdoutBest.carryover,
      score: +holdoutBest.score.toFixed(4) } : null,
    note: 'alpha/carryover chosen on the selection seasons only; the holdout score is what that choice ' +
      'actually did on the last completed season, next to the pair hindsight would have picked.'
  };

  const { off, def, results } = simulate(games, { alpha: best.alpha, carryover: best.carryover, hfa, leagueAvg });
  const warm = results.filter(r => r.g.season >= LEAGUE_MIN_SEASON + 5);
  const rawMarginResiduals = warm.map(r => r.actualMargin - r.predMargin);
  const rawTotalResiduals = warm.map(r => r.actualTotal - r.predTotal);
  // The raw ratings forecast has an intercept miss, especially on totals. Apply
  // that cutoff-safe bias to the displayed point estimate, then bootstrap only
  // the centred uncertainty. Previously the board displayed an unadjusted total
  // while its probability silently included a roughly four-point residual mean.
  const marginBias = mean(rawMarginResiduals);
  const totalBias = mean(rawTotalResiduals);
  const marginResiduals = rawMarginResiduals.map(v => v - marginBias);
  const totalResiduals = rawTotalResiduals.map(v => v - totalBias);
  const marginStd = stdev(marginResiduals);
  const totalStd = stdev(totalResiduals);

  // Split-conformal calibration off the same walk-forward residuals. Each of
  // these residuals came from a prediction made with ratings that only saw
  // strictly earlier games, which is what makes them a legal calibration set
  // rather than an in-sample fit of their own spread.
  const marginConformal = buildConformal(
    warm.map((r, i) => ({ key: marginBinKey(r.g, r.predMargin), residual: marginResiduals[i] })),
    { edges: MARGIN_BIN_EDGES, minBin: MIN_BIN_CALIBRATION });
  const totalConformal = buildConformal(
    warm.map((r, i) => ({ key: totalBinKey(r.g, r.predTotal), residual: totalResiduals[i] })),
    { edges: TOTAL_BIN_EDGES, minBin: MIN_BIN_CALIBRATION });

  // Recency weights for the bootstrap. The fitted season carryover is reused as
  // the decay: the model has already estimated, from this data, how fast a
  // season's information stops describing the next one.
  const residualSeasons = warm.map(r => r.g.season);
  const marginWeights = recencyWeights(residualSeasons, { decay: best.carryover });
  const totalWeights = marginWeights;

  return {
    off, def, hfa, leagueAvg, alpha: best.alpha, carryover: best.carryover, fitWindow,
    marginStd, totalStd, marginBias, totalBias, marginResiduals, totalResiduals, results,
    marginConformal, totalConformal, residualSeasons, marginWeights, totalWeights,
    warmGames: warm.length, totalGames: games.length,
    // The last season with a completed game in the data. `simulate()` only
    // decays ratings at a season boundary it actually walks through, and with
    // no completed games yet in the upcoming season it never crosses that
    // boundary — the returned maps are raw end-of-season ratings. Recording
    // the boundary here lets `predictGame` apply the fitted carryover itself.
    lastCompletedSeason: games.length ? games[games.length - 1].season : null
  };
}

/**
 * Bootstrap: resample an actual historical (margin or total) miss instead of
 * assuming the error is a clean normal curve. Real NFL score residuals are
 * fatter-tailed than a Gaussian (blowouts and defensive struggles both happen
 * more than a bell curve predicts), and this way the tails come from games
 * that actually happened rather than an assumed shape.
 */
function bootstrapProb(predicted, threshold, residuals, trials, weights = null) {
  // A board must not change merely because it was refreshed. Seed a tiny local
  // generator from the exact question being asked rather than Math.random().
  // Replays and UI checks are therefore reproducible without sharing RNG state.
  const seedText = `${predicted}|${threshold}|${residuals.length}|${trials}|${weights ? weights.decay : 'flat'}`;
  let seed = 2166136261;
  for (let i = 0; i < seedText.length; i++) {
    seed ^= seedText.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  const next = () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  // Recency-weighted resampling (Giant Plan 7.3, fix #16). The previous draw was
  // uniform over 1999-2024, which treats a 1999 miss as exactly as relevant to
  // next Sunday as a 2024 one — while this same file fits, and then uses, a
  // season-carryover decay precisely because a season's information does NOT
  // survive intact into the next. The weights below apply that fitted decay to
  // the residual pool too, so the two halves of the model finally agree about
  // how fast the past stops mattering.
  const useWeights = weights && weights.cumulative?.length === residuals.length && weights.total > 0;
  let hits = 0;
  for (let i = 0; i < trials; i++) {
    const u = next();
    const draw = useWeights
      ? residuals[weightedDraw(weights.cumulative, weights.total, u)]
      : residuals[(u * residuals.length) | 0];
    if (predicted + draw > threshold) hits++;
  }
  return hits / trials;
}

/** Model's predicted score/margin/total for a future game, from current ratings. */
export function predictGame(homeTeam, awayTeam, season = null, { neutral = false } = {}) {
  const m = fitModel();
  if (m.error) return m;
  // Apply the fitted between-season carryover for any season boundary the
  // walk-forward fit never walked through — i.e. every prediction for a
  // season with no completed games in it yet. Without this a Week 1
  // prediction used full, undecayed end-of-last-season ratings.
  const seasonsElapsed = season != null && m.lastCompletedSeason != null && season > m.lastCompletedSeason
    ? season - m.lastCompletedSeason : 0;
  const decay = m.carryover ** seasonsElapsed;
  const off = r => (m.off.get(r) ?? 0) * decay, def = r => (m.def.get(r) ?? 0) * decay;
  const hfa = neutral ? 0 : m.hfa;
  const rawHome = m.leagueAvg / 2 + off(homeTeam) + def(awayTeam) + hfa / 2;
  const rawAway = m.leagueAvg / 2 + off(awayTeam) + def(homeTeam) - hfa / 2;
  const margin = rawHome - rawAway + m.marginBias;
  const total = rawHome + rawAway + m.totalBias;
  const predHome = (total + margin) / 2;
  const predAway = (total - margin) / 2;
  return {
    predicted_home_score: +predHome.toFixed(1), predicted_away_score: +predAway.toFixed(1),
    predicted_margin: +margin.toFixed(1), predicted_total: +total.toFixed(1),
    home_off: +off(homeTeam).toFixed(2), home_def: +def(homeTeam).toFixed(2),
    away_off: +off(awayTeam).toFixed(2), away_def: +def(awayTeam).toFixed(2)
  };
}

/* ---------------------------------------------------------- odds conversion */

/** No-vig probability of side A, from both sides' real American prices — Shin's method (nfl-devig.js). */
const noVigProb = (oddsA, oddsB) => shinNoVig(oddsA, oddsB);

/* -------------------------------------------------------------------- board */

/**
 * Every game with real, unsettled prices this week, model probability vs. no-vig
 * market. Model probability comes from bootstrap simulation — `trials` random
 * scenarios per bet, each one a resampled real historical miss applied to this
 * week's prediction — not a closed-form curve.
 */
export function boardFor(season, week, trials = 20000) {
  const m = fitModel();
  if (m.error) return m;

  const games = rows(`
    SELECT team AS home, opponent AS away, spread AS home_spread, total,
           moneyline AS home_ml, spread_odds AS home_spread_odds, total_over_odds, total_under_odds,
           neutral_site
    FROM game_lines
    WHERE season = ? AND week = ? AND home = 1 AND team_score IS NULL
  `, season, week);

  // Need the away side's prices too, for the no-vig pair.
  const awayPrices = new Map(rows(`
    SELECT team, moneyline, spread_odds FROM game_lines WHERE season = ? AND week = ? AND home = 0
  `, season, week).map(r => [r.team, r]));

  // Every market below is graded from the home/over side, then flipped to the
  // away/under side if that's what the model actually prefers — a negative edge
  // on one side is exactly a positive edge of the same size on the other, and
  // the row should always name the side the model likes, not always the home team.
  const rowsOut = [];
  for (const g of games) {
    const away = awayPrices.get(g.away);
    const pred = predictGame(g.home, g.away, season, { neutral: Boolean(g.neutral_site) });
    if (pred.error) continue;

    if (g.home_ml != null && away?.moneyline != null) {
      const homeModelP = bootstrapProb(pred.predicted_margin, 0, m.marginResiduals, trials, m.marginWeights);
      const homeMarketP = noVigProb(g.home_ml, away.moneyline);
      if (homeMarketP != null) {
        const homeEdge = homeModelP - homeMarketP;
        const pickHome = homeEdge >= 0;
        rowsOut.push({
          market: 'moneyline', home_team: g.home, away_team: g.away,
          matchup: `${g.away} at ${g.home}`,
          selection: pickHome ? g.home : g.away, side: pickHome ? g.home : g.away, line: null,
          american_price: pickHome ? g.home_ml : away.moneyline,
          model_probability: pickHome ? homeModelP : 1 - homeModelP,
          implied_probability: pickHome ? homeMarketP : 1 - homeMarketP,
          probability_difference: Math.abs(homeEdge),
          detail: `Model: ${g.home} ${predToScoreline(pred)}`
        });
      }
    }
    if (g.home_spread != null && g.home_spread_odds != null && away?.spread_odds != null) {
      const homeModelP = bootstrapProb(pred.predicted_margin, -g.home_spread, m.marginResiduals, trials, m.marginWeights);
      const homeMarketP = noVigProb(g.home_spread_odds, away.spread_odds);
      if (homeMarketP != null) {
        const homeEdge = homeModelP - homeMarketP;
        const pickHome = homeEdge >= 0;
        const awaySpread = -g.home_spread;
        rowsOut.push({
          market: 'spread', home_team: g.home, away_team: g.away,
          matchup: `${g.away} at ${g.home}`,
          selection: pickHome ? g.home : g.away,
          side: pickHome
            ? (g.home_spread > 0 ? `+${g.home_spread}` : `${g.home_spread}`)
            : (awaySpread > 0 ? `+${awaySpread}` : `${awaySpread}`),
          line: pickHome ? g.home_spread : awaySpread,
          american_price: pickHome ? g.home_spread_odds : away.spread_odds,
          model_probability: pickHome ? homeModelP : 1 - homeModelP,
          implied_probability: pickHome ? homeMarketP : 1 - homeMarketP,
          probability_difference: Math.abs(homeEdge),
          detail: `Model margin: ${pred.predicted_margin > 0 ? '+' : ''}${pred.predicted_margin}`
        });
      }
    }
    if (g.total != null && g.total_over_odds != null && g.total_under_odds != null) {
      const overModelP = bootstrapProb(pred.predicted_total, g.total, m.totalResiduals, trials, m.totalWeights);
      const overMarketP = noVigProb(g.total_over_odds, g.total_under_odds);
      if (overMarketP != null) {
        const overEdge = overModelP - overMarketP;
        const pickOver = overEdge >= 0;
        rowsOut.push({
          market: 'total', home_team: g.home, away_team: g.away,
          matchup: `${g.away} at ${g.home}`, selection: `${g.away} at ${g.home}`,
          side: `${pickOver ? 'Over' : 'Under'} ${g.total}`, line: g.total,
          american_price: pickOver ? g.total_over_odds : g.total_under_odds,
          model_probability: pickOver ? overModelP : 1 - overModelP,
          implied_probability: pickOver ? overMarketP : 1 - overMarketP,
          probability_difference: Math.abs(overEdge),
          edge_points: +Math.abs(pred.predicted_total - g.total).toFixed(2),
          detail: `Model total: ${pred.predicted_total}`
        });
      }
    }
  }
  return rowsOut.sort((a, b) => b.probability_difference - a.probability_difference);
}

function predToScoreline(pred) {
  return `${pred.predicted_home_score}-${pred.predicted_away_score}`;
}

/* ---------------------------------------------------------------- accuracy */

/** Walk-forward accuracy, same reporting bar as the fantasy engine's backtest. */
export function accuracy() {
  const nested = nestedEvaluationRows();
  if (nested.error) return nested;
  const total = scoreAccuracy(nested.rows, null, null);
  return {
    ...total,
    evaluation_seasons: nested.evaluation_seasons,
    per_season: nested.per_season,
    note: 'Nested rolling holdout: each season is graded with hyperparameters, HFA and probability calibration fitted only on prior seasons.'
  };
}

/**
 * Exact outer-fold predictions used by both the public accuracy card and every
 * downstream residual/challenger audit. Keeping one canonical row set prevents
 * a diagnostic from quietly using a weaker or leakier evaluation path.
 */
export function nestedEvaluationRows({ seasonsBack = 4 } = {}) {
  if (_nestedCache.has(seasonsBack)) return _nestedCache.get(seasonsBack);
  const games = historicalGames();
  if (games.length < 500) return { error: `only ${games.length} completed games with scores — sync game lines first` };

  // Outer rolling holdout: every reported season gets hyperparameters, HFA,
  // league scoring level and probability scale fitted only on earlier seasons.
  // The previous report walked ratings forward but selected alpha/carryover and
  // calibrated residuals on the same games it graded.
  const seasons = [...new Set(games.map(g => g.season))].sort((a, b) => a - b);
  const evalSeasons = seasons.slice(-seasonsBack);
  const evaluated = [];
  const perSeason = [];

  for (const season of evalSeasons) {
    const train = games.filter(g => g.season < season);
    const test = games.filter(g => g.season === season);
    if (train.length < 500 || !test.length) continue;
    const hfa = mean(train.map(g => g.home_score - g.away_score));
    const leagueAvg = mean(train.flatMap(g => [g.home_score, g.away_score]));
    let best = null;
    for (const alpha of [0.05, 0.08, 0.1, 0.13, 0.16, 0.2]) {
      for (const carryover of [0.5, 0.65, 0.75, 0.85, 1.0]) {
        const result = simulate(train, { alpha, carryover, hfa, leagueAvg });
        const score = gridScore(result.results, 5);
        if (!best || score < best.score) best = { alpha, carryover, score };
      }
    }
    const trainFit = simulate(train, { ...best, hfa, leagueAvg });
    const warmTrain = trainFit.results.filter(r => r.g.season >= LEAGUE_MIN_SEASON + 5);
    const marginResiduals = warmTrain.map(r => r.actualMargin - r.predMargin);
    const totalResiduals = warmTrain.map(r => r.actualTotal - r.predTotal);
    const marginBias = mean(marginResiduals);
    const totalBias = mean(totalResiduals);
    const marginStd = stdev(marginResiduals.map(v => v - marginBias)) || 14;
    const totalStd = stdev(totalResiduals.map(v => v - totalBias)) || 10;
    // Conformal calibration for this fold, fitted on the training seasons only.
    // It travels with the held-out rows so every downstream audit grades the
    // same interval the board would have shown, not a refitted one.
    const marginConformal = buildConformal(
      warmTrain.map((r, i) => ({ key: marginBinKey(r.g, r.predMargin), residual: marginResiduals[i] - marginBias })),
      { edges: MARGIN_BIN_EDGES, minBin: MIN_BIN_CALIBRATION });
    const totalConformal = buildConformal(
      warmTrain.map((r, i) => ({ key: totalBinKey(r.g, r.predTotal), residual: totalResiduals[i] - totalBias })),
      { edges: TOTAL_BIN_EDGES, minBin: MIN_BIN_CALIBRATION });
    // The exact resampling pool the board would have drawn from for this fold,
    // carried on the rows so an audit can replay the bootstrap it actually ran
    // rather than a refitted approximation of it. One shared object per fold.
    const bootstrapPool = {
      margin: marginResiduals.map(v => v - marginBias),
      total: totalResiduals.map(v => v - totalBias),
      seasons: warmTrain.map(r => r.g.season),
      decay: best.carryover
    };
    bootstrapPool.weights = recencyWeights(bootstrapPool.seasons, { decay: best.carryover });
    const combined = simulate([...train, ...test], { ...best, hfa, leagueAvg });
    const held = combined.results.filter(r => r.g.season === season)
      .map(r => ({ ...r, predMargin: r.predMargin + marginBias,
        predTotal: r.predTotal + totalBias, marginStd, totalStd,
        marginConformal, totalConformal, bootstrapPool }));
    evaluated.push(...held);
    perSeason.push(scoreAccuracy(held, season, best));
  }

  const out = {
    rows: evaluated,
    evaluation_seasons: evalSeasons,
    per_season: perSeason
  };
  _nestedCache.set(seasonsBack, out);
  return out;
}

/**
 * Interval coverage is the honest test of an uncertainty claim: an 80% interval
 * has to contain the truth 80% of the time, and it has to do that inside every
 * slice a bet can be placed in, not just on average. Marginal coverage alone can
 * be perfect while the pick'ems over-cover and the double-digit favourites
 * under-cover in equal and opposite amounts — which is precisely the failure a
 * single pooled SD produces, and precisely the one that costs money, because the
 * staking rule reads the width of the game in front of it.
 */
function coverageReport(usable, interval, key) {
  const bins = new Map();
  let hits = 0, width = 0, graded = 0;
  for (const r of usable) {
    const iv = interval(r);
    if (!iv) continue;
    graded++;
    const truth = key(r);
    const inside = truth >= iv[0] && truth <= iv[1];
    if (inside) hits++;
    width += iv[1] - iv[0];
    const b = binLabelFor(r);
    const e = bins.get(b) ?? { n: 0, hits: 0, width: 0 };
    e.n++; e.hits += inside ? 1 : 0; e.width += iv[1] - iv[0];
    bins.set(b, e);
  }
  if (!graded) return null;
  const perBin = [...bins.entries()].map(([label, e]) => ({
    bin: label, n: e.n, coverage: +(e.hits / e.n).toFixed(4), mean_width: +(e.width / e.n).toFixed(2)
  })).sort((a, b) => (a.bin < b.bin ? -1 : 1));
  return {
    games: graded,
    coverage: +(hits / graded).toFixed(4),
    mean_width: +(width / graded).toFixed(2),
    // One number for "how badly does coverage depend on which game it is" —
    // the worst slice's distance from nominal, weighted slices ignored, because
    // the worst slice is the one a bet lands in when it goes wrong.
    max_bin_coverage_error: +Math.max(...perBin.map(b => Math.abs(b.coverage - 0.80))).toFixed(4),
    per_bin: perBin
  };
}

const binLabelFor = r => {
  const k = marginBinKey(r.g, r.predMargin);
  return k < MARGIN_BIN_EDGES[0] ? `0-${MARGIN_BIN_EDGES[0]}`
    : k < MARGIN_BIN_EDGES[1] ? `${MARGIN_BIN_EDGES[0]}-${MARGIN_BIN_EDGES[1]}`
    : k < MARGIN_BIN_EDGES[2] ? `${MARGIN_BIN_EDGES[1]}-${MARGIN_BIN_EDGES[2]}`
    : `${MARGIN_BIN_EDGES[2]}+`;
};

function scoreAccuracy(usable, season = null, params = null) {
  let correct = 0, brierSum = 0;
  const marginErrs = [], totalErrs = [], marketMarginErrs = [], marketTotalErrs = [];
  for (const r of usable) {
    // Win probability now comes from the bin's own empirical residual
    // distribution rather than a normal curve on one pooled SD, so the
    // probability and the interval are two readings of one calibration set
    // instead of two independent assumptions that can disagree.
    const p = r.marginConformal
      ? r.marginConformal.probabilityAbove(r.predMargin, marginBinKey(r.g, r.predMargin), 0)
      : normalCdf(r.predMargin / r.marginStd);
    const actualWin = r.actualMargin > 0 ? 1 : 0;
    if ((p > 0.5 ? 1 : 0) === actualWin) correct++;
    brierSum += (p - actualWin) ** 2;
    marginErrs.push(Math.abs(r.actualMargin - r.predMargin));
    totalErrs.push(Math.abs(r.actualTotal - r.predTotal));
    if (r.g?.home_spread != null) marketMarginErrs.push(Math.abs(r.actualMargin - (-r.g.home_spread)));
    if (r.g?.total != null) marketTotalErrs.push(Math.abs(r.actualTotal - r.g.total));
  }
  const out = {
    games_graded: usable.length,
    win_accuracy: usable.length ? +(correct / usable.length).toFixed(4) : null,
    brier_score: usable.length ? +(brierSum / usable.length).toFixed(4) : null,
    margin_mae: +mean(marginErrs).toFixed(2),
    total_mae: +mean(totalErrs).toFixed(2),
    market_margin_mae: marketMarginErrs.length ? +mean(marketMarginErrs).toFixed(2) : null,
    market_total_mae: marketTotalErrs.length ? +mean(marketTotalErrs).toFixed(2) : null,
    margin_interval_80: coverageReport(usable,
      r => r.marginConformal?.interval(r.predMargin, marginBinKey(r.g, r.predMargin), 0.80)
        ?? [r.predMargin - 1.2816 * r.marginStd, r.predMargin + 1.2816 * r.marginStd],
      r => r.actualMargin),
    total_interval_80: coverageReport(usable,
      r => r.totalConformal?.interval(r.predTotal, totalBinKey(r.g, r.predTotal), 0.80)
        ?? [r.predTotal - 1.2816 * r.totalStd, r.predTotal + 1.2816 * r.totalStd],
      r => r.actualTotal)
  };
  if (season != null) out.season = season;
  if (params) { out.fitted_alpha = params.alpha; out.fitted_carryover = params.carryover; }
  return out;
}
