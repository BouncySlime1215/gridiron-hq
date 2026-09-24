export const name = '099_people_credibility';
/**
 * CRED-01. Additive only: one new table.
 *
 * `people_credibility` — per league x as_of x method x roster x statement type
 * x window: how often that manager's statements of that type turned into the
 * matching action (follow-through lift), shrunk to the league, with a status
 * and the weight consumers apply. roster_id '*' is the league-pooled row.
 * Written nightly by scripts/people/credibility.mjs through
 * server/services/people/credibility.js#storeCredibility (the one producer of
 * people.credibility); read by #readCredibility, which picks the newest as_of
 * at or before the caller's cut so backtests never see a later run.
 * Labels and counts only: no message text, no names.
 *
 * Numbered 099 per docs/handoff MIGRATIONS.md (098 is PULSE-01 #316).
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS people_credibility (
      league_id INTEGER NOT NULL,
      as_of TEXT NOT NULL,
      method_version TEXT NOT NULL,
      roster_id TEXT NOT NULL,
      stmt_type TEXT NOT NULL,
      window_days INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      n_statements INTEGER NOT NULL DEFAULT 0,
      hits REAL,
      base_hits REAL,
      base_n REAL,
      rate REAL,
      base_rate REAL,
      lift_raw REAL,
      lift_shrunk REAL,
      league_lift REAL,
      league_ci_lo REAL,
      league_ci_hi REAL,
      league_n INTEGER,
      league_managers INTEGER,
      p_value REAL,
      status TEXT NOT NULL CHECK (status IN ('proven','manager_split','noise','unknown')),
      weight REAL,
      computed_at TEXT NOT NULL,
      PRIMARY KEY (league_id, as_of, method_version, roster_id, stmt_type, window_days)
    );
    CREATE INDEX IF NOT EXISTS people_credibility_latest
      ON people_credibility (league_id, method_version, as_of);
  `);
}

export function down(db) {
  db.exec('DROP TABLE IF EXISTS people_credibility');
}
