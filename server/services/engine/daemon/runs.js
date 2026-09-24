/**
 * Run rows for the daemon (ENGINE-ARCHITECTURE.md §2.6). `engine_runs` is append-only, so
 * a run that must be citable while it is still going is two rows:
 *
 *   lease row   written when the run starts: started_at, the input cut, lease_until,
 *               finished_at NULL. State rows the run writes carry this row's id as run_id,
 *               so their lineage (the input cut) is readable before the run ends.
 *   result row  written when it ends: finished_at, ms, rows written/unchanged, error.
 *               Freshness (fields.js freshAt) reads only finished rows without an error.
 *
 * Single-row runs (adapters, a finished child) use recordRun (fields.js) directly.
 * Role-guarded like every engine write.
 */
import { assertWriteRole } from '../role.js';
import { recordRun } from '../fields.js';

/** The input cut: the highest event and state ids now. */
export function currentCut(database) {
  const r = database.prepare('SELECT (SELECT MAX(id) FROM engine_events) AS e, (SELECT MAX(id) FROM engine_state) AS s').get();
  return { event: r.e == null ? 0 : Number(r.e), state: r.s == null ? 0 : Number(r.s) };
}

/** Insert a lease row and return {id, startedAt, cut}. */
export function startRun({ producer, version, lane = 'live', scopeKey = '', tickId = null, cut, leaseMs,
  dirtyReason = null, now = new Date() }, database) {
  assertWriteRole('startRun');
  const startedAt = new Date(now).toISOString();
  const leaseUntil = new Date(Date.parse(startedAt) + Math.max(0, Number(leaseMs) || 0)).toISOString();
  const r = database.prepare(`INSERT INTO engine_runs (tick_id, producer, version, lane, scope_key, input_cut_event_id,
      input_cut_state_id, started_at, finished_at, ms, rows_written, rows_unchanged, error, dirty_reason, lease_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?) RETURNING id`)
    .get(tickId, producer, version, lane, scopeKey, cut?.event ?? null, cut?.state ?? null, startedAt, dirtyReason, leaseUntil);
  return { id: Number(r.id), startedAt, cut, leaseUntil };
}

/** Insert the result row for a run started with startRun. Returns its id. */
export function finishRun(lease, { producer, version, lane = 'live', scopeKey = '', tickId = null, rowsWritten = null,
  rowsUnchanged = null, error = null, dirtyReason = null, finishedAt = new Date() }, database) {
  return recordRun({ producer, version, lane, scopeKey, tickId, inputCutEventId: lease.cut?.event ?? null,
    inputCutStateId: lease.cut?.state ?? null, startedAt: lease.startedAt, finishedAt: new Date(finishedAt).toISOString(),
    rowsWritten, rowsUnchanged, error, dirtyReason }, database);
}
