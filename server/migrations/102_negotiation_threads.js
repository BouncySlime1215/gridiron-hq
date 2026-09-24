export const name = '102_negotiation_threads';
/**
 * NEGOTIATE-UI (WAR-ROOM-UI.md v3, new mode 1). Additive only: two new tables.
 *
 * `negotiation_threads` — one row per War Room offer Nick marked "I sent it" and is
 * now negotiating. It holds NO sent time of its own: "I sent it" has one store,
 * `trade_outcomes.sent_at` (migration 080, written by
 * warroom-actions/store.js#recordRequest -> trade-outcomes.js#recordSentOffer), and
 * the thread points at that row through `trade_outcome_id`. The step is stored as it
 * was on the card (`step_json`: p_yes, title-odds change, walk-away, message,
 * reply_table) with the labels it named (`names_json`), so the live thread still
 * shows the branches he sent against after the producer replans. At most one open
 * thread per league, move and step (partial unique index); a closed one keeps its
 * row and says why it closed.
 *
 * `negotiation_events` — the thread: each reply Nick logs (accept / decline /
 * counter with his ask / silence), each counter Nick sends from the builder, each
 * follow-up. Append-only.
 *
 * Written and read by server/services/warroom-negotiate.js only. No manager names:
 * teams are roster ids, players are ids plus the labels the plans file served.
 *
 * Numbered 102 (docs/handoff/local/MIGRATIONS.md). New table names, not #309's
 * `warroom_negotiations`: that draft carried its own sent_at, and a stray copy of it
 * on a preview database must not be silently kept by CREATE TABLE IF NOT EXISTS.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS negotiation_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id INTEGER NOT NULL,
      user_id INTEGER,
      trade_outcome_id INTEGER NOT NULL REFERENCES trade_outcomes(id),
      move_id TEXT NOT NULL,
      step_index INTEGER NOT NULL DEFAULT 0,
      partner TEXT NOT NULL,
      give_json TEXT NOT NULL,
      get_json TEXT NOT NULL,
      step_json TEXT NOT NULL,
      names_json TEXT NOT NULL,
      snapshot_id TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
      closed_at TEXT,
      closed_reason TEXT CHECK (closed_reason IS NULL
        OR closed_reason IN ('accepted', 'declined', 'walked_away', 'undone'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_negotiation_threads_open
      ON negotiation_threads(league_id, move_id, step_index) WHERE status = 'open';
    CREATE INDEX IF NOT EXISTS idx_negotiation_threads_outcome
      ON negotiation_threads(trade_outcome_id);
    CREATE TABLE IF NOT EXISTS negotiation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL REFERENCES negotiation_threads(id),
      kind TEXT NOT NULL CHECK (kind IN ('reply', 'counter_sent', 'follow_up')),
      reply TEXT CHECK (reply IS NULL OR reply IN ('accept', 'decline', 'counter', 'silence')),
      give_json TEXT,
      get_json TEXT,
      note TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_negotiation_events_thread
      ON negotiation_events(thread_id, id);
  `);
}

export function down(db) {
  db.exec('DROP INDEX IF EXISTS idx_negotiation_events_thread');
  db.exec('DROP TABLE IF EXISTS negotiation_events');
  db.exec('DROP INDEX IF EXISTS idx_negotiation_threads_outcome');
  db.exec('DROP INDEX IF EXISTS idx_negotiation_threads_open');
  db.exec('DROP TABLE IF EXISTS negotiation_threads');
}
