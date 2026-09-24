/**
 * HYPO-01a stream `projection_miss` (FIX-277-4): a rostered player's actual points fell
 * far outside the weekly range we served for him.
 *
 * The served range is the one weekly-learning.js froze before kickoff in
 * `weekly_prediction_snapshots` (prediction, lower_80, upper_80), settled with `actual`.
 * p(outcome) is the two-sided tail probability of the actual under the distribution that
 * range states: 10th / 50th / 90th percentiles at lower_80 / prediction / upper_80, normal
 * on each side (sigma = half-width / z_0.90). u = F(actual), p = 2 min(u, 1 - u), and the
 * surprisal is -ln p. A row is written when p < PROJ_TAIL_P_MAX: for a range that is
 * calibrated, that is 5% of player-weeks, the spec's target flag rate.
 *
 * Scope: players on a roster in this league that scoring period (league_roster_snapshots),
 * so a hypothesis is about a player some manager in the league was relying on. The
 * evidence is the snapshot key (season:week:player_id) and the roster team.
 *
 * The second FIX-277-4 stream (a PROJ-04 autopsy row's knowable, non-luck miss) needs
 * #251's projection_autopsy table, which is not on main.
 */
import { rows, row } from '../../db/index.js';
import { normalCdf } from '../stats-util.js';

export const PROJ_TAIL_P_MAX = 0.05;
const Z90 = 1.2815515655446004;

const tableExists = name =>
  !!row(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`, name);

/** Two-sided tail probability of `actual` under the range, or null when the range is not usable. */
export function rangeTailP({ prediction, lower_80: lower, upper_80: upper, actual }) {
  if (![prediction, lower, upper, actual].every(Number.isFinite)) return null;
  const lo = prediction - lower;
  const hi = upper - prediction;
  if (!(lo > 0) || !(hi > 0)) return null;
  const u = actual < prediction ? normalCdf((actual - prediction) / (lo / Z90))
    : normalCdf((actual - prediction) / (hi / Z90));
  return Math.min(1, 2 * Math.min(u, 1 - u));
}

/**
 * Every settled, rostered player-week with a usable range, scored.
 * @returns { state: 'read' | 'snapshots_absent' | 'rosters_absent', units, no_range }
 */
export function projectionUnits(leagueId, season) {
  if (!tableExists('weekly_prediction_snapshots')) return { state: 'snapshots_absent', units: [], no_range: 0 };
  if (!tableExists('league_roster_snapshots')) return { state: 'rosters_absent', units: [], no_range: 0 };
  const found = rows(`SELECT s.season, s.week, s.player_id, s.position, s.prediction, s.lower_80, s.upper_80,
         s.actual, s.engine_version, s.as_of, s.settled_at, MIN(r.team_id) AS team_id
       FROM weekly_prediction_snapshots s
       JOIN league_roster_snapshots r
         ON r.league_id = ? AND r.season = s.season AND r.scoring_period_id = s.week
        AND r.player_id = s.player_id AND r.on_roster = 1
      WHERE s.season = ? AND s.actual IS NOT NULL
      GROUP BY s.season, s.week, s.player_id
      ORDER BY s.week, s.player_id`, leagueId, season);
  let noRange = 0;
  const units = [];
  for (const r of found) {
    const p = rangeTailP(r);
    if (p == null) { noRange += 1; continue; }
    units.push({ ...r, p, at: r.settled_at ?? r.as_of, surprisal: -Math.log(Math.max(1e-300, p)) });
  }
  return { state: 'read', units, no_range: noRange };
}

const f1 = v => (Number.isFinite(v) ? v.toFixed(1) : '?');

export function projectionSurprises(units) {
  return units.filter(u => u.p < PROJ_TAIL_P_MAX).map(u => {
    const key = `${u.season}:${u.week}:${u.player_id}`;
    const side = u.actual < u.prediction ? 'below' : 'above';
    return {
      surprise_key: `projection_miss:${key}`,
      kind: 'projection_miss', team_id: String(u.team_id), model_p: u.p, surprisal: -Math.log(Math.max(1e-300, u.p)),
      outcome: `${f1(u.actual)} pts, ${side} the 80% range ${f1(u.lower_80)}-${f1(u.upper_80)}`,
      occurred_at: u.at ?? null,
      statement: `Player ${u.player_id} (${u.position}, week ${u.week}) scored ${f1(u.actual)} against a served range `
        + `of ${f1(u.lower_80)}-${f1(u.upper_80)} around ${f1(u.prediction)} (tail P = ${u.p.toExponential(1)}). `
        + 'Hypothesis: the weekly range is missing something about this player\'s role, health or game. '
        + 'Test: does the input that separates this week from his in-range weeks predict his next miss, '
        + 'walk-forward, excluding this week?',
      evidence: {
        snapshot_keys: [key], player_id: u.player_id, week: u.week,
        range: { prediction: u.prediction, lower_80: u.lower_80, upper_80: u.upper_80 },
        actual: u.actual, engine_version: u.engine_version, snapshot_as_of: u.as_of,
      },
    };
  });
}
