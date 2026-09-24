export const name = '088_coach_briefs';
/**
 * COACH-BRIEF (COACH-ANCHOR.md job 6). Additive only: one new table.
 *
 * `coach_briefs` — Coach's morning brief, weekly itinerary check-in and
 * next-move push text, one row per (league, kind, plan version, window). The
 * brief is built from the plans file plus the overnight rows, with no model
 * call; caching it means a second read of the same plan in the same window is
 * a lookup, and a new plan version (or a new morning) builds a fresh one.
 *
 *   kind          'morning' | 'weekly' | 'push'
 *   plan_version  server/services/coach/brief.js#planVersion: generated_at,
 *                 producer version, objective version and next-move key
 *   window_key    'morning': the ET date; 'weekly': the NFL week; 'push': the
 *                 from->to next-move keys, so one change drafts one text
 *   body          the brief as JSON: the grounded claims, what was dropped by
 *                 the check and why, and the text Nick reads
 *
 * Written and read only by server/services/coach/brief.js. Nothing is sent
 * from here: the push text is a draft PUSH-01 can deliver.
 *
 * Numbered 088: 087 is claimed by four open branches (push-01, broken-q,
 * bandit-01, autopsy-01).
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS coach_briefs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('morning', 'weekly', 'push')),
      plan_version TEXT NOT NULL,
      window_key TEXT NOT NULL,
      body TEXT NOT NULL,
      claims_kept INTEGER NOT NULL DEFAULT 0,
      claims_dropped INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_coach_briefs_key
      ON coach_briefs(league_id, kind, plan_version, window_key);
  `);
}

export function down(db) {
  db.exec('DROP INDEX IF EXISTS idx_coach_briefs_key');
  db.exec('DROP TABLE IF EXISTS coach_briefs');
}
