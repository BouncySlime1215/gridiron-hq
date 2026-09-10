export const name = '027_decision_tape';

/**
 * Codex audit finding E6 (2026-09-10): "Phase 2 does not persist all policy
 * decisions, and existing persistence is mutable."
 *
 * Two separate defects, both fixed here at the schema level:
 *
 *   1. `nfl_pick_decisions` UPSERTs over
 *      (season, week, policy_id, matchup, market, selection) -- a key that
 *      omits policy_version entirely -- replacing the earlier price,
 *      features, reasons and timestamp in place. Re-running the board after
 *      a line moved silently destroyed what the model actually decided
 *      before it moved. That is a mutable latest-view, not a decision tape,
 *      and no honest evaluation can be reconstructed from it.
 *
 *   2. The execution pipeline only writes evidence for candidates it
 *      SELECTED. A run that selected nothing wrote nothing at all, so the
 *      denominator -- how many candidates were considered and why each was
 *      passed over -- was unrecoverable.
 *
 * `nfl_decision_runs` + `nfl_decision_events` are the append-only tape those
 * two problems require. A run is content-addressed by `board_hash` (a hash
 * of every decision it contains plus the policy identity), so re-running the
 * identical board is idempotent -- it finds the existing run instead of
 * writing a second copy -- while ANY change (a moved quote, a new policy
 * version, a different model output) produces a different hash and therefore
 * a new, separate, immutable run. The earlier run stays byte-identical
 * forever, which is exactly the property the audit asked for.
 *
 * `nfl_pick_decisions` is deliberately left in place and still written: it
 * remains useful as the mutable "latest view" projection the UI reads. It is
 * no longer the evidence.
 *
 * Also here, per the same finding's last paragraph: terminal
 * `passed`/`expired`/`cancelled` states on the execution lifecycle, so an
 * opportunity that never became a bet records WHY rather than sitting at
 * `decision` forever and quietly suppressing future matching opportunities.
 * SQLite cannot ALTER a CHECK constraint, so both execution tables are
 * rebuilt with their rows, indexes and append-only triggers preserved.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nfl_decision_runs (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      season INTEGER NOT NULL,
      week INTEGER NOT NULL,
      policy_id TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      -- Content address of the whole board: identical inputs produce an
      -- identical hash, so a retry is idempotent and a changed input is a
      -- provably different run rather than an overwrite.
      board_hash TEXT NOT NULL UNIQUE,
      code_hash TEXT,
      data_hash TEXT,
      decided_at TEXT NOT NULL,
      decision_count INTEGER NOT NULL,
      selected_count INTEGER NOT NULL,
      engine_mode TEXT,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_decision_runs_week ON nfl_decision_runs(season, week);
    CREATE INDEX IF NOT EXISTS idx_decision_runs_created ON nfl_decision_runs(created_at);

    CREATE TABLE IF NOT EXISTS nfl_decision_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES nfl_decision_runs(id) ON DELETE CASCADE,
      matchup TEXT NOT NULL,
      market TEXT NOT NULL,
      selection TEXT,
      line REAL,
      american_price INTEGER,
      book TEXT,
      quote_at TEXT,
      quote_source TEXT,
      quote_id TEXT,
      edge REAL,
      disagreement REAL,
      -- EVERY candidate is written, selected or not: this column is the
      -- denominator the audit said was missing.
      eligible INTEGER NOT NULL,
      abstention_reason TEXT,
      policy_rank INTEGER,
      feature_snapshot_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_decision_events_run ON nfl_decision_events(run_id, id);
    CREATE INDEX IF NOT EXISTS idx_decision_events_eligible ON nfl_decision_events(run_id, eligible);

    CREATE TRIGGER IF NOT EXISTS nfl_decision_events_no_update
      BEFORE UPDATE ON nfl_decision_events
      BEGIN SELECT RAISE(ABORT, 'decision events are append-only — record a new run instead'); END;
    CREATE TRIGGER IF NOT EXISTS nfl_decision_events_no_delete
      BEFORE DELETE ON nfl_decision_events
      BEGIN SELECT RAISE(ABORT, 'decision events are append-only — record a new run instead'); END;
    CREATE TRIGGER IF NOT EXISTS nfl_decision_runs_no_update
      BEFORE UPDATE ON nfl_decision_runs
      BEGIN SELECT RAISE(ABORT, 'decision runs are immutable — a changed board is a new run'); END;
  `);

  // Terminal non-execution outcomes. SQLite cannot ALTER a CHECK, so the two
  // execution tables are rebuilt. Rows, indexes and the append-only triggers
  // are all preserved; only the permitted state/status vocabulary widens.
  const oppCols = db.prepare(`PRAGMA table_info(nfl_execution_opportunities)`).all().map(c => c.name);
  if (oppCols.length && !oppCols.includes('decision_event_id')) {
    db.exec(`ALTER TABLE nfl_execution_opportunities ADD COLUMN decision_event_id INTEGER
             REFERENCES nfl_decision_events(id)`);
  }

  const statusSql = db.prepare(`SELECT sql FROM sqlite_master WHERE name='nfl_execution_opportunities'`).get()?.sql ?? '';
  if (statusSql && !statusSql.includes("'passed'")) {
    db.exec(`
      DROP INDEX IF EXISTS idx_execution_opp_contract;
      DROP INDEX IF EXISTS idx_execution_opp_status;
      DROP INDEX IF EXISTS idx_execution_opp_event;
      CREATE TABLE nfl_execution_opportunities_new (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        contract_key TEXT NOT NULL,
        contract_hash TEXT,
        event_key TEXT,
        matchup TEXT,
        market TEXT NOT NULL,
        side TEXT NOT NULL,
        participant TEXT,
        decision_source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'offered'
          CHECK(status IN ('offered','observed','decision','refreshed','accepted','settled','passed','expired','cancelled')),
        note TEXT,
        model_line REAL,
        model_probability REAL,
        market_line_at_decision REAL,
        decision_event_id INTEGER REFERENCES nfl_decision_events(id)
      );
      INSERT INTO nfl_execution_opportunities_new
        (id, created_at, contract_key, contract_hash, event_key, matchup, market, side, participant,
         decision_source, status, note, model_line, model_probability, market_line_at_decision, decision_event_id)
        SELECT id, created_at, contract_key, contract_hash, event_key, matchup, market, side, participant,
               decision_source, status, note, model_line, model_probability, market_line_at_decision, decision_event_id
        FROM nfl_execution_opportunities;
      DROP TABLE nfl_execution_opportunities;
      ALTER TABLE nfl_execution_opportunities_new RENAME TO nfl_execution_opportunities;
      CREATE INDEX idx_execution_opp_contract ON nfl_execution_opportunities(contract_key);
      CREATE INDEX idx_execution_opp_status ON nfl_execution_opportunities(status);
      CREATE INDEX idx_execution_opp_event ON nfl_execution_opportunities(event_key);
    `);
  }

  const eventSql = db.prepare(`SELECT sql FROM sqlite_master WHERE name='nfl_execution_lifecycle_events'`).get()?.sql ?? '';
  if (eventSql && !eventSql.includes("'passed'")) {
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
          CHECK(state IN ('offered','observed','decision','refreshed','accepted','settled','passed','expired','cancelled')),
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
        book TEXT,
        line REAL,
        price INTEGER,
        stake_units REAL,
        source TEXT NOT NULL
          CHECK(source IN ('quote_tape','user_recorded','replay_synthetic','settlement_result')),
        quote_id TEXT,
        fill_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(fill_confirmed = 0),
        result TEXT CHECK(result IS NULL OR result IN ('won','lost','push','void')),
        realized_pnl_units REAL,
        actor TEXT,
        detail_json TEXT
      );
      INSERT INTO nfl_execution_lifecycle_events_new
        SELECT id, opportunity_id, state, occurred_at, recorded_at, book, line, price, stake_units,
               source, quote_id, fill_confirmed, result, realized_pnl_units, actor, detail_json
        FROM nfl_execution_lifecycle_events;
      DROP TABLE nfl_execution_lifecycle_events;
      ALTER TABLE nfl_execution_lifecycle_events_new RENAME TO nfl_execution_lifecycle_events;
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
}

export function down(db) {
  // Restore the narrower state vocabulary, preserving rows that still fit it.
  const eventSql = db.prepare(`SELECT sql FROM sqlite_master WHERE name='nfl_execution_lifecycle_events'`).get()?.sql ?? '';
  if (eventSql.includes("'passed'")) {
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
          CHECK(state IN ('offered','observed','decision','refreshed','accepted','settled')),
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
        FROM nfl_execution_lifecycle_events
        WHERE state IN ('offered','observed','decision','refreshed','accepted','settled');
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

  const statusSql = db.prepare(`SELECT sql FROM sqlite_master WHERE name='nfl_execution_opportunities'`).get()?.sql ?? '';
  if (statusSql.includes("'passed'")) {
    db.exec(`
      DROP INDEX IF EXISTS idx_execution_opp_contract;
      DROP INDEX IF EXISTS idx_execution_opp_status;
      DROP INDEX IF EXISTS idx_execution_opp_event;
      CREATE TABLE nfl_execution_opportunities_old (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        contract_key TEXT NOT NULL, contract_hash TEXT, event_key TEXT, matchup TEXT,
        market TEXT NOT NULL, side TEXT NOT NULL, participant TEXT,
        decision_source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'offered'
          CHECK(status IN ('offered','observed','decision','refreshed','accepted','settled')),
        note TEXT, model_line REAL, model_probability REAL, market_line_at_decision REAL
      );
      INSERT INTO nfl_execution_opportunities_old
        SELECT id, created_at, contract_key, contract_hash, event_key, matchup, market, side, participant,
               decision_source, status, note, model_line, model_probability, market_line_at_decision
        FROM nfl_execution_opportunities
        WHERE status IN ('offered','observed','decision','refreshed','accepted','settled');
      DROP TABLE nfl_execution_opportunities;
      ALTER TABLE nfl_execution_opportunities_old RENAME TO nfl_execution_opportunities;
      CREATE INDEX idx_execution_opp_contract ON nfl_execution_opportunities(contract_key);
      CREATE INDEX idx_execution_opp_status ON nfl_execution_opportunities(status);
      CREATE INDEX idx_execution_opp_event ON nfl_execution_opportunities(event_key);
    `);
  }

  db.exec(`
    DROP TRIGGER IF EXISTS nfl_decision_runs_no_update;
    DROP TRIGGER IF EXISTS nfl_decision_events_no_delete;
    DROP TRIGGER IF EXISTS nfl_decision_events_no_update;
    DROP INDEX IF EXISTS idx_decision_events_eligible;
    DROP INDEX IF EXISTS idx_decision_events_run;
    DROP TABLE IF EXISTS nfl_decision_events;
    DROP INDEX IF EXISTS idx_decision_runs_created;
    DROP INDEX IF EXISTS idx_decision_runs_week;
    DROP TABLE IF EXISTS nfl_decision_runs;
  `);
}
