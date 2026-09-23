/**
 * The engine's one event log: `engine_events` (migration 075).
 *
 * `appendEvents` is the ONLY writer (test/engine-spine.test.js greps for it). It
 * validates each event, inserts with ON CONFLICT (source, source_key) DO NOTHING so
 * any adapter can be re-run safely, and calls the onEvent handlers once per event it
 * actually added. `getEvents` is the as-of reader: it refuses to run without an
 * asOf and never returns an event stamped after it.
 *
 * Privacy: a payload may carry counts, rates, ids and public facts only. Keys that
 * would hold private text or credentials are refused at any depth.
 */
import { db as appDb } from '../../db/index.js';
import { isEventType, handlersFor } from './registry.js';

const FORBIDDEN_KEYS = new Set(['text', 'body', 'message', 'messages', 'msg', 'content', 'espn_s2', 'swid',
  'cookie', 'password', 'token']);

/**
 * Normalise a timestamp to ISO-8601 UTC with milliseconds. Accepts ISO strings,
 * SQLite `datetime('now')` text (UTC, no zone), epoch milliseconds and Dates.
 * Anything unparseable throws: a guessed time is how a future event leaks in.
 */
export function normalizeAsOf(input) {
  let v = input;
  if (v instanceof Date) v = v.getTime();
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) v = `${s.replace(' ', 'T')}Z`;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) v = `${s}T00:00:00Z`;
    else v = s;
  }
  const t = typeof v === 'number' ? v : Date.parse(v);
  if (!Number.isFinite(t)) throw new Error(`as_of "${input}" is not a timestamp`);
  return new Date(t).toISOString();
}

function assertNoPrivateKeys(value, where) {
  if (value === null || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(k.toLowerCase())) throw new Error(`${where}: payload key "${k}" is not allowed in engine_events`);
    assertNoPrivateKeys(v, where);
  }
}

function validate(ev) {
  const where = `event ${ev?.source}/${ev?.source_key}`;
  if (!ev || typeof ev !== 'object') throw new Error('event must be an object');
  if (!isEventType(ev.event_type)) throw new Error(`${where}: event type "${ev.event_type}" is not registered`);
  if (typeof ev.source !== 'string' || !ev.source) throw new Error(`${where}: source is required`);
  if (ev.source_key == null || String(ev.source_key) === '') throw new Error(`${where}: source_key is required`);
  const payload = ev.payload ?? {};
  if (typeof payload !== 'object' || Array.isArray(payload)) throw new Error(`${where}: payload must be an object`);
  assertNoPrivateKeys(payload, where);
  const playerId = ev.player_id == null ? null : Number(ev.player_id);
  if (playerId != null && !Number.isInteger(playerId)) throw new Error(`${where}: player_id must be an integer`);
  const leagueId = ev.league_id == null ? null : Number(ev.league_id);
  if (leagueId != null && !Number.isInteger(leagueId)) throw new Error(`${where}: league_id must be an integer`);
  return {
    event_type: ev.event_type, as_of: normalizeAsOf(ev.as_of), league_id: leagueId,
    team_id: ev.team_id == null ? null : String(ev.team_id), player_id: playerId,
    source: ev.source, source_key: String(ev.source_key), payload: JSON.stringify(payload),
  };
}

/**
 * Append events. Returns { inserted, skipped, events } where `events` are the rows
 * added by this call (duplicates are skipped silently by design: that is what makes
 * a re-run a no-op). All events are validated before any is written.
 */
export function appendEvents(list, { database = appDb, dispatch = true } = {}) {
  const clean = list.map(validate);
  const ingestedAt = new Date().toISOString();
  const insert = database.prepare(`INSERT INTO engine_events
      (event_type, as_of, league_id, team_id, player_id, source, source_key, payload, ingested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source, source_key) DO NOTHING
      RETURNING id`);
  const added = [];
  const own = !database.isTransaction;
  if (own) database.exec('BEGIN IMMEDIATE');
  try {
    for (const e of clean) {
      const r = insert.get(e.event_type, e.as_of, e.league_id, e.team_id, e.player_id, e.source, e.source_key,
        e.payload, ingestedAt);
      if (r) added.push({ id: Number(r.id), ...e, payload: JSON.parse(e.payload), ingested_at: ingestedAt });
    }
    if (own) database.exec('COMMIT');
  } catch (error) {
    if (own) database.exec('ROLLBACK');
    throw error;
  }
  if (dispatch) for (const ev of added) for (const h of handlersFor(ev.event_type)) h(ev);
  return { inserted: added.length, skipped: clean.length - added.length, events: added };
}

/**
 * The as-of event reader. `asOf` is required; only events with as_of <= asOf are
 * returned, oldest first. Filters are optional and combine with AND.
 */
export function getEvents({ asOf, leagueId, teamId, playerId, types, limit = 1000 } = {}, database = appDb) {
  if (asOf == null) throw new Error('getEvents needs asOf: an as-of read without a cutoff can see the future');
  const where = ['as_of <= ?'];
  const params = [normalizeAsOf(asOf)];
  if (leagueId != null) { where.push('league_id = ?'); params.push(Number(leagueId)); }
  if (teamId != null) { where.push('team_id = ?'); params.push(String(teamId)); }
  if (playerId != null) { where.push('player_id = ?'); params.push(Number(playerId)); }
  if (types?.length) { where.push(`event_type IN (${types.map(() => '?').join(',')})`); params.push(...types); }
  params.push(Math.max(1, Math.min(10000, Number(limit) || 1000)));
  return database.prepare(`SELECT id, event_type, as_of, league_id, team_id, player_id, source, source_key, payload,
      ingested_at FROM engine_events WHERE ${where.join(' AND ')} ORDER BY as_of, id LIMIT ?`).all(...params)
    .map(r => ({ ...r, id: Number(r.id), payload: JSON.parse(r.payload) }));
}
