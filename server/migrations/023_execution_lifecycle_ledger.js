export const name = '023_execution_lifecycle_ledger';

/**
 * Package H — the execution/acceptance state lifecycle, as a real ledger.
 *
 * `nfl_execution_log` (nfl-execution.js) already exists and it is a single
 * post-hoc row: "here is where we routed it." It has no notion of time
 * passing between deciding to bet and actually taking the price, which is
 * exactly the gap docs/NFL_RESEARCH_MASTER_PLAN_2026_09_08.md's Package H
 * exists to close — "a user-recorded acceptance is not an automatic
 * sportsbook execution," and everything that happens between OFFERED and
 * SETTLED is where a paper edge actually survives or dies.
 *
 * Two tables, event-sourced rather than one wide mutable row:
 *
 *   nfl_execution_opportunities   one header per candidate bet, addressed by
 *                                 the exact Package-A contract key. `status`
 *                                 is a materialized cache of the furthest
 *                                 state reached — convenient to query, never
 *                                 the source of truth.
 *
 *   nfl_execution_lifecycle_events   the actual event log. OFFERED, OBSERVED,
 *                                 DECISION and ACCEPTED/SETTLED can each
 *                                 happen at most once per opportunity (a
 *                                 partial unique index enforces this).
 *                                 REFRESHED is the one state allowed to
 *                                 recur, because the plan is explicit that a
 *                                 price may be re-checked more than once
 *                                 between deciding and accepting.
 *
 * THE COLUMN THAT MATTERS MOST: `fill_confirmed` carries a CHECK that pins it
 * to zero, always. Nothing in this project connects to a sportsbook account,
 * so there is no code path that could ever set it — the constraint makes
 * that a schema-level fact instead of a comment someone could stop reading.
 * An ACCEPTED row means "Nick recorded taking this," full stop; it is never
 * upgraded into a claim that a book actually filled it.
 *
 * `quote_id` is a loose reference to nfl_quote_tape.quote_id (no FK): a
 * replay_synthetic or stress-test row will never have one, and a row sourced
 * from a frozen evidence-dataset extract cites a quote that still lives in
 * the immutable tape but is addressed by the extract's own copy, not a live
 * join. Looseness here is deliberate — it must never be possible for an
 * app-level replay to be blocked by a foreign-key on data it is only reading.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nfl_execution_opportunities (
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
        CHECK(status IN ('offered','observed','decision','refreshed','accepted','settled')),
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_execution_opp_contract
      ON nfl_execution_opportunities(contract_key);
    CREATE INDEX IF NOT EXISTS idx_execution_opp_status
      ON nfl_execution_opportunities(status);
    CREATE INDEX IF NOT EXISTS idx_execution_opp_event
      ON nfl_execution_opportunities(event_key);

    CREATE TABLE IF NOT EXISTS nfl_execution_lifecycle_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opportunity_id TEXT NOT NULL REFERENCES nfl_execution_opportunities(id) ON DELETE CASCADE,
      state TEXT NOT NULL
        CHECK(state IN ('offered','observed','decision','refreshed','accepted','settled')),
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

    -- OFFERED/OBSERVED/DECISION/ACCEPTED/SETTLED each occur at most once per
    -- opportunity. REFRESHED is excluded on purpose — see file header.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lifecycle_single_state
      ON nfl_execution_lifecycle_events(opportunity_id, state)
      WHERE state <> 'refreshed';

    CREATE INDEX IF NOT EXISTS idx_lifecycle_opportunity_order
      ON nfl_execution_lifecycle_events(opportunity_id, id);
    CREATE INDEX IF NOT EXISTS idx_lifecycle_quote
      ON nfl_execution_lifecycle_events(quote_id);

    CREATE TRIGGER IF NOT EXISTS nfl_execution_lifecycle_events_no_update
      BEFORE UPDATE ON nfl_execution_lifecycle_events
      BEGIN SELECT RAISE(ABORT, 'lifecycle events are append-only — record a new state instead'); END;
    CREATE TRIGGER IF NOT EXISTS nfl_execution_lifecycle_events_no_delete
      BEFORE DELETE ON nfl_execution_lifecycle_events
      BEGIN SELECT RAISE(ABORT, 'lifecycle events are append-only — record a new state instead'); END;
  `);
}

export function down(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS nfl_execution_lifecycle_events_no_delete;
    DROP TRIGGER IF EXISTS nfl_execution_lifecycle_events_no_update;
    DROP INDEX IF EXISTS idx_lifecycle_quote;
    DROP INDEX IF EXISTS idx_lifecycle_opportunity_order;
    DROP INDEX IF EXISTS idx_lifecycle_single_state;
    DROP TABLE IF EXISTS nfl_execution_lifecycle_events;
    DROP INDEX IF EXISTS idx_execution_opp_event;
    DROP INDEX IF EXISTS idx_execution_opp_status;
    DROP INDEX IF EXISTS idx_execution_opp_contract;
    DROP TABLE IF EXISTS nfl_execution_opportunities;
  `);
}
