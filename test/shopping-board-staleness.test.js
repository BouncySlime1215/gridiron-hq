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
await import('../server/services/gamescript.js');
const board = await import('../server/services/nfl-shopping-board.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const captured = '2026-09-02T18:00:00Z';
test.beforeEach(t => t.mock.timers.enable({ apis: ['Date'], now: new Date(captured) }));
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

test('cached quotes expire without another ingestion and remain unavailable after kickoff', t => {
  board.clearShoppingBoardCache();
  assert.ok(board.simultaneousQuotes('spreads').length);
  t.mock.timers.tick(16 * 60 * 1000);
  assert.equal(board.simultaneousQuotes('spreads').length, 0);
  assert.equal(board.executionBoardSummary().stale, true);
});

// a6-money-path: the exact-equality MAX(captured_at) join used to drop a book
// unless its own poll happened to land at the EVENT's single latest instant.
// Books are polled on separate schedules, so a book only a few minutes behind
// the freshest one is not stale -- it is the normal staggered-tier case this
// module exists to handle, and the old join reported it as absent instead of
// as a real second book to shop against.
test('two books polled a few minutes apart in the same round are both shown, not just whichever was polled last', () => {
  const snapAt = (book, capturedAt) => run(`INSERT INTO nfl_line_snapshots
    (captured_at,event_id,commence_time,home_team,away_team,book,market,side,line,price,provider,book_updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, capturedAt, 'nfl:2026-09-13:NYJ@NE', '2026-09-13T17:00:01Z',
    'New England Patriots', 'New York Jets', book, 'spreads', 'New England Patriots', -3, -110, 'free:oddstrader', capturedAt);
  const t0 = new Date(captured);
  snapAt('pinnacle', t0.toISOString());
  snapAt('circa', new Date(t0.getTime() - 3 * 60 * 1000).toISOString()); // 3 minutes earlier, still one polling round

  board.clearShoppingBoardCache();
  const ev = board.simultaneousQuotes('spreads').find(s => s.event_id === 'nfl:2026-09-13:NYJ@NE');
  assert.ok(ev, 'the event is reported');
  assert.equal(ev.books, 2, 'a book polled 3 minutes earlier in the same round still counts');
  assert.ok(ev.quotes.some(q => q.book === 'circa'));
});

test('a book whose own latest poll trails the event\'s freshest book past the capture window is excluded from the comparison, even though it is not stale on its own', () => {
  const snapAt = (book, capturedAt) => run(`INSERT INTO nfl_line_snapshots
    (captured_at,event_id,commence_time,home_team,away_team,book,market,side,line,price,provider,book_updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, capturedAt, 'nfl:2026-09-13:LAC@LV', '2026-09-13T17:00:01Z',
    'Las Vegas Raiders', 'Los Angeles Chargers', book, 'spreads', 'Las Vegas Raiders', -3, -110, 'free:oddstrader', capturedAt);
  const t0 = new Date(captured);
  snapAt('pinnacle', t0.toISOString());
  snapAt('circa', new Date(t0.getTime() - 2 * 60 * 1000).toISOString());
  // draftkings' own quote is 10 minutes behind pinnacle -- well within the
  // 15-minute overall staleness window (isFreshQuote/quoteClockValid would
  // pass it on its own) but outside the 5-minute capture window this
  // comparison is bounded to.
  snapAt('draftkings', new Date(t0.getTime() - 10 * 60 * 1000).toISOString());

  board.clearShoppingBoardCache();
  const ev = board.simultaneousQuotes('spreads').find(s => s.event_id === 'nfl:2026-09-13:LAC@LV');
  assert.ok(ev);
  assert.equal(ev.books, 2, 'the 10-minutes-behind book is excluded from this comparison');
  assert.ok(!ev.quotes.some(q => q.book === 'draftkings'));
});

// a6-money-path: bestExecution() (nfl-execution-edge.js) throws once it tries
// to convert a sub-100-magnitude price to decimal odds, and the old call site
// here only filtered on Number.isFinite(american_price) -- which a captured
// 0 passes. One bad ingestion row used to crash the entire shoppingBoard()
// response; it must instead just be dropped from the comparison.
test('a captured price of 0 does not crash the shopping board and is dropped from the comparison', () => {
  const snapAt = (book, price) => run(`INSERT INTO nfl_line_snapshots
    (captured_at,event_id,commence_time,home_team,away_team,book,market,side,line,price,provider,book_updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, captured, 'nfl:2026-09-13:GB@CHI', '2026-09-13T17:00:01Z',
    'Chicago Bears', 'Green Bay Packers', book, 'spreads', 'Chicago Bears', -3, price, 'free:oddstrader', captured);
  snapAt('pinnacle', -110);
  snapAt('fanduel', -105);
  snapAt('brokenfeed', 0);

  board.clearShoppingBoardCache();
  assert.doesNotThrow(() => board.shoppingBoard({ market: 'spreads' }));
  const rowsOut = board.shoppingBoard({ market: 'spreads' });
  const bears = rowsOut.find(r => r.event_id === 'nfl:2026-09-13:GB@CHI' && r.side === 'Chicago Bears');
  assert.ok(bears, 'the side is still boarded from the two real prices');
  assert.notEqual(bears.best_book, 'brokenfeed');
  assert.ok(['pinnacle', 'fanduel'].includes(bears.best_book));
});
