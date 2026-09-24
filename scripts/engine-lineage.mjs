#!/usr/bin/env node
/**
 * Lineage of one engine_state row (ENGINE-ARCHITECTURE.md §2.3, §6.5): the row, the run
 * that wrote it (producer@version, lane, league scope, dirty reason), that run's input cut,
 * and every row of the producer's declared input fields in force at that cut, plus the
 * events and state rows its reason chain cites. Read-only.
 *
 * Usage: GRIDIRON_DB_PATH=/path/to/copy.sqlite node scripts/engine-lineage.mjs <state_id>
 */
process.env.SCHEDULER_DISABLED ??= '1';
const id = Number(process.argv[2]);
if (!Number.isInteger(id) || id <= 0) { console.error('usage: engine-lineage.mjs <engine_state id>'); process.exit(64); }
const { db } = await import('../server/db/index.js');
const row = db.prepare('SELECT * FROM engine_state WHERE id = ?').get(id);
if (!row) { console.error(`no engine_state row ${id}`); process.exit(1); }
const run = row.run_id == null ? null : db.prepare('SELECT * FROM engine_runs WHERE id = ?').get(row.run_id);
const producer = db.prepare('SELECT * FROM engine_producers WHERE producer = ? AND version = ?').get(row.producer, row.producer_version);
const inputs = producer ? JSON.parse(producer.inputs) : {};
const inForce = [];
if (run?.input_cut_state_id != null) {
  for (const field of inputs.fields ?? []) {
    inForce.push(...db.prepare(`SELECT id, entity_type, entity_id, league_id, field, producer_version, as_of FROM engine_state
        WHERE id IN (SELECT MAX(id) FROM engine_state WHERE field = ? AND lane = 'live' AND id <= ?
                     AND league_id IN (0, ?) GROUP BY entity_type, entity_id, league_id)`)
      .all(field, run.input_cut_state_id, row.league_id));
  }
}
const chain = JSON.parse(row.reason_chain);
const eventIds = JSON.parse(row.event_ids);
const cited = eventIds.length ? db.prepare(`SELECT id, event_type, as_of, as_of_quality, provenance, source, natural_key
    FROM engine_events WHERE id IN (${eventIds.map(() => '?').join(',')})`).all(...eventIds) : [];
console.log(JSON.stringify({
  row: { ...row, value: row.value == null ? null : JSON.parse(row.value), reason_chain: chain, health: JSON.parse(row.health) },
  run, producer: producer ? { ...producer, inputs } : null,
  input_cut: run ? { event: run.input_cut_event_id, state: run.input_cut_state_id } : null,
  input_rows_in_force: inForce, cited_events: cited,
}, null, 2));
