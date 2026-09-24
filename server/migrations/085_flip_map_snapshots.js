export const name = '085_flip_map_snapshots';
/**
 * FLIP-01. Additive only: one new table.
 *
 * `flip_map_snapshots` — one row per flip-radar run (nightly, or on news about
 * a rostered player). `section_json` is the `flip_map` section of the War Room
 * plans contract (plans-schema.js, PR #238), already typed; `names_json` holds
 * the display name of every player id it names; `managers_json` is each
 * league-mate's clone price vs title value for his key players; `trigger_ref`
 * names the news signals that triggered a news run. A failed run is a row too,
 * with `error` set, so a radar that stopped working says so.
 * Read by server/services/flip-radar/flip-radar.js#latestFlipMap.
 *
 * Numbered 085: 082 (follow ledger), 083 (eval seams) and 084 (offer
 * snapshots) are claimed.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS flip_map_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id INTEGER NOT NULL,
      trigger TEXT NOT NULL CHECK (trigger IN ('nightly', 'news', 'manual')),
      trigger_ref TEXT,
      generated_at TEXT NOT NULL,
      days_to_deadline INTEGER,
      pairs_n INTEGER NOT NULL DEFAULT 0,
      flips_n INTEGER NOT NULL DEFAULT 0,
      section_json TEXT,
      names_json TEXT,
      managers_json TEXT,
      runtime_ms INTEGER,
      rescores INTEGER,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_flip_map_snapshots_league
      ON flip_map_snapshots(league_id, generated_at);
  `);
}

export function down(db) {
  db.exec('DROP INDEX IF EXISTS idx_flip_map_snapshots_league');
  db.exec('DROP TABLE IF EXISTS flip_map_snapshots');
}
