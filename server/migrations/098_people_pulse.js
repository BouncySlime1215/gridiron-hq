export const name = '098_people_pulse';
/**
 * PULSE-01 (PEOPLE-FLOW §2, M9). Additive only: two new tables.
 *
 * `people_pulse` — one row per labelled statement a league-mate made in the chat:
 * statement type, speaker roster, the players and position it names, and the weight
 * it carries (its follow-through). LABELS ONLY: no message text, no names. `msg_id` is
 * the local chat DB's row id; (league, msg_id, stmt_key = type|players|pos) is unique, so a
 * re-run never stores the same statement twice.
 * Written by server/services/people/pulse.js#pulseTick (run by scripts/people/pulse.mjs
 * from the refresh loop); read by the War Room ticker and by the engine adapter
 * `people_pulse` (event type people.statement). Append-only.
 *
 * `people_pulse_runs` — one row per pulse pass per league: which chat rows it read, what
 * it labelled, and whether it asked the planner to replan (and what came of that).
 *
 * Numbered 098: next free in MIGRATIONS.md (row added there).
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS people_pulse (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id INTEGER NOT NULL,
      roster_id INTEGER NOT NULL,
      msg_id INTEGER NOT NULL,
      chat_kind TEXT,
      as_of TEXT NOT NULL,
      statement_type TEXT NOT NULL,
      stmt_key TEXT NOT NULL,
      player_ids_json TEXT NOT NULL DEFAULT '[]',
      pos TEXT,
      own INTEGER,
      style TEXT,
      conf REAL,
      weight REAL,
      weight_basis TEXT,
      credible INTEGER NOT NULL DEFAULT 0,
      live INTEGER NOT NULL DEFAULT 1,
      labeller_version TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (league_id, msg_id, stmt_key)
    );
    CREATE INDEX IF NOT EXISTS people_pulse_league_time ON people_pulse (league_id, as_of);
    CREATE TABLE IF NOT EXISTS people_pulse_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id INTEGER NOT NULL,
      ran_at TEXT NOT NULL,
      from_msg_id INTEGER,
      to_msg_id INTEGER,
      messages_read INTEGER NOT NULL,
      statements INTEGER NOT NULL,
      credible INTEGER NOT NULL,
      backfill INTEGER NOT NULL DEFAULT 0,
      replan_status TEXT,
      replan_detail TEXT,
      labeller_version TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS people_pulse_runs_league ON people_pulse_runs (league_id, id);
  `);
}

export function down(db) {
  db.exec('DROP TABLE IF EXISTS people_pulse_runs; DROP TABLE IF EXISTS people_pulse');
}
