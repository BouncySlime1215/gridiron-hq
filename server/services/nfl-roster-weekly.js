/**
 * The weekly roster-status panel: who was active, on injured reserve, on the
 * practice squad or inactive, in every regular-season week.
 *
 * WHY THIS EXISTS. `ros-projection.js` says it in its own header (line 66): "ros_ppg
 * is per game PLAYED and carries no availability term, so a consumer that wants
 * expected points per calendar week must apply one." No consumer applies one.
 * `trade-engine.js:360` repeats the same caveat and then prices every player as if
 * he plays every remaining week, so a player on injured reserve is valued at his
 * healthy per-game rate. Closing that is WO / O2 in the master plan, and it needs a
 * history of who was actually unavailable — which is this table.
 *
 * WHY NOT THE EXISTING FEEDS.
 *   - `nfl_injuries` is the *practice/game report* (Out, Doubtful, Questionable). It
 *     answers "is he hurt this week", never "is he on IR and how long has he been
 *     there". It also only exists for players a team bothered to list.
 *   - `nfl_verified_events` ingests this same nflverse feed already, but keeps only
 *     transitions, and drops any week with no kickoff on file
 *     (`nfl-event-archive.js`'s `gameAvailability()` returns null and the row is
 *     skipped). Reconstructing week-by-week state from a transition log with known
 *     gaps would shift a player's whole season on one missing row.
 * So the panel is loaded as a panel, and the event archive keeps doing its own job.
 *
 * SOURCE. nflverse `weekly_rosters` releases, one CSV per season, published from
 * 2002 but only joinable to this codebase's usage tables from 2021 (which is where
 * `player_week_usage` starts). 2021 is 15 MB, the current season about 1.8 MB —
 * streamed row by row rather than buffered, because the same host's
 * `depth_charts_2026.csv` is 51 MB and this loader should not be the reason a 2 GB
 * machine dies.
 *
 * Data license: CC BY 4.0 (nflverse). No upstream code is copied or executed.
 */
import { db, rows, row } from '../db/index.js';
import { eachRow } from './nfl-advanced.js';
import { canonicalTeamCode } from './team-codes.js';
import { recordSync } from './scheduler.js';

const RELEASE = 'https://github.com/nflverse/nflverse-data/releases/download/weekly_rosters';

export const ROSTER_WEEKLY_SOURCE = Object.freeze({
  repo: 'nflverse/nflverse-data',
  release: 'weekly_rosters',
  data_license: 'CC BY 4.0',
  code_copied: false
});

/**
 * The status codes, grouped by what they mean for availability. Kept here rather
 * than in the migration because which codes count as "cannot play" is a modelling
 * decision, and a modelling decision that lives in a schema cannot be revised
 * without a reload.
 *
 * ACT plays. RES is reserve/injured — the code fantasy cares about. DEV is the
 * practice squad (eligible for elevation, so not the same as injured). INA is
 * inactive for that week's game, which on this feed is a game-day decision rather
 * than a season-long placement. CUT, RET, EXE and the trade codes mean he is not on
 * the team at all.
 *
 * Counts measured on 2024 (46,579 rows, 44,473 regular season): ACT 27,369,
 * DEV 8,722, RES 5,426, INA 3,611, CUT 1,028, RET 398, EXE 13, TRC 6, TRD 5.
 */
export const STATUS_GROUPS = Object.freeze({
  active: ['ACT'],
  reserve: ['RES'],
  practice_squad: ['DEV'],
  inactive: ['INA'],
  off_roster: ['CUT', 'RET', 'EXE', 'TRC', 'TRD']
});

/**
 * The NFL's finer abbreviations worth telling apart inside RES. R01 is
 * reserve/injured; R48 is the designated-to-return variant, which is a different
 * forecast — a team has spent a return designation on him. Everything else stays as
 * whatever the feed said; this is a lookup, not an allowlist, so an unseen code
 * passes through rather than being dropped.
 */
export const RESERVE_DETAIL = Object.freeze({
  R01: 'reserve_injured',
  R48: 'designated_to_return'
});

const text = v => (v === '' || v == null || v === 'NA' ? null : String(v));
const int = v => { const x = Number(v); return Number.isFinite(x) ? Math.trunc(x) : null; };

/**
 * Load one or more seasons of the weekly roster panel.
 *
 * Regular season only, and only rows carrying a `gsis_id`: a player who cannot be
 * joined to `player_week_usage` cannot be graded, so storing him would inflate every
 * count without making any claim checkable. Both exclusions are reported per season
 * rather than silently applied.
 *
 * Upsert rather than insert-or-ignore: nflverse revises a week's roster after the
 * fact (a retroactive IR placement is common), and a stale row is worse than no row
 * for a model that reads "how long has he been out".
 */
export async function syncRosterWeekly(seasons = [2021, 2022, 2023, 2024, 2025, 2026]) {
  const wanted = [...new Set(seasons.map(Number).filter(Number.isInteger))].sort();
  const stmt = db.prepare(`INSERT INTO nfl_roster_weekly
      (season, week, gsis_id, team, position, depth_position, status, status_detail,
       player_name, pfr_id, espn_id, years_exp, ingested_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(season, week, gsis_id) DO UPDATE SET
      team=excluded.team, position=excluded.position, depth_position=excluded.depth_position,
      status=excluded.status, status_detail=excluded.status_detail,
      player_name=excluded.player_name, pfr_id=excluded.pfr_id, espn_id=excluded.espn_id,
      years_exp=excluded.years_exp, ingested_at=excluded.ingested_at`);

  const details = [];
  const failures = [];
  for (const season of wanted) {
    const url = `${RELEASE}/roster_weekly_${season}.csv`;
    const batch = [];
    let seen = 0, postseason = 0, noGsis = 0;
    try {
      await eachRow(url, r => {
        seen++;
        if (r.game_type && r.game_type !== 'REG') { postseason++; return; }
        const week = int(r.week);
        const gsisId = text(r.gsis_id);
        if (!week) return;
        if (!gsisId) { noGsis++; return; }
        batch.push([season, week, gsisId, canonicalTeamCode(text(r.team)), text(r.position),
          text(r.depth_chart_position), text(r.status), text(r.status_description_abbr),
          text(r.full_name), text(r.pfr_id), text(r.espn_id), int(r.years_exp)]);
      });
    } catch (error) {
      failures.push({ season, source: url, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const ingestedAt = new Date().toISOString();
    db.exec('BEGIN');
    try {
      for (const v of batch) stmt.run(...v, ingestedAt);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    details.push({ season, status: 'ok', rows: batch.length, rows_seen: seen,
      skipped_postseason: postseason, skipped_no_gsis: noGsis });
  }

  const result = { source: ROSTER_WEEKLY_SOURCE, seasons: details, failures,
    rows: details.reduce((sum, d) => sum + d.rows, 0) };
  // Every season failing is a broken loader, not a thin week: say so instead of
  // reporting a successful zero.
  if (wanted.length && failures.length === wanted.length) {
    recordSync('nflverse_weekly_rosters', 'error', result);
    throw new Error(`Every weekly-roster season failed: ${failures.map(f => `${f.season}: ${f.error}`).join('; ')}`);
  }
  recordSync('nflverse_weekly_rosters', failures.length ? 'error' : 'ok', result);
  return result;
}

/** What is stored, per season: weeks covered and the status mix. */
export function rosterWeeklyStatus() {
  const bySeason = rows(`SELECT season, COUNT(*) AS rows, COUNT(DISTINCT week) AS weeks,
      MIN(week) AS first_week, MAX(week) AS last_week,
      SUM(CASE WHEN status='RES' THEN 1 ELSE 0 END) AS reserve,
      SUM(CASE WHEN status='ACT' THEN 1 ELSE 0 END) AS active
    FROM nfl_roster_weekly GROUP BY season ORDER BY season`);
  return { source: ROSTER_WEEKLY_SOURCE, seasons: bySeason,
    rows: bySeason.reduce((sum, s) => sum + s.rows, 0),
    last_sync: row(`SELECT last_run_at, last_status FROM sync_log WHERE job='nflverse_weekly_rosters'`) ?? null };
}

/**
 * One player's season in week order, as the availability model reads it.
 *
 * `offense_snaps` is the truth about whether he played, not the status code: a
 * status says where the team put him, and only a snap says he took the field. The
 * two disagree often enough to matter — an ACT player can be a healthy scratch, and
 * a player activated mid-week can carry a stale status.
 *
 * The join goes through `players` because `player_week_snaps` keys on the internal
 * integer `player_id` while this panel keys on `gsis_id`; 8,519 of 8,556 players
 * carry a gsis_id, so the crosswalk is not the binding constraint. A null
 * `offense_snaps` means no snap row for that week, which is what "did not play"
 * looks like in that table — distinguished from a real zero by `has_snap_row`.
 */
export function playerSeasonPanel(gsisId, season) {
  return rows(`SELECT rw.week, rw.team, rw.position, rw.status, rw.status_detail,
      COALESCE(s.offense_snaps, 0) AS offense_snaps,
      CASE WHEN s.player_id IS NULL THEN 0 ELSE 1 END AS has_snap_row
    FROM nfl_roster_weekly rw
    LEFT JOIN players p ON p.gsis_id = rw.gsis_id
    LEFT JOIN player_week_snaps s
      ON s.player_id = p.id AND s.season = rw.season AND s.week = rw.week
    WHERE rw.gsis_id = ? AND rw.season = ?
    ORDER BY rw.week`, gsisId, season);
}
