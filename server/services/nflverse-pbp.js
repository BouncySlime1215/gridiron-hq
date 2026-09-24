/**
 * nflverse play-by-play history into nfl_play_by_play (PROJ-00).
 *
 * The table's one writer stays `storePlays` (nfl-espn-pbp.js). This module only
 * maps nflverse columns into the play shape storePlays already takes, in the
 * engine's own play_type vocabulary (`classifyPlay` there). So a play loaded
 * from nflverse and a play polled from ESPN mean the same thing to every reader.
 *
 * `event_id` is the nflverse game_id (`2023_05_LA_PHI`). It names its source,
 * so pbpStatus can report the two sources apart. It also joins directly to
 * nfl_play_formations.game_id and nfl_play_participation_players.game_id.
 * ESPN's backfillSeasons skips a season this loader filled, and this loader
 * refuses a season that already holds ESPN plays, so a game has one producer.
 * Two-point tries are untyped (null) here as in classifyPlay ('two-point').
 *
 * Every published row is stored, including the ones the engine does not
 * simulate (kickoffs, extra points, timeouts, penalties). Those rows get
 * play_type NULL, the same as classifyPlay gives them. The row count then
 * equals the published count, which is the floor PROJ-00 checks.
 *
 * Licence: CC BY 4.0, "nflverse", attribution already on /api/data-freshness
 * (NFLVERSE_SOURCE). See docs/evidence/2026-09-23/proj-00-licences.md.
 */
import { db } from '../db/index.js';
import { storePlays, espnPlays } from './nfl-espn-pbp.js';
import { canonicalTeamCode } from './team-codes.js';
import { csvRecords } from './csv-stream.js';

export const NFLVERSE_PBP_URL = season =>
  `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${season}.csv.gz`;

// 'NA' and blank are unknown, not zero.
const num = v => {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '' || s === 'NA') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const flag = v => (num(v) === 1 ? 1 : 0);
const str = v => {
  const s = String(v ?? '').trim();
  return s === '' || s === 'NA' ? null : s;
};
const team = v => { const s = str(v); return s ? canonicalTeamCode(s) : null; };

/**
 * nflverse play_type plus its outcome flags, in classifyPlay's vocabulary.
 * Order follows classifyPlay: a sack is a sack before it is a pass; an
 * interception or lost fumble is a turnover before it is a pass or a run.
 * A spike is ESPN's "Pass Incompletion", so it maps to incompletion here too
 * (guess: ESPN's taxonomy for spikes was read from classifyPlay's inputs, not
 * checked against a stored spike).
 */
export function classifyNflverse(rec) {
  const type = str(rec.play_type);
  if (!type || type === 'kickoff' || type === 'extra_point' || type === 'no_play') return null;
  // ESPN parity: classifyPlay maps 'two-point' to null. nflverse marks a failed
  // two-point pass incomplete_pass 0, so without this it would count as a completion.
  if (flag(rec.two_point_attempt)) return null;
  if (type === 'punt') return 'punt';
  if (type === 'field_goal') return str(rec.field_goal_result) === 'made' ? 'fg_make' : 'fg_miss';
  if (type === 'qb_kneel') return 'kneel';
  if (type === 'qb_spike') return 'incompletion';
  if (flag(rec.sack)) return 'sack';
  if (flag(rec.interception)) return 'interception';
  if (flag(rec.fumble_lost)) return 'fumble';
  if (type === 'pass') return flag(rec.incomplete_pass) ? 'incompletion' : 'pass';
  if (type === 'run') return 'rush';
  return null;
}

/** One nflverse record -> { event_id, season, week, play } for storePlays. */
export function mapNflversePlay(rec) {
  const scoring = flag(rec.touchdown) || flag(rec.safety)
    || str(rec.field_goal_result) === 'made' || str(rec.extra_point_result) === 'good'
    || str(rec.two_point_conv_result) === 'success';
  return {
    event_id: str(rec.game_id),
    season: num(rec.season),
    week: num(rec.week),
    play: {
      play_id: str(rec.play_id),
      sequence: num(rec.order_sequence),
      period: num(rec.qtr),
      clock_seconds: num(rec.game_seconds_remaining),
      offense: team(rec.posteam),
      defense: team(rec.defteam),
      down: num(rec.down),
      distance: num(rec.ydstogo),
      yards_to_endzone: num(rec.yardline_100),
      play_type: classifyNflverse(rec),
      yards_gained: num(rec.yards_gained),
      is_turnover: flag(rec.interception) || flag(rec.fumble_lost) ? 1 : 0,
      is_scoring: scoring ? 1 : 0,
      is_penalty: flag(rec.penalty),
      shotgun: num(rec.shotgun),
      no_huddle: num(rec.no_huddle),
      pass_depth: str(rec.pass_length),
      pass_direction: str(rec.pass_location),
      home_score: num(rec.total_home_score),
      away_score: num(rec.total_away_score),
      text: str(rec.desc),
    },
  };
}

/**
 * Load one season file (play_by_play_<season>.csv.gz, already downloaded).
 * Streams the file and writes one game at a time in a transaction.
 * A record whose season is not `season` stops the load before anything past
 * the current game is written: the file is for the wrong season.
 */
export async function ingestNflversePbpFile(season, file) {
  const espn = espnPlays(season);
  if (espn > 0) {
    throw new Error(`season ${season} already has ${espn} ESPN plays in nfl_play_by_play; `
      + 'loading nflverse too would store those games twice (one producer per game)');
  }
  let rowsRead = 0, stored = 0, games = 0;
  let game = null;
  const flush = () => {
    if (!game) return;
    db.exec('BEGIN');
    try {
      stored += storePlays(game).stored;
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    games++;
    game = null;
  };
  for await (const rec of csvRecords(file)) {
    rowsRead++;
    const m = mapNflversePlay(rec);
    if (m.season !== season) {
      throw new Error(`season mismatch: ${file} row ${rowsRead} is season ${m.season}, expected ${season}`);
    }
    if (!m.event_id || !m.play.play_id) throw new Error(`row ${rowsRead} of ${file} has no game_id or play_id`);
    if (game && game.event_id !== m.event_id) flush();
    if (!game) game = { event_id: m.event_id, season: m.season, week: m.week, plays: [] };
    game.plays.push(m.play);
  }
  flush();
  return { season, rows_read: rowsRead, plays_stored: stored, games, source: NFLVERSE_PBP_URL(season) };
}
