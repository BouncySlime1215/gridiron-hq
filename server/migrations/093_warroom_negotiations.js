export const name = '093_warroom_negotiations';
/**
 * NEGOTIATE-UI (WAR-ROOM-UI.md v3, new mode 1). Additive only: two new tables.
 *
 * `warroom_negotiations` — one row per offer Nick marked "I sent it" in the War Room.
 * The step is stored as it was on the card (`step_json`: p_yes, title-odds change,
 * walk-away, message, reply_table) together with the labels it named (`names_json`),
 * so the live thread still shows the branches he sent against after the producer
 * replans and the move leaves the deck. At most one open thread per league, move and
 * step (partial unique index); a closed one keeps its row and says why it closed.
 *
 * `warroom_negotiation_events` — the thread: each reply Nick logs (accept / decline /
 * counter with his ask / silence), each counter Nick sends from the builder, each
 * follow-up. Append-only; nothing here is ever updated.
 *
 * Written and read by server/services/warroom-negotiate.js only. No manager names:
 * teams are roster ids, players are ids plus the labels the plans file already served.
 *
 * Numbered 093: main tops at 073, and 074-088 and 098 are each held by at least one
 * open branch (087 by four of them), so this takes an unclaimed number.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS warroom_negotiations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id INTEGER NOT NULL,
      user_id INTEGER,
      move_id TEXT NOT NULL,
      step_index INTEGER NOT NULL DEFAULT 0,
      partner TEXT NOT NULL,
      give_json TEXT NOT NULL,
      get_json TEXT NOT NULL,
      step_json TEXT NOT NULL,
      names_json TEXT NOT NULL,
      snapshot_id TEXT,
      sent_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
      closed_at TEXT,
      closed_reason TEXT CHECK (closed_reason IS NULL
        OR closed_reason IN ('accepted', 'declined', 'walked_away', 'undone'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_warroom_negotiations_open
      ON warroom_negotiations(league_id, move_id, step_index) WHERE status = 'open';
    CREATE INDEX IF NOT EXISTS idx_warroom_negotiations_league
      ON warroom_negotiations(league_id, sent_at);
    CREATE TABLE IF NOT EXISTS warroom_negotiation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      negotiation_id INTEGER NOT NULL REFERENCES warroom_negotiations(id),
      kind TEXT NOT NULL CHECK (kind IN ('reply', 'counter_sent', 'follow_up')),
      reply TEXT CHECK (reply IS NULL OR reply IN ('accept', 'decline', 'counter', 'silence')),
      give_json TEXT,
      get_json TEXT,
      note TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_warroom_negotiation_events_thread
      ON warroom_negotiation_events(negotiation_id, id);
  `);
}

export function down(db) {
  db.exec('DROP INDEX IF EXISTS idx_warroom_negotiation_events_thread');
  db.exec('DROP TABLE IF EXISTS warroom_negotiation_events');
  db.exec('DROP INDEX IF EXISTS idx_warroom_negotiations_league');
  db.exec('DROP INDEX IF EXISTS idx_warroom_negotiations_open');
  db.exec('DROP TABLE IF EXISTS warroom_negotiations');
}
