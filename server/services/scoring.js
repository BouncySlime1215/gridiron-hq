/**
 * League scoring, applied to a weekly stat line.
 *
 * Kept in its own module because the backtester, the projection model and the
 * simulator all have to score identically — if the harness grades on PPR while the
 * model optimises half-PPR, every comparison it produces is meaningless.
 */

export const PPR = {
  pass_yd: 0.04, pass_td: 4, pass_int: -2,
  rush_yd: 0.1, rush_td: 6,
  rec: 1, rec_yd: 0.1, rec_td: 6,
  fumble_lost: -2,
  // Some leagues pay a bonus on long plays or first downs; left at zero by default.
  first_down: 0
};

export const HALF_PPR = { ...PPR, rec: 0.5 };
export const STANDARD = { ...PPR, rec: 0 };

/**
 * ESPN stat ids we care about. ESPN publishes the league's actual per-stat point
 * values, so a league with six-point passing touchdowns or a tight-end premium can be
 * read exactly rather than bucketed into "PPR or not".
 */
const ESPN_STAT = {
  3: 'pass_yd',      // passing yards
  4: 'pass_td',
  20: 'pass_int',
  42: 'rush_yd',
  43: 'rush_td',
  44: 'rec',         // ESPN uses 53 for receptions in most leagues; 44 appears in some
  53: 'rec',
  42.1: null,
  72: 'fumble_lost',
  104: 'rec_td',
  105: 'rec_yd',
  106: 'rec_yd'
};

/**
 * Scoring rules for a synced league.
 *
 * Prefers the league's own published scoring settings; falls back to the PPR bucket
 * when a platform doesn't expose them. Getting this right matters more than it looks:
 * the backtester, the projection model and the simulator all score through here, so a
 * wrong assumption here is a wrong number everywhere at once.
 */
export function scoringFor(lg) {
  const ppr = lg?.ppr ?? 1;
  const fallback = ppr >= 1 ? PPR : ppr >= 0.5 ? HALF_PPR : STANDARD;
  if (!lg?.payload || lg.platform !== 'espn') return fallback;

  try {
    const items = JSON.parse(lg.payload)?.settings?.scoringSettings?.scoringItems;
    if (!Array.isArray(items) || !items.length) return fallback;
    const s = { ...fallback };
    let matched = 0;
    for (const it of items) {
      const key = ESPN_STAT[it.statId];
      if (!key || typeof it.points !== 'number') continue;
      // Receiving yardage appears under more than one id across league templates;
      // last one wins, and they agree in practice.
      s[key] = it.points;
      matched++;
    }
    // A payload that yielded almost nothing is more likely a shape we don't understand
    // than a league that scores nothing.
    return matched >= 4 ? s : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Fantasy points for one weekly line from `player_week_usage`.
 * Null-safe: a receiver's row has no passing columns and vice versa.
 */
export function scoreLine(u, s = PPR) {
  const n = v => v ?? 0;
  return +(
    n(u.passing_yards) * s.pass_yd + n(u.passing_tds) * s.pass_td + n(u.interceptions) * s.pass_int
    + n(u.rushing_yards) * s.rush_yd + n(u.rushing_tds) * s.rush_td
    + n(u.receptions) * s.rec + n(u.receiving_yards) * s.rec_yd + n(u.receiving_tds) * s.rec_td
    + n(u.fumbles_lost) * s.fumble_lost
    + n(u.first_downs) * s.first_down
  ).toFixed(2);
}

/** Same scoring, over a simulated stat line rather than a database row. */
export function scoreSim({ passYd = 0, passTd = 0, int = 0, rushYd = 0, rushTd = 0,
                           rec = 0, recYd = 0, recTd = 0, fumbles = 0 }, s = PPR) {
  return passYd * s.pass_yd + passTd * s.pass_td + int * s.pass_int
    + rushYd * s.rush_yd + rushTd * s.rush_td
    + rec * s.rec + recYd * s.rec_yd + recTd * s.rec_td
    + fumbles * s.fumble_lost;
}
