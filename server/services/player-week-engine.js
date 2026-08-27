/**
 * Shared player-week state estimator.
 *
 * The structural head estimates football events (volume x efficiency). The
 * frozen Stage 1.3 ensemble updates that estimate from fantasy outcomes known
 * before the requested week. Fantasy scoring is a consumer of this state; the
 * props head will consume the same event parameters in Stage 2.2.
 */
import { rows } from '../db/index.js';
import { buildProjections, sampleWeeks } from './projections.js';
import { PPR, scoreLine } from './scoring.js';
import {
  WEEKLY_ROLE_RECENCY, WEEKLY_ENSEMBLE_WEIGHTS,
  weeklyEnsembleContext, weeklyEnsemblePrediction
} from './weekly-ensemble.js';
import { percentiles } from './stats-util.js';

export const PLAYER_WEEK_ENGINE_VERSION = 'player-week-v1.0.0';

function priorScores(season, week, scoring) {
  const out = new Map();
  for (const row of rows(`SELECT * FROM player_week_usage
                          WHERE season = ? AND week < ? ORDER BY week`, season, week)) {
    const list = out.get(row.player_id) ?? [];
    list.push(Number(scoreLine(row, scoring)));
    out.set(row.player_id, list);
  }
  return out;
}

export function buildPlayerWeekEngine({ season, week, scoring = PPR, kOverride } = {}) {
  if (!Number.isInteger(season) || !Number.isInteger(week) || week < 1 || week > 22) {
    throw new Error('player-week engine requires an integer season and week');
  }
  const structural = buildProjections({
    through: season, throughWeek: week - 1, scoring, kOverride,
    roleRecency: WEEKLY_ROLE_RECENCY
  });
  const history = priorScores(season, week, scoring);
  const out = new Map();
  for (const [playerId, projection] of structural) {
    const context = weeklyEnsembleContext({
      structural: projection.ppg,
      priorWeeks: history.get(playerId) ?? [],
      position: projection.position
    });
    const ppg = context ? weeklyEnsemblePrediction(context) : projection.ppg;
    out.set(playerId, {
      ...projection,
      ppg: +ppg.toFixed(2),
      structural_ppg: projection.ppg,
      ensemble_shift: +(ppg - projection.ppg).toFixed(4),
      player_week_engine: {
        version: PLAYER_WEEK_ENGINE_VERSION,
        season, week,
        cutoff: `${season}-W${Math.max(0, week - 1)}`,
        mode: context ? 'position_ensemble' : 'structural_only_no_current_season_history',
        heads: context,
        weights: context ? WEEKLY_ENSEMBLE_WEIGHTS[projection.position] : null
      }
    });
  }
  return out;
}

/** Distribution centered on the shared engine's ensemble point estimate. */
export function playerWeekDistribution(projection, {
  runs = 2000, scoring = PPR, mult = 1, activeProbability = 1
} = {}) {
  const shift = projection.ensemble_shift ?? 0;
  const samples = sampleWeeks(projection.params, runs, scoring, mult, activeProbability)
    .map(value => Math.max(0, value + shift));
  const pct = percentiles(samples, [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95]);
  const mean = samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length);
  const boom = ({ QB: 24, RB: 18, WR: 18, TE: 14 })[projection.position] ?? 18;
  const bust = ({ QB: 14, RB: 8, WR: 8, TE: 6 })[projection.position] ?? 8;
  return {
    ...pct,
    mean: +mean.toFixed(2),
    boom_rate: +(samples.filter(value => value >= boom).length / samples.length).toFixed(3),
    bust_rate: +(samples.filter(value => value <= bust).length / samples.length).toFixed(3)
  };
}
