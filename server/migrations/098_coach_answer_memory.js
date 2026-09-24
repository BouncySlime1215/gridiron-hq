export const name = '098_coach_answer_memory';
/**
 * COACH-LINK (3). Additive only: one new table and its index.
 *
 * `coach_answer_memory` — one row per Coach answer that passed the grounding
 * check (verify.js) with at least one claim. It keeps what was said and what it
 * stood on: the claims with their cites, every number served with the cell that
 * grounded it, each cited source (tool, tables, column, value), and a stamp per
 * source taken at answer time. recall.js reads it: a row whose stamps no longer
 * match what the sources hold now, or that is past its age limit, is stale and
 * is served without its numbers.
 *
 * coach_answers (audit.js) already records every answer, verified or not, for
 * the grounding rate; this is the subset Coach may cite back, in the shape
 * recall needs. audit_id points at that row.
 *
 * Numbered 098: docs/handoff/local/MIGRATIONS.md lists 097 as the last reserved
 * number and 098+ as next free; no branch on origin carries 098 or higher.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS coach_answer_memory (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id     INTEGER,
      audit_id      INTEGER,
      asked_at      TEXT NOT NULL,
      question      TEXT NOT NULL,
      claims_json   TEXT NOT NULL,
      served_json   TEXT NOT NULL DEFAULT '[]',
      sources_json  TEXT NOT NULL DEFAULT '[]',
      stamps_json   TEXT NOT NULL DEFAULT '{}',
      entities_json TEXT NOT NULL DEFAULT '[]',
      search_text   TEXT NOT NULL,
      as_of         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_coach_answer_memory_league
      ON coach_answer_memory(league_id, asked_at);
  `);
}

export function down(db) {
  db.exec('DROP INDEX IF EXISTS idx_coach_answer_memory_league');
  db.exec('DROP TABLE IF EXISTS coach_answer_memory');
}
