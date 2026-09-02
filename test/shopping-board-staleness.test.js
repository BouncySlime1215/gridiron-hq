import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// The shopping board and the middle finder must never compare a stale
// aggregator quote against a fresh one as if both were live prices, even
// when both share the same `captured_at` instant (see book-feeds.js's
// STALE_BOOK_HOURS docstring for the live evidence that motivated this).
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-board-stale-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/line-shopping.js');
const board = await import('../server/services/nfl-shopping-board.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const captured = '2026-09-02T18:00:00Z';
const snap = (book, side, line, price, bookUpdatedAt) => run(`INSERT INTO nfl_line_snapshots
  (captured_at,event_id,commence_time,home_team,away_team,book,market,side,line,price,provider,book_updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, captured, 'nfl:2026-09-13:DEN@KC', '2026-09-13T17:00:01Z',
'Kansas City Chiefs', 'Denver Broncos', book, 'spreads', side, line, price, 'free:oddstrader', bookUpdatedAt);

test('a quote captured at the fresh instant but stamped weeks old is excluded from the board', () => {
  // Fresh: pinnacle and bovada both actually refreshed today.
  snap('pinnacle', 'Kansas City Chiefs', -3, -110, captured);
  snap('bovada', 'Kansas City Chiefs', -3, -105, captured);
  // Stale: unibet's own price has not been re-polled in 12 days, even though our
  // capture batch shares the same timestamp as the fresh books above.
  const staleAt = '2026-08-21T18:00:00Z';
  snap('unibet', 'Kansas City Chiefs', -1.5, -118, staleAt);

  const sets = board.simultaneousQuotes('spreads');
  const ev = sets.find(s => s.event_id === 'nfl:2026-09-13:DEN@KC');
  assert.ok(ev, 'the event is still reported');
  assert.equal(ev.books, 2, 'only the two fresh books count');
  assert.ok(!ev.quotes.some(q => q.book === 'unibet'), 'the stale unibet quote is dropped');

  const rows = board.shoppingBoard({ market: 'spreads' });
  const kc = rows.find(r => r.event_id === 'nfl:2026-09-13:DEN@KC' && r.side === 'Kansas City Chiefs');
  assert.ok(kc, 'the side is still boarded from the fresh books');
  assert.notEqual(kc.best?.book, 'unibet', 'the stale price never wins best execution');
});

test('an event whose only fresh quote is a single book is skipped, not reported as a one-book board', () => {
  const snap2 = (book, side, line, price, bookUpdatedAt) => run(`INSERT INTO nfl_line_snapshots
    (captured_at,event_id,commence_time,home_team,away_team,book,market,side,line,price,provider,book_updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, captured, 'nfl:2026-09-13:BUF@MIA', '2026-09-13T17:00:01Z',
  'Miami Dolphins', 'Buffalo Bills', book, 'spreads', side, line, price, 'free:oddstrader', bookUpdatedAt);
  snap2('pinnacle', 'Miami Dolphins', 3, -110, captured);
  const staleAt = '2026-07-01T00:00:00Z';
  snap2('lowvig', 'Miami Dolphins', 3.5, -110, staleAt);

  board.clearShoppingBoardCache();
  const sets = board.simultaneousQuotes('spreads');
  const ev = sets.find(s => s.event_id === 'nfl:2026-09-13:BUF@MIA');
  assert.equal(ev, undefined, 'one fresh book plus one stale one is not a shopping decision');
});
