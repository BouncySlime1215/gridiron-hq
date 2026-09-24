/**
 * The engine's one event log: `engine_events` + `engine_event_entities` (migration 075;
 * ENGINE-ARCHITECTURE.md §2.1-2.2, §3.1).
 *
 * `appendEvents` is the ONLY writer (test/engine-spine.test.js greps for it). Per event:
 *   - role guard: refused unless the process role is engine/script/test (role.js);
 *   - validation: registered type, no private keys at any depth, integer ids;
 *   - valid time: `as_of` + `as_of_quality` (exact | first_seen | date_only | clamped).
 *     A bare date is the end of that day, Eastern (date_only). A stamp later than this
 *     log's receipt is clamped to `ingested_at`, the raw stamp kept in payload.source_as_of;
 *   - `provenance`: captured (default) | reconstructed (a backfill) | derived;
 *   - compare-latest dedupe by `(source, natural_key)`: the event is appended only when its
 *     payload hash differs from the latest event with the same key, so an unchanged
 *     re-capture appends nothing and A -> B -> A appends three events. `source_key` =
 *     natural_key:hash:prev_event_id, UNIQUE with source (a race is a no-op, not a dup);
 *   - entities: every party ({type, id, role}), plus the primary scope columns; players
 *     without a players.id arrive as alias entities (gsis:, espn:, sleeper:) and are
 *     resolved at read time, so a mapping added later reaches events already written.
 * Handlers registered with onEvent run only with `dispatch: true`.
 *
 * `getEvents` is the as-of reader: `asOf` is required; `afterId`, a `from` window,
 * `entities` (a player: filter expands to its aliases), and it THROWS when a result hits
 * its limit (`allowTruncated` returns {events, truncated}) instead of silently dropping
 * the newest rows. `stripModel` removes payload.model (a model's own output is never a
 * learner's feature).
 *
 * Privacy: a payload may carry counts, rates, ids and public facts only.
 */
import crypto from 'node:crypto';
import { db as appDb } from '../../db/index.js';
import { isEventType, eventTypeSpec, handlersFor } from './registry.js';
import { assertWriteRole } from './role.js';

const FORBIDDEN_KEYS = new Set(['text', 'body', 'message', 'messages', 'msg', 'content', 'espn_s2', 'swid',
  'cookie', 'password', 'token']);
export const AS_OF_QUALITY = Object.freeze(['exact', 'first_seen', 'date_only', 'clamped']);
export const PROVENANCE = Object.freeze(['captured', 'reconstructed', 'derived']);
export const ENTITY_ROLES = Object.freeze(['subject', 'from', 'to', 'counterparty', 'league']);
/** Entity types an event may name: the state grammar's plus raw-source aliases. */
export const EVENT_ENTITY_TYPES = Object.freeze(['player', 'league', 'league_team', 'nfl_team', 'game', 'week',
  'offer', 'rec', 'deal', 'gsis', 'espn', 'sleeper', 'source', 'engine', 'hypothesis']);
const ALIAS_COLUMNS = Object.freeze({ espn: 'espn_id', gsis: 'gsis_id', sleeper: 'sleeper_id' });
const MAX_LIMIT = 50000;

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalise a timestamp to ISO-8601 UTC with milliseconds. Accepts ISO strings, SQLite
 * `datetime('now')` text (UTC, no zone), epoch milliseconds and Dates. Anything
 * unparseable throws: a guessed time is how a future event leaks in.
 */
export function normalizeAsOf(input) {
  let v = input;
  if (v instanceof Date) v = v.getTime();
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) v = `${s.replace(' ', 'T')}Z`;
    else if (BARE_DATE.test(s)) v = `${s}T00:00:00Z`;
    else v = s;
  }
  const t = typeof v === 'number' ? v : Date.parse(v);
  if (!Number.isFinite(t)) throw new Error(`as_of "${input}" is not a timestamp`);
  return new Date(t).toISOString();
}

/** 23:59:59.999 America/New_York on a bare date, as ISO UTC. */
export function endOfDayEastern(date) {
  const [y, m, d] = date.split('-').map(Number);
  // New York is UTC-4 or UTC-5; find the offset in force at local noon that day.
  const noonUtc = Date.UTC(y, m - 1, d, 16);
  const hourNy = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' })
    .format(new Date(noonUtc)));
  const offsetHours = 16 - hourNy; // 4 in EDT, 5 in EST
  return new Date(Date.UTC(y, m - 1, d, 23 + offsetHours, 59, 59, 999)).toISOString();
}

function assertNoPrivateKeys(value, where) {
  if (value === null || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(k.toLowerCase())) throw new Error(`${where}: payload key "${k}" is not allowed in engine_events`);
    assertNoPrivateKeys(v, where);
  }
}

function stableJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
}
const hashOf = (type, payload) => crypto.createHash('sha256').update(`${type}\n${stableJson(payload)}`).digest('hex').slice(0, 16);

const intOrNull = (v, name, where) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${where}: ${name} must be an integer`);
  return n;
};

function cleanEntities(ev, where) {
  const out = new Map();
  const add = (type, id, entityRole) => {
    if (id == null || String(id) === '') return;
    if (!EVENT_ENTITY_TYPES.includes(type)) throw new Error(`${where}: entity type "${type}" is not allowed`);
    if (!ENTITY_ROLES.includes(entityRole)) throw new Error(`${where}: entity role "${entityRole}" is not allowed`);
    const key = `${type}:${id}`;
    if (!out.has(key)) out.set(key, { entity_type: type, entity_id: String(id), role: entityRole });
  };
  for (const e of ev.entities ?? []) {
    if (!e || typeof e !== 'object') throw new Error(`${where}: entities must be objects {type, id, role}`);
    add(e.type, e.id, e.role ?? 'subject');
  }
  return { out, add };
}

function validate(ev, ingestedAt) {
  const where = `event ${ev?.source}/${ev?.natural_key ?? ev?.source_key}`;
  if (!ev || typeof ev !== 'object') throw new Error('event must be an object');
  if (!isEventType(ev.event_type)) throw new Error(`${where}: event type "${ev.event_type}" is not registered`);
  if (typeof ev.source !== 'string' || !ev.source) throw new Error(`${where}: source is required`);
  const naturalKey = ev.natural_key ?? ev.source_key;
  if (naturalKey == null || String(naturalKey) === '') throw new Error(`${where}: natural_key is required`);
  const provenance = ev.provenance ?? 'captured';
  if (!PROVENANCE.includes(provenance)) throw new Error(`${where}: provenance "${provenance}" is not one of ${PROVENANCE.join('/')}`);
  const payload = { ...(ev.payload ?? {}) };
  if (typeof ev.payload !== 'undefined' && (typeof ev.payload !== 'object' || Array.isArray(ev.payload) || ev.payload === null)) {
    throw new Error(`${where}: payload must be an object`);
  }
  assertNoPrivateKeys(payload, where);

  // Valid time and its quality.
  // No source stamp at all: the capture time, labelled first_seen (never a guess, never dropped).
  const atCapture = (ev.as_of == null || ev.as_of === '') && ev.as_of_quality === 'first_seen';
  if (!atCapture && (ev.as_of == null || ev.as_of === '')) {
    throw new Error(`${where}: as_of is required (or as_of_quality 'first_seen' to stamp the capture time)`);
  }
  let quality = ev.as_of_quality ?? 'exact';
  let asOf;
  if (atCapture) {
    asOf = ingestedAt;
  } else if (typeof ev.as_of === 'string' && BARE_DATE.test(ev.as_of.trim())) {
    asOf = endOfDayEastern(ev.as_of.trim());
    quality = 'date_only';
  } else {
    asOf = normalizeAsOf(ev.as_of);
  }
  if (!AS_OF_QUALITY.includes(quality)) throw new Error(`${where}: as_of_quality "${quality}" is not one of ${AS_OF_QUALITY.join('/')}`);
  if (asOf > ingestedAt) {
    payload.source_as_of = payload.source_as_of ?? asOf;
    asOf = ingestedAt;
    quality = 'clamped';
  }

  const playerId = intOrNull(ev.player_id, 'player_id', where);
  const leagueId = intOrNull(ev.league_id, 'league_id', where) ?? 0;
  const teamId = ev.team_id == null || ev.team_id === '' ? null : String(ev.team_id);
  const { out: entities, add } = cleanEntities(ev, where);
  if (playerId != null) add('player', playerId, 'subject');
  if (leagueId) add('league', leagueId, 'league');
  if (leagueId && teamId != null) add('league_team', `${leagueId}:${teamId}`, 'subject');
  const schemaVersion = intOrNull(ev.schema_version, 'schema_version', where) ?? eventTypeSpec(ev.event_type)?.schema_version ?? 1;
  return {
    event_type: ev.event_type, as_of: asOf, as_of_quality: quality, provenance, league_id: leagueId, team_id: teamId,
    player_id: playerId, source: ev.source, natural_key: String(naturalKey), payload, schema_version: schemaVersion,
    entities: [...entities.values()], hash: hashOf(ev.event_type, payload),
  };
}

/**
 * Append events. Returns { inserted, skipped, events } where `events` are the rows this
 * call added; `skipped` counts events whose payload equals the latest event with the same
 * (source, natural_key). All events are validated before any is written.
 */
export function appendEvents(list, { database = appDb, dispatch = false } = {}) {
  assertWriteRole('appendEvents');
  const ingestedAt = new Date().toISOString();
  const clean = list.map(ev => validate(ev, ingestedAt));
  const latest = database.prepare(`SELECT id, source_key FROM engine_events WHERE source = ? AND natural_key = ?
      ORDER BY id DESC LIMIT 1`);
  const insert = database.prepare(`INSERT INTO engine_events
      (event_type, as_of, as_of_quality, ingested_at, provenance, league_id, team_id, player_id, source, natural_key,
       source_key, payload, schema_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source, source_key) DO NOTHING
      RETURNING id`);
  const insertEntity = database.prepare(`INSERT INTO engine_event_entities (event_id, entity_type, entity_id, role)
      VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`);
  const added = [];
  const own = !database.isTransaction;
  if (own) database.exec('BEGIN IMMEDIATE');
  try {
    for (const e of clean) {
      const prev = latest.get(e.source, e.natural_key);
      // source_key = natural_key:hash:prev_id, so the hash is the second-to-last segment.
      const prevHash = prev ? String(prev.source_key).split(':').at(-2) : null;
      if (prevHash === e.hash) continue;
      const sourceKey = `${e.natural_key}:${e.hash}:${prev ? Number(prev.id) : 0}`;
      const payloadJson = JSON.stringify(e.payload);
      const r = insert.get(e.event_type, e.as_of, e.as_of_quality, ingestedAt, e.provenance, e.league_id, e.team_id,
        e.player_id, e.source, e.natural_key, sourceKey, payloadJson, e.schema_version);
      if (!r) continue;
      const id = Number(r.id);
      for (const ent of e.entities) insertEntity.run(id, ent.entity_type, ent.entity_id, ent.role);
      const { hash, ...rest } = e;
      added.push({ id, ...rest, source_key: sourceKey, ingested_at: ingestedAt });
    }
    if (own) database.exec('COMMIT');
  } catch (error) {
    if (own) database.exec('ROLLBACK');
    throw error;
  }
  const handlerErrors = [];
  if (dispatch) {
    for (const ev of added) {
      for (const h of handlersFor(ev.event_type)) {
        try { h(ev); } catch (error) { handlerErrors.push({ event_id: ev.id, error }); }
      }
    }
  }
  if (handlerErrors.length) {
    const err = new Error(`${handlerErrors.length} onEvent handler(s) threw; the events are committed`);
    err.handlerErrors = handlerErrors;
    err.appended = added;
    throw err;
  }
  return { inserted: added.length, skipped: clean.length - added.length, events: added };
}

/**
 * Expand entity filters ('type:id' strings or {type, id}) to (type, id) pairs; a player
 * filter also matches its alias entities (espn:/gsis:/sleeper: ids on its players row),
 * resolved now, so an alias mapped after the event was written still matches.
 */
function expandEntities(list, database) {
  const pairs = [];
  let playerCols = null;
  for (const item of list) {
    let type; let id;
    if (typeof item === 'string') {
      const cut = item.indexOf(':');
      if (cut <= 0) throw new Error(`entity filter "${item}" must be type:id`);
      type = item.slice(0, cut); id = item.slice(cut + 1);
    } else { type = item?.type; id = item?.id; }
    if (!type || id == null) throw new Error('entity filter needs a type and an id');
    pairs.push([type, String(id)]);
    if (type === 'player') {
      playerCols ??= new Set(database.prepare('PRAGMA table_info(players)').all().map(c => c.name));
      const cols = Object.entries(ALIAS_COLUMNS).filter(([, c]) => playerCols.has(c));
      if (cols.length && /^\d+$/.test(String(id))) {
        const p = database.prepare(`SELECT ${cols.map(([, c]) => c).join(', ')} FROM players WHERE id = ?`).get(Number(id));
        if (p) for (const [alias, c] of cols) if (p[c] != null && p[c] !== '') pairs.push([alias, String(p[c])]);
      }
    }
  }
  return pairs;
}

const rowOut = (r, stripModel) => {
  const payload = JSON.parse(r.payload);
  if (stripModel) delete payload.model;
  return { ...r, id: Number(r.id), payload };
};

/**
 * The as-of event reader. `asOf` is required; only events with as_of <= asOf are
 * returned, oldest first (as_of, id). Filters combine with AND:
 *   afterId (id > afterId: a cursor), from (as_of >= from: a window), leagueId, teamId,
 *   playerId (through engine_event_entities, aliases included), entities, types.
 * A result larger than `limit` THROWS; with `allowTruncated` it returns
 * {events, truncated: true} holding the first `limit` rows instead.
 */
export function getEvents({ asOf, afterId, from, leagueId, teamId, playerId, entities, types, limit = 1000,
  allowTruncated = false, stripModel = false } = {}, database = appDb) {
  if (asOf == null) throw new Error('getEvents needs asOf: an as-of read without a cutoff can see the future');
  const where = ['e.as_of <= ?'];
  const params = [normalizeAsOf(asOf)];
  if (afterId != null) { where.push('e.id > ?'); params.push(Number(afterId)); }
  if (from != null) { where.push('e.as_of >= ?'); params.push(normalizeAsOf(from)); }
  if (leagueId != null) { where.push('e.league_id = ?'); params.push(Number(leagueId)); }
  if (teamId != null) { where.push('e.team_id = ?'); params.push(String(teamId)); }
  const entityFilters = [...(entities ?? []), ...(playerId != null ? [`player:${Number(playerId)}`] : [])];
  if (entityFilters.length) {
    const pairs = expandEntities(entityFilters, database);
    where.push(`e.id IN (SELECT event_id FROM engine_event_entities WHERE ${pairs.map(() => '(entity_type = ? AND entity_id = ?)').join(' OR ')})`);
    for (const [t, i] of pairs) params.push(t, i);
  }
  if (types?.length) { where.push(`e.event_type IN (${types.map(() => '?').join(',')})`); params.push(...types); }
  const lim = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || 1000));
  params.push(lim + 1);
  const found = database.prepare(`SELECT e.id, e.event_type, e.as_of, e.as_of_quality, e.ingested_at, e.provenance,
      e.league_id, e.team_id, e.player_id, e.source, e.natural_key, e.source_key, e.payload, e.schema_version
      FROM engine_events e WHERE ${where.join(' AND ')} ORDER BY e.as_of, e.id LIMIT ?`).all(...params);
  const truncated = found.length > lim;
  if (truncated && !allowTruncated) {
    throw new Error(`getEvents hit its limit of ${lim}: narrow the read (afterId, from, types, entities) or pass allowTruncated`);
  }
  const out = found.slice(0, lim).map(r => rowOut(r, stripModel));
  return allowTruncated ? { events: out, truncated } : out;
}

/** The parties of one event. */
export function eventEntities(eventId, database = appDb) {
  return database.prepare('SELECT entity_type, entity_id, role FROM engine_event_entities WHERE event_id = ? ORDER BY entity_type, entity_id')
    .all(Number(eventId));
}
