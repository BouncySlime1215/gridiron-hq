export const name = '044_polymarket_order_book_levels';

/**
 * Keep the order-book ladder that `captureOrderBooks()` already fetches and
 * currently throws away.
 *
 * The function pulls the whole book from the CLOB:
 *
 *     const bids = book.bids ?? [], asks = book.asks ?? [];
 *     const bestBid = bids[bids.length - 1];
 *     const bestAsk = asks[asks.length - 1];
 *
 * and then persists four numbers — `best_bid`, `best_ask`, `bid_size`,
 * `ask_size` — because those are the only columns `polymarket_quotes` has.
 * Levels two and beyond are discarded at the moment of capture, every half
 * hour, since 2026-08-29.
 *
 * That is the reason a depth-aware fill cannot be measured on stored history.
 * `server/services/execution-fill.js` can walk a ladder correctly and is
 * tested against hand-computed fills, but the only book the database can hand
 * it has one level, so every fill larger than the touch comes back bounded:
 * "at least this many shares, at best this average price, remainder unknown."
 * No backfill can fix it — the data was never written.
 *
 * This adds the table so that future captures can. It changes nothing about
 * what is currently stored and breaks no reader: `polymarket_quotes` keeps its
 * touch columns, `polymarketCost()` and `liveBoard()` keep reading them, and
 * this table is additive and joined on (captured_at, condition_id).
 *
 * `level` is the rank away from the touch, 0 being the best price on that
 * side, which is the canonical best-first ordering
 * `execution-fill.js#normalizeLadder` validates. Storing rank rather than
 * relying on insertion order means a reader cannot reintroduce the
 * already-committed bug class of reading the CLOB's arrays from the wrong end:
 * ORDER BY level is unambiguous in a way ORDER BY rowid is not.
 *
 * NOT applied by this change. A fresh migration file only; running it against
 * a real database is a separate, explicit step.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS polymarket_order_book_levels (
      captured_at  TEXT NOT NULL,
      condition_id TEXT NOT NULL,
      side         TEXT NOT NULL CHECK (side IN ('bid','ask')),
      level        INTEGER NOT NULL CHECK (level >= 0),
      price        REAL NOT NULL CHECK (price > 0 AND price < 1),
      size         REAL NOT NULL CHECK (size > 0),
      PRIMARY KEY (captured_at, condition_id, side, level)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pmobl_cond
           ON polymarket_order_book_levels(condition_id, captured_at);`);
}

export function down(db) {
  db.exec(`DROP INDEX IF EXISTS idx_pmobl_cond;`);
  db.exec(`DROP TABLE IF EXISTS polymarket_order_book_levels;`);
}
