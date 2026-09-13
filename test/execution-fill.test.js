/**
 * Known-answer tests for the depth-aware fill simulator.
 *
 * Every arithmetic assertion below is a number computed by hand from a book
 * written in the test, not a value read off a run and frozen. A fill simulator
 * that is wrong is worse than none at all, because its output is the input to
 * every size and every dollar figure downstream.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXECUTION_FILL_VERSION, normalizeLadder, fromPolymarketBook, fromStoredQuote,
  walkLadder, simulateFill, naiveFill, fillShortfall, combinationFill
} from '../server/services/execution-fill.js';

const near = (actual, expected, tol = 1e-6, what = '') =>
  assert.ok(Math.abs(actual - expected) <= tol, `${what} expected ${expected}, got ${actual}`);

/* ------------------------------------------------------------------ ladders */

test('a ladder sorted away from the touch throws rather than filling at the wrong end', () => {
  // Polymarket's raw ask array: descending, best LAST. Reading it as best-first
  // would walk 0.70 -> 0.60 -> 0.55 and report an average fill BETTER than the
  // touch, which is the one error nobody questions.
  assert.throws(() => normalizeLadder(
    [{ price: 0.70, size: 100 }, { price: 0.60, size: 100 }, { price: 0.55, size: 100 }], 'buy'),
  /not sorted best-first/);
  assert.throws(() => normalizeLadder(
    [{ price: 0.40, size: 100 }, { price: 0.45, size: 100 }], 'sell'),
  /not sorted best-first/);
});

test('fromPolymarketBook performs the documented reversal exactly once', () => {
  const book = fromPolymarketBook({
    bids: [{ price: '0.50', size: '10' }, { price: '0.53', size: '20' }, { price: '0.54', size: '30' }],
    asks: [{ price: '0.62', size: '10' }, { price: '0.58', size: '20' }, { price: '0.56', size: '30' }]
  });
  assert.equal(book.bids[0].price, 0.54, 'best bid is the LAST bid in the raw array');
  assert.equal(book.asks[0].price, 0.56, 'best ask is the LAST ask in the raw array');
  assert.equal(book.bids.at(-1).price, 0.50);
  assert.equal(book.asks.at(-1).price, 0.62);
  assert.equal(book.truncated, false);
});

test('zero-size, out-of-range and non-numeric levels are dropped, not walked', () => {
  const l = normalizeLadder([
    { price: 0.20, size: 100 }, { price: 0.25, size: 0 }, { price: 0.30, size: 50 },
    { price: 1.00, size: 999 }, { price: 0, size: 999 }, { price: 0.40, size: 'x' }
  ], 'buy');
  assert.deepEqual(l, [{ price: 0.20, size: 100 }, { price: 0.30, size: 50 }]);
});

/* ------------------------------------------------------------------ the walk */

test('walking three levels returns the size-weighted average price, by hand', () => {
  // 100 @ 0.50, 100 @ 0.52, 100 @ 0.55.  Want 250.
  // cash = 100*0.50 + 100*0.52 + 50*0.55 = 50 + 52 + 27.5 = 129.5
  // avg  = 129.5 / 250 = 0.518
  const ladder = normalizeLadder(
    [{ price: 0.50, size: 100 }, { price: 0.52, size: 100 }, { price: 0.55, size: 100 }], 'buy');
  const w = walkLadder(ladder, { shares: 250, side: 'buy' });
  near(w.cash, 129.5, 1e-9, 'cash');
  near(w.avg_price, 0.518, 1e-9, 'avg');
  assert.equal(w.shares_filled, 250);
  assert.equal(w.levels_consumed, 3);
  assert.equal(w.worst_price, 0.55);
  assert.equal(w.touch_price, 0.50);
  assert.equal(w.shares_unfilled, 0);
  assert.equal(w.stopped_by, 'target');
  assert.equal(w.fill_ratio, 1);
});

test('a budget target converts to shares level by level, not at the touch', () => {
  // $100 against 100 @ 0.50 then 100 @ 0.52.
  // First level takes 100 shares for $50. $50 left at 0.52 buys 96.153846...
  const ladder = normalizeLadder([{ price: 0.50, size: 100 }, { price: 0.52, size: 100 }], 'buy');
  const w = walkLadder(ladder, { budget: 100, side: 'buy' });
  near(w.shares_filled, 100 + 50 / 0.52, 1e-6, 'shares');
  near(w.cash, 100, 1e-6, 'cash');
  // The naive assumption would have been 100/0.50 = 200 shares. It is not.
  assert.ok(w.shares_filled < 200, 'a budget buys fewer shares than the touch suggests');
});

test('the book running out is reported as unfilled size, never as a fill', () => {
  const ladder = normalizeLadder([{ price: 0.50, size: 15 }], 'buy');
  const w = walkLadder(ladder, { shares: 500, side: 'buy' });
  assert.equal(w.shares_filled, 15);
  assert.equal(w.shares_unfilled, 485);
  assert.equal(w.fill_ratio, 0.03);
  assert.equal(w.stopped_by, 'book_exhausted');
  assert.equal(w.bound, 'exact', 'a complete book that runs out is an exact answer');
});

test('a limit price stops the walk before the level that breaches it', () => {
  const ladder = normalizeLadder(
    [{ price: 0.50, size: 100 }, { price: 0.52, size: 100 }, { price: 0.60, size: 100 }], 'buy');
  const w = walkLadder(ladder, { shares: 300, limitPrice: 0.55, side: 'buy' });
  assert.equal(w.shares_filled, 200);
  assert.equal(w.stopped_by, 'limit_price');
  assert.equal(w.worst_price, 0.52);
});

test('the sell side walks bids downward and its limit is a floor', () => {
  const ladder = normalizeLadder(
    [{ price: 0.50, size: 100 }, { price: 0.48, size: 100 }, { price: 0.40, size: 100 }], 'sell');
  const w = walkLadder(ladder, { shares: 300, limitPrice: 0.45, side: 'sell' });
  assert.equal(w.shares_filled, 200);
  near(w.cash, 98, 1e-9, 'cash received');
  near(w.avg_price, 0.49, 1e-9, 'avg');
});

/* ------------------------------------------------ truncated (stored) books */

test('a stored quote makes a one-level book whose exhaustion is only a best case', () => {
  const book = fromStoredQuote({ best_bid: 0.48, best_ask: 0.52, bid_size: 30, ask_size: 15 });
  assert.equal(book.truncated, true);
  const f = simulateFill({ book, side: 'buy', shares: 200 });
  assert.equal(f.shares_filled, 15);
  assert.equal(f.shares_beyond_known_book, 185,
    'the remainder is UNKNOWN, not zero — the ladder past level one was never stored');
  assert.equal(f.bound, 'best_case');
  assert.equal(f.stopped_by, 'known_book_exhausted');
});

test('a fill entirely inside level one of a stored quote is exact, not bounded', () => {
  const book = fromStoredQuote({ best_bid: 0.48, best_ask: 0.52, bid_size: 30, ask_size: 100 });
  const f = simulateFill({ book, side: 'buy', shares: 40 });
  assert.equal(f.shares_filled, 40);
  assert.equal(f.bound, 'exact');
  assert.equal(f.shares_beyond_known_book, null);
});

/* ------------------------------------------------------------------ fees */

test('a fee raises the effective price of a buy and lowers it on a sell', () => {
  const book = fromPolymarketBook({ bids: [{ price: 0.40, size: 100 }], asks: [{ price: 0.60, size: 100 }] });
  const fee = () => 1.00;   // one dollar, flat
  const buy = simulateFill({ book, side: 'buy', shares: 100, fee });
  near(buy.cash, 60, 1e-9);
  near(buy.net_cash, 61, 1e-9);
  near(buy.effective_price, 0.61, 1e-9);
  const sell = simulateFill({ book, side: 'sell', shares: 100, fee });
  near(sell.cash, 40, 1e-9);
  near(sell.net_cash, 39, 1e-9);
  near(sell.effective_price, 0.39, 1e-9);
});

/* ------------------------------------------------------------------ shortfall */

test('naive against real on a thin book: the whole arithmetic, by hand', () => {
  // Book: 15 @ 0.50, 25 @ 0.54, 60 @ 0.60. Fair value 0.62. Want 300 shares.
  //   naive : 300 @ 0.50, edge 0.12/share -> profit 36.00
  //   real  : 15*0.50 + 25*0.54 + 60*0.60 = 7.5 + 13.5 + 36 = 57.00 for 100 shares
  //           avg 0.57, edge 0.05/share -> profit 5.00
  //   realised fraction 5/36 = 0.138888...
  const book = fromPolymarketBook({
    bids: [{ price: 0.45, size: 100 }],
    asks: [{ price: 0.60, size: 60 }, { price: 0.54, size: 25 }, { price: 0.50, size: 15 }]
  });
  const s = fillShortfall({ book, side: 'buy', shares: 300, fairValue: 0.62 });
  near(s.naive.expected_profit, 36, 1e-9, 'naive profit');
  near(s.actual.cash, 57, 1e-9, 'real cash');
  near(s.actual.avg_price, 0.57, 1e-9, 'real avg');
  near(s.actual.expected_profit, 5, 1e-9, 'real profit');
  near(s.profit_realised_fraction, 0.1389, 5e-5, 'realised fraction');
  near(s.slippage_vs_touch, 0.07, 1e-9, 'slippage');
  assert.equal(s.fill_ratio, 0.3333);
  assert.equal(s.capped_by, 'book_exhausted');
  assert.equal(s.version, EXECUTION_FILL_VERSION);
});

test('a size the touch can absorb costs nothing, which is the control case', () => {
  const book = fromPolymarketBook({ bids: [{ price: 0.45, size: 500 }], asks: [{ price: 0.50, size: 500 }] });
  const s = fillShortfall({ book, side: 'buy', shares: 100, fairValue: 0.60 });
  assert.equal(s.profit_realised_fraction, 1, 'inside the touch, naive and real agree exactly');
  assert.equal(s.slippage_vs_touch, 0);
  assert.equal(s.fill_ratio, 1);
});

test('pricing off the MID rather than the touch is more optimistic still', () => {
  // live-edge.js uses (best_bid + best_ask) / 2 as the tradeable price. On a
  // 0.45/0.55 book that is 0.50, a price no buyer can get.
  const book = fromPolymarketBook({ bids: [{ price: 0.45, size: 500 }], asks: [{ price: 0.55, size: 500 }] });
  const atTouch = fillShortfall({ book, side: 'buy', shares: 100, fairValue: 0.65 });
  const atMid = fillShortfall({ book, side: 'buy', shares: 100, fairValue: 0.65, naivePrice: 0.50 });
  near(atTouch.naive.expected_profit, 10, 1e-9, 'touch-based naive');
  near(atMid.naive.expected_profit, 15, 1e-9, 'mid-based naive is 50% larger');
  near(atTouch.actual.expected_profit, 10, 1e-9);
  assert.equal(atMid.profit_realised_fraction, 0.6667,
    'a third of the mid-priced edge is the spread, before depth costs anything');
});

test('an edge that the walk erases entirely is reported as a negative, not clipped', () => {
  const book = fromPolymarketBook({
    bids: [{ price: 0.40, size: 10 }],
    asks: [{ price: 0.90, size: 1000 }, { price: 0.52, size: 10 }]
  });
  const s = fillShortfall({ book, side: 'buy', shares: 100, fairValue: 0.60 });
  // 10 @ 0.52 then 90 @ 0.90 = 5.2 + 81 = 86.2 for 100 -> avg 0.862, edge -0.262
  near(s.actual.avg_price, 0.862, 1e-9);
  assert.ok(s.actual.expected_profit < 0, 'walking into a wall turns an edge into a loss');
  assert.ok(s.profit_realised_fraction < 0, 'and the realised fraction says so');
});

/* ------------------------------------------------------------------ combinations */

test('a four-leg package is capped by its thinnest leg and nothing else', () => {
  const deep = () => fromPolymarketBook({ bids: [{ price: 0.20, size: 5000 }], asks: [{ price: 0.22, size: 5000 }] });
  const thin = fromPolymarketBook({ bids: [{ price: 0.20, size: 15 }], asks: [{ price: 0.22, size: 15 }] });
  const legs = [
    { key: 'a', book: deep(), side: 'buy', ratio: 1, fairValue: 0.30 },
    { key: 'b', book: deep(), side: 'buy', ratio: 1, fairValue: 0.30 },
    { key: 'c', book: thin, side: 'buy', ratio: 1, fairValue: 0.30 },
    { key: 'd', book: deep(), side: 'buy', ratio: 1, fairValue: 0.30 }
  ];
  const c = combinationFill({ legs, units: 1000 });
  assert.equal(c.units_executable, 15, 'the 15-share leg sets the size for all four');
  assert.deepEqual(c.binding_legs, ['c']);
  assert.equal(c.execution_ratio, 0.015);
  // Aspirational: 4 legs * 1000 * (0.30 - 0.22) = 320.  Real: 4 * 15 * 0.08 = 4.80.
  near(c.aspirational_expected_profit, 320, 1e-6);
  near(c.realistic_expected_profit, 4.8, 1e-6);
  assert.equal(c.profit_realised_fraction, 0.015);
});

test('leg ratios are respected when sizing the package', () => {
  // Leg b needs two contracts per package, and its book holds 30 — so 15 units.
  const legs = [
    { key: 'a', book: fromPolymarketBook({ bids: [], asks: [{ price: 0.30, size: 1000 }] }), side: 'buy', ratio: 1, fairValue: 0.40 },
    { key: 'b', book: fromPolymarketBook({ bids: [], asks: [{ price: 0.30, size: 30 }] }), side: 'buy', ratio: 2, fairValue: 0.40 }
  ];
  const c = combinationFill({ legs, units: 100 });
  assert.equal(c.units_executable, 15);
  assert.deepEqual(c.binding_legs, ['b']);
  assert.equal(c.legs.find(l => l.key === 'a').shares_filled, 15);
  assert.equal(c.legs.find(l => l.key === 'b').shares_filled, 30);
});

test('one truncated leg makes the whole package a lower bound', () => {
  const legs = [
    { key: 'a', book: fromPolymarketBook({ bids: [], asks: [{ price: 0.30, size: 1000 }] }), side: 'buy', ratio: 1, fairValue: 0.40 },
    { key: 'b', book: fromStoredQuote({ best_bid: 0.28, best_ask: 0.30, bid_size: 10, ask_size: 20 }), side: 'buy', ratio: 1, fairValue: 0.40 }
  ];
  const c = combinationFill({ legs, units: 100 });
  assert.equal(c.units_executable, 20);
  assert.equal(c.bound, 'best_case');
  assert.match(c.note, /LOWER bound/);
});

test('a leg with no book at all caps the package at zero rather than being skipped', () => {
  const legs = [
    { key: 'a', book: fromPolymarketBook({ bids: [], asks: [{ price: 0.30, size: 1000 }] }), side: 'buy', ratio: 1, fairValue: 0.40 },
    { key: 'missing', book: { bids: [], asks: [] }, side: 'buy', ratio: 1, fairValue: 0.40 }
  ];
  const c = combinationFill({ legs, units: 100 });
  assert.equal(c.units_executable, 0);
  assert.equal(c.realistic_expected_profit, 0);
  assert.deepEqual(c.binding_legs, ['missing']);
});

test('naiveFill states its own assumption and refuses impossible prices', () => {
  const n = naiveFill({ price: 0.5, shares: 1000 });
  assert.equal(n.shares_filled, 1000);
  assert.equal(n.cash, 500);
  assert.match(n.assumption, /no depth, no walk/);
  assert.ok(naiveFill({ price: 1.0, shares: 10 }).error);
  assert.ok(naiveFill({ price: 0, shares: 10 }).error);
});
