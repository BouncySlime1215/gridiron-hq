/**
 * Regression coverage for the receipt-clock fix in nfl-expert-council.js's
 * shoppingFor: the decision-cutoff gate (`captured_at<=cutoff`) was a CONTENT
 * clock for archive-sourced rows -- odds-archive.js#storeArchiveQuotes writes
 * `nfl_line_snapshots.captured_at` from the book's own `book_updated_at`, not
 * from this system's real receipt instant (`nfl_odds_archive.fetched_at`,
 * carried into `nfl_line_snapshots.received_at` by migration
 * 052_line_snapshot_receipt_clock.js). A historical game's cutoff could see a
 * closing quote the system did not actually possess until a much later
 * backfill run -- the same look-ahead class already closed for
 * news_items.ingested_at (test/nfl-expert-council-news-feed-cutoff.test.js)
 * and nfl_injuries.modified_at (test/nfl-team-card-injury-cutoff.test.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-shopping-receipt-cutoff-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();

const { __test } = await import('../server/services/nfl-expert-council.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// Each test uses its own team pair so rows seeded by one test can never be
// picked up by another (same isolation strategy as the sibling cutoff tests).
// shoppingFor requires at least 2 distinct books per side to put that side on
// the board at all, so every fixture below seeds 2+ per side.
let nextTeamId = 1101;
function seedTeamPair() {
  const homeId = nextTeamId++, awayId = nextTeamId++;
  const home = `Z${homeId}`, away = `Z${awayId}`;
  run(`INSERT INTO nfl_teams (id,abbr,name,conference,division) VALUES (?,?,?,'AFC','East')`, homeId, home, `${home} City`);
  run(`INSERT INTO nfl_teams (id,abbr,name,conference,division) VALUES (?,?,?,'AFC','East')`, awayId, away, `${away} City`);
  return { home, away, homeName: `${home} City`, awayName: `${away} City` };
}

function seedArchiveSnapshot({ homeName, awayName, capturedAt, receivedAt, book, side, line = -3, price = -110 }) {
  run(`INSERT INTO nfl_line_snapshots
    (captured_at,event_id,commence_time,home_team,away_team,book,market,side,line,price,provider,book_updated_at,received_at,receipt_clock_source)
    VALUES (?,?,?,?,?,?,'spreads',?,?,?,'archive:oddstrader',?,?,?)`,
  capturedAt, `archive:1:close`, '2022-10-07T00:15:01Z', homeName, awayName, book, side, line, price,
  capturedAt, receivedAt, receivedAt == null ? 'legacy_unrecoverable' : 'response_completion');
}

const CUTOFF = '2022-10-07T00:15:00.000Z'; // one second before kickoff

test('shoppingFor: quotes posted before the cutoff but not received by this system until after it are excluded', () => {
  const { home, away, homeName, awayName } = seedTeamPair();
  // Both books posted Wednesday (well before Friday's cutoff), but the system
  // did not actually backfill either one until well after kickoff -- e.g. a
  // 2026 sweep of a 2022 season game. Pre-fix, this built a real 2-book board.
  for (const side of [homeName, awayName]) {
    seedArchiveSnapshot({ homeName, awayName, capturedAt: '2022-10-05T18:00:00Z', receivedAt: '2026-01-01T00:00:00Z', book: 'pinnacle', side, line: side === homeName ? -3 : 3 });
    seedArchiveSnapshot({ homeName, awayName, capturedAt: '2022-10-06T12:00:00Z', receivedAt: '2026-01-01T00:00:00Z', book: 'bovada', side, line: side === homeName ? -2.5 : 2.5 });
  }

  const board = __test.shoppingFor(home, away, CUTOFF);
  assert.equal(board, null, 'a quote not actually received by this system before the cutoff must not be usable, ' +
    'regardless of how early the book itself posted it');
});

test('shoppingFor: quotes posted and received before the cutoff still build a board (happy path preserved)', () => {
  const { home, away, homeName, awayName } = seedTeamPair();
  for (const side of [homeName, awayName]) {
    seedArchiveSnapshot({ homeName, awayName, capturedAt: '2022-10-06T23:10:00Z', receivedAt: '2022-10-06T23:15:00Z', book: 'pinnacle', side, line: side === homeName ? -3 : 3 });
    seedArchiveSnapshot({ homeName, awayName, capturedAt: '2022-10-06T23:50:00Z', receivedAt: '2022-10-06T23:55:00Z', book: 'bovada', side, line: side === homeName ? -2.5 : 2.5 });
  }

  const board = __test.shoppingFor(home, away, CUTOFF);
  assert.ok(board, 'a board is built when every quote was genuinely known by the cutoff');
  const homeSide = board.sides.find(s => s.team === home);
  assert.equal(homeSide.books, 2);
});

test('shoppingFor: a legacy row with no recoverable receipt clock (received_at NULL) is invisible, not silently trusted', () => {
  const { home, away, homeName, awayName } = seedTeamPair();
  for (const side of [homeName, awayName]) {
    seedArchiveSnapshot({ homeName, awayName, capturedAt: '2022-10-05T18:00:00Z', receivedAt: null, book: 'pinnacle', side, line: side === homeName ? -3 : 3 });
    seedArchiveSnapshot({ homeName, awayName, capturedAt: '2022-10-06T12:00:00Z', receivedAt: null, book: 'bovada', side, line: side === homeName ? -2.5 : 2.5 });
  }

  const board = __test.shoppingFor(home, away, CUTOFF);
  assert.equal(board, null, 'without a known receipt clock there is no evidence this system had the quotes by the cutoff');
});

test('shoppingFor: mixing on-time and late-received quotes only counts the on-time ones', () => {
  const { home, away, homeName, awayName } = seedTeamPair();
  // Home: three books, one of them (lowvig) never actually received by the
  // cutoff -- if it leaked through it would win "best" outright at -1.
  seedArchiveSnapshot({ homeName, awayName, capturedAt: '2022-10-06T23:10:00Z', receivedAt: '2022-10-06T23:15:00Z', book: 'pinnacle', side: homeName, line: -3 });
  seedArchiveSnapshot({ homeName, awayName, capturedAt: '2022-10-06T23:50:00Z', receivedAt: '2022-10-06T23:55:00Z', book: 'bovada', side: homeName, line: -2.5 });
  seedArchiveSnapshot({ homeName, awayName, capturedAt: '2022-10-06T23:59:00Z', receivedAt: '2026-01-01T00:00:00Z', book: 'lowvig', side: homeName, line: -1 });
  // Away: two on-time books, straightforward control.
  seedArchiveSnapshot({ homeName, awayName, capturedAt: '2022-10-06T23:10:00Z', receivedAt: '2022-10-06T23:15:00Z', book: 'pinnacle', side: awayName, line: 3 });
  seedArchiveSnapshot({ homeName, awayName, capturedAt: '2022-10-06T23:50:00Z', receivedAt: '2022-10-06T23:55:00Z', book: 'bovada', side: awayName, line: 2.5 });

  const board = __test.shoppingFor(home, away, CUTOFF);
  assert.ok(board);
  const homeSide = board.sides.find(s => s.team === home);
  assert.equal(homeSide.books, 2, 'only the two on-time books count; the late-received lowvig quote is excluded');
  assert.equal(homeSide.best.book, 'bovada', 'bovada -2.5, not lowvig -1, since lowvig was never actually received by the cutoff');
});
