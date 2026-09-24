/**
 * The engine's registries and its event hook (ENGINE-ARCHITECTURE.md §2.4-2.5, §4.1, §4.5).
 *
 * EVENT TYPES. `engine_events.event_type` is an open string, but a type must be
 * registered before anything may append it, so a typo is a thrown error rather than a
 * stream no reader ever finds. Later stages register their own types from their modules.
 *
 * FIELDS. Every `engine_state.field` has exactly ONE producer, enforced three ways:
 *   1. here, at runtime: the FIRST registration returns the field's writer, an opaque
 *      capability object, and `writeState` (state.js) accepts only that object, compared
 *      by identity; a second producer's claim throws;
 *   2. in the database: `writeState` stores the spec in `engine_fields` (fields.js) and a
 *      BEFORE INSERT trigger refuses any engine_state row whose producer is not the field's;
 *   3. by grep: test/engine-spine.test.js checks each field is declared once, with a
 *      literal name, and that no writer is ever exported.
 * The in-memory maps are per process; the web process registers nothing and reads specs
 * from `engine_fields` (routes/engine.js).
 *
 * `registerField(field, spec)` claims one field for a single-version producer (the #216
 * API, kept for LIVING-01a / TELLS-01a). `registerProducer({...})` declares a producer
 * with its versions (one active -> lane `live`, the rest shadow -> lane `shadow`), its
 * fields and inputs, and returns {field: writer}. A producer cannot pick its own lane:
 * the lane follows from the version it writes (`laneFor`).
 *
 * Field spec (ENGINE-ARCHITECTURE §2.4, §2.9): valueType ('number' | 'prob' | 'model' |
 * 'dist' | 'state' | 'object'), space ('pts' | 'logit' | 'prob' | 'pp' | null),
 * entityTypes, maxAgeSec, tolerance (write-on-change), fallbackField, checks (health.js
 * ids), replaces (legacy functions the field retires), description.
 *
 * onEvent. The hook later learners attach to. `appendEvents` calls handlers only when
 * asked (`dispatch: true`); the daemon, not the appender, drives producers.
 */
import crypto from 'node:crypto';
import { assertCheckIds } from './health.js';

const eventTypes = new Map();
const fields = new Map();
const writers = new Map(); // field -> the one writer capability handed out
const producers = new Map(); // producer -> { name, active, shadow:Set, versions:{v: meta}, inputs }
const handlers = new Map();

const NAME = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
export const VALUE_TYPES = Object.freeze(['number', 'prob', 'model', 'dist', 'state', 'object']);
export const SPACES = Object.freeze(['pts', 'logit', 'prob', 'pp']);

function checkName(kind, name) {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new Error(`${kind} "${name}" must be a dotted lower-case name like "espn.transaction"`);
  }
}

export function registerEventType(type, { description = '', schema_version = 1, payload_keys = null } = {}) {
  checkName('event type', type);
  if (!eventTypes.has(type)) eventTypes.set(type, Object.freeze({ type, description, schema_version, payload_keys }));
  return eventTypes.get(type);
}

export function isEventType(type) {
  return eventTypes.has(type);
}

export function eventTypeSpec(type) {
  return eventTypes.get(type) ?? null;
}

export function listEventTypes() {
  return [...eventTypes.values()];
}

/* -------------------------------------------------------------------- fields */

function stableJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
}

function normalizeSpec(field, producer, s) {
  const valueType = s.valueType ?? 'object';
  if (!VALUE_TYPES.includes(valueType)) throw new Error(`field ${field}: valueType "${valueType}" is not one of ${VALUE_TYPES.join('/')}`);
  const space = s.space ?? null;
  if (space != null && !SPACES.includes(space)) throw new Error(`field ${field}: space "${space}" is not one of ${SPACES.join('/')}`);
  const checks = [...(s.checks ?? [])];
  assertCheckIds(checks);
  const tolerance = s.tolerance ?? 0;
  if (!(Number.isFinite(tolerance) && tolerance >= 0)) throw new Error(`field ${field}: tolerance must be a number >= 0`);
  const maxAgeSec = s.maxAgeSec ?? null;
  if (maxAgeSec != null && !(Number.isInteger(maxAgeSec) && maxAgeSec > 0)) throw new Error(`field ${field}: maxAgeSec must be a positive integer`);
  if (s.fallbackField != null) checkName('fallbackField', s.fallbackField);
  return Object.freeze({
    field, producer, valueType, space,
    entityTypes: Object.freeze([...(s.entityTypes ?? [])]),
    maxAgeSec, tolerance, fallbackField: s.fallbackField ?? null,
    checks: Object.freeze(checks), replaces: Object.freeze([...(s.replaces ?? [])]),
    description: s.description ?? '',
  });
}

function declareProducer(name, { active, versions, shadow = [], inputs = {} }) {
  const existing = producers.get(name);
  const shadowSet = new Set(shadow.map(String));
  const vs = Object.fromEntries(Object.entries(versions).map(([v, meta]) => {
    const params = meta?.params ?? null;
    return [String(v), Object.freeze({
      version: String(v),
      params_hash: crypto.createHash('sha256').update(stableJson({ params, fit_id: meta?.fitId ?? null })).digest('hex'),
      fit_ref: meta?.fit_ref ?? null,
      training_window: meta?.training_window ?? null,
      prereg_ref: meta?.prereg_ref ?? null,
    })];
  }));
  if (!vs[String(active)]) throw new Error(`producer ${name}: active version "${active}" is not among its versions`);
  for (const v of shadowSet) {
    if (!vs[v]) throw new Error(`producer ${name}: shadow version "${v}" is not among its versions`);
    if (v === String(active)) throw new Error(`producer ${name}: version "${v}" cannot be both active and shadow`);
  }
  if (existing) {
    if (existing.active !== String(active)) {
      throw new Error(`producer ${name} is already registered with active version ${existing.active}, not ${active}`);
    }
    return existing;
  }
  const p = { name, active: String(active), shadow: shadowSet, versions: vs, inputs, fields: new Set() };
  producers.set(name, p);
  return p;
}

function claim(field, producer, s) {
  checkName('field', field);
  const existing = fields.get(field);
  if (existing) {
    if (existing.producer !== producer) {
      throw new Error(`field ${field} already has its one producer ${existing.producer}; ${producer} may not claim it`);
    }
    return null;
  }
  const spec = normalizeSpec(field, producer, s);
  fields.set(field, spec);
  producers.get(producer).fields.add(field);
  const writer = Object.freeze({ field, producer });
  writers.set(field, writer);
  return writer;
}

/**
 * Claim a state field for one single-version producer. Returns the field's writer
 * capability on the first claim. Re-registering by the same producer does not throw (a
 * module imported twice) but returns null: the writer is handed out once. Any other
 * producer throws. Keep the returned writer in a module-private const; never export it.
 */
export function registerField(field, { producer, version, ...spec } = {}) {
  checkName('field', field);
  if (typeof producer !== 'string' || !producer) throw new Error(`field ${field}: producer is required`);
  if (typeof version !== 'string' || !version) throw new Error(`field ${field}: version is required`);
  const owner = fields.get(field);
  if (owner && owner.producer !== producer) {
    throw new Error(`field ${field} already has its one producer ${owner.producer}; ${producer} may not claim it`);
  }
  const p = producers.get(producer);
  if (!p) declareProducer(producer, { active: version, versions: { [version]: {} } });
  else if (!p.versions[version]) throw new Error(`field ${field}: producer ${producer} has no version ${version}`);
  return claim(field, producer, spec);
}

/**
 * Declare a producer: its versions (`active` runs in lane live, each of `shadow` in lane
 * shadow), the fields it owns and its inputs. Returns a frozen {field: writer} map, with
 * null for a field this producer had already claimed (a module imported twice). Keep it in
 * a module-private const; never export it.
 */
export function registerProducer({ name, active, versions, shadow = [], fields: fieldList = [], inputs = {} } = {}) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_.-]*$/.test(name)) throw new Error(`producer name "${name}" is invalid`);
  if (!versions || typeof versions !== 'object' || !Object.keys(versions).length) throw new Error(`producer ${name}: versions are required`);
  if (!Array.isArray(fieldList) || !fieldList.length) throw new Error(`producer ${name}: at least one field is required`);
  for (const f of fieldList) {
    const owner = fields.get(f?.field);
    if (owner && owner.producer !== name) {
      throw new Error(`field ${f.field} already has its one producer ${owner.producer}; ${name} may not claim it`);
    }
  }
  declareProducer(name, { active, versions, shadow, inputs });
  return Object.freeze(Object.fromEntries(fieldList.map(({ field, ...spec }) => [field, claim(field, name, spec)])));
}

/** True only for the exact object registerField/registerProducer returned for this field. */
export function isWriterFor(field, writer) {
  return writer != null && writers.get(field) === writer;
}

/** The registered spec for a field in this process, or null. */
export function fieldSpec(field) {
  return fields.get(field) ?? null;
}

export function listFields() {
  return [...fields.values()];
}

/** A producer's declaration in this process, or null. */
export function producerSpec(name) {
  const p = producers.get(name);
  if (!p) return null;
  return { name: p.name, active: p.active, shadow: [...p.shadow], versions: p.versions, inputs: p.inputs, fields: [...p.fields] };
}

/** The lane a producer version writes to: its active version -> live, a shadow version -> shadow. */
export function laneFor(producer, version) {
  const p = producers.get(producer);
  if (!p) throw new Error(`producer ${producer} is not registered`);
  if (String(version) === p.active) return 'live';
  if (p.shadow.has(String(version))) return 'shadow';
  throw new Error(`producer ${producer} has no active or shadow version "${version}"`);
}

/* -------------------------------------------------------------------- onEvent */

/**
 * Subscribe to new events of one type, or '*' for all. Returns an unsubscribe function.
 * Handlers run only when appendEvents is called with dispatch:true; each handler's error
 * is collected so one broken handler cannot stop delivery to the others.
 */
export function onEvent(type, handler) {
  if (typeof handler !== 'function') throw new Error('onEvent needs a handler function');
  if (type !== '*') checkName('event type', type);
  const set = handlers.get(type) ?? new Set();
  set.add(handler);
  handlers.set(type, set);
  return () => set.delete(handler);
}

export function handlersFor(type) {
  return [...(handlers.get(type) ?? []), ...(handlers.get('*') ?? [])];
}

/* ------------------------------------------------ the spine's own registrations */

/** Event types the backfill adapters append (backfill.js). */
export const SPINE_EVENT_TYPES = Object.freeze({
  'espn.transaction': 'An ESPN league transaction status row (waiver, free agent, trade), from league_transactions_raw',
  'league.lineup': "A fantasy team's lineup slot for one player in one scoring period, from league_roster_snapshots",
  'news.item': 'A news item with its resolved player ids (headline only, no body), from news_items',
  'news.ingested': 'A news_items row first received, at its receipt time (ingested_at, else created_at) (BROKEN-Q, flagged)',
  'news.edited': 'A news_items revision, at its edited_at, headline only (BROKEN-Q, flagged)',
  'market.game_line': 'A game spread/total/implied points as captured, from game_lines',
  'nfl.injury': 'An official NFL injury report line, from nfl_injuries',
  'trade.proposed': 'A trade proposal recorded in trade_outcomes (model outputs under payload.model)',
  'trade.considered': 'A trade the app considered and did not propose, recorded in trade_outcomes',
  'trade.resolved': 'A trade resolution (accepted, declined, ...) recorded in trade_outcomes',
  'manager.signal': 'A per-fantasy-team count or rate from manager_signals (every source; counts only, no names or text)',
  'source.coverage': 'A collector run as recorded in sync_log: a window without one is unknown, never zero',
});
for (const [type, description] of Object.entries(SPINE_EVENT_TYPES)) registerEventType(type, { description });
// The spine's own field engine.ingest is registered in backfill.js, its one writer,
// so the writer capability never has to leave that module.
