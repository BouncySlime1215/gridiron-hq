/**
 * Regression coverage for two fixes in beat-the-close.js's pinnacleLineAt and
 * openerFor, found in the same nightly sweep as the shoppingFor receipt-clock
 * fix (test/nfl-expert-council-shopping-receipt-cutoff.test.js):
 *
 * 1. CONTENT-clock gap: pinnacleLineAt's archived-close branch had no
 *    `book_updated_at<=before` filter at all -- unlike the live branch, which
 *    already required `captured_at<=before`. An archived row whose
 *    book_updated_at fell AFTER `before` (in-game price action) could still
 *    be picked whenever its gap to `before` was small enough, violating the
 *    function's own documented invariant: "A quote is never taken from after
 *    `before` -- CLV must not leak in-game price action."
 *
 * 2. RECEIPT-clock gap: neither pinnacleLineAt nor openerFor ever consulted
 *    `nfl_odds_archive.fetched_at` -- this system's real receipt clock (see
 *    migration 052_line_snapshot_receipt_clock.js) -- so a caller simulating a
 *    decision or settlement as of some instant (`receiptAsOf`) could still see
 *    an archived quote this system had not actually backfilled yet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-btc-archive-receipt-cutoff-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();

const btc = await import('../server/services/beat-the-close.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

let nextEid = 5001;
function seedTeams(home, away) {
  run(`INSERT OR IGNORE INTO nfl_teams (abbr,name,conference,division) VALUES (?,?,'AFC','East'),(?,?,'AFC','East')`,
    home, `${home} City`, away, `${away} City`);
}
function seedArchivedClose({ season, week, home, away, market, side, line, bookUpdatedAt, fetchedAt }) {
  run(`INSERT INTO nfl_odds_archive (eid,season,week,home,away,commence_time,book,market,side,phase,line,price,book_updated_at,source,fetched_at)
       VALUES (?,?,?,?,?,?,'pinnacle',?,?,'close',?,-110,?,'test',?)`,
  nextEid++, season, week, home, away, '2026-09-13T17:00:00Z', market, side, line, bookUpdatedAt, fetchedAt);
}
function seedArchivedOpen({ season, week, home, away, market, side, line, bookUpdatedAt, fetchedAt }) {
  run(`INSERT INTO nfl_odds_archive (eid,season,week,home,away,commence_time,book,market,side,phase,line,price,book_updated_at,source,fetched_at)
       VALUES (?,?,?,?,?,?,'pinnacle',?,?,'open',?,-110,?,'test',?)`,
  nextEid++, season, week, home, away, '2026-09-13T17:00:00Z', market, side, line, bookUpdatedAt, fetchedAt);
}

const KICKOFF = '2026-09-13T17:00:00.000Z';

test('pinnacleLineAt: an archived "close" row whose own timestamp falls AFTER `before` is refused, not picked as the close', () => {
  seedTeams('CAR', 'CHI');
  // The book moved this price 20 minutes into the game -- in-game action, not a pre-kickoff close.
  seedArchivedClose({ season: 2026, week: 1, home: 'CAR', away: 'CHI', market: 'spreads', side: 'CAR',
    line: -6, bookUpdatedAt: '2026-09-13T17:20:00.000Z', fetchedAt: '2026-09-14T00:00:00Z' });

  const line = btc.pinnacleLineAt(2026, 1, 'CAR', 'CHI', 'spreads', KICKOFF);
  assert.equal(line, null, 'a quote timestamped after kickoff must never be usable as the close, ' +
    'even though its gap to kickoff (20 minutes) is well within every fallback tolerance');
});

test('pinnacleLineAt: an archived close row at or before `before` is unaffected by the content-clock fix (happy path preserved)', () => {
  seedTeams('SEA', 'ARI');
  seedArchivedClose({ season: 2026, week: 1, home: 'SEA', away: 'ARI', market: 'spreads', side: 'SEA',
    line: -6, bookUpdatedAt: '2026-09-13T16:55:00.000Z', fetchedAt: '2026-09-14T00:00:00Z' });

  const line = btc.pinnacleLineAt(2026, 1, 'SEA', 'ARI', 'spreads', KICKOFF);
  assert.equal(line.line, -6);
  assert.equal(line.source, 'archive:pinnacle:close');
  assert.equal(line.is_fallback, false);
});

test('pinnacleLineAt: with receiptAsOf given, a close this system had not backfilled yet is refused', () => {
  seedTeams('DAL', 'NYG');
  seedArchivedClose({ season: 2026, week: 1, home: 'DAL', away: 'NYG', market: 'spreads', side: 'DAL',
    line: -4, bookUpdatedAt: '2026-09-13T16:50:00.000Z', fetchedAt: '2026-09-20T00:00:00Z' });

  // Without receiptAsOf, existing behavior is unchanged: the archive is usable.
  const noGate = btc.pinnacleLineAt(2026, 1, 'DAL', 'NYG', 'spreads', KICKOFF);
  assert.equal(noGate.line, -4, 'omitting receiptAsOf must not change existing behavior');

  // A settlement pretending to run before the backfill actually happened must not see it.
  const gated = btc.pinnacleLineAt(2026, 1, 'DAL', 'NYG', 'spreads', KICKOFF, undefined, '2026-09-14T00:00:00Z');
  assert.equal(gated, null, 'the archive row was not actually received by this system until 2026-09-20; ' +
    'a settlement as of 2026-09-14 must not be able to use it');
});

test('pinnacleLineAt: with receiptAsOf given, a close this system had already backfilled by then is still usable', () => {
  seedTeams('MIA', 'BUF');
  seedArchivedClose({ season: 2026, week: 1, home: 'MIA', away: 'BUF', market: 'spreads', side: 'MIA',
    line: -1.5, bookUpdatedAt: '2026-09-13T16:50:00.000Z', fetchedAt: '2026-09-12T00:00:00Z' });

  const line = btc.pinnacleLineAt(2026, 1, 'MIA', 'BUF', 'spreads', KICKOFF, undefined, '2026-09-14T00:00:00Z');
  assert.equal(line.line, -1.5);
  assert.equal(line.source, 'archive:pinnacle:close');
});

test('openerFor: with receiptAsOf given, an opener this system had not backfilled yet falls through (no live capture either) to null', () => {
  seedTeams('GB', 'MIN');
  seedArchivedOpen({ season: 2026, week: 1, home: 'GB', away: 'MIN', market: 'spreads', side: 'GB',
    line: -3, bookUpdatedAt: '2026-05-01T00:00:00Z', fetchedAt: '2026-09-20T00:00:00Z' });

  const noGate = btc.openerFor(2026, 1, 'GB', 'MIN', 'spreads');
  assert.equal(noGate.line, -3, 'omitting receiptAsOf must not change existing behavior');

  const gated = btc.openerFor(2026, 1, 'GB', 'MIN', 'spreads', undefined, '2026-09-01T00:00:00Z');
  assert.equal(gated, null, 'the opener was not actually received by this system until 2026-09-20; ' +
    'a caller simulating 2026-09-01 must not be able to use it');
});

test('openerFor: with receiptAsOf given, an opener already backfilled by then is still usable', () => {
  seedTeams('LAR', 'SF');
  seedArchivedOpen({ season: 2026, week: 1, home: 'LAR', away: 'SF', market: 'spreads', side: 'LAR',
    line: -2, bookUpdatedAt: '2026-05-01T00:00:00Z', fetchedAt: '2026-05-02T00:00:00Z' });

  const line = btc.openerFor(2026, 1, 'LAR', 'SF', 'spreads', undefined, '2026-09-01T00:00:00Z');
  assert.equal(line.line, -2);
  assert.equal(line.source, 'archive:pinnacle:open');
});
