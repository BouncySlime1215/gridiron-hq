/**
 * FEAS-140-ESPN: ESPN's projected starting-lineup points, per week, for the 140 card.
 *
 * The 140 target is on ESPN's scale (evidence: scale-140.md, section Fix). The season
 * sim runs about 45% low (chance-to-play haircut, no K or D/ST, last season's level),
 * so the card measures the target on ESPN's own projections instead:
 *
 *   per week w, the best legal 10-man lineup (QB, 2 RB, 2 WR, TE, 2 FLEX RB/WR/TE, K, D/ST)
 *   from ESPN per-week projections (stats: statSourceId 1, statSplitTypeId 1,
 *   scoringPeriodId w). For a week ESPN has not posted yet, the rest-of-season
 *   per-game projection (statSourceId 1, statSplitTypeId 0, scoringPeriodId 0,
 *   appliedAverage). A player on bye that week, OUT this week, or on IR in a week ESPN
 *   has not posted for him scores 0.
 *
 * Pure except loadEspnLineup, which takes the db helpers ({ row, rows }) as an argument
 * and reads only leagues.payload / leagues.season and schedule_games (never the
 * league's cookies). The producer builds the context; the planner stays DB-free.
 */

export const ESPN_SCALE = 'espn_projected_lineup';
export const ESPN_SCALE_LABEL = 'ESPN projected lineup points (10 starters)';

/** The league-4 lineup (lineupSlotCounts): 10 starters. */
export const LINEUP = Object.freeze([
  ['QB', ['QB'], 1], ['RB', ['RB'], 2], ['WR', ['WR'], 2], ['TE', ['TE'], 1],
  ['FLEX', ['RB', 'WR', 'TE'], 2], ['K', ['K'], 1], ['D/ST', ['D/ST'], 1],
]);
const POS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' };
/** ESPN proTeamId -> abbr; mirrors espn-draft.js#PRO_TEAM (not imported: that module opens the DB). */
const PRO_TEAM = {
  1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET',
  9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN',
  17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC',
  25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WAS', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU',
};
const LONG_OUT = new Set(['INJURY_RESERVE', 'SUSPENSION']);

/**
 * One ESPN roster entry -> { id, name, position, pro_team, status, week: Map(week -> pts), ros_per_game }.
 * Position null (not K/DST/skill) players never start.
 */
export function espnPlayer(entry, season) {
  const pl = entry?.playerPoolEntry?.player ?? entry?.player ?? entry ?? {};
  const week = new Map();
  let ros = null;
  for (const s of pl.stats ?? []) {
    if (s.statSourceId !== 1 || (season != null && s.seasonId !== season)) continue;
    if (s.statSplitTypeId === 1 && s.scoringPeriodId > 0 && Number.isFinite(s.appliedTotal)) week.set(s.scoringPeriodId, s.appliedTotal);
    if (s.statSplitTypeId === 0 && s.scoringPeriodId === 0 && Number.isFinite(s.appliedAverage)) ros = s.appliedAverage;
  }
  return {
    id: pl.id ?? entry?.playerId ?? null, name: pl.fullName ?? null,
    position: POS[pl.defaultPositionId] ?? null, pro_team: pl.proTeamId ?? null,
    status: pl.injuryStatus ?? entry?.injuryStatus ?? null, week, ros_per_game: ros,
  };
}

/**
 * ESPN lineupSlotId -> [slot, eligible positions], dedicated slots first and flex slots
 * most restrictive first, the order bestLineup fills them in. Bench (20) and IR (21)
 * are not starting slots; TQB (1) is not a slot any ESPN league here uses.
 */
const ESPN_SLOTS = Object.freeze([
  [0, 'QB', ['QB']], [2, 'RB', ['RB']], [4, 'WR', ['WR']], [6, 'TE', ['TE']],
  [17, 'K', ['K']], [16, 'D/ST', ['D/ST']],
  [3, 'RB/WR', ['RB', 'WR']], [5, 'WR/TE', ['WR', 'TE']], [23, 'FLEX', ['RB', 'WR', 'TE']],
  [7, 'OP', ['QB', 'RB', 'WR', 'TE']],
]);

/**
 * A league's own lineup from ESPN's settings.rosterSettings.lineupSlotCounts ({ slotId: n }),
 * in LINEUP's shape. Null when the counts name no starting slot (the caller then says why).
 */
export function lineupFromSlotCounts(counts) {
  if (!counts || typeof counts !== 'object') return null;
  const out = ESPN_SLOTS.map(([id, slot, ok]) => [slot, ok, Number(counts[id]) || 0]).filter(([, , n]) => n > 0);
  return out.length ? Object.freeze(out) : null;
}

/**
 * Best legal lineup: dedicated slots first, then FLEX from what is left (optimal for nested
 * slot sets). `lineup` defaults to league 4's; SOURCE-TABLES passes each league's own.
 */
export function bestLineup(players, lineup = LINEUP) {
  const pool = players.filter(p => p.position && Number.isFinite(p.points)).sort((a, b) => b.points - a.points);
  const used = new Set();
  const starters = [];
  for (const [slot, ok, n] of lineup) {
    let k = 0;
    for (const p of pool) {
      if (k >= n) break;
      if (used.has(p) || !ok.includes(p.position)) continue;
      used.add(p); starters.push({ slot, id: p.id, position: p.position, points: p.points }); k++;
    }
  }
  return { total: starters.reduce((s, p) => s + p.points, 0), starters };
}

/**
 * A player's ESPN points in week w. 0 on bye; 0 when OUT in the current week; 0 on IR or
 * suspended in any week ESPN has not posted a projection for him (return date unknown).
 */
export function pointsInWeek(p, w, { currentWeek, byeOf = () => null } = {}) {
  if (byeOf(p.pro_team) === w) return { points: 0, source: 'bye' };
  if (p.status === 'OUT' && w === currentWeek) return { points: 0, source: 'out' };
  if (p.week.has(w)) return { points: p.week.get(w), source: 'espn_week' };
  if (LONG_OUT.has(p.status)) return { points: 0, source: 'out' };
  return { points: p.ros_per_game ?? 0, source: 'espn_ros' };
}

/** [{ week, total, starters, posted }] for the given weeks. */
export function lineupWeeks(players, weeks, opts = {}) {
  return weeks.map(w => {
    const scored = players.map(p => ({ ...p, ...pointsInWeek(p, w, opts) }));
    const { total, starters } = bestLineup(scored);
    return { week: w, total, starters, posted: players.some(p => p.week.has(w)) };
  });
}

/**
 * Rest-of-season per-game lineup: ESPN's own per-game numbers for the whole roster, no byes and
 * no status zeroes (the scale-140 study's "ROS per-game, split 0" column). The weekly totals
 * above are what the card compares with the target; this is the reference rate beside them.
 */
export function rosPerGame(players) {
  return bestLineup(players.map(p => ({ ...p, points: p.ros_per_game ?? 0 }))).total;
}

/**
 * The context the 140 card takes (feasibility.js#sidePanelFeasibility `espn`).
 * payload: ESPN league JSON (teams[].roster.entries[]); byes: Map(proTeamId -> bye week).
 * forTeam(teamId) / forRoster(espnIds) -> { scale, label, ros_per_game, weeks(list) -> [{ week, total, starters, posted }] }
 */
export function espnLineupContext(payload, { season = payload?.seasonId, currentWeek = payload?.scoringPeriodId, byes = new Map() } = {}) {
  const all = new Map();
  const teams = new Map();
  for (const t of payload?.teams ?? []) {
    const ps = (t.roster?.entries ?? []).map(e => espnPlayer(e, season));
    ps.forEach(p => all.set(String(p.id), p));
    teams.set(String(t.id), ps);
  }
  const opts = { currentWeek, byeOf: pt => byes.get(Number(pt)) ?? null };
  const view = ps => ({
    scale: ESPN_SCALE, label: ESPN_SCALE_LABEL, current_week: currentWeek,
    ros_per_game: rosPerGame(ps),
    weeks: list => lineupWeeks(ps, list, opts),
  });
  return {
    forTeam: id => (teams.has(String(id)) ? view(teams.get(String(id))) : null),
    /** A post-trade roster by ESPN player id; unknown ids (free agents) are skipped. */
    forRoster: ids => view(ids.map(id => all.get(String(id))).filter(Boolean)),
  };
}

/** Bye week per ESPN proTeamId: the one week 1-18 a team has no schedule_games row. */
export function byesFromSchedule(scheduleRows) {
  const played = new Map();
  for (const r of scheduleRows) {
    if (!played.has(r.abbr)) played.set(r.abbr, new Set());
    played.get(r.abbr).add(Number(r.week));
  }
  const byes = new Map();
  for (const [id, abbr] of Object.entries(PRO_TEAM)) {
    const wk = played.get(abbr);
    if (!wk) continue;
    const missing = [];
    for (let w = 1; w <= 18; w++) if (!wk.has(w)) missing.push(w);
    if (missing.length === 1) byes.set(Number(id), missing[0]);
  }
  return byes;
}

/** Producer-side loader: db = { row, rows } (server/db/index.js). Null when the league has no ESPN payload. */
export function loadEspnLineup(db, leagueRowId) {
  const lg = db.row('SELECT platform, season, current_week, payload FROM leagues WHERE id = ?', leagueRowId);
  if (!lg || lg.platform !== 'espn' || !lg.payload) return null;
  const payload = JSON.parse(lg.payload);
  const season = lg.season ?? payload.seasonId;
  const sched = db.rows(`SELECT t.abbr AS abbr, g.week AS week FROM schedule_games g JOIN nfl_teams t ON t.id = g.team_id
                         WHERE g.season = ?`, season);
  return espnLineupContext(payload, { season, currentWeek: payload.scoringPeriodId ?? lg.current_week, byes: byesFromSchedule(sched) });
}
