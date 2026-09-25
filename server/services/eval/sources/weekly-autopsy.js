/**
 * SOURCE-TABLES: the `weekly_autopsy` producer, E7's source (server/services/eval/e7.js).
 *
 * One row per team per finished scoring period, from the period's FINAL lineups
 * (`league_roster_snapshots`, source 'final', written by scripts/collect-roster-snapshots.mjs
 * from ESPN's boxscore; its starters are checked there to sum to ESPN's team score):
 *
 *   actual_points            sum of the starters' actual points (what the team scored)
 *   expected_points          sum of the starters' ESPN projections for the period
 *   optimal_expected_points  the best legal lineup from the same roster on those same
 *                            projections (espn-lineup.js#bestLineup, the league's own
 *                            lineupSlotCounts), so decision = expected - optimal <= 0
 *
 * "Expected" is ESPN's projection for the period as the final capture stored it. ESPN
 * freezes a player's projection when his game locks, so this is the pregame number ESPN
 * served; that is ESPN's behaviour, not something this module checks (see the PR's
 * "Not confirmed"). Players in the IR slot are not eligible for the optimal lineup: a
 * manager cannot start them without a roster move.
 *
 * Idempotent: a period's rows are rewritten from its final snapshot each run (INSERT OR
 * REPLACE on the primary key), so a re-captured boxscore corrects them and a second run
 * with the same input writes the same rows. Only periods with final rows are produced;
 * a period still being played has no autopsy.
 *
 * Off by default: the refresh tick runs this only with GRIDIRON_SOURCE_TABLES=1
 * (sources/flag.js). Nothing here moves a served number; it feeds a grader.
 */
import { bestLineup, lineupFromSlotCounts, LINEUP } from '../../campaign/espn-lineup.js';

export const TABLE = 'weekly_autopsy';
const IR_SLOT = 21;
/** ESPN defaultPositionId -> the positions espn-lineup.js#bestLineup knows. */
const POS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' };

export const DDL = `CREATE TABLE IF NOT EXISTS weekly_autopsy (
  league_id INTEGER NOT NULL,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  actual_points REAL NOT NULL,
  expected_points REAL NOT NULL,
  optimal_expected_points REAL NOT NULL,
  starters INTEGER NOT NULL,
  unprojected_starters INTEGER NOT NULL,
  lineup_basis TEXT NOT NULL,
  produced_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, week, team_id)
)`;

export function ensureTable(database) {
  database.exec(DDL);
}

const r2 = v => Math.round(v * 100) / 100;

/**
 * Pure: one team-week's autopsy from its final snapshot rows.
 * rows: [{ espn_player_id, espn_position_id, lineup_slot_id, is_starter, projected_points, actual_points }]
 * lineup: LINEUP-shaped slot list. Returns null for a team with no starters (no lineup was set).
 */
export function autopsyTeamWeek(rows, lineup = LINEUP) {
  const starters = rows.filter(r => Number(r.is_starter) === 1);
  if (!starters.length) return null;
  const pts = v => (Number.isFinite(Number(v)) && v != null ? Number(v) : 0);
  const actual = starters.reduce((s, r) => s + pts(r.actual_points), 0);
  const expected = starters.reduce((s, r) => s + pts(r.projected_points), 0);
  const pool = rows
    .filter(r => Number(r.lineup_slot_id) !== IR_SLOT)
    .map(r => ({ id: r.espn_player_id, position: POS[Number(r.espn_position_id)] ?? null, points: pts(r.projected_points) }));
  const optimal = bestLineup(pool, lineup).total;
  return {
    actual_points: r2(actual),
    expected_points: r2(expected),
    // Not clamped to expected: the solver is exact for nested slot sets (league 4's),
    // so optimal < expected would be a solver fault, and the test that proves decision <= 0
    // must be able to see one.
    optimal_expected_points: r2(optimal),
    starters: starters.length,
    unprojected_starters: starters.filter(r => r.projected_points == null).length,
  };
}

/** The league's lineup from its stored ESPN payload, or league 4's with the reason. */
export function leagueLineup(payloadText) {
  let counts = null;
  try {
    counts = payloadText ? JSON.parse(payloadText)?.settings?.rosterSettings?.lineupSlotCounts ?? null : null;
  } catch (e) {
    return { lineup: LINEUP, basis: `league 4 lineup (payload unreadable: ${String(e.message).slice(0, 80)})` };
  }
  const own = lineupFromSlotCounts(counts);
  return own ? { lineup: own, basis: 'league lineupSlotCounts' } : { lineup: LINEUP, basis: 'league 4 lineup (payload has no lineupSlotCounts)' };
}

/**
 * Produce every finished team-week of the given leagues (default: every league with final
 * snapshots). Returns { weeks, rows, skipped_teams } counts for the tick's log line.
 */
export function produceWeeklyAutopsy(database, { leagueIds = null, now = () => new Date().toISOString() } = {}) {
  ensureTable(database);
  const periods = database.prepare(`SELECT DISTINCT league_id, season, scoring_period_id AS week
    FROM league_roster_snapshots WHERE source = 'final' ORDER BY league_id, season, week`).all()
    .filter(p => !leagueIds || leagueIds.includes(Number(p.league_id)));
  const snap = database.prepare(`SELECT team_id, espn_player_id, espn_position_id, lineup_slot_id, is_starter,
      projected_points, actual_points
    FROM league_roster_snapshots WHERE league_id = ? AND season = ? AND scoring_period_id = ? AND source = 'final'`);
  const payloadOf = database.prepare('SELECT payload FROM leagues WHERE id = ?');
  const put = database.prepare(`INSERT OR REPLACE INTO weekly_autopsy (league_id, season, week, team_id, actual_points,
      expected_points, optimal_expected_points, starters, unprojected_starters, lineup_basis, produced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const lineups = new Map();
  const at = now();
  let rows = 0, skipped = 0;
  const weeks = new Set();
  database.exec('BEGIN');
  try {
    for (const p of periods) {
      if (!lineups.has(p.league_id)) lineups.set(p.league_id, leagueLineup(payloadOf.get(p.league_id)?.payload ?? null));
      const { lineup, basis } = lineups.get(p.league_id);
      const byTeam = new Map();
      for (const r of snap.all(p.league_id, p.season, p.week)) {
        if (!byTeam.has(r.team_id)) byTeam.set(r.team_id, []);
        byTeam.get(r.team_id).push(r);
      }
      for (const [team, teamRows] of byTeam) {
        const a = autopsyTeamWeek(teamRows, lineup);
        if (!a) { skipped++; continue; }
        put.run(p.league_id, p.season, p.week, team, a.actual_points, a.expected_points, a.optimal_expected_points,
          a.starters, a.unprojected_starters, basis, at);
        rows++;
      }
      weeks.add(`${p.league_id}:${p.season}:${p.week}`);
    }
    database.exec('COMMIT');
  } catch (e) {
    database.exec('ROLLBACK');
    throw e;
  }
  return { weeks: weeks.size, rows, skipped_teams: skipped };
}
