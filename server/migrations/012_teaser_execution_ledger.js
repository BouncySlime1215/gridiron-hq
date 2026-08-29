export const name = '012_teaser_execution_ledger';

/**
 * A teaser ticket is the atomic execution unit: both legs must be available at
 * the same book, at the recorded teaser payout, and in different games.  The
 * child rows preserve the exact numbers taken so forward results can audit the
 * historical 74.69% leg-rate claim instead of merely grading a ticket W/L.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE nfl_teaser_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id TEXT NOT NULL,
      logged_at TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('paper','placed')),
      book TEXT NOT NULL,
      american_price INTEGER NOT NULL,
      teaser_points REAL NOT NULL DEFAULT 6,
      stake_units REAL NOT NULL CHECK (stake_units > 0),
      expected_leg_rate REAL NOT NULL,
      expected_ticket_probability REAL NOT NULL,
      expected_ev REAL NOT NULL,
      price_captured_at TEXT NOT NULL,
      line_captured_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','won','lost','push','void')),
      settled_at TEXT,
      profit_units REAL,
      note TEXT,
      UNIQUE (candidate_id, mode)
    );

    CREATE TABLE nfl_teaser_execution_legs (
      execution_id INTEGER NOT NULL REFERENCES nfl_teaser_executions(id) ON DELETE CASCADE,
      slot INTEGER NOT NULL CHECK (slot IN (1,2)),
      event_id TEXT NOT NULL,
      team TEXT NOT NULL,
      opponent TEXT,
      matchup TEXT,
      commence_time TEXT,
      market_line REAL NOT NULL,
      teased_line REAL NOT NULL,
      result TEXT CHECK (result IS NULL OR result IN ('won','lost','push','void')),
      team_score INTEGER,
      opponent_score INTEGER,
      PRIMARY KEY (execution_id, slot),
      UNIQUE (execution_id, event_id)
    );

    CREATE INDEX idx_teaser_executions_status
      ON nfl_teaser_executions(status, logged_at);
    CREATE INDEX idx_teaser_execution_legs_event
      ON nfl_teaser_execution_legs(event_id, team);
  `);
}

export function down(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_teaser_execution_legs_event;
    DROP INDEX IF EXISTS idx_teaser_executions_status;
    DROP TABLE IF EXISTS nfl_teaser_execution_legs;
    DROP TABLE IF EXISTS nfl_teaser_executions;
  `);
}
