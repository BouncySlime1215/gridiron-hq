/**
 * The NFL schedule as events: `nfl.game`, one per game, from game_lines (the home row).
 *
 * The `calendar` producer (producers/calendar.js) needs kickoffs and which games are over
 * to say what week it is; the `market.game_line` events deliberately carry neither
 * (backfill.js: no scores, no closing lines). This stream carries the schedule facts and a
 * `final` flag only: never a score. Compare-latest by `game:season:week:home` under source
 * `game_lines.schedule`, so a game appends one event when first seen, one when its kickoff
 * moves, and one when it goes final.
 *
 * as_of: fetched_at (first_seen: the capture that saw it). gamescript.js rewrites
 * fetched_at when it writes a score, so the `final` change lands with a fresh stamp.
 */
import { registerEventType } from '../registry.js';

registerEventType('nfl.game', {
  description: 'An NFL game on the schedule (teams, kickoff, final or not; never the score), from game_lines',
});

const present = v => v != null && v !== '';

export const SCHEDULE_ADAPTER = Object.freeze({
  stream: 'schedule', table: 'game_lines',
  // Its own source name: market.game_line events from the same table key on season:week:team too.
  source: 'game_lines.schedule',
  sql: (t, database) => {
    const cols = new Set(database.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));
    const opt = c => (cols.has(c) ? c : `NULL AS ${c}`);
    return `SELECT season, week, team, opponent, home, ${opt('gameday')}, ${opt('gametime')},
              ${cols.has('team_score') ? 'team_score IS NOT NULL' : '0'} AS final, fetched_at FROM ${t}`;
  },
  map: r => {
    if (Number(r.home) !== 1 || !present(r.team) || !present(r.opponent)) return [];
    return [{
      event_type: 'nfl.game', as_of: r.fetched_at, as_of_quality: 'first_seen',
      natural_key: `game:${r.season}:${r.week}:${r.team}`,
      entities: [
        { type: 'game', id: `${r.season}:${r.week}:${r.team}`, role: 'subject' },
        { type: 'nfl_team', id: r.team, role: 'subject' },
        { type: 'nfl_team', id: r.opponent, role: 'counterparty' },
      ],
      payload: { season: Number(r.season), week: Number(r.week), home: r.team, away: r.opponent,
        gameday: r.gameday ?? null, gametime: r.gametime ?? null, final: Number(r.final) === 1 },
    }];
  },
});
