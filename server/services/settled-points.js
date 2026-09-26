/**
 * ONE-NUMBER-FIX: a starter whose game this week is over has a score, not a range.
 *
 * The weekly range (lineup-week-range.js, WEEKLY-RANGE-ONE) drew every starter from the league
 * world, including one whose game had already been played. A Thursday starter then has no
 * served week projection (the week's projection drops a played game), so the range counted him
 * as 0, and each lineup picker handled him its own way: the lineup posture held him in his slot
 * (ESPN had locked him) and scored him 0, while the trade card, My team and the ceiling lineup
 * benched him for a healthy player. The same lineup-week then printed two ranges 15 points apart
 * (number audit, league 2, weekly_range; week 3: 123.6 vs 138.9, with the locked starter's
 * actual 35.3 in neither).
 *
 * This is the one reader of "points a player has already scored this week": ESPN's own actual
 * (statSourceId 0, applied total for the scoring period) from the league's synced payload, taken
 * only once his game is final (kickoff + FINAL_AFTER_HOURS). A game in progress is not settled:
 * its partial total is not a week. Keyed by the app's player id.
 */
import { rows } from '../db/index.js';
import { gameCutoff } from './game-cutoff.js';

export const FINAL_AFTER_HOURS = 4;

const payloadOf = lg => {
  if (!lg?.payload) return null;
  try { return typeof lg.payload === 'string' ? JSON.parse(lg.payload) : lg.payload; } catch (e) {
    console.warn(`[settled-points] league ${lg?.id}: payload unreadable: ${e?.message ?? e}`);
    return null;
  }
};

/** ESPN's actual applied total for `week`, or null. */
function actualFor(player, week) {
  for (const s of player?.stats ?? []) {
    if (Number(s.scoringPeriodId) === Number(week) && Number(s.statSourceId) === 0 && Number(s.statSplitTypeId) === 1
      && Number.isFinite(s.appliedTotal)) return +s.appliedTotal.toFixed(2);
  }
  return null;
}

/**
 * Map of app player id -> points already scored in `week`, for every rostered player in the
 * league whose game that week is final by `now`. Empty for a league that is not ESPN or has no
 * payload, and for a week nobody has finished yet.
 */
export function settledWeekPoints(lg, week, { now = Date.now(), season = lg?.season } = {}) {
  const out = new Map();
  const payload = payloadOf(lg);
  if (!payload || week == null || season == null) return out;
  const byEspn = new Map();
  for (const t of payload.teams ?? []) {
    for (const e of t.roster?.entries ?? []) {
      const pl = e.playerPoolEntry?.player;
      const pts = pl ? actualFor(pl, week) : null;
      if (pts != null) byEspn.set(String(pl.id), pts);
    }
  }
  if (!byEspn.size) return out;
  const ids = [...byEspn.keys()];
  const marks = ids.map(() => '?').join(',');
  const kickoffs = new Map();
  for (const p of rows(`SELECT p.id, p.espn_id, t.abbr AS team_abbr FROM players p LEFT JOIN nfl_teams t ON t.id = p.team_id
                        WHERE p.espn_id IN (${marks})`, ...ids)) {
    if (!p.team_abbr) continue;
    if (!kickoffs.has(p.team_abbr)) kickoffs.set(p.team_abbr, gameCutoff(season, week, p.team_abbr));
    const kickoff = kickoffs.get(p.team_abbr);
    if (kickoff == null || Date.parse(kickoff) + FINAL_AFTER_HOURS * 3_600_000 > now) continue;
    out.set(Number(p.id), byEspn.get(String(p.espn_id)));
  }
  return out;
}
