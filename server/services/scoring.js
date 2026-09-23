/**
 * League scoring, applied to a weekly stat line.
 *
 * Kept in its own module because the backtester, the projection model and the
 * simulator all have to score identically — if the harness grades on PPR while the
 * model optimises half-PPR, every comparison it produces is meaningless.
 */

import { ESPN_STAT_NAMES } from './espn-stat-ids.js';

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
 * ESPN stat ids scoreLine() can apply, by the public id list in espn-stat-ids.js.
 * ESPN publishes the league's actual per-stat point values, so a league with
 * six-point passing touchdowns or a tight-end premium can be read exactly rather
 * than bucketed into "PPR or not".
 *
 * 24/25 are rushing and 42/43 receiving (yards/TD). They were once mapped the
 * other way round, which went unnoticed because most leagues pay both the same.
 * 44 is receiving 2pt, not a reception id: it was once mapped to 'rec' and
 * doubled every league's reception value. Ids not listed here are read and
 * reported on `espn.unscored` (known id, no bucket) or `espn.unmapped`
 * (not in the public list), never dropped silently.
 */
const ESPN_STAT = {
  3: 'pass_yd',
  4: 'pass_td',
  20: 'pass_int',
  24: 'rush_yd',
  25: 'rush_td',
  42: 'rec_yd',
  43: 'rec_td',
  53: 'rec',
  72: 'fumble_lost'
};

/**
 * The points one scoringItem pays in a lineup slot. ESPN carries slot-specific
 * values in pointsOverrides keyed by slot id — D/ST items (slot 16) routinely
 * have points: 0 with the real value there — so the override wins when present.
 */
function itemPoints(it, slot) {
  const o = slot == null ? undefined : it.pointsOverrides?.[String(slot)];
  return typeof o === 'number' ? o : it.points;
}

/**
 * Attach the provenance report without changing what the weights serialise to:
 * callers memoise on JSON.stringify(scoring), and a fallback must still equal
 * its bucket byte for byte.
 */
function withReport(weights, report) {
  return Object.defineProperty(weights, 'espn', { value: report, enumerable: false });
}

/**
 * Scoring rules for a synced league.
 *
 * Prefers the league's own published scoring settings; falls back to the PPR bucket
 * when a platform doesn't expose them. Getting this right matters more than it looks:
 * the backtester, the projection model and the simulator all score through here, so a
 * wrong assumption here is a wrong number everywhere at once.
 *
 * `slot` (an ESPN lineup slot id, e.g. 16 for D/ST, 6 for TE) resolves each item's
 * pointsOverrides for that slot. The non-enumerable `espn` report says where the
 * weights came from (`source`, `reason`), every stat id's resolved `points`, and
 * which ids the league pays that scoreLine cannot apply (`unscored`) or that are
 * outside the public id list (`unmapped`), so a caller can surface them.
 * `hasOverrides` / `overrideSlots` say whether the payload carries any
 * pointsOverrides AT ALL and which slot ids they key on — independent of
 * `slot` and of which items matched — so a caller who resolved with no slot
 * (or the wrong one) can tell there is slot-specific pricing it is missing,
 * rather than only ever seeing the base values.
 */
export function scoringFor(lg, { slot } = {}) {
  const ppr = lg?.ppr ?? 1;
  const bucket = ppr >= 1 ? PPR : ppr >= 0.5 ? HALF_PPR : STANDARD;
  const fallback = (reason, read = { points: {}, unscored: [], unmapped: [], hasOverrides: false, overrideSlots: [] }) =>
    withReport({ ...bucket }, { source: 'fallback', reason, ...read });
  if (lg?.platform !== 'espn') return fallback('not-espn');
  if (!lg.payload) return fallback('no-payload');

  let items;
  try {
    items = JSON.parse(lg.payload)?.settings?.scoringSettings?.scoringItems;
  } catch (e) {
    return fallback(`payload-unparseable: ${e.message}`);
  }
  if (!Array.isArray(items) || !items.length) return fallback('no-scoring-items');

  // Every slot id ANY item carries pointsOverrides for, regardless of which
  // items matched a bucket key and regardless of the `slot` requested here.
  const overrideSlotSet = new Set();
  for (const it of items) {
    if (it.pointsOverrides && typeof it.pointsOverrides === 'object') {
      for (const k of Object.keys(it.pointsOverrides)) overrideSlotSet.add(Number(k));
    }
  }
  const overrideSlots = [...overrideSlotSet].sort((a, b) => a - b);
  const hasOverrides = overrideSlots.length > 0;

  const s = { ...bucket };
  const points = {};
  const unscored = [];
  const unmapped = [];
  let matched = 0;
  for (const it of items) {
    const pts = itemPoints(it, slot);
    if (typeof pts !== 'number') continue;
    points[it.statId] = pts;
    const key = ESPN_STAT[it.statId];
    if (key) {
      s[key] = pts;
      matched++;
    } else if (!ESPN_STAT_NAMES[it.statId]) {
      unmapped.push({ statId: it.statId, points: pts });
    } else if (pts !== 0) {
      unscored.push({ statId: it.statId, name: ESPN_STAT_NAMES[it.statId], points: pts });
    }
  }
  // A payload that yielded almost nothing is more likely a shape we don't understand
  // than a league that scores nothing.
  if (matched < 4) return fallback(`only-${matched}-scoring-ids-matched`, { points, unscored, unmapped, hasOverrides, overrideSlots });
  return withReport(s, { source: 'league', reason: null, points, unscored, unmapped, hasOverrides, overrideSlots });
}

/** ESPN's lineup slot id for a team defense (D/ST). */
export const ESPN_DST_SLOT = 16;

/**
 * Points for one ESPN stat line — `stats` keyed by ESPN stat id, as ESPN serves
 * `player.stats[].stats` — under a league's resolved per-id points
 * (`scoringFor(lg, { slot }).espn.points`). Unlike scoreLine this needs no
 * column per stat: every id the league pays is applied, which is how a D/ST
 * line (sacks, takeaways, points-allowed tiers) is scored.
 */
export function scoreEspnStats(stats, points) {
  let total = 0;
  for (const [id, value] of Object.entries(stats ?? {})) {
    const p = points?.[id];
    if (typeof p === 'number' && typeof value === 'number') total += value * p;
  }
  return +total.toFixed(2);
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
