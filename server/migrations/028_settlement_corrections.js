export const name = '028_settlement_corrections';

/**
 * Codex audit finding E8 (2026-09-10), the half Codex's own implementation
 * note left open: "Explicit provider-finality observations and append-only
 * settlement corrections still need implementation."
 *
 * Settlement is terminal and the lifecycle is append-only, which together
 * meant a graded result could never be corrected at all: a provider score
 * correction, a mis-keyed ticket, an abandoned game or a later book ruling
 * had nowhere to go. The only ways out were to mutate history (which the
 * append-only triggers correctly refuse) or to leave a known-wrong result
 * standing.
 *
 * `settlement_correction` is the compensating event that resolves this. It
 * NEVER edits the original settled row -- that stays byte-identical forever,
 * as the audit requires -- it appends a new event carrying the corrected
 * result and the P&L DELTA against the original, so realized economics are
 * computed from the net of ledger events rather than from whichever row
 * happens to be last. Corrections may recur (a second correction can revise
 * a first), so unlike every other terminal state this one is excluded from
 * the single-state uniqueness index, exactly as `refreshed` already is.
 */
export function up(db) {
  const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE name='nfl_execution_lifecycle_events'`).get()?.sql ?? '';
  if (!sql || sql.includes("'settlement_correction'")) return;
  db.exec(`
    DROP TRIGGER IF EXISTS nfl_execution_lifecycle_events_no_update;
    DROP TRIGGER IF EXISTS nfl_execution_lifecycle_events_no_delete;
    DROP INDEX IF EXISTS idx_lifecycle_single_state;
    DROP INDEX IF EXISTS idx_lifecycle_opportunity_order;
    DROP INDEX IF EXISTS idx_lifecycle_quote;
    CREATE TABLE nfl_execution_lifecycle_events_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opportunity_id TEXT NOT NULL REFERENCES nfl_execution_opportunities(id) ON DELETE CASCADE,
      state TEXT NOT NULL
        CHECK(state IN ('offered','observed','decision','refreshed','accepted','settled',
                        'passed','expired','cancelled','settlement_correction')),
      occurred_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      book TEXT, line REAL, price INTEGER, stake_units REAL,
      source TEXT NOT NULL
        CHECK(source IN ('quote_tape','user_recorded','replay_synthetic','settlement_result')),
      quote_id TEXT,
      fill_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(fill_confirmed = 0),
      result TEXT CHECK(result IS NULL OR result IN ('won','lost','push','void')),
      realized_pnl_units REAL, actor TEXT, detail_json TEXT
    );
    INSERT INTO nfl_execution_lifecycle_events_new
      SELECT id, opportunity_id, state, occurred_at, recorded_at, book, line, price, stake_units,
             source, quote_id, fill_confirmed, result, realized_pnl_units, actor, detail_json
      FROM nfl_execution_lifecycle_events;
    DROP TABLE nfl_execution_lifecycle_events;
    ALTER TABLE nfl_execution_lifecycle_events_new RENAME TO nfl_execution_lifecycle_events;
    -- A correction may recur, so it joins 'refreshed' outside the single-state guard.
    CREATE UNIQUE INDEX idx_lifecycle_single_state
      ON nfl_execution_lifecycle_events(opportunity_id, state)
      WHERE state NOT IN ('refreshed','settlement_correction');
    CREATE INDEX idx_lifecycle_opportunity_order ON nfl_execution_lifecycle_events(opportunity_id, id);
    CREATE INDEX idx_lifecycle_quote ON nfl_execution_lifecycle_events(quote_id);
    CREATE TRIGGER nfl_execution_lifecycle_events_no_update
      BEFORE UPDATE ON nfl_execution_lifecycle_events
      BEGIN SELECT RAISE(ABORT, 'lifecycle events are append-only — record a new state instead'); END;
    CREATE TRIGGER nfl_execution_lifecycle_events_no_delete
      BEFORE DELETE ON nfl_execution_lifecycle_events
      BEGIN SELECT RAISE(ABORT, 'lifecycle events are append-only — record a new state instead'); END;
  `);
}

/**
 * Narrow the vocabulary again — unless a correction has actually been
 * recorded.
 *
 * The rebuild below copies rows through `WHERE state <> 'settlement_correction'`,
 * so every correction is deleted on the way past. A correction is the only
 * record that a settled result was later found to be wrong: the original
 * settled row still stands, byte-identical, saying the old thing, and deleting
 * the compensating event does not restore an earlier truth — it reinstates a
 * known-wrong one and silently changes realized economics, which are computed
 * from the net of ledger events. That is a data loss dressed as a schema
 * change, so this refuses and names the count. An uncorrected ledger
 * downgrades exactly as before.
 */
export function down(db) {
  const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE name='nfl_execution_lifecycle_events'`).get()?.sql ?? '';
  if (!sql.includes("'settlement_correction'")) return;
  const corrections = db.prepare(`SELECT COUNT(*) AS n FROM nfl_execution_lifecycle_events
    WHERE state = 'settlement_correction'`).get()?.n ?? 0;
  if (corrections) {
    throw new Error(`rollback refused: ${corrections} settlement correction(s) exist, and 027's schema cannot `
      + `represent them. Rolling back would delete the record that a settled result was corrected and leave the `
      + `superseded result standing as the ledger's answer. Restore the pre-migration snapshot instead.`);
  }
  db.exec(`
    DROP TRIGGER IF EXISTS nfl_execution_lifecycle_events_no_update;
    DROP TRIGGER IF EXISTS nfl_execution_lifecycle_events_no_delete;
    DROP INDEX IF EXISTS idx_lifecycle_single_state;
    DROP INDEX IF EXISTS idx_lifecycle_opportunity_order;
    DROP INDEX IF EXISTS idx_lifecycle_quote;
    CREATE TABLE nfl_execution_lifecycle_events_old (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opportunity_id TEXT NOT NULL REFERENCES nfl_execution_opportunities(id) ON DELETE CASCADE,
      state TEXT NOT NULL
        CHECK(state IN ('offered','observed','decision','refreshed','accepted','settled',
                        'passed','expired','cancelled')),
      occurred_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      book TEXT, line REAL, price INTEGER, stake_units REAL,
      source TEXT NOT NULL
        CHECK(source IN ('quote_tape','user_recorded','replay_synthetic','settlement_result')),
      quote_id TEXT,
      fill_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(fill_confirmed = 0),
      result TEXT CHECK(result IS NULL OR result IN ('won','lost','push','void')),
      realized_pnl_units REAL, actor TEXT, detail_json TEXT
    );
    INSERT INTO nfl_execution_lifecycle_events_old
      SELECT id, opportunity_id, state, occurred_at, recorded_at, book, line, price, stake_units,
             source, quote_id, fill_confirmed, result, realized_pnl_units, actor, detail_json
      FROM nfl_execution_lifecycle_events WHERE state <> 'settlement_correction';
    DROP TABLE nfl_execution_lifecycle_events;
    ALTER TABLE nfl_execution_lifecycle_events_old RENAME TO nfl_execution_lifecycle_events;
    CREATE UNIQUE INDEX idx_lifecycle_single_state
      ON nfl_execution_lifecycle_events(opportunity_id, state)
      WHERE state <> 'refreshed';
    CREATE INDEX idx_lifecycle_opportunity_order ON nfl_execution_lifecycle_events(opportunity_id, id);
    CREATE INDEX idx_lifecycle_quote ON nfl_execution_lifecycle_events(quote_id);
    CREATE TRIGGER nfl_execution_lifecycle_events_no_update
      BEFORE UPDATE ON nfl_execution_lifecycle_events
      BEGIN SELECT RAISE(ABORT, 'lifecycle events are append-only — record a new state instead'); END;
    CREATE TRIGGER nfl_execution_lifecycle_events_no_delete
      BEFORE DELETE ON nfl_execution_lifecycle_events
      BEGIN SELECT RAISE(ABORT, 'lifecycle events are append-only — record a new state instead'); END;
  `);
}
