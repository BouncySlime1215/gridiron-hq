/**
 * The engine's one world state: `engine_state` (migration 075).
 *
 * `writeState` is the ONLY writer (test/engine-spine.test.js greps for it). It
 * enforces, at runtime:
 *   - one writer per field: only the writer capability registerField returned may write
 *     (registry.js), or the write throws;
 *   - the reason chain: {contributions:[{source,event_ids,delta,text}]}, present even
 *     when empty, each contribution citing only events the row itself cites;
 *   - as-of safety: every cited event exists and is stamped at or before the row's
 *     as_of, so a state row can never carry information from its own future.
 * Rows are never rewritten: a new value is a new row (the table's triggers refuse
 * UPDATE and DELETE). Writing the same key twice is a no-op, so producers may re-run.
 *
 * `getState` is the as-of reader: the latest row with as_of <= asOf.
 */
import { db as appDb } from '../../db/index.js';
import { fieldSpec, isWriterFor } from './registry.js';
import { normalizeAsOf } from './events.js';

function checkReasonChain(chain, eventIds) {
  if (chain == null || typeof chain !== 'object') {
    throw new Error('reason_chain is required: {contributions:[{source,event_ids,delta,text}]}, empty contributions allowed');
  }
  if (!Array.isArray(chain.contributions)) throw new Error('reason_chain.contributions must be an array');
  const cited = new Set(eventIds);
  return {
    ...chain,
    contributions: chain.contributions.map((c, i) => {
      const at = `reason_chain.contributions[${i}]`;
      if (!c || typeof c.source !== 'string' || !c.source) throw new Error(`${at}.source is required`);
      if (!Array.isArray(c.event_ids) || !c.event_ids.every(Number.isInteger)) {
        throw new Error(`${at}.event_ids must be an array of event ids`);
      }
      for (const id of c.event_ids) {
        if (!cited.has(id)) throw new Error(`${at} cites event ${id}, which is not in event_ids`);
      }
      if (c.delta != null && !Number.isFinite(c.delta)) throw new Error(`${at}.delta must be a number or null`);
      if (typeof c.text !== 'string') throw new Error(`${at}.text must be a string`);
      return { source: c.source, event_ids: c.event_ids, delta: c.delta ?? null, text: c.text };
    }),
  };
}

/**
 * Write one state row. Returns { written: boolean, id } (written=false when the same
 * key already exists).
 */
export function writeState({
  entityType, entityId, field, value, asOf, writer, producerVersion, reasonChain, eventIds = [], leagueId = null,
}, database = appDb) {
  const spec = fieldSpec(field);
  if (!spec) throw new Error(`field ${field} is not registered: register it with its one producer first`);
  if (writer == null) {
    throw new Error(`writeState needs the writer registerField returned for ${field}; a producer name is not a permission`);
  }
  if (!isWriterFor(field, writer)) {
    throw new Error(`one writer per field: ${field} belongs to ${spec.producer}; this writer may not write it`);
  }
  const producer = spec.producer;
  if (spec.entityTypes.length && !spec.entityTypes.includes(entityType)) {
    throw new Error(`field ${field} is declared for ${spec.entityTypes.join('/')}, not ${entityType}`);
  }
  if (typeof entityType !== 'string' || !entityType || entityId == null || String(entityId) === '') {
    throw new Error('entityType and entityId are required');
  }
  if (typeof producerVersion !== 'string' || !producerVersion) throw new Error('producerVersion is required');
  if (!Array.isArray(eventIds) || !eventIds.every(Number.isInteger)) throw new Error('event_ids must be integers');
  const chain = checkReasonChain(reasonChain, eventIds);
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

  const r = database.prepare(`INSERT INTO engine_state
      (entity_type, entity_id, league_id, field, value, as_of, producer, producer_version, reason_chain, event_ids, written_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING RETURNING id`)
    .get(entityType, String(entityId), leagueId == null ? null : Number(leagueId), field,
      value === undefined ? null : JSON.stringify(value), at, producer, producerVersion,
      JSON.stringify(chain), JSON.stringify(eventIds), new Date().toISOString());
  return { written: !!r, id: r ? Number(r.id) : null };
}

/**
 * The as-of state reader: the latest row for (entity, field, league) with
 * as_of <= asOf, or null. `asOf` defaults to now. `leagueId` null reads global rows.
 */
export function getState(entityType, entityId, field, { asOf = new Date(), leagueId = null } = {}, database = appDb) {
  const r = database.prepare(`SELECT entity_type, entity_id, league_id, field, value, as_of, producer, producer_version,
      reason_chain, event_ids, written_at FROM engine_state
      WHERE entity_type = ? AND entity_id = ? AND field = ? AND COALESCE(league_id, -1) = ? AND as_of <= ?
      ORDER BY as_of DESC, id DESC LIMIT 1`)
    .get(entityType, String(entityId), field, leagueId == null ? -1 : Number(leagueId), normalizeAsOf(asOf));
  if (!r) return null;
  return {
    ...r,
    value: r.value == null ? null : JSON.parse(r.value),
    reason_chain: JSON.parse(r.reason_chain),
    event_ids: JSON.parse(r.event_ids),
  };
}
