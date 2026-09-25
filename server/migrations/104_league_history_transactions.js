export const name = '104_league_history_transactions';
/**
 * HISTORY-INGEST (LIVING-01b re-gate, part 4). Additive: one new table.
 *
 * `league_history_transactions` — PAST seasons' ESPN transactions, in
 * league_transactions_raw's own shape, written only by
 * server/services/league-history-tx.js with GRIDIRON_HISTORY_INGEST=1. A table of
 * its own because several served readers of league_transactions_raw
 * (follow-ledger, waiver-runs, warroom-negotiate, decided-offers, league-adapter)
 * do not filter by season: a past season's rows there would move served numbers.
 * The current season stays the forward collector's
 * (scripts/collect-league-transactions.mjs).
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS league_history_transactions (
      league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
      type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
      team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
      bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
      source TEXT NOT NULL, first_seen_at TEXT NOT NULL,
      PRIMARY KEY (league_id, season, tx_id)
    )`);
}

export function down(db) {
  db.exec('DROP TABLE IF EXISTS league_history_transactions');
}
