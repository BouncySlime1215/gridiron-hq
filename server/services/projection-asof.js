/**
 * SIM-CALIB: every simulated player's rate per game PLAYED, as of a week, from
 * information strictly before that week.
 *
 * The season sim's outcome pools are shaped on last season
 * (projections.js#buildProjections({ through: SEASON - 1 })), and RL-17-3 moved their
 * level onto the finder's ros_ppg. Two problems with that for a calibrated sim:
 *   1. ros_ppg has no entry for a player with no game yet this season
 *      (ros-projection.js#buildRosProjections), so as of week 1 it is empty and every
 *      pool stays on last season's level (BROKEN-NUMBERS row A; evidence scale-140.md:
 *      sim ppg = 0.93x ros_ppg at the median).
 *   2. ros_ppg is built for the CURRENT week, so a replay of an earlier week that
 *      reads it is graded on the very games it was fit to (in-sample).
 *
 * This is the same gated ROS model (ros-projection.js#rosUpdate, ROS_PARAMS), run for
 * any week `week`, for every player the weekly engine projects, including those with
 * no game yet:
 *
 *   ppg = alpha * structural_w + (1 - alpha) * [ n/(n+k) * season_to_date_w + k/(n+k) * prior ]
 *
 *   structural_w       the weekly engine's structural head for `week`
 *                      (player-week-engine.js: usage through week - 1 only)
 *   season_to_date_w   this season's games with week < `week` (inSeasonHistory)
 *   prior              the preseason prior, fixed before week 1: the draft-board market
 *                      curve (c_mkt, preseason-model.js) or, for a non-PPR league or a
 *                      player off the board, last season's structural rate (c_struct)
 *
 * At week 1 (n = 0) it is the preseason projection (half structural, half prior); from
 * week 2 on it is the in-season rest-of-season number. For a player who has played,
 * it equals the served ros_ppg of that week. The model's week-1 rows (n = 0) were part
 * of its pre-registered gate (2024/2025, w 1-4), so no new fit is shipped here.
 *
 * Leakage contract (test/sim-calibration-asof.test.js): nothing from week >= `week`
 * of `season` is read. Each reader is called with that cutoff, and the result is
 * unchanged when later weeks are added to the database.
 */
import { buildPlayerWeekEngine } from './player-week-engine.js';
import { ROS_PARAMS, ROS_POSITIONS, inSeasonHistory, priorFor, rosPriorMap, rosUpdate } from './ros-projection.js';
import { PPR } from './scoring.js';

const finite = v => typeof v === 'number' && Number.isFinite(v);

/** The readers, injectable so a test can see the cutoff each one is asked for. */
export const ASOF_READERS = Object.freeze({
  // Weekly engine for `week`: structural head from usage through week - 1.
  structural: ({ season, week, scoring }) => buildPlayerWeekEngine({ season, week, scoring }),
  // This season's games before `week`.
  history: ({ season, week, scoring }) => inSeasonHistory(season, week, { scoring }),
  // Preseason priors: built from data before `season` only.
  priors: ({ season, scoring }) => rosPriorMap(season, { scoring })
});

/**
 * @returns Map<player_id, { ppg, games, source: 'preseason' | 'in_season', prior_source }>
 *          for every QB/RB/WR/TE the weekly engine projects at `week`.
 */
export function projectionAsOf({ season, week, scoring = PPR, params = ROS_PARAMS, readers = ASOF_READERS } = {}) {
  const out = new Map();
  const w = Math.max(1, Math.min(22, Math.trunc(Number(week)) || 1));
  if (!params || !Number.isInteger(season)) return out;
  const weekly = readers.structural({ season, week: w, scoring });
  const hist = readers.history({ season, week: w, scoring });
  const pri = readers.priors({ season, scoring });
  for (const [id, proj] of weekly ?? []) {
    if (!ROS_POSITIONS.includes(proj?.position)) continue;
    const h = hist.get(id);
    const games = h?.games > 0 ? h.games : 0;
    const pr = pri.get(id) ?? {};
    const prior = priorFor(pr, params.prior);
    const structural = finite(proj.structural_ppg) ? proj.structural_ppg : null;
    const ppg = rosUpdate({ structural, seasonToDate: games ? h.season_to_date : null, games, prior,
      position: proj.position }, params);
    if (!finite(ppg) || ppg < 0) continue;
    out.set(id, {
      ppg, games, source: games ? 'in_season' : 'preseason',
      prior_source: !finite(prior) ? 'structural' : params.prior === 'c_mkt' && finite(pr.c_mkt) ? 'c_mkt' : 'c_struct'
    });
  }
  return out;
}
