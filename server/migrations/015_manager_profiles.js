export const name = '015_manager_profiles';

/** Manager assumptions belong to the durable schema, not a service import. */
export function up(db) {
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='manager_profiles'`).get();
  if (exists) db.exec('ALTER TABLE manager_profiles RENAME TO manager_profiles_legacy');
  db.exec(`
    CREATE TABLE manager_profiles (
      league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
      roster_id TEXT NOT NULL CHECK(length(trim(roster_id)) > 0),
      owner TEXT CHECK(owner IS NULL OR length(owner) <= 160),
      tradeability TEXT NOT NULL DEFAULT 'fair' CHECK(tradeability IN ('never','hard','fair')),
      notes TEXT CHECK(notes IS NULL OR length(notes) <= 500),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (league_id, roster_id)
    );
    CREATE INDEX idx_manager_profiles_league ON manager_profiles(league_id, updated_at DESC);
  `);
  if (exists) {
    db.exec(`
      INSERT OR IGNORE INTO manager_profiles
        (league_id,roster_id,owner,tradeability,notes,updated_at)
      SELECT p.league_id,trim(p.roster_id),substr(p.owner,1,160),
        CASE WHEN p.tradeability IN ('never','hard','fair') THEN p.tradeability ELSE 'fair' END,
        substr(p.notes,1,500),COALESCE(p.updated_at,datetime('now'))
      FROM manager_profiles_legacy p JOIN leagues l ON l.id=p.league_id
      WHERE length(trim(COALESCE(p.roster_id,''))) > 0;
      DROP TABLE manager_profiles_legacy;
    `);
  }
}

export function down(db) {
  db.exec(`DROP INDEX IF EXISTS idx_manager_profiles_league; DROP TABLE IF EXISTS manager_profiles;`);
}
