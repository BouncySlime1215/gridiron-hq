#!/usr/bin/env node
/**
 * SS-01 evidence: replay the dead-starter rule over the 2026 lineups actually played.
 * Study code, not a production module. Read-only.
 *
 * Input: league_roster_snapshots, source 'final' (writer scripts/collect-roster-snapshots.mjs:113,
 * writePeriod), one row per rostered player per team per ESPN scoring period, with the slot
 * he was set in and his actual and ESPN-projected points. Every starter is run through the
 * production classifier, dead-starters.js#deadReason, with:
 *   - injury_status  = nfl_injuries.report_status for that week (writer
 *     server/services/nfl-advanced.js:358 syncInjuries), the official pregame report, the
 *     same field trade-engine.js serves as `injury_status`;
 *   - espnStatus     = null: the 'final' rows carry no pregame ESPN status (the collector's
 *     pregame_injury_status only exists from week 3), so ESPN OUT/DOUBTFUL/IR is not replayed;
 *   - bye            = players.bye_week;
 *   - inactive       = nflverse weekly roster status 'INA' as of that week, reconstructed from
 *     nfl_verified_events (writer server/services/nfl-event-archive.js:64). This list posts
 *     90 minutes before kickoff in reality; in the product the hook stays uncovered until RL-3-2.
 * Replacement: the best bench player (not dead by the same rule) who can fill the slot, ranked
 * by ESPN's own projected_points (a stand-in: the week_points the product ranks on were not
 * stored for past weeks). Outcome: replacement actual minus dead starter actual.
 *
 * Usage: GRIDIRON_DB_PATH=<local copy> SCHEDULER_DISABLED=1 node study/replay/ss-01-dead-starter-replay.mjs
 * Prints aggregates only: no league, team or manager names.
 */
process.env.SCHEDULER_DISABLED = '1';
const { rows } = await import('../../server/db/index.js');
const { deadReason } = await import('../../server/services/dead-starters.js');

const SEASON = 2026, WEEKS = [1, 2];
const FLEX = { FLEX: ['RB', 'WR', 'TE'], OP: ['QB', 'RB', 'WR', 'TE'] };
const accepts = (slot, pos) => slot === pos || (FLEX[slot] ?? []).includes(pos);

// Known-nonzero controls first.
const control = {
  injury_report_out_or_doubtful: rows(`SELECT week, COUNT(*) AS n FROM nfl_injuries
    WHERE season = ? AND week IN (1, 2) AND report_status IN ('Out', 'Doubtful') GROUP BY week`, SEASON),
  rostered_with_out_or_doubtful_report: rows(`SELECT s.scoring_period_id AS week, COUNT(*) AS n
    FROM league_roster_snapshots s JOIN players p ON p.id = s.player_id
    JOIN nfl_injuries i ON i.gsis_id = p.gsis_id AND i.season = s.season AND i.week = s.scoring_period_id
    WHERE s.season = ? AND s.source = 'final' AND i.report_status IN ('Out', 'Doubtful')
    GROUP BY 1`, SEASON),
  teams_with_a_game_by_week: rows(`SELECT week, COUNT(DISTINCT team) AS teams FROM game_lines
    WHERE season = ? AND week IN (1, 2, 5, 6) GROUP BY week`, SEASON),
  inactive_observations_week1: rows(`SELECT COUNT(*) AS n FROM nfl_verified_events
    WHERE season = ? AND week = 1 AND source = 'nflverse_weekly_rosters' AND status_after = 'INA'`, SEASON)[0].n
};

function inactiveAsOf(week) {
  // Latest weekly-roster status per player at or before this week.
  const latest = rows(`SELECT player_id, status_after FROM nfl_verified_events e
    WHERE season = ? AND source = 'nflverse_weekly_rosters' AND week <= ? AND player_id IS NOT NULL
      AND week = (SELECT MAX(week) FROM nfl_verified_events x WHERE x.season = e.season
                  AND x.source = e.source AND x.player_id = e.player_id AND x.week <= ?)`, SEASON, week, week);
  return new Set(latest.filter(r => r.status_after === 'INA').map(r => r.player_id));
}

const out = { season: SEASON, control, weeks: [] };
for (const week of WEEKS) {
  const ina = inactiveAsOf(week);
  const snap = rows(`SELECT s.league_id, s.team_id, s.player_id, s.position, s.lineup_slot, s.lineup_slot_id,
      s.projected_points, s.actual_points, p.bye_week, p.gsis_id, i.report_status
    FROM league_roster_snapshots s LEFT JOIN players p ON p.id = s.player_id
    LEFT JOIN nfl_injuries i ON i.gsis_id = p.gsis_id AND i.season = s.season AND i.week = s.scoring_period_id
    WHERE s.season = ? AND s.scoring_period_id = ? AND s.source = 'final'`, SEASON, week);
  const teams = new Map();
  for (const r of snap) {
    const key = `${r.league_id}|${r.team_id}`;
    if (!teams.has(key)) teams.set(key, []);
    teams.get(key).push(r);
  }
  const reasons = {}, items = [];
  // Known-nonzero control on the same classifier and joins: every rostered player, any slot.
  const rosteredDead = {};
  let starters = 0, skillStarters = 0;
  for (const roster of teams.values()) {
    const classify = r => deadReason(
      { id: r.gsis_id, available: true, bye: r.bye_week, injury_status: r.report_status },
      { week, espnStatus: null, inactive: { covered: true, source: 'nflverse_weekly_rosters', ids: ina } });
    const bench = roster.filter(r => r.lineup_slot_id === 20 && !classify(r))
      .sort((a, b) => (b.projected_points ?? 0) - (a.projected_points ?? 0));
    const used = new Set();
    for (const r of roster) { const d = classify(r); if (d) rosteredDead[d.reason] = (rosteredDead[d.reason] ?? 0) + 1; }
    for (const s of roster.filter(r => r.lineup_slot_id !== 20 && r.lineup_slot_id !== 21)) {
      starters++;
      if (['QB', 'RB', 'WR', 'TE'].includes(s.position)) skillStarters++;
      const dead = classify(s);
      if (!dead) continue;
      reasons[dead.reason] = (reasons[dead.reason] ?? 0) + 1;
      const pick = bench.find(b => !used.has(b.player_id) && accepts(s.lineup_slot, b.position)
        && (b.projected_points ?? 0) > 0);
      if (pick) used.add(pick.player_id);
      items.push({ reason: dead.reason, position: s.position, dead_actual: s.actual_points ?? 0,
        replacement_actual: pick ? (pick.actual_points ?? 0) : null });
    }
  }
  const withRepl = items.filter(i => i.replacement_actual != null);
  const gain = withRepl.reduce((a, i) => a + (i.replacement_actual - i.dead_actual), 0);
  const wins = withRepl.reduce((a, i) => a + (i.replacement_actual > i.dead_actual ? 1
    : i.replacement_actual === i.dead_actual ? 0.5 : 0), 0);
  out.weeks.push({
    week, team_weeks: teams.size, starters, skill_starters: skillStarters,
    rostered_dead_any_slot_control: rosteredDead,
    dead_starters: items.length, by_reason: reasons,
    dead_starter_actual_points: +items.reduce((a, i) => a + i.dead_actual, 0).toFixed(2),
    with_replacement: withRepl.length,
    points_avoided_total: +gain.toFixed(2),
    points_avoided_per_team_week: +(gain / teams.size).toFixed(3),
    decision_win_rate_vs_keep: withRepl.length ? +(wins / withRepl.length).toFixed(3) : null
  });
}
console.log(JSON.stringify(out, null, 2));
