export const name = '032_quote_receipt_clock';

/**
 * Codex correction C11 (2026-09-10): the T-60 packet counted a quote as
 * "received by cutoff" using `nfl_quote_batches.requested_at`.
 *
 * `requested_at` is stamped BEFORE the provider request is issued. The receipt
 * clock a prospective claim depends on is when the response actually completed
 * and this system held the value. Those are different instants, and the
 * difference has a direction that always errs the wrong way:
 *
 *     requested_at  <=  received_at
 *
 * So using the request time makes every quote look like it arrived EARLIER
 * than it did. The audit's CAR-CHI fixture counted a quote whose request went
 * out before the cutoff and whose response landed after it as
 * `received_by_cutoff` -- a decision claiming to have used a price it did not
 * yet have. That is the exact shape of a look-ahead, produced by a clock
 * mislabel rather than by anyone reaching for future data.
 *
 * This migration adds the real clock, and -- just as importantly -- refuses to
 * invent one for rows that predate it.
 *
 * WHY LEGACY ROWS ARE NOT BACKFILLED FROM `requested_at`.
 *
 * It would be one line to set `received_at = requested_at` for every existing
 * batch, and every historical packet would keep working exactly as before.
 * That is precisely the defect, written into the data instead of the query.
 * A backfilled row would assert a receipt instant this system never observed,
 * and would assert it EARLY, which is the direction that admits evidence a
 * decision could not have had.
 *
 * Instead every batch carries `receipt_clock_source`:
 *
 *   'response_completion'        - `received_at` is a real observed receipt.
 *                                  Eligible to support a prospective claim.
 *   'legacy_request_time_only'   - only the request time was ever recorded.
 *                                  `received_at` holds it as the best known
 *                                  LOWER BOUND, and the packet must treat such
 *                                  a row as `availability_unknown` in
 *                                  prospective mode rather than as knowable.
 *
 * The consequence is deliberate and is the honest one: existing quote history
 * can no longer support a real prospective claim. It remains fully usable for
 * labeled historical work, where the weaker claim is stated rather than
 * assumed. New captures record the true clock from the moment this ships.
 */

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

export function up(db) {
  const existing = columns(db, 'nfl_quote_batches');
  if (!existing.length) return; // fresh install; the schema module creates it with these columns

  if (!existing.includes('received_at')) {
    db.exec(`ALTER TABLE nfl_quote_batches ADD COLUMN received_at TEXT`);
  }
  if (!existing.includes('receipt_clock_source')) {
    db.exec(`ALTER TABLE nfl_quote_batches ADD COLUMN receipt_clock_source TEXT`);
  }

  // Every batch that already exists was written by the ingestion path that
  // recorded only a request time. It is marked as such, and `received_at`
  // holds that time explicitly labelled as a lower bound -- never as an
  // observed receipt.
  //
  // `nfl_quote_batches` carries an append-only trigger, so this UPDATE aborts
  // with "quote batches are immutable" on any database holding a batch -- and
  // the live one holds 1,152. Since runMigrations() is awaited before any route
  // module imports, that is not a bad row: it is an application that cannot
  // start, deterministically, on every boot, with 031 already committed and the
  // database pinned one migration short. A fresh database has no batches, the
  // UPDATE matches nothing, the trigger never fires, and every test passes.
  //
  // Same shape as the defect found in 031, and found the same way: by running
  // the migration against real data instead of an empty fixture. The lesson is
  // that "this table has an append-only trigger" is a property to check BEFORE
  // writing a backfill, not after.
  //
  // The trigger is lifted for the backfill and restored immediately, inside the
  // transaction the migration runner already holds. Unlike the foreign-key case
  // in the 027 preflight repair, no PRAGMA is involved, so ordinary DDL inside
  // the transaction is sufficient and correct.
  //
  // Lifting it is legitimate here for the same reason it was in 031: these rows
  // predate the receipt contract, and the backfill assigns them the clock
  // columns that contract requires -- explicitly labelled as a lower bound --
  // while changing no recorded quote, price or timestamp. Immutability protects
  // captured evidence from being rewritten, and this rewrites none.
  db.exec(`DROP TRIGGER IF EXISTS nfl_quote_batches_no_update`);
  db.exec(`
    UPDATE nfl_quote_batches
       SET received_at = COALESCE(received_at, requested_at),
           receipt_clock_source = COALESCE(receipt_clock_source, 'legacy_request_time_only')
     WHERE receipt_clock_source IS NULL;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS nfl_quote_batches_no_update
      BEFORE UPDATE ON nfl_quote_batches
      BEGIN SELECT RAISE(ABORT, 'quote batches are immutable'); END;
  `);

  // The corrected packet predicate scopes a game by its canonical event --
  // both teams and the kickoff instant -- and by market and period, then
  // filters on the receipt clock. C11 asks for the corrected predicate to be
  // indexed rather than for the wrong one to be made fast, which is what
  // migration 029 did: `idx_nfl_quote_commence` makes a kickoff-only lookup
  // quick, and a kickoff-only lookup is the cross-game bug.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_nfl_quote_event_scope
      ON nfl_quote_tape(commence_time, home_team, away_team, market, period);
  `);
}

export function down(db) {
  // The index is the only reversible part. Dropping the columns would destroy
  // the distinction between an observed receipt and a request time, which is
  // the entire content of this migration; a later re-upgrade could not tell
  // which rows had real clocks and would have to assume the unsafe answer.
  const observed = db.prepare(
    `SELECT COUNT(*) n FROM nfl_quote_batches WHERE receipt_clock_source = 'response_completion'`).get()?.n ?? 0;
  if (observed) {
    throw new Error(
      `032_quote_receipt_clock: refusing to downgrade — ${observed} batch(es) carry a real observed receipt ` +
      'clock that the earlier schema cannot represent. Downgrading would silently re-label them as request ' +
      'times, which is the look-ahead this migration exists to remove.');
  }
  db.exec(`DROP INDEX IF EXISTS idx_nfl_quote_event_scope;`);
}
