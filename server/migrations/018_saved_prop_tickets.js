export const name = '018_saved_prop_tickets';

/**
 * Saved MLB prop slips ("My Picks" -> Saved Slips): singles/parlays the user
 * has actually committed to, as opposed to the in-progress slip still being
 * assembled. This used to be entirely localStorage (client/src/pages/props/lib.ts,
 * TICKETS_KEY) — real split-brain persistence on a single-user app that's
 * opened from more than one browser/device (desktop + phone via tunnel), since
 * a ticket saved on one never showed up on the other. The transient
 * in-progress slip is a legitimate scratch/draft state and stays client-side;
 * only committed tickets move here.
 *
 * legs_json mirrors the house convention for small structured JSON payload
 * columns (legs_json/outcome_json in 014_profit_execution_triggers.js,
 * spec_json/result_json in 004_model_lab.js) rather than normalizing legs into
 * their own table — a saved ticket's legs are fixed at save time and are
 * always read/written together as one unit, never queried individually.
 *
 * No user scoping: the rest of the props feature (props_auto_picks in
 * server/routes/props.js) has none either — this is a personal single-user
 * app with no multi-tenancy concept for props.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS saved_prop_tickets (
      id TEXT PRIMARY KEY,
      saved_at TEXT NOT NULL,
      legs_json TEXT NOT NULL,
      total_american_odds TEXT,
      total_decimal_odds REAL
    );
    CREATE INDEX IF NOT EXISTS idx_saved_prop_tickets_saved_at ON saved_prop_tickets(saved_at DESC);
  `);
}

export function down(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_saved_prop_tickets_saved_at;
    DROP TABLE IF EXISTS saved_prop_tickets;
  `);
}
