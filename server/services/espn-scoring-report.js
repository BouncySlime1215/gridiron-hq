/**
 * The ESPN scoring report: where a league's scoring weights came from, which
 * paid stat ids the app cannot apply, and the league's D/ST points computed
 * from its slot-16 pointsOverrides.
 *
 * Readers: GET /api/leagues/:id/scoring (routes/leagues.js) serves the whole
 * report; syncEspnLeague (routes/leagues.js) returns scoringSummary() on every
 * manual sync and scheduled roster refresh, and the Leagues page prints it.
 *
 * The D/ST section is a check as much as a number: each rostered D/ST's
 * observed week line is scored here at slot 16 and shown beside ESPN's own
 * appliedTotal for the same line, so an override read wrong shows up as a
 * mismatch rather than as a quietly different figure.
 */
import { scoringFor, scoreEspnStats, ESPN_DST_SLOT } from './scoring.js';

// ESPN player.stats[] encodings (as served in mRoster).
const STAT_SOURCE_ACTUAL = 0;      // statSourceId: 0 actual, 1 projected
const STAT_SPLIT_ONE_PERIOD = 1;   // statSplitTypeId: 0 season, 1 one scoring period
const POSITION_DST = 16;           // player.defaultPositionId for a team defense
const MATCH_TOLERANCE = 0.01;      // points; ESPN's appliedTotal is not rounded

/**
 * The part of the report every sync carries: provenance, the ids not applied,
 * and whether the payload prices any lineup slot differently (hasOverrides /
 * overrideSlots) so the sync response and sync_log detail show it.
 */
export function scoringSummary(lg) {
  const { source, reason, unscored, unmapped, hasOverrides, overrideSlots } = scoringFor(lg).espn;
  return { source, reason, unscored, unmapped, hasOverrides, overrideSlots };
}

/** One line of text naming what the summary says the app cannot apply, or null. */
export function scoringWarning(leagueId, summary) {
  const { source, reason, unscored, unmapped } = summary;
  if (source === 'league' && !unscored.length && !unmapped.length) return null;
  const ids = list => list.map(u => `${u.statId}=${u.points}`).join(', ') || 'none';
  return `[scoring] league ${leagueId}: weights from ${source}${reason ? ` (${reason})` : ''}; `
    + `${unmapped.length} paid id(s) outside the public ESPN list [${ids(unmapped)}]; `
    + `${unscored.length} paid id(s) player lines do not apply [${ids(unscored)}]`;
}

function dstLines(lg, points) {
  if (lg?.platform !== 'espn' || !lg.payload) return [];
  let data;
  try {
    data = JSON.parse(lg.payload);
  } catch (e) {
    // scoringFor has already put the parse failure in `reason`; there are no lines to score.
    return [];
  }
  const lines = [];
  for (const team of data?.teams ?? []) {
    for (const entry of team.roster?.entries ?? []) {
      const player = entry.playerPoolEntry?.player;
      if (player?.defaultPositionId !== POSITION_DST) continue;
      for (const st of player.stats ?? []) {
        if (st.statSourceId !== STAT_SOURCE_ACTUAL || st.statSplitTypeId !== STAT_SPLIT_ONE_PERIOD) continue;
        const computed = scoreEspnStats(st.stats, points);
        const applied = typeof st.appliedTotal === 'number' ? +st.appliedTotal.toFixed(2) : null;
        lines.push({
          team_id: team.id, espn_player_id: player.id, name: player.fullName ?? null,
          week: st.scoringPeriodId, points: computed, espn_applied: applied,
          matches: applied == null ? null : Math.abs(computed - applied) < MATCH_TOLERANCE
        });
      }
    }
  }
  return lines.sort((a, b) => a.team_id - b.team_id || a.week - b.week);
}

/** The full report GET /api/leagues/:id/scoring serves. */
export function espnScoringReport(lg) {
  const base = scoringFor(lg);
  const dst = scoringFor(lg, { slot: ESPN_DST_SLOT });
  const lines = dstLines(lg, dst.espn.points);
  const { source, reason, unscored, unmapped, hasOverrides, overrideSlots } = base.espn;
  return {
    source, reason,
    player_weights: { ...base },
    unscored, unmapped,
    hasOverrides, overrideSlots,
    dst: {
      slot: ESPN_DST_SLOT,
      source: dst.espn.source,
      points: dst.espn.points,
      week_lines: lines.length,
      matched: lines.filter(l => l.matches === true).length,
      mismatched: lines.filter(l => l.matches === false)
        .map(({ team_id, espn_player_id, week, points, espn_applied }) => ({ team_id, espn_player_id, week, points, espn_applied })),
      lines
    }
  };
}
