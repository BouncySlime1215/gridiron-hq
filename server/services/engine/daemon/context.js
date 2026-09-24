/**
 * The `ctx` a producer's run receives (ENGINE-ARCHITECTURE.md §3.2, §4.1).
 *
 *   ctx.tick        {id, as_of}: every row this run writes is stamped as_of = tick.as_of
 *   ctx.version     the version being run; ctx.lane follows from it (active -> live)
 *   ctx.league      the league id for a heavy (per-league) run, else null
 *   ctx.cut         {event, state}: the input cut taken when the run started
 *   ctx.fit         the producer's fit-store read (its `resolveFit(database)`), taken at
 *                   the start of the run, or null
 *   ctx.read.events({types, leagueId, entities, from, afterId, limit})
 *                   as of the tick, ids <= the cut; `types` must be declared inputs
 *   ctx.read.state(field, entityType, entityId, {leagueId})
 *                   the latest live row of the field's ACTIVE version with id <= the cut,
 *                   never a failed row; the field must be a declared input
 *   ctx.read.latest(field, {leagueId, entityType})
 *                   the same, for every entity of the field at once
 *   ctx.read.graded(field)
 *                   for a producer declaring `inputs.grades: true` only (the grader, §7.2:
 *                   "every graded field, all lanes"): every non-failed row of the field in
 *                   BOTH lanes and every version, id <= the cut, with written_at, plus the
 *                   owner's versions from engine_producers (status, registered_at,
 *                   training_window). It is the one read that is not an as-of read: the
 *                   grader applies each row's own decision-time cut itself.
 *   ctx.monitor     for a producer declaring `inputs.monitor: true` only (the monitor,
 *                   §7.4): every field's health, freshness and the fallback table
 *                   (daemon/monitor-access.js); absent for every other producer
 *   ctx.write(writer, {entityType, entityId, field, value | absence, reasonChain, eventIds,
 *                      stateIds, leagueId})
 *                   writeState with as_of, version, run_id and inputs_health bound here
 * Reading an undeclared field or event type throws: the DAG and the dirty bits are only
 * as good as the declarations. inputs_health is the worst health of every row read.
 */
import { getEvents } from '../events.js';
import { getState, writeState } from '../state.js';
import { producerSpec, fieldSpec } from '../registry.js';
import { worstHealth } from '../health.js';
import { makeMonitorAccess } from './monitor-access.js';

const parseRow = r => ({
  ...r, id: Number(r.id), value: r.value == null ? null : JSON.parse(r.value), reason_chain: JSON.parse(r.reason_chain),
  event_ids: JSON.parse(r.event_ids), health: JSON.parse(r.health),
});

export function activeVersionOf(field) {
  const owner = fieldSpec(field)?.producer;
  return owner ? producerSpec(owner)?.active ?? null : null;
}

export function makeContext({ database, producer, version, lane, tick, cut, league = null, runId, fit = null }) {
  const declaredEvents = new Set(producer.inputs?.events ?? []);
  const declaredFields = new Set(producer.inputs?.fields ?? []);
  const seen = [];
  const counts = { written: 0, unchanged: 0 };
  const note = row => { if (row) seen.push(row.health?.status === 'ok' ? (row.health?.inputs_health ?? 'ok') : row.health?.status); return row; };
  const needField = field => {
    if (!declaredFields.has(field)) throw new Error(`producer ${producer.name} read field ${field}, which it does not declare as an input`);
  };

  const read = {
    events({ types = [...declaredEvents], ...rest } = {}) {
      for (const t of types) {
        if (!declaredEvents.has(t)) throw new Error(`producer ${producer.name} read event type ${t}, which it does not declare as an input`);
      }
      if (!types.length) return [];
      const out = getEvents({ limit: 50000, ...rest, types, asOf: tick.as_of }, database);
      return out.filter(e => e.id <= cut.event);
    },
    state(field, entityType, entityId, { leagueId = null } = {}) {
      needField(field);
      return note(getState(entityType, entityId, field, { asOf: tick.as_of, leagueId, lane: 'live',
        version: activeVersionOf(field), maxId: cut.state }, database));
    },
    latest(field, { leagueId = null, entityType = null } = {}) {
      needField(field);
      const where = ['field = ?', `lane = 'live'`, 'producer_version = ?', 'id <= ?', 'as_of <= ?',
        `json_extract(health, '$.status') <> 'failed'`];
      const params = [field, activeVersionOf(field), cut.state, tick.as_of];
      if (leagueId != null) { where.push('league_id = ?'); params.push(Number(leagueId)); }
      if (entityType != null) { where.push('entity_type = ?'); params.push(entityType); }
      const found = database.prepare(`SELECT * FROM engine_state WHERE id IN (SELECT MAX(id) FROM engine_state
          WHERE ${where.join(' AND ')} GROUP BY entity_type, entity_id, league_id) ORDER BY id`).all(...params);
      return found.map(r => note(parseRow(r)));
    },
    graded(field) {
      if (producer.inputs?.grades !== true) {
        throw new Error(`producer ${producer.name} read every lane of ${field}; only a producer declaring inputs.grades may`);
      }
      const owner = fieldSpec(field)?.producer
        ?? database.prepare('SELECT producer FROM engine_fields WHERE field = ?').get(field)?.producer ?? null;
      if (!owner) return { producer: null, versions: [], rows: [] };
      const versions = database.prepare(`SELECT version, status, registered_at, training_window FROM engine_producers
          WHERE producer = ? ORDER BY version`).all(owner)
        .map(v => ({ ...v, training_window: v.training_window == null ? null : JSON.parse(v.training_window) }));
      const found = database.prepare(`SELECT id, entity_type, entity_id, league_id, field, value, producer, producer_version,
          lane, as_of, written_at FROM engine_state WHERE field = ? AND producer = ? AND id <= ?
          AND json_extract(health, '$.status') <> 'failed' ORDER BY id`).all(field, owner, cut.state)
        .map(r => ({ ...r, id: Number(r.id), value: r.value == null ? null : JSON.parse(r.value) }));
      return { producer: owner, versions, rows: found };
    },
  };

  function write(writer, { entityType, entityId, field, value = null, absence = null, reasonChain, eventIds = [],
    stateIds = [], leagueId = null }) {
    const worst = worstHealth(seen);
    const r = writeState({ entityType, entityId, field, value, absence, asOf: tick.as_of, writer, producerVersion: version,
      lane, reasonChain, eventIds, stateIds, leagueId, runId, inputsHealth: worst === 'failed' ? 'degraded' : worst }, database);
    if (r.written) counts.written += 1; else if (r.unchanged) counts.unchanged += 1;
    return r;
  }

  const monitor = producer.inputs?.monitor === true ? makeMonitorAccess({ database, tick, cut }) : undefined;
  return { ctx: { tick, version, lane, league, cut, fit, read, write, monitor }, counts };
}
