export const name = '052_line_snapshot_receipt_clock';

/**
 * Nightly look-ahead sweep, 2026-09-15: the same "decision-cutoff query gates
 * a CONTENT clock, not the RECEIPT clock" defect already fixed for
 * `news_items.ingested_at` and `nfl_injuries.modified_at`, this time centered
 * on `nfl_odds_archive` / `nfl_line_snapshots`.
 *
 * `nfl_odds_archive` genuinely has two clocks: `book_updated_at` (the book's
 * own claim about when it moved the price -- a CONTENT clock) and
 * `fetched_at` (when THIS system actually backfilled the row -- the real
 * RECEIPT clock, set from `backfillOddsArchive`'s `fetchedAt` parameter in
 * server/services/odds-archive.js). `odds-archive.js#storeArchiveQuotes`
 * writes archive-sourced rows into `nfl_line_snapshots.captured_at` using
 * `book_updated_at ?? commence_time` -- the CONTENT clock -- so a
 * cutoff-bounded reader (`nfl-expert-council.js`'s `shoppingFor`,
 * `beat-the-close.js`'s `pinnacleLineAt`/`openerFor`) sees a historical
 * (e.g. 2022-2025) game's closing quote as available by its own kickoff, even
 * though this system did not actually possess it until a much later (e.g.
 * 2026) backfill run. `fetched_at` is recorded at write time but never
 * consulted downstream -- this migration and the reads it enables are the fix.
 *
 * Every OTHER writer into `nfl_line_snapshots` (book-feeds.js,
 * book-feeds-extra.js, line-shopping.js, sportsgameodds.js) already stamps
 * `captured_at` with the wall-clock instant of that very capture call --
 * `captured_at` IS the receipt clock for those rows, by construction. Only
 * the archive path collapses the two clocks into one column.
 *
 * WHY LEGACY ROWS ARE NOT ALL HONESTLY RECOVERABLE (same posture as migration
 * 032_quote_receipt_clock.js).
 *
 * For every non-archive row, `received_at = captured_at` is not an invention:
 * it restates a fact already true of how that row was written.
 *
 * For an archive-sourced row, the real receipt instant lives in the matching
 * `nfl_odds_archive` row's `fetched_at` -- but that table is upserted by
 * (eid, book, market, side, phase), so if a later backfill run revised the
 * book's own timestamp for the same key, the CURRENT `fetched_at` no longer
 * describes when THIS OLDER snapshot row (a different `captured_at`, kept by
 * the snapshot table's `INSERT OR IGNORE`) was actually received. Recovery is
 * therefore only trusted where the archive row's `book_updated_at` still
 * matches this snapshot's `captured_at` exactly, alongside the game, book,
 * market and side (side is a full team name in `nfl_line_snapshots` but an
 * abbreviation in `nfl_odds_archive` for spreads/h2h, translated here through
 * `nfl_teams`; totals already share 'Over'/'Under' literally). Where that
 * exact match fails, `receipt_clock_source` is set to 'legacy_unrecoverable'
 * and `received_at` stays NULL -- an honest "we don't know", not a fabricated
 * early clock, matching 032's refusal to backfill `nfl_quote_batches.received_at`
 * from `requested_at`.
 */

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}
function addColumn(db, table, column, type) {
  if (!columns(db, table).includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

// event_id for an archive row is literally `archive:<eid>:<phase>` (8-char
// prefix 'archive:' stripped by substr(event_id,9)).
const EID = `CAST(substr(substr(event_id,9), 1, instr(substr(event_id,9),':')-1) AS INTEGER)`;
const PHASE = `substr(substr(event_id,9), instr(substr(event_id,9),':')+1)`;

const ARCHIVE_MATCH = `
  SELECT oa.fetched_at FROM nfl_odds_archive oa
  LEFT JOIN nfl_teams t ON t.abbr = oa.side
  WHERE oa.eid = ${EID} AND oa.phase = ${PHASE}
    AND oa.book = nfl_line_snapshots.book AND oa.market = nfl_line_snapshots.market
    AND oa.book_updated_at = nfl_line_snapshots.captured_at
    AND ((nfl_line_snapshots.market = 'totals' AND oa.side = nfl_line_snapshots.side)
      OR (nfl_line_snapshots.market IN ('spreads','h2h') AND t.name = nfl_line_snapshots.side))
  LIMIT 1
`;

export function up(db) {
  addColumn(db, 'nfl_line_snapshots', 'received_at', 'TEXT');
  addColumn(db, 'nfl_line_snapshots', 'receipt_clock_source', 'TEXT');

  db.exec(`
    UPDATE nfl_line_snapshots
       SET received_at = captured_at, receipt_clock_source = 'capture_completion'
     WHERE (provider IS NULL OR provider <> 'archive:oddstrader') AND receipt_clock_source IS NULL;
  `);

  db.exec(`
    UPDATE nfl_line_snapshots
       SET received_at = (${ARCHIVE_MATCH}),
           receipt_clock_source = CASE WHEN EXISTS (${ARCHIVE_MATCH}) THEN 'response_completion' ELSE 'legacy_unrecoverable' END
     WHERE provider = 'archive:oddstrader' AND receipt_clock_source IS NULL;
  `);
}

export function down(db) {
  // Same posture as 032: a recovered real receipt clock is not something a
  // downgrade should silently discard the distinction of.
  const observed = db.prepare(
    `SELECT COUNT(*) n FROM nfl_line_snapshots WHERE receipt_clock_source = 'response_completion'`).get()?.n ?? 0;
  if (observed) {
    throw new Error(`052_line_snapshot_receipt_clock: refusing to downgrade — ${observed} row(s) carry a recovered ` +
      'archive receipt clock the earlier schema cannot represent.');
  }
  db.exec(`ALTER TABLE nfl_line_snapshots DROP COLUMN received_at`);
  db.exec(`ALTER TABLE nfl_line_snapshots DROP COLUMN receipt_clock_source`);
}
