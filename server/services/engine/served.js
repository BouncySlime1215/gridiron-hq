/**
 * The served read: a field's value with the monitor's fallback applied (ENGINE-ARCHITECTURE
 * §7.4; ENGINE-00b-b RED (3); cloud unit EA-06).
 *
 * getState answers "the latest row"; readServed answers "what a page may show". When the
 * field has an engine_fallback row in force (written only by the monitor producer):
 *   1. the fallback field's row for the same entity, when it has one (kind 'field');
 *   2. else the field's own row as of the last healthy snapshot the monitor recorded
 *      (`health.monitor.healthy_snapshot_id`: getState with that snapshot's max_state_id)
 *      (kind 'snapshot');
 *   3. else a typed absence (kind 'none'): never the drifted value.
 * The served chain starts with a `health_monitor` contribution naming the reason, so the
 * fallback is labelled wherever the chain is shown. Failed rows are never served (getState).
 * Returns {value, row, health, reason_chain, fallback_used, fallback: {kind, field,
 * snapshot_id, reason, since, n} | null, absence}.
 */
import { db as appDb } from '../../db/index.js';
import { getState } from './state.js';
import { readFallback } from './fields.js';

export function readServed(entityType, entityId, field, { asOf = new Date(), leagueId = null } = {}, database = appDb) {
  const fb = readFallback(field, leagueId ?? 0, database);
  if (!fb) {
    const own = getState(entityType, entityId, field, { asOf, leagueId }, database);
    return { value: own?.value ?? null, row: own, health: own?.health ?? null, reason_chain: own?.reason_chain ?? null,
      fallback_used: false, fallback: null, absence: own ? null : { status: 'unknown', reason: 'no row' } };
  }
  const monitor = getState('engine_field', field, 'health.monitor', { asOf }, database)?.value ?? null;
  const snapshotId = monitor?.healthy_snapshot_id ?? null;
  let kind = 'none';
  let served = getState(entityType, entityId, fb.fallback_field, { asOf, leagueId }, database);
  if (served) kind = 'field';
  else if (snapshotId != null) {
    const snap = database.prepare('SELECT max_state_id FROM engine_snapshots WHERE id = ?').get(snapshotId);
    if (!snap) throw new Error(`health.monitor names snapshot ${snapshotId} for ${field}, which does not exist`);
    served = getState(entityType, entityId, field, { asOf, leagueId, maxId: Number(snap.max_state_id) }, database);
    if (served) kind = 'snapshot';
  }
  const note = { source: 'health_monitor', kind: 'monitor', event_ids: [], state_ids: [], delta: null, weight: null,
    text: `fell back: ${fb.reason}` };
  const chain = served?.reason_chain ?? { v: 2, additive: false, contributions: [] };
  return {
    value: served?.value ?? null, row: served, health: served?.health ?? null,
    reason_chain: { ...chain, contributions: [note, ...(chain.contributions ?? [])] },
    fallback_used: true,
    fallback: { kind, field: fb.fallback_field, snapshot_id: snapshotId, reason: fb.reason, since: fb.since, n: fb.n },
    absence: served ? null : { status: 'unknown', reason: `${field} is on its fallback and neither ${fb.fallback_field} nor the last healthy snapshot has a row` },
  };
}
