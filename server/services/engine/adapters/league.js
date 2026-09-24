/**
 * League facts as events: `league.settings` and `league.matchup_result`
 * (ENGINE-ARCHITECTURE.md §2 sources table, §4.2 `league` producer inputs, §7.1).
 *
 * league.settings   from `leagues`, one event per league per change (compare-latest on
 *                   `league:<id>:settings`). Facts the engine needs to read the league's
 *                   rules as of a time: the market format key (format.js#deriveFormat, the
 *                   key dynasty_values is priced under), the scoring key (the same hash
 *                   outcome.player_week uses), team count, superflex, roster positions, and
 *                   from the ESPN payload the trade deadline, veto votes, playoff team count
 *                   and regular-season length. Never the league name, never espn_s2 / swid:
 *                   the SELECT does not read them.
 *                   as_of: fetched_at (first_seen: the capture that saw these settings).
 * league.matchup_result
 *                   from `league_week_scores` (league-history.js#saveScores), one event per
 *                   matchup (the two rosters paired; a bye is not a matchup), compare-latest
 *                   on `matchup:<league>:<season>:<week>:<a>:<b>` (a < b), so a score
 *                   correction is a new event.
 *                   FINAL ONLY. saveScores stores whatever ESPN reports, including a week in
 *                   progress. A matchup is a result only when it was captured after its
 *                   week ended: the end (Eastern) of the NFL week's last game day in
 *                   game_lines. as_of is that week end (date_only). A week with no
 *                   game_lines rows has no known end; its rows count as final only when
 *                   captured after February 1 of the next year, with as_of the capture
 *                   (first_seen). `decision_time` is the week's first kickoff (the
 *                   calendar's game.cutoff rule): a call on the matchup is graded as of then.
 *                   Known limit: ESPN matchup period = NFL week is assumed; a two-week
 *                   playoff matchup is keyed to its first week.
 */
import { registerEventType } from '../registry.js';
import { endOfDayEastern } from '../events.js';
import { deriveFormat } from '../../format.js';
import { scoringFor, PPR } from '../../scoring.js';
import { nflKickoffDate } from '../../date-util.js';
import { scoringKey } from './outcomes.js';

registerEventType('league.settings', {
  description: 'A league\'s rules as captured: format key, scoring key, trade deadline, veto votes, playoff size (no names, no cookies)',
});
registerEventType('league.matchup_result', {
  description: 'A final fantasy matchup: both rosters\' points and the winner, as of the week end',
});

const present = v => v != null && v !== '';
const WEIGHT_KEYS = Object.keys(PPR).sort();

/** The payload JSON, or {unparseable: true}: a bad payload is reported, never dropped. */
function parsePayload(s) {
  if (!present(s)) return null;
  try { return JSON.parse(s); } catch (e) { return { unparseable: true, error: String(e.message).slice(0, 120) }; }
}
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export const LEAGUE_SETTINGS_ADAPTER = Object.freeze({
  stream: 'league_settings', table: 'leagues', source: 'leagues.settings',
  // Named columns only: name, espn_s2 and swid are never read.
  sql: (t, database) => {
    const cols = new Set(database.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));
    const opt = c => (cols.has(c) ? c : `NULL AS ${c}`);
    return `SELECT id, platform, season, team_count, ppr, superflex, roster_positions, payload, fetched_at,
              ${opt('league_type')}, ${opt('best_ball')} FROM ${t}`;
  },
  map: r => {
    const payload = parsePayload(r.payload);
    const settings = payload && !payload.unparseable ? payload.settings ?? {} : {};
    const deadline = num(settings.tradeSettings?.deadlineDate);
    const weights = Object.fromEntries(WEIGHT_KEYS.map(k => [k, Number(scoringFor(r)[k] ?? 0)]));
    let rosterPositions = null;
    if (present(r.roster_positions)) rosterPositions = parsePayload(r.roster_positions);
    const league = Number(r.id);
    return [{
      event_type: 'league.settings', as_of: present(r.fetched_at) ? r.fetched_at : null, as_of_quality: 'first_seen',
      league_id: league, natural_key: `league:${league}:settings`,
      entities: [{ type: 'league', id: String(league), role: 'subject' }],
      payload: {
        league_id: league, platform: r.platform ?? null, season: num(r.season),
        format_key: deriveFormat(r).formatKey, scoring_key: scoringKey(weights),
        team_count: num(r.team_count), ppr: num(r.ppr), superflex: Number(r.superflex) === 1,
        roster_positions: rosterPositions, league_type: r.league_type ?? null,
        trade_deadline: deadline == null ? null : new Date(deadline).toISOString(),
        veto_votes_required: num(settings.tradeSettings?.vetoVotesRequired),
        playoff_team_count: num(settings.scheduleSettings?.playoffTeamCount),
        matchup_period_count: num(settings.scheduleSettings?.matchupPeriodCount),
        ...(payload?.unparseable ? { payload_unparseable: true } : {}),
      },
    }];
  },
});

/** Week end with no schedule to read: February 1 after the season (the fantasy season is over). */
const seasonOver = season => `${Number(season) + 1}-02-01T00:00:00.000Z`;

export const MATCHUP_RESULT_ADAPTER = Object.freeze({
  stream: 'matchups', table: 'league_week_scores', source: 'league_week_scores.matchup',
  // Wrapped so the cursor's `WHERE captured_at ...` applies to the paired rows.
  sql: t => `SELECT * FROM (SELECT a.league_id, a.season, a.week, a.roster_id AS team_a, a.points AS points_a,
               b.roster_id AS team_b, b.points AS points_b, a.is_playoff,
               MAX(a.captured_at, b.captured_at) AS captured_at,
               (SELECT MAX(g.gameday) FROM game_lines g WHERE g.season = a.season AND g.week = a.week) AS last_gameday,
               (SELECT g.gameday || ' ' || COALESCE(g.gametime, '23:59') FROM game_lines g
                  WHERE g.season = a.season AND g.week = a.week AND g.gameday IS NOT NULL
                  ORDER BY g.gameday, g.gametime LIMIT 1) AS first_game
             FROM ${t} a JOIN ${t} b ON b.league_id = a.league_id AND b.season = a.season AND b.week = a.week
               AND b.roster_id = a.opponent_roster_id
             WHERE a.roster_id < b.roster_id)`,
  map: r => {
    if (r.points_a == null || r.points_b == null) return [];
    let asOf; let quality;
    if (present(r.last_gameday)) {
      asOf = endOfDayEastern(String(r.last_gameday));
      quality = 'date_only';
      if (!(new Date(r.captured_at).toISOString() >= asOf)) return []; // captured before the week ended: not a result
    } else {
      if (!(new Date(r.captured_at).toISOString() >= seasonOver(r.season))) return [];
      asOf = r.captured_at;
      quality = 'first_seen';
    }
    let decisionTime = null;
    if (present(r.first_game)) {
      const [day, time] = String(r.first_game).split(' ');
      decisionTime = nflKickoffDate(day, time || '23:59').toISOString();
    }
    const league = Number(r.league_id); const season = Number(r.season); const week = Number(r.week);
    const a = String(r.team_a); const b = String(r.team_b);
    const pa = Number(r.points_a); const pb = Number(r.points_b);
    return [{
      event_type: 'league.matchup_result', as_of: asOf, as_of_quality: quality, league_id: league,
      natural_key: `matchup:${league}:${season}:${week}:${a}:${b}`,
      entities: [
        { type: 'league_team', id: `${league}:${a}`, role: 'subject' },
        { type: 'league_team', id: `${league}:${b}`, role: 'counterparty' },
        { type: 'week', id: `${season}:${week}`, role: 'subject' },
      ],
      payload: { league_id: league, season, week, matchup: `${league}:${season}:${week}:${a}:${b}`, team_a: a, team_b: b,
        points_a: pa, points_b: pb, winner: pa > pb ? a : pb > pa ? b : null, tie: pa === pb,
        is_playoff: Number(r.is_playoff) === 1, decision_time: decisionTime,
        week_end_basis: quality === 'date_only' ? 'last game day in game_lines' : 'no schedule: captured after the season' },
    }];
  },
});
