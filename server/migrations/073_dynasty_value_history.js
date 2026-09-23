export const name = '073_dynasty_value_history';
/**
 * FC-SNAP (RL-3-1 + RL-4-3). Additive only: one new table, one new nullable column.
 *
 * `dynasty_value_history` — one row per FantasyCalc price per player per format per
 * UTC day, written by `syncDynastyValues` (server/routes/aggregates.js) in the same
 * loop and from the same response as the `dynasty_values` upsert. `dynasty_values`
 * keeps only the latest price (its upsert destroys the previous one), so before this
 * the app had no FantasyCalc history at all and C12's forward FantasyCalc test had
 * nothing to grade. FantasyCalc forbids its per-player history endpoint; a history we
 * record ourselves from the documented /values/current endpoint is the only lawful one.
 * Append-only: the day's first capture wins (INSERT ... ON CONFLICT DO NOTHING).
 * Read by server/services/dynasty-value-history.js#marketHistory, served at
 * GET /api/trades/:leagueId/market-history/:playerId.
 *
 * `dynasty_values.retired_at` — set when a pull for that format no longer returns
 * the player, cleared when a later pull returns him again. The last price is kept
 * on the row (nothing is nulled or deleted); `currentMarket` skips retired rows so
 * a price FantasyCalc stopped publishing no longer reaches a trade card.
 *
 * Numbered 073: 068 (#93), 071 (queued by RL-1-1) and 072 (#164) are claimed.
 */
const cols = db => db.prepare('PRAGMA table_info(dynasty_values)').all().map(c => c.name);

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dynasty_value_history (
      format_key TEXT NOT NULL,
      player_id INTEGER NOT NULL REFERENCES players(id),
      captured_on TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      value INTEGER,
      redraft_value INTEGER,
      trend30 INTEGER,
      age REAL,
      pos_rank INTEGER,
      PRIMARY KEY (format_key, player_id, captured_on)
    );
    CREATE INDEX IF NOT EXISTS idx_dynasty_value_history_player
      ON dynasty_value_history(player_id, format_key, captured_on);
  `);
  const have = cols(db);
  if (have.length && !have.includes('retired_at')) db.exec('ALTER TABLE dynasty_values ADD COLUMN retired_at TEXT');
}

export function down(db) {
  db.exec('DROP INDEX IF EXISTS idx_dynasty_value_history_player');
  db.exec('DROP TABLE IF EXISTS dynasty_value_history');
  if (cols(db).includes('retired_at')) db.exec('ALTER TABLE dynasty_values DROP COLUMN retired_at');
}
