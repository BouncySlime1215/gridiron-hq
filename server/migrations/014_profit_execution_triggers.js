export const name = '014_profit_execution_triggers';

/** Event-triggered paid captures and forward-only SGP quote evidence. */
export function up(db) {
  db.exec(`
    CREATE TABLE nfl_capture_triggers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('espn_move','news_signal')),
      source_ref TEXT NOT NULL,
      event_id TEXT NOT NULL,
      team TEXT,
      reason TEXT NOT NULL,
      priority REAL NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','captured','deferred','failed')),
      attempted_at TEXT,
      snapshot_at TEXT,
      outcome_json TEXT,
      UNIQUE(source,source_ref,event_id)
    );
    CREATE INDEX idx_capture_triggers_state ON nfl_capture_triggers(state,priority DESC,created_at);

    CREATE TABLE nfl_sgp_quotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      captured_at TEXT NOT NULL,
      event_key TEXT NOT NULL,
      book TEXT NOT NULL,
      stage TEXT NOT NULL CHECK(stage IN ('candidate','close')),
      legs_hash TEXT NOT NULL,
      legs_json TEXT NOT NULL,
      offered_odds INTEGER NOT NULL,
      correlated_probability REAL NOT NULL,
      fair_odds INTEGER,
      expected_value REAL NOT NULL,
      model_version TEXT NOT NULL,
      UNIQUE(event_key,book,stage,legs_hash,captured_at)
    );
    CREATE INDEX idx_sgp_quotes_route ON nfl_sgp_quotes(event_key,book,legs_hash,captured_at);
  `);
}

export function down(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_sgp_quotes_route;
    DROP TABLE IF EXISTS nfl_sgp_quotes;
    DROP INDEX IF EXISTS idx_capture_triggers_state;
    DROP TABLE IF EXISTS nfl_capture_triggers;
  `);
}
