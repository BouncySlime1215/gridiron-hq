export const name = '066_league_transactions_raw';
/**
 * `league_transactions_raw` — ESPN trade proposals, accepts, declines, vetoes,
 * waivers and drops, WITH the timestamps, which is the whole point of keeping
 * them.
 *
 * The table is not new. It has existed since 2026-09-17 in
 * `scripts/collect-league-transactions.mjs`, which created it at import time
 * with its own `CREATE TABLE IF NOT EXISTS` and then wrote to it. Six server
 * modules read it — `manager-archetypes`, `manager-signals`, `bluff-detector`,
 * `counterparty-pricing`, `trade-engine`, `trade-tactics` — and not one of them
 * writes. The schema below is that script's, character for character in its
 * column set, so this migration is a no-op against the live database and the
 * whole definition on a fresh one.
 *
 * Why it needs a migration at all: `db/index.js` says a service may no longer
 * create schema, and `scripts/schema-snapshot.mjs` proves it by requiring the
 * `baseline` (migrations only) and `full` (migrations plus every module)
 * snapshots to stay byte-identical. Moving the collector into the scheduler
 * registry moves its `CREATE TABLE` onto the server's import path, which is
 * exactly what that proof is there to catch. So the table comes here first and
 * the job is left with nothing to create.
 *
 * `first_seen_at` and `last_seen_at` are both kept because they answer
 * different questions. ESPN's `mTransactions2` view only returns the last
 * ~3 days, so `first_seen_at` is when this install first observed a
 * transaction and `last_seen_at` is the proof that the row is still being
 * refreshed rather than sitting from an old hand-run — the as-of stamp the
 * reading surfaces need, and the reason the upsert below deliberately never
 * overwrites `first_seen_at`.
 *
 * No `down()` that drops the table. Every row in it is outside ESPN's window
 * and cannot be fetched again, so dropping it destroys data that has no source
 * to come back from. A rollback of this migration should leave the table
 * standing; the marker is what comes out.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS league_transactions_raw (
      league_id      INTEGER NOT NULL,
      season         INTEGER NOT NULL,
      tx_id          TEXT NOT NULL,
      type           TEXT,
      status         TEXT,
      execution_type TEXT,
      proposed_at    TEXT,
      processed_at   TEXT,
      team_id        INTEGER,
      member_id      TEXT,
      related_tx_id  TEXT,
      scoring_period INTEGER,
      bid_amount     REAL,
      is_pending     INTEGER,
      items_json     TEXT,
      raw_json       TEXT,
      first_seen_at  TEXT NOT NULL,
      last_seen_at   TEXT NOT NULL,
      PRIMARY KEY (league_id, season, tx_id)
    );
    CREATE INDEX IF NOT EXISTS ltr_proposed
      ON league_transactions_raw(league_id, proposed_at);
  `);
}

export function down(db) {
  // Deliberately leaves the table and its rows in place — see the note above.
  // The index is this migration's own and is safe to drop.
  db.exec(`DROP INDEX IF EXISTS ltr_proposed;`);
}
