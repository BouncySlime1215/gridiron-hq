/**
 * Outcomes as events: `outcome.player_week` (ENGINE-ARCHITECTURE.md §7.1, D9).
 *
 * One event per (player_week, scoring_key, stat_version), from `player_week_usage` rows
 * whose game is final in `game_lines` (team_score set), scored with `scoring.js#scoreLine`
 * under every distinct scoring rule the synced leagues use (`scoringFor`).
 *
 *   scoring_key   sha256 of the league's scoring weights, 16 hex: the suffix of a
 *                 `player_week_scored` entity (state.js ENTITY_KEYS), so a points-space
 *                 prediction and its outcome join on the same key.
 *   stat_version  sha256 of the scored stat columns, 16 hex. It is in the natural key, so a
 *                 stat correction is a NEW event and the old one stays; the grader grades
 *                 against the latest (§7.1 "pre-registered outcome").
 *   as_of         the end of the game day, Eastern (quality date_only): the line is a fact
 *                 once the game is over, and the source row carries no stamp of its own.
 *   kickoff       the game's scheduled kickoff (the same rule as calendar.js `game.cutoff`):
 *                 the decision time of every player-week field (§3.7).
 * Facts only: points and the stat line, never a projection.
 */
import crypto from 'node:crypto';
import { registerEventType } from '../registry.js';
import { endOfDayEastern } from '../events.js';
import { scoreLine, scoringFor, PPR } from '../../scoring.js';
import { nflKickoffDate } from '../../date-util.js';

registerEventType('outcome.player_week', {
  description: 'A final player-week stat line scored under one scoring key; a stat correction is a new event (stat_version)',
});

export const STAT_COLUMNS = Object.freeze(['passing_yards', 'passing_tds', 'interceptions', 'rushing_yards', 'rushing_tds',
  'receptions', 'receiving_yards', 'receiving_tds', 'fumbles_lost', 'first_downs']);
const WEIGHT_KEYS = Object.keys(PPR).sort();

const hash16 = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

/** The scoring key of a set of weights: only the weights scoreLine applies, in a fixed order. */
export function scoringKey(weights) {
  return hash16(WEIGHT_KEYS.map(k => [k, Number(weights[k] ?? 0)]));
}

/** The version of a stat line: every column scoreLine reads, nulls kept distinct from zero. */
export function statVersion(line) {
  return hash16(STAT_COLUMNS.map(c => [c, line[c] ?? null]));
}

const tableExists = (database, t) =>
  !!database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);

/** Every distinct scoring rule among the synced leagues, as [{key, weights}]. */
export function scoringRules(database) {
  if (!tableExists(database, 'leagues')) return [];
  const out = new Map();
  for (const lg of database.prepare('SELECT id, platform, ppr, payload FROM leagues ORDER BY id').all()) {
    const weights = Object.fromEntries(WEIGHT_KEYS.map(k => [k, Number(scoringFor(lg)[k] ?? 0)]));
    const key = scoringKey(weights);
    if (!out.has(key)) out.set(key, { key, weights, leagues: [] });
    out.get(key).leagues.push(Number(lg.id));
  }
  return [...out.values()];
}

export const OUTCOMES_ADAPTER = Object.freeze({
  stream: 'outcomes', table: 'player_week_usage', source: 'player_week_usage.scored',
  // Wrapped so the cursor's `WHERE (season * 100 + week) ...` applies to the joined rows.
  sql: t => `SELECT * FROM (SELECT u.player_id, u.season, u.week, u.team, u.position,
               ${STAT_COLUMNS.map(c => `u.${c}`).join(', ')},
               g.gameday, g.gametime, CASE WHEN g.home = 1 THEN g.team ELSE g.opponent END AS game_home
             FROM ${t} u JOIN game_lines g ON g.season = u.season AND g.week = u.week AND g.team = u.team
             WHERE g.team_score IS NOT NULL)`,
  context: database => ({ rules: scoringRules(database) }),
  map: (r, { rules }) => {
    if (!r.gameday || !r.game_home || !(Number(r.player_id) > 0)) return [];
    const line = Object.fromEntries(STAT_COLUMNS.map(c => [c, r[c] ?? null]));
    const version = statVersion(line);
    const kickoff = nflKickoffDate(r.gameday, r.gametime || '23:59').toISOString();
    const season = Number(r.season); const week = Number(r.week); const pid = Number(r.player_id);
    return rules.map(rule => ({
      event_type: 'outcome.player_week', as_of: endOfDayEastern(r.gameday), as_of_quality: 'date_only',
      player_id: pid,
      natural_key: `${pid}:${season}:${week}:${rule.key}:${version}`,
      entities: [
        { type: 'player', id: String(pid), role: 'subject' },
        { type: 'game', id: `${season}:${week}:${r.game_home}`, role: 'subject' },
      ],
      payload: { season, week, player_id: pid, team: r.team, position: r.position ?? null, scoring_key: rule.key,
        stat_version: version, points: scoreLine(line, rule.weights), kickoff, game: `${season}:${week}:${r.game_home}`, line },
    }));
  },
});
