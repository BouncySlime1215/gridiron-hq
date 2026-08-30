import { row, rows } from '../db/index.js';
import { buildPlayerWeekEngine, playerWeekDistribution } from './player-week-engine.js';
import { normalizePlayerName } from './player-identity.js';
import { scoreLine } from './scoring.js';
import { weeklyAvailability } from './contingency.js';

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const round = (value, digits = 1) => value == null || !Number.isFinite(value) ? null : +value.toFixed(digits);

function nextTeamGame(team, publishedAt) {
  if (!team || !publishedAt) return null;
  const day = String(publishedAt).slice(0, 10);
  return row(`SELECT season,week,team,opponent,gameday,gametime,team_score,opp_score
    FROM game_lines WHERE team=? AND gameday>=?
    ORDER BY gameday,week LIMIT 1`, team, day) ?? null;
}

function projectionMap(cache, season, week) {
  const key = `${season}|${week}`;
  if (!cache.has(key)) cache.set(key, buildPlayerWeekEngine({ season, week }));
  return cache.get(key);
}

function resolveProjection(map, signal) {
  const direct = Number(signal.player_id);
  if (Number.isInteger(direct) && map.has(direct)) return map.get(direct);
  const key = normalizePlayerName(signal.player_name);
  const candidates = [...map.values()].filter(p => normalizePlayerName(p.name) === key);
  return candidates.find(p => !signal.team || p.team === signal.team) ?? candidates[0] ?? null;
}

function priorUsage(playerId, season, week) {
  const history = rows(`SELECT * FROM player_week_usage WHERE player_id=?
    AND (season<? OR (season=? AND week<?)) ORDER BY season DESC,week DESC LIMIT 3`,
  playerId, season, season, week);
  if (!history.length) return null;
  const mean = key => history.reduce((sum, item) => sum + Number(item[key] ?? 0), 0) / history.length;
  return {
    games: history.length,
    targets: round(mean('targets')), carries: round(mean('carries')),
    attempts: round(mean('attempts')), target_share: round(mean('target_share') * 100)
  };
}

export function trackingVerdict(signal, actual, prior, gameFinished) {
  if (!gameFinished) return { status: 'awaiting_game', label: 'Awaiting next game' };
  const opportunities = Number(actual?.attempts ?? 0) + Number(actual?.targets ?? 0) + Number(actual?.carries ?? 0);
  if (signal.signal_type === 'availability') {
    const expectedOut = Number(signal.unavailable_probability ?? 0) >= 0.5;
    const didPlay = opportunities > 0;
    const confirmed = expectedOut ? !didPlay : didPlay;
    return { status: confirmed ? 'confirmed' : 'missed', label: confirmed ? 'Report confirmed' : 'Report missed' };
  }
  if (signal.signal_type === 'role' && prior) {
    const before = Number(prior.attempts ?? 0) + Number(prior.targets ?? 0) + Number(prior.carries ?? 0);
    const change = before > 0 ? (opportunities - before) / before : null;
    if (change == null) return { status: 'settled', label: 'Outcome recorded' };
    const expected = Number(signal.role_delta ?? 0);
    const confirmed = expected === 0 ? Math.abs(change) < 0.15 : Math.sign(change) === Math.sign(expected) && Math.abs(change) >= 0.1;
    return { status: confirmed ? 'confirmed' : 'missed', label: confirmed ? 'Role move confirmed' : 'Role move missed', opportunity_change: round(change * 100) };
  }
  return { status: 'settled', label: 'Outcome recorded' };
}

/**
 * Convert source-grounded claims into a cutoff-safe fantasy scenario, then
 * track the next game's real usage against it. News remains shadow-only: this
 * does not mutate the production projection or betting model.
 */
export function newsFantasyTracker(signals) {
  const cache = new Map();
  const availabilityCache = new Map();
  const nowDay = new Date().toISOString().slice(0, 10);
  const tracked = signals.map(signal => {
    const game = nextTeamGame(signal.team, signal.published_at);
    if (!game) return { ...signal, fantasy_model: { available: false, reason: 'No later team game is loaded yet.' } };
    const projections = projectionMap(cache, Number(game.season), Number(game.week));
    const projection = resolveProjection(projections, signal);
    if (!projection) return { ...signal, target_game: game,
      fantasy_model: { available: false, reason: 'Player has no cutoff-safe usage history in the projection model.' } };

    const confidence = clamp(Number(signal.confidence ?? 0), 0, 1);
    const availabilityKey = `${game.season}|${game.week}`;
    if (!availabilityCache.has(availabilityKey)) {
      availabilityCache.set(availabilityKey, weeklyAvailability(Number(game.season), Number(game.week), { through: Number(game.season) - 1 }));
    }
    const baselineActive = availabilityCache.get(availabilityKey).get(projection.player_id)?.active_probability ?? 0.92;
    const reportedActive = clamp(1 - Number(signal.unavailable_probability ?? 0) * confidence, 0, 1);
    const roleMultiplier = signal.signal_type === 'role'
      ? clamp(1 + Number(signal.role_delta ?? 0) * confidence, 0.1, 1.75) : 1;
    const activeProbability = signal.signal_type !== 'availability' ? baselineActive
      : signal.status === 'available_positive' ? Math.max(baselineActive, reportedActive)
        : Math.min(baselineActive, reportedActive);
    const baseline = playerWeekDistribution(projection, { runs: 500, activeProbability: baselineActive });
    const scenario = playerWeekDistribution(projection, {
      runs: 500, mult: roleMultiplier, activeProbability
    });
    const actual = row(`SELECT u.*,s.offense_snaps,s.offense_pct FROM player_week_usage u
      LEFT JOIN player_week_snaps s ON s.player_id=u.player_id AND s.season=u.season AND s.week=u.week
      WHERE u.player_id=? AND u.season=? AND u.week=?`, projection.player_id, game.season, game.week) ?? null;
    const prior = priorUsage(projection.player_id, Number(game.season), Number(game.week));
    const finished = actual != null || (game.team_score != null && game.gameday < nowDay);
    const tracking = trackingVerdict(signal, actual, prior, finished);
    if (!finished && game.gameday === nowDay) {
      tracking.status = 'game_day'; tracking.label = 'Game day — refresh for usage';
    }
    return {
      ...signal,
      target_game: game,
      fantasy_model: {
        available: true,
        model: 'shared player-week ensemble distribution',
        authority: 'shadow_scenario',
        cutoff: projection.player_week_engine?.cutoff ?? (Number(game.week) <= 1 ? `${Number(game.season) - 1} season end` : `${game.season} week ${Number(game.week) - 1}`),
        baseline_points: round(baseline.mean), projected_points: round(scenario.mean),
        p10: round(scenario.p10), p90: round(scenario.p90),
        projected_usage: {
          targets: round(projection.volume.targets_per_game * roleMultiplier * activeProbability),
          carries: round(projection.volume.carries_per_game * roleMultiplier * activeProbability),
          attempts: round(projection.volume.attempts_per_game * roleMultiplier * activeProbability),
          target_share: projection.position === 'QB' ? 0 : round(projection.volume.target_share * roleMultiplier * activeProbability * 100)
        },
        usage_delta_percent: round((roleMultiplier * activeProbability / Math.max(0.01, baselineActive) - 1) * 100),
        baseline_active_probability: round(baselineActive * 100),
        active_probability: round(activeProbability * 100),
        note: 'What-if scenario from a timestamped claim; it does not alter production picks until forward calibration passes.'
      },
      tracking: {
        ...tracking,
        prior_usage: prior,
        actual: finished ? {
          fantasy_points: actual ? scoreLine(actual) : 0,
          targets: Number(actual?.targets ?? 0), carries: Number(actual?.carries ?? 0),
          attempts: Number(actual?.attempts ?? 0), receptions: Number(actual?.receptions ?? 0),
          receiving_yards: Number(actual?.receiving_yards ?? 0), rushing_yards: Number(actual?.rushing_yards ?? 0),
          passing_yards: Number(actual?.passing_yards ?? 0), snap_share: actual?.offense_pct == null ? null : round(Number(actual.offense_pct) * (Number(actual.offense_pct) <= 1 ? 100 : 1))
        } : null
      }
    };
  });
  const modeled = tracked.filter(item => item.fantasy_model?.available);
  return {
    signals: tracked,
    tracker: {
      modeled: modeled.length,
      awaiting: modeled.filter(item => ['awaiting_game', 'game_day'].includes(item.tracking?.status)).length,
      settled: modeled.filter(item => ['confirmed', 'missed', 'settled'].includes(item.tracking?.status)).length,
      confirmed: modeled.filter(item => item.tracking?.status === 'confirmed').length,
      missed: modeled.filter(item => item.tracking?.status === 'missed').length
    }
  };
}
