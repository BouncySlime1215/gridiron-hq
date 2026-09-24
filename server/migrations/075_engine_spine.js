export const name = '075_engine_spine';
/**
 * ENGINE-00a + EA-00: the ONE ENGINE spine, schema v2 (ENGINE-ARCHITECTURE.md §2).
 * Additive only: every engine table in ONE migration (a second one would take a second
 * ~0.9 GB pre-migration backup), their indexes and triggers. Nothing existing is altered.
 *
 * Append-only (triggers refuse UPDATE and DELETE):
 *   engine_events          the log. `as_of` = valid time (+ `as_of_quality`: exact |
 *                          first_seen | date_only | clamped), `ingested_at` = transaction
 *                          time, `provenance` = captured | reconstructed | derived.
 *                          `natural_key` is the row's identity in its source; `source_key`
 *                          = natural_key:payload_hash:prev_event_id (compare-latest dedupe).
 *                          Only writer: appendEvents (server/services/engine/events.js).
 *   engine_event_entities  who an event is about (every party; alias ids such as gsis:/espn:
 *                          for players with no players.id yet, resolved at read time).
 *   engine_state           entity x field rows with `lane` (live | shadow), `health` and
 *                          `run_id`. The row id is its transaction time (no known_by).
 *                          Only writer: writeState (server/services/engine/state.js).
 *   engine_runs            one row per producer run, with the input cut it read.
 *   engine_snapshots       a published cut (max event id, max state id, versions, dice).
 * Mutable bookkeeping (specs and pointers, never numbers):
 *   engine_fields          the field registry as data; a BEFORE INSERT trigger on
 *                          engine_state refuses a row whose producer is not the field's.
 *   engine_producers       producer versions (status is the only column that changes).
 *   engine_cursors, engine_fallback, engine_requests (the only table the web may insert into).
 *
 * league_id is NOT NULL DEFAULT 0 (0 = global) on both big tables, so indexes are usable.
 * Refuses to run over a v1 engine_state (no `lane`): CREATE TABLE IF NOT EXISTS would
 * silently keep the old shape. Numbered 075: 074 is held by PROJ-00.
 */
const APPEND_ONLY = ['engine_events', 'engine_event_entities', 'engine_state', 'engine_runs', 'engine_snapshots'];

export function up(db) {
  const existing = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'engine_state'`).get();
  if (existing) {
    const cols = db.prepare('PRAGMA table_info(engine_state)').all().map(c => c.name);
    if (!cols.includes('lane')) {
      throw new Error('075_engine_spine: engine_state exists without a lane column (a v1 spine database). '
        + 'Use a database without the v1 engine tables; this migration will not keep the old shape.');
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS engine_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      as_of TEXT NOT NULL,
      as_of_quality TEXT NOT NULL CHECK (as_of_quality IN ('exact', 'first_seen', 'date_only', 'clamped')),
      ingested_at TEXT NOT NULL,
      provenance TEXT NOT NULL CHECK (provenance IN ('captured', 'reconstructed', 'derived')),
      league_id INTEGER NOT NULL DEFAULT 0,
      team_id TEXT,
      player_id INTEGER,
      source TEXT NOT NULL,
      natural_key TEXT NOT NULL,
      source_key TEXT NOT NULL,
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      schema_version INTEGER NOT NULL DEFAULT 1,
      UNIQUE (source, source_key)
    );
    CREATE INDEX IF NOT EXISTS idx_engine_events_type_asof ON engine_events(event_type, as_of);
    CREATE INDEX IF NOT EXISTS idx_engine_events_player_asof ON engine_events(player_id, as_of);
    CREATE INDEX IF NOT EXISTS idx_engine_events_league_asof ON engine_events(league_id, team_id, as_of);
    CREATE INDEX IF NOT EXISTS idx_engine_events_natural ON engine_events(source, natural_key, id DESC);
    CREATE INDEX IF NOT EXISTS idx_engine_events_ingested ON engine_events(ingested_at);

    CREATE TABLE IF NOT EXISTS engine_event_entities (
      event_id INTEGER NOT NULL REFERENCES engine_events(id),
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('subject', 'from', 'to', 'counterparty', 'league')),
      PRIMARY KEY (entity_type, entity_id, event_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_engine_event_entities_event ON engine_event_entities(event_id);

    CREATE TABLE IF NOT EXISTS engine_fields (
      field TEXT PRIMARY KEY,
      producer TEXT NOT NULL,
      value_type TEXT NOT NULL,
      entity_types TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(entity_types)),
      max_age_sec INTEGER,
      tolerance REAL NOT NULL DEFAULT 0,
      fallback_field TEXT,
      checks TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(checks)),
      replaces TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(replaces)),
      space TEXT,
      description TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS engine_producers (
      producer TEXT NOT NULL,
      version TEXT NOT NULL,
      code_sha TEXT,
      params_hash TEXT,
      fit_ref TEXT,
      training_window TEXT CHECK (training_window IS NULL OR json_valid(training_window)),
      fields TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(fields)),
      inputs TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(inputs)),
      status TEXT NOT NULL CHECK (status IN ('active', 'shadow', 'retired')),
      registered_at TEXT NOT NULL,
      prereg_ref TEXT,
      PRIMARY KEY (producer, version)
    );

    CREATE TABLE IF NOT EXISTS engine_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick_id TEXT,
      producer TEXT NOT NULL,
      version TEXT NOT NULL,
      lane TEXT NOT NULL CHECK (lane IN ('live', 'shadow')),
      scope_key TEXT NOT NULL DEFAULT '',
      input_cut_event_id INTEGER,
      input_cut_state_id INTEGER,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      ms INTEGER,
      rows_written INTEGER,
      rows_unchanged INTEGER,
      error TEXT,
      dirty_reason TEXT,
      lease_until TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_engine_runs_tick ON engine_runs(tick_id);
    CREATE INDEX IF NOT EXISTS idx_engine_runs_scope ON engine_runs(producer, scope_key, finished_at);

    CREATE TABLE IF NOT EXISTS engine_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      league_id INTEGER NOT NULL DEFAULT 0,
      field TEXT NOT NULL,
      value TEXT CHECK (value IS NULL OR json_valid(value)),
      as_of TEXT NOT NULL,
      producer TEXT NOT NULL,
      producer_version TEXT NOT NULL,
      lane TEXT NOT NULL DEFAULT 'live' CHECK (lane IN ('live', 'shadow')),
      reason_chain TEXT NOT NULL CHECK (json_valid(reason_chain)),
      event_ids TEXT NOT NULL CHECK (json_valid(event_ids)),
      health TEXT NOT NULL CHECK (json_valid(health)),
      run_id INTEGER REFERENCES engine_runs(id),
      written_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_engine_state_key
      ON engine_state(entity_type, entity_id, field, league_id, lane, as_of, producer_version);
    CREATE INDEX IF NOT EXISTS idx_engine_state_read
      ON engine_state(entity_type, entity_id, field, league_id, lane, id DESC);
    CREATE INDEX IF NOT EXISTS idx_engine_state_producer ON engine_state(producer, producer_version, id);
    CREATE INDEX IF NOT EXISTS idx_engine_state_run ON engine_state(run_id);

    CREATE TABLE IF NOT EXISTS engine_cursors (
      producer TEXT NOT NULL,
      version TEXT NOT NULL,
      source TEXT NOT NULL,
      watermark TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (producer, version, source)
    );

    CREATE TABLE IF NOT EXISTS engine_fallback (
      field TEXT NOT NULL,
      league_id INTEGER NOT NULL DEFAULT 0,
      fallback_field TEXT NOT NULL,
      since TEXT NOT NULL,
      reason TEXT NOT NULL,
      n INTEGER,
      PRIMARY KEY (field, league_id)
    );

    CREATE TABLE IF NOT EXISTS engine_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id INTEGER NOT NULL DEFAULT 0,
      tick_id TEXT,
      max_event_id INTEGER NOT NULL,
      max_state_id INTEGER NOT NULL,
      version_set TEXT NOT NULL CHECK (json_valid(version_set)),
      fallback_set TEXT NOT NULL CHECK (json_valid(fallback_set)),
      season INTEGER,
      nfl_week INTEGER,
      world TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_engine_snapshots_league ON engine_snapshots(league_id, id DESC);

    CREATE TABLE IF NOT EXISTS engine_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      params_hash TEXT NOT NULL,
      params_json TEXT NOT NULL CHECK (json_valid(params_json)),
      snapshot_id INTEGER,
      requested_by INTEGER,
      requested_at TEXT NOT NULL,
      lease_until TEXT,
      started_at TEXT,
      done_at TEXT,
      result_state_id INTEGER,
      error TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_engine_requests_dedupe
      ON engine_requests(kind, params_hash, COALESCE(snapshot_id, -1));

    -- One producer per field, at the database: no process, however it writes, can insert a
    -- state row for a field whose engine_fields row names a different producer (or none).
    CREATE TRIGGER IF NOT EXISTS engine_state_one_producer BEFORE INSERT ON engine_state
      WHEN NEW.producer IS NOT (SELECT producer FROM engine_fields WHERE field = NEW.field)
      BEGIN SELECT RAISE(ABORT, 'engine_state: this producer does not own this field (engine_fields)'); END;
    -- A field's owner never changes in place: a rename is a migration of the field.
    CREATE TRIGGER IF NOT EXISTS engine_fields_producer_fixed BEFORE UPDATE OF producer ON engine_fields
      WHEN NEW.producer IS NOT OLD.producer
      BEGIN SELECT RAISE(ABORT, 'engine_fields: a field''s producer cannot change'); END;
  `);
  for (const t of APPEND_ONLY) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t}
        BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t}
        BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END;
    `);
  }
}

export function down(db) {
  for (const t of APPEND_ONLY) {
    db.exec(`DROP TRIGGER IF EXISTS ${t}_no_update`);
    db.exec(`DROP TRIGGER IF EXISTS ${t}_no_delete`);
  }
  db.exec('DROP TRIGGER IF EXISTS engine_state_one_producer');
  db.exec('DROP TRIGGER IF EXISTS engine_fields_producer_fixed');
  for (const t of ['engine_requests', 'engine_snapshots', 'engine_fallback', 'engine_cursors', 'engine_state',
    'engine_runs', 'engine_producers', 'engine_fields', 'engine_event_entities', 'engine_events']) {
    db.exec(`DROP TABLE IF EXISTS ${t}`);
  }
}
