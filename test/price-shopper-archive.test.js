import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// The price shopper must build its board from each book's latest pre-kickoff
// quote, whether the books share one capture stamp (live) or carry their own
// (the archive).
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-shopper-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/line-shopping.js');
const { __test } = await import('../server/services/nfl-expert-council.js');

run(`INSERT OR IGNORE INTO nfl_teams (abbr,name,conference,division) VALUES ('DEN','Denver Broncos','AFC','West'),('IND','Indianapolis Colts','AFC','South')`);
const snap = (captured, book, side, line, price) => run(`INSERT INTO nfl_line_snapshots
  (captured_at,event_id,commence_time,home_team,away_team,book,market,side,line,price,provider,book_updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, captured, 'archive:1:close', '2022-10-07T00:15:01Z', 'Denver Broncos', 'Indianapolis Colts',
  book, 'spreads', side, line, price, 'archive:oddstrader', captured);

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('per-book timestamps still yield a multi-book board, and post-kickoff or stale rows are ignored', () => {
  snap('2022-10-06T23:10:00Z', 'pinnacle', 'Denver Broncos', -3, -117);
  snap('2022-10-06T23:50:00Z', 'bovada', 'Denver Broncos', -3, -110);
  snap('2022-10-06T22:00:00Z', 'bovada', 'Denver Broncos', -3.5, -105); // superseded by bovada's later quote
  snap('2022-10-06T23:59:00Z', 'lowvig', 'Denver Broncos', -2.5, -120);
  snap('2022-10-07T00:20:00Z', 'unibet', 'Denver Broncos', -2.5, -110); // after kickoff
  snap('2022-10-06T23:10:00Z', 'pinnacle', 'Indianapolis Colts', 3, -103);
  snap('2022-10-06T23:50:00Z', 'bovada', 'Indianapolis Colts', 3, -110);
  const cutoff = '2022-10-07T00:15:00.000Z';
  const board = __test.shoppingFor('DEN', 'IND', cutoff);
  assert.ok(board, 'a board exists');
  const den = board.sides.find(s => s.team === 'DEN');
  assert.equal(den.books, 3, 'three books, each once, none after kickoff');
  assert.equal(den.best.book, 'lowvig');
  assert.equal(den.best.line, -2.5);
  assert.equal(den.worst.line, -3);
  assert.equal(den.line_advantage, 0.5);
  assert.equal(board.sides.find(s => s.team === 'IND').books, 2);
});
