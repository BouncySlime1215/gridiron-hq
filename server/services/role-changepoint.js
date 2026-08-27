/**
 * Detect sustained role changes from information available before kickoff.
 * Two recent games must move in the same direction, clear a material football
 * threshold, and be corroborated by offensive snap share. This is evidence for
 * the existing fast role-memory layer, not an extra multiplier that double counts it.
 */
import { rows } from '../db/index.js';

const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const opp = row => row.position === 'QB' ? (row.attempts ?? 0) : (row.targets ?? 0) + (row.carries ?? 0);

export function detectRoleChange(games, playerSnaps, week) {
  if (games.length < 6) return null;
  const recent = games.slice(-2), prior = games.slice(0, -2);
  const priorMean = mean(prior.map(opp)), recentMean = mean(recent.map(opp));
  if (!(priorMean > 0)) return null;
  const delta = recentMean - priorMean, ratio = recentMean / priorMean;
  const threshold = games.at(-1).position === 'QB' ? 7 : Math.max(2.5, priorMean * 0.25);
  const sameDirection = delta > 0
    ? recent.every(game => opp(game) > priorMean)
    : recent.every(game => opp(game) < priorMean);
  const material = Math.abs(delta) >= threshold && (ratio >= 1.35 || ratio <= 0.72) && sameDirection;

  const recentWeeks = new Set(recent.map(game => game.week));
  const recentSnaps = playerSnaps.filter(x => recentWeeks.has(x.week)).map(x => x.offense_pct);
  const priorSnaps = playerSnaps.filter(x => !recentWeeks.has(x.week)).map(x => x.offense_pct);
  const recentSnap = mean(recentSnaps), priorSnap = mean(priorSnaps);
  const snapDelta = recentSnap != null && priorSnap != null ? recentSnap - priorSnap : null;
  const snapConfirms = snapDelta != null && (delta > 0 ? snapDelta >= 0.08 : snapDelta <= -0.08);
  if (!material || !snapConfirms) return null;
  return {
    status: delta > 0 ? 'confirmed_role_increase' : 'confirmed_role_decrease',
    through_week: week - 1,
    prior_games: prior.length,
    recent_games: 2,
    prior_opportunities: +priorMean.toFixed(2),
    recent_opportunities: +recentMean.toFixed(2),
    opportunity_change_pct: +((ratio - 1) * 100).toFixed(1),
    prior_snap_share: +priorSnap.toFixed(3),
    recent_snap_share: +recentSnap.toFixed(3),
    snap_change_points: +(snapDelta * 100).toFixed(1),
    active_influence: 'captured by five-week role memory plus position-specific recent-outcome heads',
    extra_multiplier_applied: false
  };
}

export function roleChangepoints(season, week) {
  const usage = rows(`SELECT * FROM player_week_usage WHERE season=? AND week<? ORDER BY player_id,week`, season, week);
  const snaps = rows(`SELECT player_id,week,offense_pct FROM player_week_snaps
                      WHERE season=? AND week<? ORDER BY player_id,week`, season, week);
  const snapBy = new Map();
  for (const row of snaps) {
    const list = snapBy.get(row.player_id) ?? [];
    list.push(row); snapBy.set(row.player_id, list);
  }
  const byPlayer = new Map();
  for (const row of usage) {
    const list = byPlayer.get(row.player_id) ?? [];
    list.push(row); byPlayer.set(row.player_id, list);
  }
  const out = new Map();
  for (const [playerId, games] of byPlayer) {
    const playerSnaps = snapBy.get(playerId) ?? [];
    const signal = detectRoleChange(games, playerSnaps, week);
    if (signal) out.set(playerId, signal);
  }
  return out;
}
