import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * GIANT PLAN 29. The 2026-09-10 audit (commit 14c5e65) measured that
 * `coverProbabilities` is not the coin flip it claims to be — it is the
 * empirical cover rate of the posted reference line over twenty years, so it
 * carries whatever historical bias sits at that number (the audit's own
 * example: +6.5 covers 53.53%, +10 covers 55.28%, both above the 52.38%
 * break-even, on historical noise alone). That bias is a property of WHICH
 * NUMBER a side sits at, not of whether any book actually shopped better than
 * its own median — so `shoppingBoard()`'s old sort key, the absolute
 * `expected_net_return`, put the board's largest historical bias at the top
 * regardless of real shopping quality, exactly the bug this fix addresses.
 *
 * This test builds two synthetic sides with a KNOWN, hand-computable margin
 * distribution at each one's own reference line (using `noForecastMarginDistribution`'s
 * MIN_GAMES_FOR_LINE=60 exact-match path, so no window-widening is in play):
 *
 *   'biased dog'    every book quotes the exact SAME line and price (zero
 *                   line_edge, zero price_edge, by construction) at a
 *                   reference number this fixture makes cover 64.3% of the
 *                   time historically — a large ABSOLUTE expected_net_return
 *                   with ZERO real shopping value.
 *
 *   'real shopper'  the reference line is an unbiased pick'em (50/50 cover,
 *                   by construction), and one book offers a genuinely BETTER
 *                   number than the other two — a modest absolute return, but
 *                   real, non-zero shopping value.
 *
 * The old sort (`expected_net_return`) ranks the biased dog first. The fixed
 * sort (`edge_vs_median`) ranks the real shopper first, and reports the
 * biased dog's improvement as exactly zero, which is what it actually is.
 */
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-board-bias-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/line-shopping.js');
await import('../server/services/gamescript.js');
const board = await import('../server/services/nfl-shopping-board.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const captured = '2026-09-13T12:00:00Z';
test.before(t => t.mock.timers.enable({ apis: ['Date'], now: new Date(captured) }));

// GIANT PLAN 29: seasons outside MEASUREMENT_SEASONS (1999-2024) are now
// excluded from marginDistribution()/marginResidualDistribution()/
// marginsByPostedLine() in nfl-execution-edge.js, so the synthetic seed below
// has to sit inside that window to be seen at all.
const SEASON = 2010;
const insertGame = db.prepare(`INSERT INTO game_lines
  (season,week,team,opponent,home,spread,total,team_score,opp_score) VALUES (?,?,?,?,1,?,44,?,?)`);

// 'biased dog': 70 games at home spread -3. 45 have the home favorite winning
// by only 1 (the dog, taking +3, covers); 25 have the favorite winning by 10
// (the favorite covers). Dog cover rate = 45/70 = 64.3%, entirely by
// construction, at EXACTLY the posted line (>=60 games, so no window
// widening) -- a real historical bias with a known, hand-computable size.
let week = 1;
for (let i = 0; i < 45; i++) insertGame.run(SEASON, week++, 'BFAV', 'BDOG', -3, 21, 20); // margin +1
for (let i = 0; i < 25; i++) insertGame.run(SEASON, week++, 'BFAV', 'BDOG', -3, 30, 20); // margin +10

// 'real shopper': 70 games at home spread 0 (a pick'em), constructed to be an
// UNBIASED reference (win 30/70, push 10/70, loss 30/70 at the posted number
// itself) so any edge measured here comes only from the line move, not from a
// baked-in historical skew.
for (let i = 0; i < 10; i++) insertGame.run(SEASON, week++, 'SFAV', 'SDOG', 0, 20, 20); // margin 0 (push at 0)
for (let i = 0; i < 25; i++) insertGame.run(SEASON, week++, 'SFAV', 'SDOG', 0, 23, 20); // margin +3
for (let i = 0; i < 25; i++) insertGame.run(SEASON, week++, 'SFAV', 'SDOG', 0, 20, 23); // margin -3
for (let i = 0; i < 5; i++) insertGame.run(SEASON, week++, 'SFAV', 'SDOG', 0, 27, 20); // margin +7
for (let i = 0; i < 5; i++) insertGame.run(SEASON, week++, 'SFAV', 'SDOG', 0, 20, 27); // margin -7

const snap = (eventId, home, away, book, side, line, price) => run(`INSERT INTO nfl_line_snapshots
  (captured_at,event_id,commence_time,home_team,away_team,book,market,side,line,price,provider,book_updated_at)
  VALUES (?,?,?,?,?,?,'spreads',?,?,?,?,?)`,
captured, eventId, '2026-09-14T17:00:00Z', home, away, book, side, line, price, 'free:oddstrader', captured);

// The dog side: three books, all quoting the IDENTICAL number and price.
// line_edge and price_edge are zero for every one of them by construction --
// there is no shopping decision here, only a side that happens to sit at a
// historically dog-friendly number.
snap('nfl:2026-09-14:BDOG@BFAV', 'BFAV', 'BDOG', 'pinnacle', 'BDOG', 3, -110);
snap('nfl:2026-09-14:BDOG@BFAV', 'BFAV', 'BDOG', 'bovada', 'BDOG', 3, -110);
snap('nfl:2026-09-14:BDOG@BFAV', 'BFAV', 'BDOG', 'betonlineag', 'BDOG', 3, -110);

// The pick'em side: two books at the median (0), one book offering the
// favorite a genuinely better number (+1) -- a real, if modest, line
// improvement on an unbiased reference.
snap('nfl:2026-09-14:SDOG@SFAV', 'SFAV', 'SDOG', 'pinnacle', 'SFAV', 0, -110);
snap('nfl:2026-09-14:SDOG@SFAV', 'SFAV', 'SDOG', 'bovada', 'SFAV', 0, -110);
snap('nfl:2026-09-14:SDOG@SFAV', 'SFAV', 'SDOG', 'betonlineag', 'SFAV', 1, -110);

test('the biased dog shows zero real shopping edge, and the genuine shopper shows a real one', () => {
  const rows = board.shoppingBoard({ market: 'spreads', limit: 40 });
  const dog = rows.find(r => r.event_id === 'nfl:2026-09-14:BDOG@BFAV' && r.side === 'BDOG');
  const shopper = rows.find(r => r.event_id === 'nfl:2026-09-14:SDOG@SFAV' && r.side === 'SFAV');
  assert.ok(dog, 'the dog side is boarded');
  assert.ok(shopper, 'the pick\'em side is boarded');

  // The bias is real and large in absolute terms -- every book quoting this
  // side pays out on a ~64.3% historical cover rate, nowhere near a coin flip.
  assert.ok(dog.expected_net_return > 0.15,
    `the dog's absolute expected_net_return should show the baked-in bias, got ${dog.expected_net_return}`);
  // But NOT ONE of the three books actually beat the others: every quote is
  // identical, so the real shopping value is exactly zero.
  assert.equal(dog.line_edge, 0, 'no book offered a better line than the others');
  assert.equal(dog.price_edge, 0, 'no book offered a better price than the others');
  // Floating-point, not exactly bit-identical (coverProbabilities recomputes
  // rather than reusing the reference baseline's own sum), so this checks
  // "zero to four decimal places" rather than `Object.is` equality -- -0 and
  // 0 both mean "no edge" here.
  assert.ok(Math.abs(dog.edge_vs_median) < 1e-6,
    `edge_vs_median must be ~zero when the best book does not differ from the median at all, got ${dog.edge_vs_median}`);

  // The pick'em side is a real, if modest, shopping win: a genuinely better
  // number, on a reference line this fixture built to be unbiased.
  assert.equal(shopper.best_book, 'betonlineag', 'the book offering the better number must be recommended');
  assert.ok(shopper.edge_vs_median > 0, 'a real line improvement must show a positive edge_vs_median');

  // THE ACTUAL BUG. The old sort key (expected_net_return) ranks the biased
  // dog above the genuine shopper -- its baked-in historical cover rate alone
  // clears the pick'em side's real, but modest, line-shopping value.
  assert.ok(dog.expected_net_return > shopper.expected_net_return,
    'sanity check on the fixture: the bias must be large enough to beat the real edge in absolute terms, ' +
    `or this test is not exercising the bug (dog=${dog.expected_net_return}, shopper=${shopper.expected_net_return})`);

  // THE FIX. Leading on edge_vs_median instead reverses that: the side with
  // an actual shopping advantage outranks the side with none, regardless of
  // which one has the larger historical baseline.
  assert.ok(shopper.edge_vs_median > dog.edge_vs_median,
    `edge_vs_median must rank the real shopper above the zero-edge biased dog (dog=${dog.edge_vs_median}, ` +
    `shopper=${shopper.edge_vs_median})`);

  const order = rows.map(r => `${r.event_id}:${r.side}`);
  const shopperIdx = order.indexOf('nfl:2026-09-14:SDOG@SFAV:SFAV');
  const dogIdx = order.indexOf('nfl:2026-09-14:BDOG@BFAV:BDOG');
  assert.ok(shopperIdx < dogIdx,
    'the board itself, not just the two numbers, must rank the real shopper ahead of the biased dog');

  // The summary's headline numbers must follow the same rule.
  const summary = board.executionBoardSummary();
  assert.equal(summary.best_edge_vs_median, shopper.edge_vs_median,
    'the summary\'s leading number must come from the real shopper, not the biased dog');
  assert.notEqual(summary.best_expected_return, summary.best_edge_vs_median,
    'the two numbers must actually differ on this fixture, or the fix is not being exercised');
});
