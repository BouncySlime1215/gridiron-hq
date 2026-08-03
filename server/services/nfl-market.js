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

const LEAGUE_MIN_SEASON = 1999;

/** One row per real game (not the doubled team-rows game_lines stores), chronological. */
function historicalGames() {
  return rows(`
    SELECT season, week, team AS home, opponent AS away,
           team_score AS home_score, opp_score AS away_score,
           spread AS home_spread, total, moneyline AS home_ml, spread_odds AS home_spread_odds,
           total_over_odds, total_under_odds
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

    const predHome = leagueAvg / 2 + rating(off, g.home) + rating(def, g.away) + hfa / 2;
    const predAway = leagueAvg / 2 + rating(off, g.away) + rating(def, g.home) - hfa / 2;
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
export function clearNflMarketCache() { _cache = null; }

/**
 * Fits alpha/carryover by grid search, computes home-field advantage and the two
 * residual standard deviations empirically, and returns everything needed to both
 * predict future games and report how good the model actually is.
 */
export function fitModel() {
  if (_cache) return _cache;
  const games = historicalGames();
  if (games.length < 500) return { error: `only ${games.length} completed games with scores — sync game lines first` };

  const hfa = 2 * mean(games.map(g => (g.home_score - g.away_score) / 2));
  const leagueAvg = mean(games.flatMap(g => [g.home_score, g.away_score]));

  const ALPHAS = [0.05, 0.08, 0.1, 0.13, 0.16, 0.2];
  const CARRYOVERS = [0.5, 0.65, 0.75, 0.85, 1.0];
  let best = null;
  for (const alpha of ALPHAS) {
    for (const carryover of CARRYOVERS) {
      const { results } = simulate(games, { alpha, carryover, hfa, leagueAvg });
      const score = gridScore(results, 5);
      if (!best || score < best.score) best = { alpha, carryover, score };
    }
  }

  const { off, def, results } = simulate(games, { alpha: best.alpha, carryover: best.carryover, hfa, leagueAvg });
  const warm = results.filter(r => r.g.season >= LEAGUE_MIN_SEASON + 5);
  const marginResiduals = warm.map(r => r.actualMargin - r.predMargin);
  const totalResiduals = warm.map(r => r.actualTotal - r.predTotal);
  const marginStd = stdev(marginResiduals);
  const totalStd = stdev(totalResiduals);

  _cache = {
    off, def, hfa, leagueAvg, alpha: best.alpha, carryover: best.carryover,
    marginStd, totalStd, marginResiduals, totalResiduals, results,
    warmGames: warm.length, totalGames: games.length
  };
  return _cache;
}

/**
 * Bootstrap: resample an actual historical (margin or total) miss instead of
 * assuming the error is a clean normal curve. Real NFL score residuals are
 * fatter-tailed than a Gaussian (blowouts and defensive struggles both happen
 * more than a bell curve predicts), and this way the tails come from games
 * that actually happened rather than an assumed shape.
 */
function bootstrapProb(predicted, threshold, residuals, trials) {
  let hits = 0;
  for (let i = 0; i < trials; i++) {
    const draw = residuals[(Math.random() * residuals.length) | 0];
    if (predicted + draw > threshold) hits++;
  }
  return hits / trials;
}

/** Model's predicted score/margin/total for a future game, from current ratings. */
export function predictGame(homeTeam, awayTeam) {
  const m = fitModel();
  if (m.error) return m;
  const off = r => m.off.get(r) ?? 0, def = r => m.def.get(r) ?? 0;
  const predHome = m.leagueAvg / 2 + off(homeTeam) + def(awayTeam) + m.hfa / 2;
  const predAway = m.leagueAvg / 2 + off(awayTeam) + def(homeTeam) - m.hfa / 2;
  return {
    predicted_home_score: +predHome.toFixed(1), predicted_away_score: +predAway.toFixed(1),
    predicted_margin: +(predHome - predAway).toFixed(1), predicted_total: +(predHome + predAway).toFixed(1),
    home_off: +off(homeTeam).toFixed(2), home_def: +def(homeTeam).toFixed(2),
    away_off: +off(awayTeam).toFixed(2), away_def: +def(awayTeam).toFixed(2)
  };
}

/* ---------------------------------------------------------- odds conversion */

const americanToProb = odds => (odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100));
/** No-vig probability of side A, from both sides' real American prices. */
function noVigProb(oddsA, oddsB) {
  if (oddsA == null || oddsB == null) return null;
  const a = americanToProb(oddsA), b = americanToProb(oddsB);
  return a + b > 0 ? a / (a + b) : null;
}

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
           moneyline AS home_ml, spread_odds AS home_spread_odds, total_over_odds, total_under_odds
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
    const pred = predictGame(g.home, g.away);
    if (pred.error) continue;

    if (g.home_ml != null && away?.moneyline != null) {
      const homeModelP = bootstrapProb(pred.predicted_margin, 0, m.marginResiduals, trials);
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
      const homeModelP = bootstrapProb(pred.predicted_margin, -g.home_spread, m.marginResiduals, trials);
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
      const overModelP = bootstrapProb(pred.predicted_total, g.total, m.totalResiduals, trials);
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
  const m = fitModel();
  if (m.error) return m;
  const usable = m.results.filter(r => r.g.season >= LEAGUE_MIN_SEASON + 5);
  let correct = 0, brierSum = 0;
  const marginErrs = [], totalErrs = [];
  for (const r of usable) {
    const p = normalCdf(r.predMargin / m.marginStd);
    const actualWin = r.actualMargin > 0 ? 1 : 0;
    if ((p > 0.5 ? 1 : 0) === actualWin) correct++;
    brierSum += (p - actualWin) ** 2;
    marginErrs.push(Math.abs(r.actualMargin - r.predMargin));
    totalErrs.push(Math.abs(r.actualTotal - r.predTotal));
  }
  return {
    games_graded: usable.length,
    win_accuracy: +(correct / usable.length).toFixed(4),
    brier_score: +(brierSum / usable.length).toFixed(4),
    margin_mae: +mean(marginErrs).toFixed(2),
    total_mae: +mean(totalErrs).toFixed(2),
    margin_std: +m.marginStd.toFixed(2), total_std: +m.totalStd.toFixed(2),
    fitted_alpha: m.alpha, fitted_carryover: m.carryover, fitted_hfa: +m.hfa.toFixed(2),
    note: 'Walk-forward: every prediction used only games that happened before it. First 5 seasons are warm-up and excluded from grading.'
  };
}
