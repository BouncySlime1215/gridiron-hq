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
 *
 * ONE OF THOSE TWO REBUILDS CANNOT BE DONE FROM HERE. Dropping the lifecycle
 * child is safe — nothing references it, so nothing cascades. Dropping the
 * opportunity parent is not: with foreign keys on, DROP TABLE implicitly
 * deletes every row first, each delete cascades into the lifecycle child, and
 * the child's append-only trigger aborts the migration. Suspending foreign
 * keys is the standard fix and is unavailable inside migrate()'s transaction,
 * where PRAGMA foreign_keys is silently ignored. So the parent rebuild is
 * performed before the runner starts, by the versioned repair in
 * server/db/preflight.js, and the guard below finds that half already done and
 * skips it. On a fresh or empty database nothing has to be repaired and this
 * file does both rebuilds itself, exactly as it always did.
 */

/**
 * How many lifecycle events a parent-table rebuild would have to cascade
 * through. Answers zero when the ledger has not been created yet, which is
 * the fresh-install case.
 */
function lifecycleEventCount(db) {
  const exists = db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master
    WHERE type='table' AND name='nfl_execution_lifecycle_events'`).get()?.n ?? 0;
  if (!exists) return 0;
  return db.prepare(`SELECT COUNT(*) AS n FROM nfl_execution_lifecycle_events`).get()?.n ?? 0;
}

/** Everything 023 allowed. Rows outside it are the evidence a downgrade to 023's schema cannot carry. */
const ORIGINAL_VOCABULARY = ['offered', 'observed', 'decision', 'refreshed', 'accepted', 'settled'];
const ORIGINAL_LIST = ORIGINAL_VOCABULARY.map(state => `'${state}'`).join(',');
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
    // Reaching here with a populated ledger means the preflight repair did not
    // run — this file was applied directly, or through some path that bypasses
    // server/db/migrate.js. Proceeding would abort inside SQLite with the
    // append-only trigger's message, which says nothing about why a migration
    // was touching that trigger at all; on a database whose trigger has been
    // dropped it would instead cascade the evidence away and report success.
    // Neither is an acceptable outcome for a rebuild that has a correct path
    // available, so refuse and name it.
    const stranded = lifecycleEventCount(db);
    if (stranded) {
      throw new Error(`027_decision_tape cannot rebuild nfl_execution_opportunities while ${stranded} `
        + `append-only lifecycle event(s) cascade from it. That rebuild needs foreign keys suspended, which is `
        + `impossible inside a migration transaction; run migrations through server/db/migrate.js so the `
        + `preflight repair in server/db/preflight.js widens the table first.`);
    }
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

/**
 * Restore the narrower state vocabulary — but only where doing so costs
 * nothing.
 *
 * Both rebuilds below copy rows through a `WHERE state IN (…)` filter, and
 * anything outside 023's vocabulary simply does not survive the copy. That is
 * a silent, permanent deletion of the exact evidence 027 was written to start
 * recording: an opportunity marked `passed` is the record of a candidate the
 * policy considered and declined, and once it is gone the denominator is
 * unrecoverable. A downgrade is a convenience; the evidence is not. So this
 * refuses instead, and says which rows are in the way.
 *
 * The second refusal is a limitation rather than a policy. Undoing the widened
 * vocabulary means rebuilding the opportunity parent, and that runs into the
 * same cascade this migration's up() has the preflight repair to get around —
 * except that rollbackMigration() has no equivalent, and a rollback is not
 * something the application does on its own at startup. Rather than abort deep
 * inside SQLite with a message about append-only triggers, say plainly that a
 * populated execution ledger cannot be downgraded in place and point at the
 * pre-migration snapshot that db/index.js takes before every upgrade.
 */
export function down(db) {
  const events = lifecycleEventCount(db);
  const strandedEvents = events
    ? db.prepare(`SELECT COUNT(*) AS n FROM nfl_execution_lifecycle_events
        WHERE state NOT IN (${ORIGINAL_LIST})`).get()?.n ?? 0
    : 0;
  const strandedOpportunities = db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master
    WHERE type='table' AND name='nfl_execution_opportunities'`).get()?.n
    ? db.prepare(`SELECT COUNT(*) AS n FROM nfl_execution_opportunities
        WHERE status NOT IN (${ORIGINAL_LIST})`).get()?.n ?? 0
    : 0;
  if (strandedEvents || strandedOpportunities) {
    throw new Error(`rollback refused: ${strandedEvents} lifecycle event(s) and ${strandedOpportunities} `
      + `opportunity row(s) hold terminal states 023's schema cannot represent `
      + `(${ORIGINAL_VOCABULARY.join(', ')} only). Rolling back would delete that evidence rather than `
      + `downgrade it. Restore the pre-migration snapshot instead.`);
  }
  if (events) {
    throw new Error(`rollback refused: rebuilding nfl_execution_opportunities would cascade into ${events} `
      + `append-only lifecycle event(s), and a rollback cannot suspend foreign keys from inside its own `
      + `transaction. Restore the pre-migration snapshot instead.`);
  }

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
