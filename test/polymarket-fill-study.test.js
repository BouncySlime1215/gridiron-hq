/**
 * End-to-end over a real (scratch) database: the ladder migration, the reader
 * that prefers a stored ladder over the touch, and the fill study that finally
 * reads the sizes `captureOrderBooks()` has been storing and nothing has ever
 * used.
 *
 * The books here are written by the test, so the NUMBERS are about the test's
 * books and not about Polymarket. What the test establishes is the plumbing: a
 * stored ladder is walked, a touch-only row is bounded rather than
 * extrapolated, and the naive figure the codebase actually computes is
 * reproduced exactly so the comparison is against the real incumbent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-fill-study-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const pm = await import('../server/services/polymarket.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const AT = '2026-09-12T18:00:00.000Z';

function market(id, question, { bid, ask, bidSize, askSize, volume = 50000 }) {
  run(`INSERT INTO polymarket_markets (condition_id, question, event_title, kind, first_seen)
       VALUES (?,?,?,?,?)`, id, question, 'Week 2', 'other', AT);
  run(`INSERT INTO polymarket_quotes (captured_at, condition_id, mid_yes, best_bid, best_ask,
       bid_size, ask_size, spread, volume) VALUES (?,?,?,?,?,?,?,?,?)`,
  AT, id, (bid + ask) / 2, bid, ask, bidSize, askSize, ask - bid, volume);
}

function ladder(id, side, levels) {
  levels.forEach((l, i) => run(
    `INSERT INTO polymarket_order_book_levels (captured_at, condition_id, side, level, price, size)
     VALUES (?,?,?,?,?,?)`, AT, id, side, i, l.price, l.size));
}

// Market A: a full ladder. 20 @ 0.50, 30 @ 0.52, 50 @ 0.58.
market('A', 'Deep-looking market with a thin ladder', { bid: 0.48, ask: 0.50, bidSize: 20, askSize: 20 });
ladder('A', 'ask', [{ price: 0.50, size: 20 }, { price: 0.52, size: 30 }, { price: 0.58, size: 50 }]);
ladder('A', 'bid', [{ price: 0.48, size: 20 }, { price: 0.45, size: 40 }]);

// Market B: touch only, the shape every stored row has today.
market('B', 'Touch-only market, no ladder stored', { bid: 0.30, ask: 0.32, bidSize: 100, askSize: 15 });

// Market C: genuinely deep, the control that must show no cost at all.
market('C', 'Genuinely deep market', { bid: 0.44, ask: 0.45, bidSize: 8000, askSize: 8000 });
ladder('C', 'ask', [{ price: 0.45, size: 8000 }]);
ladder('C', 'bid', [{ price: 0.44, size: 8000 }]);

test('migration 044 creates the ladder table and storedBook prefers it', () => {
  const book = pm.storedBook('A');
  assert.equal(book.source, 'polymarket_order_book_levels');
  assert.equal(book.truncated, false);
  assert.equal(book.asks.length, 3);
  assert.equal(book.asks[0].price, 0.50, 'level 0 is the touch');
  assert.equal(book.asks[2].price, 0.58);
  assert.equal(book.bids[0].price, 0.48, 'the bid side is best-first too, i.e. descending');
});

test('a market with no stored ladder falls back to a truncated touch-only book', () => {
  const book = pm.storedBook('B');
  assert.equal(book.truncated, true);
  assert.match(book.source, /touch only/);
  assert.equal(book.asks.length, 1);
  assert.equal(book.asks[0].size, 15);
});

test('the fill study walks the ladder and reports what the stake really costs', () => {
  // $50 at the 0.50 touch is 100 shares wanted. The ladder holds 20 + 30 + 50 = 100.
  //   cash = 20*0.50 + 30*0.52 + 50*0.58 = 10 + 15.6 + 29 = 54.60, avg 0.546
  const study = pm.fillStudy({ stake: 50, edge: 0.06, naiveAtMid: true });
  const a = study.worst.concat(study.worst).find(r => r.question.startsWith('Deep-looking'));
  assert.equal(a.source, 'polymarket_order_book_levels');
  assert.equal(a.levels_available, 3);
  assert.equal(a.shares_filled, 100);
  assert.equal(a.fill_ratio, 1);
  assert.equal(a.avg_price, 0.546);
  assert.equal(a.slippage_vs_touch, 0.046, 'the walk cost 4.6 cents a share against the touch');
  assert.equal(a.bound, 'exact');

  // The naive figure is the one this codebase actually computes: priced at the
  // MID (0.49), unlimited size. fair = touch + edge = 0.56.
  //   naive profit = 100 * (0.56 - 0.49) = 7.00
  //   real  profit = 100 * (0.56 - 0.546) = 1.40   ->  20% of it survives
  assert.equal(a.naive_expected_profit, 7);
  assert.ok(Math.abs(a.real_expected_profit - 1.4) < 1e-6, `got ${a.real_expected_profit}`);
  assert.equal(a.profit_realised_fraction, 0.2);
});

test('a touch-only market is bounded, and its unfilled remainder is not treated as zero', () => {
  // $50 at a 0.32 touch wants 156.25 shares; only 15 are known to exist.
  const study = pm.fillStudy({ stake: 50, edge: 0.06 });
  const b = study.worst.find(r => r.question.startsWith('Touch-only'));
  assert.equal(b.truncated, true);
  assert.equal(b.bound, 'best_case');
  assert.equal(b.shares_filled, 15);
  assert.equal(b.capped_by, 'known_book_exhausted');
  assert.ok(b.fill_ratio < 0.1, `fill ratio ${b.fill_ratio}`);
  assert.equal(study.touch_only_markets, 1);
  assert.equal(study.full_ladder_markets, 2);
  assert.ok(study.best_case_from_touch_only_books.markets === 1);
  assert.match(study.note, /LOWER bounds/);
});

test('a genuinely deep market shows no execution cost, which is the control', () => {
  const study = pm.fillStudy({ stake: 50, edge: 0.06 });
  const c = study.worst.find(r => r.question.startsWith('Genuinely deep'));
  assert.equal(c.fill_ratio, 1);
  assert.equal(c.slippage_vs_touch, 0, 'the whole stake sits inside the touch');
  assert.equal(c.avg_price, 0.45);
  // The naive figure is still optimistic here, but only by the half-spread —
  // that part is the spread, not depth, and the two are separable.
  assert.ok(c.profit_realised_fraction < 1);
});

test('the study separates exact from bounded rather than averaging them together', () => {
  const study = pm.fillStudy({ stake: 50, edge: 0.06 });
  assert.equal(study.exact.markets, 2);
  assert.equal(study.best_case_from_touch_only_books.markets, 1);
  assert.ok(study.exact.mean_profit_realised < 1);
  assert.match(study.ladder_note, /discarded|thrown away|fetched by captureOrderBooks/);
});

test('a stake the books can absorb costs only the spread, which is the size sensitivity', () => {
  const small = pm.fillStudy({ stake: 5, edge: 0.06 });
  const large = pm.fillStudy({ stake: 500, edge: 0.06 });
  assert.ok(small.exact.mean_fill_ratio > large.exact.mean_fill_ratio,
    'a smaller stake fills a larger fraction of itself');
  assert.ok(small.exact.mean_profit_realised > large.exact.mean_profit_realised,
    'and keeps more of its claimed edge');
});
