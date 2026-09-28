/**
 * Marcel-NFL: the minimum-competence referee for the rest-of-season (ROS) projection.
 *
 * Tango's Marcel adapted to NFL fantasy points per game (R&D r37 IDEA-026, confirmed on
 * held-out 2023-24 against season-to-date ppg):
 *
 *   rate = (w0*P0 + 5*P1 + 4*P2 + 3*P3 + R*m) / (w0*G0 + 5*G1 + 4*G2 + 3*G3 + R)
 *   pred = rate * clamp(1 + a*(peak - age), 0.8, 1.2)
 *
 * P0/G0 = PPR points and games so far this season, P1..P3/G1..G3 = the three prior
 * seasons, m = the position's games-weighted mean ppg in the previous season, age at
 * 1 Sep of the season (factor 1 when the birth date is unknown). Params were fitted on
 * target seasons 2019-22 and are pinned here; they are not refitted per run.
 *
 * Report-only: it serves no number. scripts/fit-ros-projection.mjs --marcel-referee
 * scores it next to the candidates and prints whether d_update beats it on MAE.
 */
import { rows } from '../db/index.js';

export const MARCEL_PARAMS = Object.freeze({
  R: Object.freeze({ QB: 32, RB: 16, WR: 6, TE: 12 }),
  w0: 16,
  priorWeights: Object.freeze([5, 4, 3]),
  a: 0.02,
  peak: Object.freeze({ QB: 29, RB: 25, WR: 27, TE: 28 }),
  ageClamp: Object.freeze([0.8, 1.2])
});

/** Age in years at 1 Sep of `season` from a YYYY-MM-DD birth date; null when unknown. */
export function ageAtSeason(birthDate, season) {
  if (!birthDate) return null;
  const born = Date.parse(`${String(birthDate).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(born)) return null;
  return (Date.UTC(season, 8, 1) - born) / 86400000 / 365.25;
}

/**
 * One Marcel prediction. points/games = [current, t-1, t-2, t-3] (missing seasons 0).
 * `R`, `peak` may be per-position maps (looked up by `position`) or plain numbers.
 */
export function marcelPrediction({ points, games, positionMean, position, age = null, params = MARCEL_PARAMS }) {
  const W = [params.w0, ...params.priorWeights];
  const R = typeof params.R === 'number' ? params.R : params.R[position];
  const peak = typeof params.peak === 'number' ? params.peak : params.peak[position];
  if (!Number.isFinite(R) || !Number.isFinite(positionMean)) return null;
  let num = R * positionMean, den = R;
  for (let i = 0; i < W.length; i++) {
    num += W[i] * (points[i] ?? 0);
    den += W[i] * (games[i] ?? 0);
  }
  const [lo, hi] = params.ageClamp ?? [0.8, 1.2];
  const f = age == null || !Number.isFinite(peak) ? 1 : Math.min(hi, Math.max(lo, 1 + params.a * (peak - age)));
  return (num / den) * f;
}

/**
 * Games-weighted mean ppg per position for one season.
 * seasonActuals: Map(player_id -> {points, games}) (backtest.js actuals shape);
 * positionOf: Map(player_id -> position).
 */
export function positionMeans(seasonActuals, positionOf, positions = Object.keys(MARCEL_PARAMS.R)) {
  const acc = Object.fromEntries(positions.map(p => [p, [0, 0]]));
  for (const [pid, a] of seasonActuals ?? []) {
    const pos = positionOf.get(pid);
    if (!acc[pos]) continue;
    acc[pos][0] += a.points;
    acc[pos][1] += a.games;
  }
  return Object.fromEntries(positions.map(p => [p, acc[p][1] ? acc[p][0] / acc[p][1] : null]));
}

/** player_id -> birth date (nflverse, via players.gsis_id). */
export function loadBirthDates() {
  const out = new Map();
  for (const r of rows(`SELECT p.id AS player_id, n.birth_date FROM players p
      JOIN nflverse_player_positions n ON n.gsis_id = p.gsis_id
      WHERE n.birth_date IS NOT NULL AND n.birth_date <> ''`)) out.set(r.player_id, r.birth_date);
  return out;
}

/**
 * Referee checks: for each season x w, is MAE(candidate) <= MAE(marcel)?
 * bySeason: { [season]: { by_w: { [w]: { primary: { [cand]: {mae, n}, marcel: {mae, n} } } } } }
 * Seasons without a marcel column are skipped (e.g. closed seasons).
 */
export function marcelRefereeChecks(bySeason, { candidate = 'd_update', seasons, ws } = {}) {
  const checks = [];
  for (const s of seasons ?? Object.keys(bySeason).map(Number)) {
    const byW = bySeason[s]?.by_w;
    if (!byW) continue;
    for (const w of ws ?? Object.keys(byW).map(Number)) {
      const m = byW[w]?.primary;
      if (!m?.marcel || m.marcel.mae == null || m[candidate]?.mae == null) continue;
      checks.push({ season: s, w, candidate, mae_candidate: m[candidate].mae, mae_marcel: m.marcel.mae,
        n: m.marcel.n, ok: m[candidate].mae <= m.marcel.mae });
    }
  }
  return { candidate, checks, all_ok: checks.length > 0 && checks.every(c => c.ok) };
}
