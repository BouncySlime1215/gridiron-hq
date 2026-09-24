export const name = '079_served_numbers';
/**
 * IDEA-001 serve-log. Additive only: one new table, two indexes.
 *
 * `served_numbers` — one row per number the app actually served on a trade card,
 * a title-odds surface or a range (a ±2 SE band, a 95% interval, a p10/p90 lineup
 * delta), stamped with what produced it. Written by server/services/serve-log.js,
 * never on the request thread: a route pushes its payload onto an in-memory queue
 * and the flush loop writes it. The weekly snapshot job (`served_numbers_weekly`)
 * writes the same shape once per league per NFL week, whether or not anyone
 * opened a page.
 *
 * Why: grading a model by REPLAYING it grades the code as it is today, not the
 * number Nick read on the day. This keeps the number as served, so a later
 * grader compares an outcome against exactly that.
 *
 * `entity` is what the number is about: `deal:<me>|<partner>|<give ids>><get ids>`
 * for a trade, `team:<roster id>` for a team's odds. `as_of` is the league state
 * the number was computed from (`leagues.fetched_at`); `served_at` is when it
 * left the server. `request_id` groups every number from one response (and one
 * weekly snapshot run) and is sent to the client as `X-Served-Request-Id`.
 *
 * Numbered 079: 076 (#230), 077 (BROKEN-01) and 078 (EVAL) are claimed.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS served_numbers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id INTEGER NOT NULL,
      surface TEXT NOT NULL,
      entity TEXT NOT NULL,
      field TEXT NOT NULL,
      value REAL,
      model TEXT NOT NULL,
      model_version TEXT,
      as_of TEXT,
      served_at TEXT NOT NULL,
      request_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      season INTEGER,
      week INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_served_numbers_entity
      ON served_numbers(league_id, entity, field, served_at);
    CREATE INDEX IF NOT EXISTS idx_served_numbers_request
      ON served_numbers(request_id);
  `);
}

export function down(db) {
  db.exec('DROP INDEX IF EXISTS idx_served_numbers_request');
  db.exec('DROP INDEX IF EXISTS idx_served_numbers_entity');
  db.exec('DROP TABLE IF EXISTS served_numbers');
}
