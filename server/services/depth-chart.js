import { rows } from '../db/index.js';

/**
 * A team's depth chart, from whichever of three sources last said anything.
 *
 * **Read this before writing `SELECT ... FROM off_depth_chart`.** That is the
 * obvious table by name and it is the wrong one on its own. This app holds three
 * depth orderings and they are not interchangeable:
 *
 *   - `nfl_depth` — a weekly ordering, one `captured` timestamp per row. From
 *     2025 it is a dated ESPN scrape.
 *   - `off_sleeper_players` — a live snapshot with `fetched_at`. Current season
 *     only; Sleeper publishes no history, so there is nothing here for a past
 *     year and stamping today's chart onto one would be a leak.
 *   - `off_depth_chart` — the nflverse `depth_charts_YYYY.csv`, documented in
 *     `docs/reference/fantasy/OFFSEASON_DATA.md:54` as **"Opening-week ordering
 *     only"**, with `:78` adding that a March chart "predates free agency and
 *     the draft".
 *
 * So the third one, rendered unlabelled, shows an ordering taken before the
 * roster existed as though it were this week's. Coach's stat lexicon already
 * warns that a depth-chart rank is a listing rather than a measurement; serving
 * the opening chart as the current one is that failure with a second one under
 * it, and it is the reason this module exists rather than a query in a route.
 *
 * What it does about it: takes the source that spoke most recently, says which
 * one that was and when, marks the opening-week chart as stale whenever it is
 * what is left, and carries each listed player's snap share beside his rank —
 * because the snap share is the measurement, and it is what settles an argument
 * with the listing. A caller that renders the rank without it is back to
 * publishing a listing with the authority of a measurement.
 *
 * Snap share is a fraction here, as it is everywhere else on the platform
 * (`who-plays.js`, `nfl-postgame-truth.js`, `role-changepoint.js`, and the news
 * card since the unit was unified). Formatting it as a percentage is the
 * caller's job.
 */

/**
 * The positions `player_week_snaps.offense_pct` can describe.
 *
 * It counts OFFENSIVE snaps, so it is a real measurement of an offensive player
 * and says nothing about anyone else. A linebacker who played every defensive
 * snap has an offense_pct of 0, and reporting that beside his rank claims the
 * team's best defender did nothing — the column put there to settle an argument
 * with the listing instead losing it on his behalf.
 *
 * Special teams are out for the same reason, and deliberately not replaced with
 * a kicker's own snap count: this field means one thing, and a field that means
 * different things per row is worse than one that is absent.
 */
const OFFENSIVE_POSITIONS = new Set([
  'QB', 'RB', 'FB', 'HB', 'TB', 'WR', 'TE',
  'LT', 'LG', 'C', 'RG', 'RT', 'G', 'T', 'OL', 'OT', 'OG'
]);

/** Ordered freshest-first by the timestamp each source reports for itself. */
const SOURCES = [
  {
    name: 'weekly',
    stale: false,
    load: (team, season, week) => rows(
      `SELECT gsis_id, player_name, pos_abb, pos_rank, captured AS captured
         FROM nfl_depth
        WHERE team = ? AND season = ? AND week = ?`, team, season, week)
  },
  {
    name: 'live_snapshot',
    stale: false,
    // No season column: Sleeper holds one live snapshot and nothing older, so a
    // request for a past season must not be answered from it.
    // Fails closed: if the caller has not said which season is current, we
    // cannot show that this snapshot belongs to the one being asked about, so
    // it is not used. Silently assuming the requested season is the current one
    // is how a live snapshot ends up stamped onto a past year.
    load: (team, season, _week, currentSeason) => (currentSeason == null || season !== currentSeason ? [] : rows(
      `SELECT gsis_id, full_name AS player_name, depth_chart_position AS pos_abb,
              depth_chart_order AS pos_rank, fetched_at AS captured
         FROM off_sleeper_players
        WHERE team = ? AND depth_chart_position IS NOT NULL`, team))
  },
  {
    name: 'opening_week',
    stale: true,
    load: (team, season) => rows(
      `SELECT gsis_id, player_name, pos_abb, pos_rank, source_dt AS captured
         FROM off_depth_chart
        WHERE team = ? AND season = ?`, team, season)
  }
];

/** The newest timestamp any row in a set carries, as a comparable string. */
const newest = list => list.reduce((max, r) => (r.captured && r.captured > max ? r.captured : max), '');

export function teamDepthChart(abbr, { season, week, currentSeason = null } = {}) {
  const team = String(abbr ?? '').toUpperCase();
  const empty = { team, season: season ?? null, source: null, captured: null, stale: false,
    unavailable_reason: 'no_chart_on_file', positions: [] };
  if (!team || season == null) return { ...empty, unavailable_reason: 'no_team_or_season' };

  const candidates = SOURCES
    .map(source => ({ source, list: source.load(team, season, week, currentSeason) }))
    .filter(c => c.list.length > 0);
  if (candidates.length === 0) return empty;

  // Freshest by its own reported timestamp, not by a fixed ranking of the
  // tables: which source is current depends on which one last ran, and a table
  // that is usually freshest is not always.
  const chosen = candidates.reduce((best, c) =>
    (newest(c.list) > newest(best.list) ? c : best));

  const snaps = new Map(rows(
    `SELECT p.gsis_id AS gsis_id, s.offense_pct AS offense_pct
       FROM player_week_snaps s JOIN players p ON p.id = s.player_id
      WHERE s.season = ? AND s.week = ? AND p.gsis_id IS NOT NULL`, season, week)
    .map(r => [r.gsis_id, r.offense_pct]));

  const byPos = new Map();
  for (const row of chosen.list) {
    const pos = row.pos_abb;
    if (!byPos.has(pos)) byPos.set(pos, []);
    const raw = snaps.get(row.gsis_id);
    // Three different facts, which a single number cannot carry:
    //   offensive_snaps  — measured, and the stat describes him
    //   not_measured     — an offensive player with no snap row this week
    //   not_applicable…  — a defender or specialist, for whom offensive snap
    //                      share is not a low score but the wrong question
    // Collapsing any two of these renders someone as having done nothing.
    const describable = OFFENSIVE_POSITIONS.has(String(pos).toUpperCase());
    const measured = raw != null;
    byPos.get(pos).push({
      gsis_id: row.gsis_id,
      name: row.player_name,
      rank: row.pos_rank == null ? null : Number(row.pos_rank),
      snap_share: describable && measured ? Number(raw) : null,
      snap_share_basis: !describable ? 'not_applicable_to_this_position'
        : measured ? 'offensive_snaps' : 'not_measured'
    });
  }

  return {
    team,
    season,
    source: chosen.source.name,
    captured: newest(chosen.list) || null,
    stale: chosen.source.stale,
    unavailable_reason: null,
    positions: [...byPos.entries()]
      .map(([pos, players]) => ({ pos, players: players.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)) }))
      .sort((a, b) => a.pos.localeCompare(b.pos))
  };
}
