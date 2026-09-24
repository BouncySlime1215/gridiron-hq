/**
 * The engine's one world state: `engine_state` (migration 075; ENGINE-ARCHITECTURE.md
 * §2.3, §2.9-2.11, §4.3 step 4).
 *
 * `writeState` is the ONLY writer (test/engine-spine.test.js greps for it). It enforces:
 *   - the role guard: refused unless the process role is engine/script/test (role.js);
 *   - one writer per field: only the capability registerField/registerProducer returned
 *     may write; the spec is stored in engine_fields, whose trigger refuses any other
 *     producer even from raw SQL;
 *   - version and lane: the version must be one the producer declared; the lane follows
 *     from it (active -> live, shadow -> shadow); a caller cannot pick another lane;
 *   - the entity key grammar (ENTITY_KEYS): registered entity types, well-formed ids, a
 *     league-scoped key's league_id equal to its id prefix, and points-space fields keyed
 *     by player_week_scored (a scoring key), never player_week;
 *   - the reason chain v2 {v, additive, space, baseline, contributions[{source, kind,
 *     event_ids, state_ids, delta, weight, text}], residual, n}: every cited id is the
 *     row's own and none is from the row's future; when additive, baseline + sum(delta) +
 *     residual equals the value IN THE DECLARED SPACE (log-odds for a logit-space
 *     probability; the mean for a dist). A legacy {contributions} chain is stored as a
 *     non-additive v2 chain;
 *   - health (HEALTH-01a): the field's checks run on every row; a failed row is WRITTEN
 *     (kept for the audit) with health.status='failed' and never served by getState;
 *     inputsHealth ('ok' | 'thin' | 'degraded') is recorded, and 'degraded' inputs make the
 *     row degraded;
 *   - write-on-change: a value equal (within the field's tolerance) to the latest row of the
 *     same key, lane and version, with the same chain, writes nothing ({unchanged: true}).
 * Rows are never rewritten (triggers refuse UPDATE and DELETE). The same key twice is a no-op.
 *
 * `getState` is the as-of reader: the latest row (by id, the transaction clock) with
 * as_of <= asOf and id <= maxId, in lane `live` unless asked, never a failed row.
 * `readServed` (HEALTH-01b) is what pages and Coach read: the value plus its health, and
 * for a failed or degraded field the declared fallback or last good row, labelled.
 */
import { db as appDb } from '../../db/index.js';
import { fieldSpec, isWriterFor, laneFor, producerSpec } from './registry.js';
import { normalizeAsOf } from './events.js';
import { assertWriteRole } from './role.js';
import { runChecks } from './health.js';
import { storeFieldSpec, readFieldSpec } from './fields.js';

/* ------------------------------------------------------------ key grammar */
const INT = '\\d+';
const SEASON = '\\d{4}';
const WEEK = '\\d{1,2}';
const HEX = '[0-9a-f]{8,64}';
const TEAM = '[A-Z]{2,4}';
const ROSTER = '[A-Za-z0-9_-]+';
const k = (re, leagueScoped = false) => Object.freeze({ re: new RegExp(`^${re}$`), leagueScoped });
/** Entity key grammar (ENGINE-ARCHITECTURE §2.11). leagueScoped keys start with their league id. */
export const ENTITY_KEYS = Object.freeze({
  player: k(INT),
  player_week: k(`${INT}:${SEASON}:${WEEK}`),
  player_week_scored: k(`${INT}:${SEASON}:${WEEK}:${HEX}`),
  nfl_team: k(TEAM),
  game: k(`${SEASON}:${WEEK}:${TEAM}`),
  week: k(`${SEASON}:${WEEK}`),
  league: k(`(${INT})`, true),
  league_week: k(`(${INT}):${SEASON}:${WEEK}`, true),
  league_team: k(`(${INT}):${ROSTER}`, true),
  league_team_week: k(`(${INT}):${ROSTER}:${SEASON}:${WEEK}`, true),
  matchup: k(`(${INT}):${SEASON}:${WEEK}:${ROSTER}:${ROSTER}`, true),
  deal: k(`(${INT}):${HEX}`, true),
  offer: k(INT),
  rec: k(INT),
  hypothesis: k(HEX),
  producer: k('[a-z0-9][a-z0-9_.-]*@[A-Za-z0-9_.-]+'),
  engine: k('(events|daemon|jev)'),
});

export function isLeagueScoped(entityType) {
  return !!ENTITY_KEYS[entityType]?.leagueScoped;
}

/** Throws unless (entityType, entityId, leagueId) follows the grammar. Returns the league id to store (0 = global). */
export function checkEntityKey(entityType, entityId, leagueId) {
  const g = ENTITY_KEYS[entityType];
  if (!g) throw new Error(`entity type "${entityType}" is not registered (ENTITY_KEYS)`);
  const id = String(entityId ?? '');
  const m = g.re.exec(id);
  if (!m) throw new Error(`entity key ${entityType}:${id} does not follow the ${entityType} key grammar`);
  const league = leagueId == null ? 0 : Number(leagueId);
  if (!Number.isInteger(league) || league < 0) throw new Error('leagueId must be a non-negative integer');
  if (g.leagueScoped && String(league) !== m[1]) {
    throw new Error(`${entityType}:${id} is league-scoped: its league_id must be ${m[1]}, got ${leagueId ?? 'none'}`);
  }
  if (entityType === 'matchup') {
    const [, , , a, b] = id.split(':');
    if (!(a < b)) throw new Error(`matchup ${id}: the two teams must be in order (a < b)`);
  }
  return league;
}

/* ------------------------------------------------------------ reason chain */
const KINDS = ['event', 'state', 'model', 'prior', 'monitor', 'blend', 'rescore'];
const logit = p => Math.log(p / (1 - p));

/** The number an additive chain must sum to, in the chain's space. */
function targetInSpace(value, space, valueType) {
  let v = value;
  if (valueType === 'dist' || (v && typeof v === 'object' && Number.isFinite(v.mean))) v = v?.mean;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error('an additive reason chain needs a numeric value (or a dist with a mean)');
  }
  if (space === 'logit') {
    if (!(v > 0 && v < 1)) throw new Error(`a logit-space chain needs a probability in (0, 1), got ${v}`);
    return logit(v);
  }
  return v;
}

function checkIds(list, at, what) {
  if (list == null) return [];
  if (!Array.isArray(list) || !list.every(Number.isInteger)) throw new Error(`${at}.${what} must be an array of ids`);
  return list;
}

function checkReasonChain(chain, { eventIds, stateIds, value, spec }) {
  if (chain == null || typeof chain !== 'object') {
    throw new Error('reason_chain is required: {v:2, contributions:[{source,event_ids,delta,text}], ...}, empty contributions allowed');
  }
  if (!Array.isArray(chain.contributions)) throw new Error('reason_chain.contributions must be an array');
  const citedEvents = new Set(eventIds);
  const citedStates = new Set(stateIds);
  const additive = chain.additive === true;
  const space = chain.space ?? spec.space ?? null;
  if (chain.space != null && spec.space != null && chain.space !== spec.space) {
    throw new Error(`reason_chain.space "${chain.space}" differs from the field's declared space "${spec.space}"`);
  }
  const contributions = chain.contributions.map((c, i) => {
    const at = `reason_chain.contributions[${i}]`;
    if (!c || typeof c.source !== 'string' || !c.source) throw new Error(`${at}.source is required`);
    if (!Array.isArray(c.event_ids) || !c.event_ids.every(Number.isInteger)) throw new Error(`${at}.event_ids must be an array of event ids`);
    for (const id of c.event_ids) if (!citedEvents.has(id)) throw new Error(`${at} cites event ${id}, which is not in event_ids`);
    const sids = checkIds(c.state_ids, at, 'state_ids');
    for (const id of sids) if (!citedStates.has(id)) throw new Error(`${at} cites state row ${id}, which is not in stateIds`);
    if (c.delta != null && !Number.isFinite(c.delta)) throw new Error(`${at}.delta must be a number or null`);
    if (c.weight != null && !Number.isFinite(c.weight)) throw new Error(`${at}.weight must be a number or null`);
    if (c.kind != null && !KINDS.includes(c.kind)) throw new Error(`${at}.kind must be one of ${KINDS.join('/')}`);
    if (typeof c.text !== 'string') throw new Error(`${at}.text must be a string`);
    return { source: c.source, kind: c.kind ?? null, event_ids: c.event_ids, state_ids: sids, delta: c.delta ?? null,
      weight: c.weight ?? null, text: c.text };
  });
  const baseline = chain.baseline == null ? null : {
    value: chain.baseline.value ?? null, source: chain.baseline.source ?? null, text: chain.baseline.text ?? '',
  };
  if (baseline?.value != null && !Number.isFinite(baseline.value)) throw new Error('reason_chain.baseline.value must be a number');
  const residual = chain.residual ?? null;
  if (residual != null && !Number.isFinite(residual)) throw new Error('reason_chain.residual must be a number or null');
  if (additive) {
    if (space == null) throw new Error('an additive reason chain must declare its space');
    if (baseline?.value == null) throw new Error('an additive reason chain needs baseline.value');
    if (contributions.some(c => c.delta == null)) throw new Error('an additive reason chain needs a delta on every contribution');
    const total = baseline.value + contributions.reduce((a, c) => a + c.delta, 0) + (residual ?? 0);
    const target = targetInSpace(value, space, spec.valueType);
    if (!(Math.abs(total - target) <= 1e-6)) {
      throw new Error(`reason chain is not additive: baseline + sum(delta) + residual = ${total}, the value is ${target} in ${space} space`);
    }
  }
  const n = chain.n ?? null;
  return { v: 2, additive, space, baseline, contributions, residual, n };
}

/* ------------------------------------------------------------ write-on-change */
function sameWithin(a, b, tol) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= tol;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a); const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(key => Object.hasOwn(b, key) && sameWithin(a[key], b[key], tol));
}

const ABSENCE = ['unknown', 'not_measured', 'zero'];
const INPUTS_HEALTH = ['ok', 'thin', 'degraded'];

/**
 * Write one state row. Returns { written, unchanged, id, lane, health }: written=false with
 * unchanged=true when write-on-change found the same value; written=false, unchanged=false
 * when the exact key already exists (an idempotent re-run).
 * `absence` ({status: unknown|not_measured|zero, reason}) is required when value is null.
 */
export function writeState({
  entityType, entityId, field, value, absence = null, asOf, writer, producerVersion, lane, reasonChain,
  eventIds = [], stateIds = [], leagueId = null, runId = null, inputsHealth = 'ok',
}, database = appDb) {
  assertWriteRole('writeState');
  const spec = fieldSpec(field);
  if (!spec) throw new Error(`field ${field} is not registered: register it with its one producer first`);
  if (writer == null) {
    throw new Error(`writeState needs the writer registerField returned for ${field}; a producer name is not a permission`);
  }
  if (!isWriterFor(field, writer)) {
    throw new Error(`one writer per field: ${field} belongs to ${spec.producer}; this writer may not write it`);
  }
  const producer = spec.producer;
  if (typeof producerVersion !== 'string' || !producerVersion) throw new Error('producerVersion is required');
  const rowLane = laneFor(producer, producerVersion);
  if (lane != null && lane !== rowLane) {
    throw new Error(`lane: version ${producerVersion} of ${producer} writes lane ${rowLane}; a producer cannot pick its lane`);
  }
  if (typeof entityType !== 'string' || !entityType || entityId == null || String(entityId) === '') {
    throw new Error('entityType and entityId are required');
  }
  if (spec.entityTypes.length && !spec.entityTypes.includes(entityType)) {
    throw new Error(`field ${field} is declared for ${spec.entityTypes.join('/')}, not ${entityType}`);
  }
  const league = checkEntityKey(entityType, entityId, leagueId);
  if (spec.space === 'pts' && entityType === 'player_week') {
    throw new Error(`field ${field} is in points space: key it by player_week_scored (with the league's scoring key), not player_week`);
  }
  if (!Array.isArray(eventIds) || !eventIds.every(Number.isInteger)) throw new Error('event_ids must be integers');
  if (!Array.isArray(stateIds) || !stateIds.every(Number.isInteger)) throw new Error('stateIds must be integers');
  if (!INPUTS_HEALTH.includes(inputsHealth)) throw new Error(`inputsHealth must be one of ${INPUTS_HEALTH.join('/')}`);
  const isAbsent = value === null || value === undefined;
  if (isAbsent) {
    if (!absence || !ABSENCE.includes(absence.status) || typeof absence.reason !== 'string' || !absence.reason) {
      throw new Error(`a null value needs absence {status: ${ABSENCE.join('|')}, reason}: absence is typed, never a default`);
    }
  } else if (absence != null) {
    throw new Error('absence is only for a null value');
  }
  const chain = checkReasonChain(reasonChain, { eventIds, stateIds, value, spec });
  const at = normalizeAsOf(asOf);

  if (eventIds.length) {
    const found = database.prepare(`SELECT id, as_of FROM engine_events WHERE id IN (${eventIds.map(() => '?').join(',')})`)
      .all(...eventIds);
    const byId = new Map(found.map(r => [Number(r.id), r.as_of]));
    for (const id of eventIds) {
      if (!byId.has(id)) throw new Error(`state row cites unknown event ${id}`);
      if (byId.get(id) > at) {
        throw new Error(`state row as of ${at} cites event ${id} stamped ${byId.get(id)}, after the row: future leak`);
      }
    }
  }
  if (stateIds.length) {
    const found = database.prepare(`SELECT id, as_of FROM engine_state WHERE id IN (${stateIds.map(() => '?').join(',')})`)
      .all(...stateIds);
    const byId = new Map(found.map(r => [Number(r.id), r.as_of]));
    for (const id of stateIds) {
      if (!byId.has(id)) throw new Error(`state row cites unknown state row ${id}`);
      if (byId.get(id) > at) throw new Error(`state row as of ${at} cites state row ${id} stamped ${byId.get(id)}: future leak`);
    }
  }
  if (runId != null) {
    if (!Number.isInteger(runId) || !database.prepare('SELECT 1 FROM engine_runs WHERE id = ?').get(runId)) {
      throw new Error(`run_id ${runId} is not an engine_runs row`);
    }
  }

  const checked = runChecks(isAbsent ? null : value, spec.checks);
  const health = {
    status: checked.status === 'failed' ? 'failed' : inputsHealth === 'degraded' ? 'degraded' : 'ok',
    checks: checked.checks,
    inputs_health: inputsHealth,
    ...(isAbsent ? { absence: { status: absence.status, reason: absence.reason } } : {}),
  };
  const storedValue = isAbsent ? null : value;

  const latest = database.prepare(`SELECT id, value, reason_chain, health FROM engine_state
      WHERE entity_type = ? AND entity_id = ? AND field = ? AND league_id = ? AND lane = ? AND producer_version = ?
      ORDER BY id DESC LIMIT 1`).get(entityType, String(entityId), field, league, rowLane, producerVersion);
  if (latest && health.status !== 'failed') {
    const prevValue = latest.value == null ? null : JSON.parse(latest.value);
    const prevHealth = JSON.parse(latest.health);
    if (prevHealth.status === health.status && sameWithin(prevValue, storedValue, spec.tolerance)
      && latest.reason_chain === JSON.stringify(chain)
      && JSON.stringify(prevHealth.absence ?? null) === JSON.stringify(health.absence ?? null)) {
      return { written: false, unchanged: true, id: Number(latest.id), lane: rowLane, health };
    }
  }

  storeFieldSpec(spec, producerSpec(producer), database);
  const r = database.prepare(`INSERT INTO engine_state
      (entity_type, entity_id, league_id, field, value, as_of, producer, producer_version, lane, reason_chain, event_ids,
       health, run_id, written_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING RETURNING id`)
    .get(entityType, String(entityId), league, field, isAbsent ? null : JSON.stringify(storedValue), at, producer,
      producerVersion, rowLane, JSON.stringify(chain), JSON.stringify(eventIds), JSON.stringify(health), runId,
      new Date().toISOString());
  return { written: !!r, unchanged: false, id: r ? Number(r.id) : null, lane: rowLane, health };
}

const parseRow = r => ({
  ...r,
  id: Number(r.id),
  value: r.value == null ? null : JSON.parse(r.value),
  reason_chain: JSON.parse(r.reason_chain),
  event_ids: JSON.parse(r.event_ids),
  health: JSON.parse(r.health),
});

/**
 * The as-of state reader: the latest row (by id) for (entity, field, league, lane) with
 * as_of <= asOf and id <= maxId, skipping failed rows, or null. `asOf` defaults to now;
 * `leagueId` null reads global rows (league_id 0); `lane` defaults to 'live' (a shadow
 * row is never served by default); `version` pins one producer version.
 */
export function getState(entityType, entityId, field, {
  asOf = new Date(), leagueId = null, lane = 'live', version = null, maxId = null, includeFailed = false, okOnly = false,
} = {}, database = appDb) {
  const where = ['entity_type = ?', 'entity_id = ?', 'field = ?', 'league_id = ?', 'lane = ?', 'as_of <= ?'];
  const params = [entityType, String(entityId), field, leagueId == null ? 0 : Number(leagueId), lane, normalizeAsOf(asOf)];
  if (version != null) { where.push('producer_version = ?'); params.push(String(version)); }
  if (maxId != null) { where.push('id <= ?'); params.push(Number(maxId)); }
  if (okOnly) where.push(`json_extract(health, '$.status') = 'ok'`);
  else if (!includeFailed) where.push(`json_extract(health, '$.status') <> 'failed'`);
  const r = database.prepare(`SELECT id, entity_type, entity_id, league_id, field, value, as_of, producer, producer_version,
      lane, reason_chain, event_ids, health, run_id, written_at FROM engine_state
      WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 1`).get(...params);
  return r ? parseRow(r) : null;
}

/** Why a row is not served as itself. Names the failed check ids, never the failed value. */
function problemReason(field, row) {
  if (row.health?.status === 'failed') {
    const ids = (row.health.checks ?? []).filter(c => !c.passed).map(c => c.id);
    return `${field} failed its checks (${ids.join(', ') || 'unnamed'})`;
  }
  return `${field} was built on degraded inputs`;
}

/**
 * HEALTH-01b, fallback never fake: what a reader (a page, Coach) is allowed to show for one
 * field. Returns {field, status, value, row, health, fallback_used, fallback, reason}:
 *   ok        the latest row is healthy: it is served as itself, fallback_used=false;
 *   fallback  the latest row failed or is degraded: the field's declared fallbackField row
 *             (healthy) is served, else the field's last healthy row; fallback_used=true,
 *             `fallback` = {kind: 'field'|'last_good', field, row_id, as_of}, `reason` says why;
 *   degraded  degraded with nothing healthy to fall back to: the degraded value, labelled;
 *   failed    failed with nothing healthy to fall back to: value null, never the failed value;
 *   unknown   no row as of then, or the field has no stored spec.
 * The failed row's value is never returned: not as the value, not in `reason`, not in the
 * check details (the audit keeps those in engine_state).
 *
 * `pin` (EA-03 views, #257; RULINGS 3) reads the same rule at a snapshot's cut:
 * `{ maxId, versionFor(field) }` pins every read (the field, its fallback, its last good
 * row) to id <= maxId and that field's producer version. A field whose producer has no
 * version in the pin has no row. Without `pin` nothing changes.
 */
export function readServed(entityType, entityId, field, {
  asOf = new Date(), leagueId = null, lane = 'live', pin = null,
} = {}, database = appDb) {
  const opts = { asOf, leagueId, lane };
  const read = (f, extra) => {
    if (!pin) return getState(entityType, entityId, f, { ...opts, ...extra }, database);
    const version = pin.versionFor ? pin.versionFor(f) : null;
    if (pin.versionFor && version == null) return null;
    return getState(entityType, entityId, f, { ...opts, ...extra, maxId: pin.maxId ?? null, version }, database);
  };
  const base = { field, status: 'unknown', value: null, row: null, health: null, fallback_used: false, fallback: null };
  const spec = readFieldSpec(field, database);
  if (!spec) return { ...base, reason: 'field_not_registered' };
  const latest = read(field, { includeFailed: true });
  if (!latest) return { ...base, reason: 'no_row_as_of' };
  const status = latest.health?.status ?? 'ok';
  if (status === 'ok') return { ...base, status: 'ok', value: latest.value, row: latest, health: latest.health, reason: null };

  const why = problemReason(field, latest);
  // The problem row's health without check details: a failed check's detail quotes the failed value.
  const checks = (latest.health?.checks ?? []).map(c => ({ id: c.id, passed: c.passed }));
  const problem = { ...base, health: { ...latest.health, checks } };
  const serve = (kind, row, text) => ({
    ...problem, status: 'fallback', value: row.value, row, fallback_used: true,
    fallback: { kind, field: row.field, row_id: row.id, as_of: row.as_of }, reason: `${why}; ${text}`,
  });
  if (spec.fallbackField) {
    const fb = read(spec.fallbackField, { okOnly: true });
    if (fb) return serve('field', fb, `serving its fallback ${spec.fallbackField}`);
  }
  const good = read(field, { okOnly: true });
  if (good) return serve('last_good', good, `serving the last good row, as of ${good.as_of}`);
  if (status === 'degraded') {
    return { ...problem, status: 'degraded', value: latest.value, row: latest,
      reason: `${why}; no fallback or healthy row, served labelled degraded` };
  }
  return { ...problem, status: 'failed', reason: `${why}; no fallback or healthy row to serve` };
}
