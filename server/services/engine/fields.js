/**
 * The field registry as data (ENGINE-ARCHITECTURE.md §2.4-2.6, D5).
 *
 * Writers (engine/script/test roles only, via writeState): `storeFieldSpec` upserts a
 * field's spec into `engine_fields` and its producer's versions into `engine_producers`
 * the first time a process writes that field to a database. It refuses a takeover: when
 * the table already names a different producer for the field, it throws (a rename is a
 * migration of the field, never a silent takeover), and the table's trigger refuses it too.
 *
 * `recordRun` appends one engine_runs row per finished producer run (its input cut is the
 * lineage of the rows it wrote); `setFallback` is the monitor's writer of engine_fallback.
 * Both are role-guarded like every engine write.
 *
 * Readers (any process, the web included): `readFieldSpec`, `readFallback`, `freshAt`.
 * The web process registers nothing; it learns every field's spec from this table.
 */
import { assertWriteRole } from './role.js';

const stored = new WeakMap(); // database -> Set(field) already upserted by this process

const parseJson = (s, fallback) => {
  if (s == null || s === '') return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

/** Upsert a field spec and its producer's versions. `spec` is registry.fieldSpec(); `producer` is registry.producerSpec(). */
export function storeFieldSpec(spec, producer, database) {
  const done = stored.get(database) ?? new Set();
  if (done.has(spec.field)) return;
  assertWriteRole('storeFieldSpec');
  const current = database.prepare('SELECT producer FROM engine_fields WHERE field = ?').get(spec.field);
  if (current && current.producer !== spec.producer) {
    throw new Error(`one writer per field: engine_fields says ${spec.field} belongs to ${current.producer}, not ${spec.producer}`);
  }
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO engine_fields (field, producer, value_type, entity_types, max_age_sec, tolerance,
      fallback_field, checks, replaces, space, description, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (field) DO UPDATE SET value_type = excluded.value_type, entity_types = excluded.entity_types,
        max_age_sec = excluded.max_age_sec, tolerance = excluded.tolerance, fallback_field = excluded.fallback_field,
        checks = excluded.checks, replaces = excluded.replaces, space = excluded.space,
        description = excluded.description, updated_at = excluded.updated_at`)
    .run(spec.field, spec.producer, spec.valueType, JSON.stringify(spec.entityTypes), spec.maxAgeSec, spec.tolerance,
      spec.fallbackField, JSON.stringify(spec.checks), JSON.stringify(spec.replaces), spec.space, spec.description, now);
  const insertVersion = database.prepare(`INSERT INTO engine_producers (producer, version, code_sha, params_hash, fit_ref,
      training_window, fields, inputs, status, registered_at, prereg_ref)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (producer, version) DO UPDATE SET status = excluded.status`);
  for (const v of Object.values(producer.versions)) {
    const status = v.version === producer.active ? 'active' : producer.shadow.includes(v.version) ? 'shadow' : 'retired';
    insertVersion.run(producer.name, v.version, v.params_hash, v.fit_ref,
      v.training_window == null ? null : JSON.stringify(v.training_window), JSON.stringify(producer.fields),
      JSON.stringify(producer.inputs ?? {}), status, now, v.prereg_ref);
  }
  done.add(spec.field);
  stored.set(database, done);
}

/** A field's stored spec (camelCase, parsed), or null when no process has registered it here. */
export function readFieldSpec(field, database) {
  const r = database.prepare('SELECT * FROM engine_fields WHERE field = ?').get(field);
  if (!r) return null;
  return {
    field: r.field, producer: r.producer, valueType: r.value_type, space: r.space,
    entityTypes: parseJson(r.entity_types, []), maxAgeSec: r.max_age_sec == null ? null : Number(r.max_age_sec),
    tolerance: Number(r.tolerance), fallbackField: r.fallback_field, checks: parseJson(r.checks, []),
    replaces: parseJson(r.replaces, []), description: r.description, updatedAt: r.updated_at,
  };
}

/** The fallback in force for (field, league), else the global one, or null. */
export function readFallback(field, leagueId, database) {
  return database.prepare(`SELECT field, league_id, fallback_field, since, reason, n FROM engine_fallback
      WHERE field = ? AND league_id IN (?, 0) ORDER BY league_id DESC LIMIT 1`).get(field, Number(leagueId ?? 0)) ?? null;
}

/**
 * When the field's producer was last known to have run, at or before `ref`: the later of the
 * row's own as_of (a row is computed at its tick) and the last successful engine_runs row for
 * that producer (league scope or global). Freshness comes from runs, not from the row alone,
 * because write-on-change keeps healthy rows unchanged for hours (ENGINE-ARCHITECTURE §2.6).
 */
export function freshAt({ producer, leagueId, rowAsOf, ref }, database) {
  const run = database.prepare(`SELECT MAX(finished_at) AS f FROM engine_runs
      WHERE producer = ? AND error IS NULL AND finished_at IS NOT NULL AND finished_at <= ?
        AND scope_key IN ('', ?, ?)`).get(producer, ref, `league:${Number(leagueId ?? 0)}`, String(Number(leagueId ?? 0)));
  const candidates = [rowAsOf, run?.f].filter(Boolean);
  return candidates.length ? candidates.sort().at(-1) : null;
}

/**
 * Record one finished producer run (engine_runs is append-only: one row per run, written
 * when it ends). The row carries the run's input cut (max event id and max state id when
 * it started), which is the lineage of every state row stamped with its id.
 * Returns the run id.
 */
export function recordRun({
  producer, version, lane = 'live', scopeKey = '', tickId = null, inputCutEventId = null, inputCutStateId = null,
  startedAt, finishedAt = new Date().toISOString(), rowsWritten = null, rowsUnchanged = null, error = null,
  dirtyReason = null,
}, database) {
  assertWriteRole('recordRun');
  if (typeof producer !== 'string' || !producer || typeof version !== 'string' || !version) {
    throw new Error('recordRun needs producer and version');
  }
  const started = new Date(startedAt ?? finishedAt).toISOString();
  const finished = new Date(finishedAt).toISOString();
  const r = database.prepare(`INSERT INTO engine_runs (tick_id, producer, version, lane, scope_key, input_cut_event_id,
      input_cut_state_id, started_at, finished_at, ms, rows_written, rows_unchanged, error, dirty_reason, lease_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) RETURNING id`)
    .get(tickId, producer, version, lane, scopeKey, inputCutEventId, inputCutStateId, started, finished,
      Date.parse(finished) - Date.parse(started), rowsWritten, rowsUnchanged, error, dirtyReason);
  return Number(r.id);
}

/**
 * Put a field on its fallback for one league (0 = every league), or change the reason.
 * The monitor producer (ENGINE-ARCHITECTURE §7.4) is meant to be this table's one
 * caller; the reader serves the fallback field's row, labelled `fallback`.
 */
export function setFallback({ field, leagueId = 0, fallbackField, reason, n = null, since = new Date() }, database) {
  assertWriteRole('setFallback');
  if (!field || !fallbackField || typeof reason !== 'string' || !reason) {
    throw new Error('setFallback needs field, fallbackField and a reason');
  }
  database.prepare(`INSERT INTO engine_fallback (field, league_id, fallback_field, since, reason, n)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (field, league_id) DO UPDATE SET fallback_field = excluded.fallback_field, since = excluded.since,
        reason = excluded.reason, n = excluded.n`)
    .run(field, Number(leagueId ?? 0), fallbackField, new Date(since).toISOString(), reason, n);
}
