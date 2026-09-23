export const name = '075_engine_spine';
/**
 * ENGINE-00a: the ONE ENGINE spine. Additive only: two new tables, their indexes and
 * four triggers. Nothing existing is altered.
 *
 * `engine_events` — one append-only, as-of-stamped log of everything the engine
 * observes (ESPN transactions, lineups, news, lines, injuries, trade outcomes, chat
 * counts and rates, and later offers, Jev calls and grades). `as_of` is when the fact
 * became true or known, `ingested_at` is when this log received it. (source,
 * source_key) is unique, which is what makes every adapter idempotent. The only
 * writer is `appendEvents` (server/services/engine/events.js).
 *
 * `engine_state` — entity x field x as_of rows. Each field has exactly one producer
 * (server/services/engine/registry.js), enforced by `writeState`
 * (server/services/engine/state.js), the only writer. A row is never rewritten: a new
 * value is a new row with a later as_of, so every number traces to the version and
 * the events that made it. `reason_chain` is {contributions:[{source,event_ids,delta,text}]}.
 * `league_id` scopes a row to one league for access control (null = global).
 * Read by `getState`, served at GET /api/engine/state (server/routes/engine.js).
 *
 * The triggers make append-only a property of the database, not a promise of the code.
 * Numbered 075: 074 is held by PROJ-00.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS engine_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      as_of TEXT NOT NULL,
      league_id INTEGER,
      team_id TEXT,
      player_id INTEGER,
      source TEXT NOT NULL,
      source_key TEXT NOT NULL,
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      ingested_at TEXT NOT NULL,
      UNIQUE (source, source_key)
    );
    CREATE INDEX IF NOT EXISTS idx_engine_events_type_asof ON engine_events(event_type, as_of);
    CREATE INDEX IF NOT EXISTS idx_engine_events_player_asof ON engine_events(player_id, as_of);
    CREATE INDEX IF NOT EXISTS idx_engine_events_league_asof ON engine_events(league_id, team_id, as_of);

    CREATE TABLE IF NOT EXISTS engine_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      league_id INTEGER,
      field TEXT NOT NULL,
      value TEXT CHECK (value IS NULL OR json_valid(value)),
      as_of TEXT NOT NULL,
      producer TEXT NOT NULL,
      producer_version TEXT NOT NULL,
      reason_chain TEXT NOT NULL CHECK (json_valid(reason_chain)),
      event_ids TEXT NOT NULL CHECK (json_valid(event_ids)),
      written_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_engine_state_key
      ON engine_state(entity_type, entity_id, field, COALESCE(league_id, -1), as_of, producer_version);
    CREATE INDEX IF NOT EXISTS idx_engine_state_read
      ON engine_state(entity_type, entity_id, field, as_of);

    CREATE TRIGGER IF NOT EXISTS engine_events_no_update BEFORE UPDATE ON engine_events
      BEGIN SELECT RAISE(ABORT, 'engine_events is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS engine_events_no_delete BEFORE DELETE ON engine_events
      BEGIN SELECT RAISE(ABORT, 'engine_events is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS engine_state_no_update BEFORE UPDATE ON engine_state
      BEGIN SELECT RAISE(ABORT, 'engine_state is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS engine_state_no_delete BEFORE DELETE ON engine_state
      BEGIN SELECT RAISE(ABORT, 'engine_state is append-only'); END;
  `);
}

export function down(db) {
  for (const t of ['engine_events_no_update', 'engine_events_no_delete', 'engine_state_no_update', 'engine_state_no_delete']) {
    db.exec(`DROP TRIGGER IF EXISTS ${t}`);
  }
  db.exec('DROP TABLE IF EXISTS engine_state');
  db.exec('DROP TABLE IF EXISTS engine_events');
}
