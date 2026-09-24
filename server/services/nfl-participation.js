/**
 * Who was on the field: nflverse participation, one row per offense player per
 * offensive snap (PROJ-00). The table is nfl_play_participation_players
 * (migration 074).
 *
 * The file lists `offense_players` for special-teams plays too (the punt,
 * field-goal and kickoff units). Those are not offensive snaps, and PFR's
 * offense_snaps (player_week_snaps) does not count them. So each play is judged
 * against its nflverse row in nfl_play_by_play (loaded first by
 * ingestNflversePbpFile, engine vocabulary from classifyNflverse):
 *   - punt, fg_make, fg_miss: skipped (kicking unit);
 *   - any other typed play (pass, rush, sack, kneel, ...): kept;
 *   - untyped (NULL: kickoff, extra point, penalty no-play, two-point try):
 *     kept only when the feed recorded an offense_formation, i.e. the ball was
 *     snapped from scrimmage (post-snap penalty, two-point try). Kickoffs,
 *     extra points and pre-snap penalties carry no formation.
 *
 * `ingestFormations` (nfl-formations.js) reads the same file for per-play
 * formation and personnel counts. This keeps the part it drops: the gsis ids in
 * `offense_players`. With those, a player's real on-field plays can be counted
 * per week and checked against the PFR snap counts in player_week_snaps
 * (writer: syncSnapCounts, nflverse.js). `participationStatus` reports that
 * check.
 *
 * Licence: CC BY-SA 4.0. Credit "FTN Data via nflverse" from 2023 and "NFL
 * NextGenStats via nflverse" for 2022 and earlier (nflreadr load_participation).
 * Only aggregates go in the public repo (docs/evidence/2026-09-23/proj-00-licences.md).
 */
import { db, rows } from '../db/index.js';
import { canonicalTeamCode } from './team-codes.js';
import { csvRecords } from './csv-stream.js';

export const PARTICIPATION_URL = season =>
  `https://github.com/nflverse/nflverse-data/releases/download/pbp_participation/pbp_participation_${season}.csv`;
export const participationAttribution = season =>
  (season >= 2023 ? 'FTN Data via nflverse' : 'NFL NextGenStats via nflverse');

const GSIS = /^00-\d{7}$/;

/** `offense_players` is gsis ids joined by ';'. Anything that is not a gsis id is dropped. */
export function parseOffensePlayers(value) {
  return String(value ?? '').split(';').map(s => s.trim()).filter(s => GSIS.test(s));
}

/** nflverse game ids are `<season>_<week>_<away>_<home>`; the week is the second part. */
function weekOf(gameId) {
  const w = Number(String(gameId).split('_')[1]);
  return Number.isInteger(w) && w > 0 ? w : null;
}

const KICKING = new Set(['punt', 'fg_make', 'fg_miss']);

/** Load one season file (pbp_participation_<season>.csv, already downloaded). Upserts, so a re-run is safe. */
export async function ingestParticipationFile(season, file) {
  const pbpRows = rows(`SELECT COUNT(*) AS n FROM nfl_play_by_play WHERE season = ? AND event_id LIKE ? ESCAPE '!'`,
    season, `${season}!_%`)[0]?.n ?? 0;
  if (!pbpRows) {
    throw new Error(`no nflverse plays for ${season} in nfl_play_by_play: load nflverse pbp for ${season} first `
      + '(scripts/backfill-history.mjs pbp); participation is kept only for offensive snaps judged from it');
  }
  const pbpType = db.prepare('SELECT play_type FROM nfl_play_by_play WHERE event_id = ? AND play_id = ?');
  const stmt = db.prepare(`INSERT INTO nfl_play_participation_players
      (game_id, play_id, season, week, gsis_id, team, was_route_runner)
      VALUES (?,?,?,?,?,?,NULL)
      ON CONFLICT(game_id, play_id, gsis_id) DO UPDATE SET
        season = excluded.season, week = excluded.week, team = excluded.team`);
  let rowsRead = 0, playsWithPlayers = 0, playerRows = 0, skippedKicking = 0, skippedUntyped = 0;
  const games = new Set();
  let batch = 0;
  db.exec('BEGIN');
  try {
    for await (const rec of csvRecords(file)) {
      rowsRead++;
      const gameId = String(rec.nflverse_game_id ?? '').trim();
      if (!gameId.startsWith(`${season}_`)) {
        throw new Error(`season mismatch: ${file} row ${rowsRead} is game ${gameId}, expected season ${season}`);
      }
      const playId = Number(rec.play_id);
      const week = weekOf(gameId);
      if (!Number.isInteger(playId) || week == null) throw new Error(`row ${rowsRead} of ${file}: bad game or play id`);
      games.add(gameId);
      const players = parseOffensePlayers(rec.offense_players);
      if (!players.length) continue;
      const pbp = pbpType.get(gameId, String(playId));
      if (!pbp) throw new Error(`row ${rowsRead} of ${file}: ${gameId} play ${playId} has players but no nflverse pbp row`);
      if (KICKING.has(pbp.play_type)) { skippedKicking++; continue; }
      if (pbp.play_type == null && !String(rec.offense_formation ?? '').trim()) { skippedUntyped++; continue; }
      const team = String(rec.possession_team ?? '').trim();
      const code = team ? canonicalTeamCode(team) : null;
      for (const gsis of players) { stmt.run(gameId, playId, season, week, gsis, code); playerRows++; }
      playsWithPlayers++;
      if (++batch >= 5000) { db.exec('COMMIT'); db.exec('BEGIN'); batch = 0; }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { season, rows_read: rowsRead, games: games.size, plays_with_players: playsWithPlayers,
    player_rows: playerRows, skipped_kicking_plays: skippedKicking, skipped_untyped_no_formation: skippedUntyped,
    attribution: participationAttribution(season), source: PARTICIPATION_URL(season) };
}

const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/**
 * Per season: plays and player rows stored, and how well they cover the PFR
 * snap counts. `snap_match_share` = offense snaps in player_week_snaps whose
 * player-week (players.gsis_id, season, week) has at least one participation
 * row, over all offense snaps that season. `matched_play_ratio` = participation
 * plays over PFR snaps on those matched player-weeks. It is near 1 when the
 * two feeds count the same plays.
 */
export function participationStatus({ season = null } = {}) {
  const where = season == null ? '' : 'WHERE season = ?';
  const args = season == null ? [] : [season];
  const stored = rows(`SELECT season, COUNT(DISTINCT game_id || '|' || play_id) AS plays, COUNT(*) AS player_rows
                       FROM nfl_play_participation_players ${where} GROUP BY season ORDER BY season`, ...args);
  const seasons = stored.map(s => {
    const m = rows(`
      WITH part AS (
        SELECT gsis_id, week, COUNT(*) AS plays FROM nfl_play_participation_players
        WHERE season = ? GROUP BY gsis_id, week)
      SELECT SUM(s.offense_snaps) AS snaps,
             SUM(CASE WHEN part.plays IS NOT NULL THEN s.offense_snaps END) AS matched_snaps,
             SUM(part.plays) AS matched_plays
      FROM player_week_snaps s
      LEFT JOIN players p ON p.id = s.player_id
      LEFT JOIN part ON part.gsis_id = p.gsis_id AND part.week = s.week
      WHERE s.season = ? AND s.offense_snaps > 0`, s.season, s.season)[0] ?? {};
    return { season: s.season, plays: s.plays, player_rows: s.player_rows,
      snaps: m.snaps ?? 0, matched_snaps: m.matched_snaps ?? 0,
      snap_match_share: m.snaps ? r4(m.matched_snaps / m.snaps) : null,
      matched_play_ratio: m.matched_snaps ? r4(m.matched_plays / m.matched_snaps) : null,
      attribution: participationAttribution(s.season) };
  });
  return { seasons,
    attribution: 'FTN Data via nflverse (2023 on); NFL NextGenStats via nflverse (2022 and earlier). CC BY-SA 4.0.',
    note: 'Route runners are not published per play; was_route_runner is NULL.' };
}
