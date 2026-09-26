export const name = '114_coach_threads';
/**
 * COACH-CHAT: Coach conversations. One active thread per (user, league) plus any
 * number of archived ones ("New conversation" archives the active one).
 *
 *   coach_threads   the thread: its current focus (the move, partner and players
 *                   under discussion, as ids) and a rolling structured summary of
 *                   the turns that fell out of the retention window (intents and
 *                   ids, never the text).
 *   coach_messages  the retained turns, Nick's question and Coach's reply. The
 *                   reply's payload is the grounded answer the route returned
 *                   (claims with cites, refusals, the ledger they cite, follow-up
 *                   chips), so a reopened drawer shows exactly what was shown.
 *
 * Local-only data in the gitignored database; written only by
 * services/coach/threads.js.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS coach_threads (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL,
      league_id     INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      focus_json    TEXT NOT NULL DEFAULT '{}',
      summary_json  TEXT NOT NULL DEFAULT '{}',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_coach_threads_active
      ON coach_threads(user_id, league_id) WHERE status = 'active';
    CREATE TABLE IF NOT EXISTS coach_messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id     INTEGER NOT NULL REFERENCES coach_threads(id) ON DELETE CASCADE,
      role          TEXT NOT NULL CHECK (role IN ('nick', 'coach')),
      text          TEXT NOT NULL,
      intent        TEXT,
      payload_json  TEXT NOT NULL DEFAULT '{}',
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_coach_messages_thread ON coach_messages(thread_id, id);
  `);
}

export function down(db) {
  db.exec(`DROP INDEX IF EXISTS idx_coach_messages_thread;
           DROP TABLE IF EXISTS coach_messages;
           DROP INDEX IF EXISTS idx_coach_threads_active;
           DROP TABLE IF EXISTS coach_threads;`);
}
