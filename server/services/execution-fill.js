/**
 * What a stake can ACTUALLY be filled at, given the book in front of it.
 *
 * The gap this closes is narrow and expensive. `captureOrderBooks()` in
 * polymarket.js has been storing `bid_size`/`ask_size` since the books were
 * first pulled, and nothing downstream has ever read them as sizes. The two
 * places that touch them at all reduce the book to a single scalar:
 *
 *   live-edge.js:215   depth = Math.min(bid_size, ask_size)
 *   live-edge.js:151   maxUnits = Math.min(3, depth / 500)
 *   polymarket.js:225  depth = Math.min(bid_size, ask_size)   (a reporting tier)
 *
 * and then price every dollar of the position at the touch (or at the mid)
 * with a constant `costFraction`. That is the naive fill: infinitely elastic
 * supply at the best quote. It is wrong in the one direction that always
 * flatters a backtest — the bigger the claimed edge, the bigger the stake it
 * justifies, and the bigger the stake the less of it the touch can absorb.
 *
 * This module is the pure-function replacement: hand it a desired size and a
 * book and it returns what would have been filled, at what average price,
 * after walking as far down the ladder as the size demands.
 *
 * ------------------------------------------------------------------ CAVEAT
 * A structural limitation, stated here because it decides what this module can
 * be trusted for today. `captureOrderBooks()` FETCHES the whole ladder and
 * PERSISTS only the touch:
 *
 *     const bids = book.bids ?? [], asks = book.asks ?? [];
 *     const bestBid = bids[bids.length - 1];   // the rest of the ladder
 *     const bestAsk = asks[asks.length - 1];   // is discarded here
 *     UPDATE polymarket_quotes SET best_bid=?, best_ask=?, bid_size=?, ask_size=? ...
 *
 * and `polymarket_quotes` has columns for exactly those four numbers. So no
 * amount of stored history can support a book-walk: level two onward was never
 * written down. Until capture keeps the ladder (see `POLYMARKET_LADDER_NOTE`
 * and the companion migration), any historical fill estimate is a ONE-LEVEL
 * estimate, and this module says so on its face rather than extrapolating —
 * `truncated` books return `bound: 'best_case'` and a non-null
 * `shares_beyond_known_book`, never a confident average price.
 *
 * Nothing here reads the database, calls a network, or changes a forecast.
 */

export const EXECUTION_FILL_VERSION = 'execution-fill/1.0.0';

export const POLYMARKET_LADDER_NOTE =
  'polymarket_quotes stores only the touch (best_bid, best_ask, bid_size, ask_size). ' +
  'The full ladder is fetched by captureOrderBooks() and thrown away, so a book-walk over ' +
  'stored history is impossible without a capture change. Books built from stored rows are ' +
  'truncated and every fill past level one is reported as unknown, not as filled.';

const isNum = Number.isFinite;
const r4 = x => (isNum(x) ? +x.toFixed(4) : null);
const r6 = x => (isNum(x) ? +x.toFixed(6) : null);

/* ------------------------------------------------------------------ ladders */

/**
 * Canonical internal form for one side of a book: levels sorted BEST FIRST.
 *
 * Sort order is checked rather than guessed. Polymarket's CLOB returns bids
 * ascending and asks descending — the best of each is the LAST element — and
 * reading index zero there is a documented, already-committed bug class in
 * this repo (see the note captureOrderBooks() returns). Auto-detecting the
 * order would reintroduce it silently: a ladder read from the wrong end walks
 * from the worst price toward the best and reports an average fill BETTER than
 * the touch, which is the one error a reader would never question. So a
 * mis-ordered ladder throws, and the single place that performs the reversal
 * is `fromPolymarketBook`.
 *
 * @param {Array<{price:number,size:number}>} levels
 * @param {'buy'|'sell'} side - 'buy' walks asks (ascending price is correct
 *   best-first), 'sell' walks bids (descending price is correct best-first).
 */
export function normalizeLadder(levels, side) {
  if (side !== 'buy' && side !== 'sell') throw new Error(`side must be 'buy' or 'sell', got ${side}`);
  const out = [];
  for (const lvl of levels ?? []) {
    const price = Number(lvl?.price);
    const size = Number(lvl?.size);
    if (!isNum(price) || !isNum(size)) continue;
    if (size <= 0) continue;
    if (price <= 0 || price >= 1) continue;  // a binary contract lives strictly inside (0,1)
    out.push({ price, size });
  }
  for (let i = 1; i < out.length; i++) {
    const worse = side === 'buy' ? out[i].price < out[i - 1].price : out[i].price > out[i - 1].price;
    if (worse) {
      throw new Error(`ladder is not sorted best-first for a ${side}: level ${i} at ${out[i].price} ` +
        `is better than level ${i - 1} at ${out[i - 1].price}. Polymarket's CLOB sorts away from ` +
        'the touch; use fromPolymarketBook() rather than passing its arrays through.');
    }
  }
  return out;
}

/**
 * The reversal, in one place. Polymarket's `/book` returns bids ascending and
 * asks descending; best-first is therefore the reverse of both.
 */
export function fromPolymarketBook(book) {
  const bids = [...(book?.bids ?? [])].reverse()
    .map(l => ({ price: Number(l.price), size: Number(l.size) }));
  const asks = [...(book?.asks ?? [])].reverse()
    .map(l => ({ price: Number(l.price), size: Number(l.size) }));
  return { bids: normalizeLadder(bids, 'sell'), asks: normalizeLadder(asks, 'buy'), truncated: false };
}

/**
 * A book reconstructed from a stored `polymarket_quotes` row.
 *
 * One level per side and `truncated: true`, which is not a formality: every
 * fill that exhausts it is reported as bounded rather than as filled. This is
 * the only book shape available from stored history today.
 */
export function fromStoredQuote(quote) {
  const bid = Number(quote?.best_bid), ask = Number(quote?.best_ask);
  const bidSize = Number(quote?.bid_size), askSize = Number(quote?.ask_size);
  return {
    bids: isNum(bid) && isNum(bidSize) && bidSize > 0 ? normalizeLadder([{ price: bid, size: bidSize }], 'sell') : [],
    asks: isNum(ask) && isNum(askSize) && askSize > 0 ? normalizeLadder([{ price: ask, size: askSize }], 'buy') : [],
    truncated: true,
    source: 'polymarket_quotes (touch only)'
  };
}

/* ------------------------------------------------------------------ the walk */

/**
 * Consume a best-first ladder until the size, the budget or the limit price
 * stops it.
 *
 * Partial levels are allowed — resting size is divisible, and rounding a
 * partial level away would understate achievable size on exactly the thin
 * books this exists to measure.
 *
 * @param {Array<{price:number,size:number}>} ladder - best-first
 * @param {object} opts
 * @param {number} [opts.shares]   size target in contracts
 * @param {number} [opts.budget]   cash target in dollars (shares cost `price` each)
 * @param {number} [opts.limitPrice] worst price willing to trade at
 * @param {'buy'|'sell'} opts.side
 * @param {boolean} [opts.truncated] the ladder is known to be incomplete
 */
export function walkLadder(ladder, { shares = null, budget = null, limitPrice = null, side = 'buy', truncated = false } = {}) {
  if (shares == null && budget == null) throw new Error('walkLadder needs a shares or budget target');
  if (shares != null && !(isNum(shares) && shares > 0)) throw new Error('shares must be a positive number');
  if (budget != null && !(isNum(budget) && budget > 0)) throw new Error('budget must be a positive number');

  const wantShares = shares ?? Infinity;
  const wantCash = budget ?? Infinity;

  let filled = 0, cash = 0, levelsConsumed = 0, worst = null;
  let stoppedBy = 'target';

  for (const lvl of ladder) {
    if (filled >= wantShares - 1e-12 || cash >= wantCash - 1e-12) break;
    const outsideLimit = limitPrice != null &&
      (side === 'buy' ? lvl.price > limitPrice + 1e-12 : lvl.price < limitPrice - 1e-12);
    if (outsideLimit) { stoppedBy = 'limit_price'; break; }

    const roomShares = wantShares - filled;
    const roomCash = wantCash - cash;
    const takeByCash = isNum(roomCash) ? roomCash / lvl.price : Infinity;
    const take = Math.min(lvl.size, roomShares, takeByCash);
    if (!(take > 0)) break;

    filled += take;
    cash += take * lvl.price;
    worst = lvl.price;
    levelsConsumed++;
  }

  const exhausted = levelsConsumed >= ladder.length &&
    filled < wantShares - 1e-9 && cash < wantCash - 1e-9;
  if (exhausted) stoppedBy = truncated ? 'known_book_exhausted' : 'book_exhausted';

  const requested = shares ?? null;
  const unfilled = requested == null ? null : Math.max(0, requested - filled);

  return {
    side,
    shares_requested: requested,
    budget_requested: budget ?? null,
    shares_filled: r6(filled),
    cash: r6(cash),
    avg_price: filled > 0 ? r6(cash / filled) : null,
    touch_price: ladder.length ? ladder[0].price : null,
    worst_price: worst,
    levels_consumed: levelsConsumed,
    levels_available: ladder.length,
    shares_unfilled: unfilled == null ? null : r6(unfilled),
    stopped_by: stoppedBy,
    // A truncated ladder that ran out has NOT told us the position is
    // unfillable — only that the stored book cannot say. The distinction
    // decides whether a caller may treat the remainder as zero.
    shares_beyond_known_book: truncated && exhausted && unfilled ? r6(unfilled) : null,
    bound: truncated && exhausted ? 'best_case' : 'exact',
    fill_ratio: requested ? r4(Math.min(1, filled / requested)) : null
  };
}

/* ------------------------------------------------------------------ fills */

const ZERO_FEE = () => 0;

/**
 * Fill a desired position against a two-sided book.
 *
 * @param {object} opts
 * @param {object} opts.book        {bids, asks, truncated}
 * @param {'buy'|'sell'} opts.side
 * @param {number} [opts.shares]    desired contracts
 * @param {number} [opts.stake]     desired dollars at risk (buy side)
 * @param {number} [opts.limitPrice]
 * @param {function} [opts.fee]     (avgPrice, shares) => dollars. Polymarket
 *                                  charges none; Kalshi's is priced separately.
 */
export function simulateFill({ book, side = 'buy', shares = null, stake = null, limitPrice = null, fee = ZERO_FEE } = {}) {
  if (!book) return { error: 'no book supplied' };
  const ladder = side === 'buy' ? (book.asks ?? []) : (book.bids ?? []);
  if (!ladder.length) {
    return { error: `book has no ${side === 'buy' ? 'ask' : 'bid'} side`, side, shares_filled: 0 };
  }
  const walk = walkLadder(ladder, { shares, budget: stake, limitPrice, side, truncated: Boolean(book.truncated) });
  const feeDollars = walk.shares_filled > 0 ? Number(fee(walk.avg_price, walk.shares_filled)) || 0 : 0;
  return {
    ...walk,
    fee: r6(feeDollars),
    // For a buy, cash out the door. For a sell, cash received net of fee.
    net_cash: r6(side === 'buy' ? walk.cash + feeDollars : walk.cash - feeDollars),
    effective_price: walk.shares_filled > 0
      ? r6((side === 'buy' ? walk.cash + feeDollars : walk.cash - feeDollars) / walk.shares_filled)
      : null,
    truncated_book: Boolean(book.truncated)
  };
}

/**
 * The incumbent assumption, written down so it can be compared against.
 *
 * Every share at the touch (or at whatever single price the caller has been
 * using — live-edge.js uses the MID, which is strictly better than the touch
 * and therefore strictly more optimistic), no size limit, no walk.
 */
export function naiveFill({ price, shares = null, stake = null, side = 'buy', fee = ZERO_FEE } = {}) {
  if (!isNum(price) || price <= 0 || price >= 1) return { error: 'price must lie strictly inside (0,1)' };
  const filled = shares != null ? shares : stake / price;
  const cash = filled * price;
  const feeDollars = Number(fee(price, filled)) || 0;
  return {
    side, shares_requested: shares ?? r6(filled), shares_filled: r6(filled),
    cash: r6(cash), avg_price: r6(price), fee: r6(feeDollars),
    net_cash: r6(side === 'buy' ? cash + feeDollars : cash - feeDollars),
    effective_price: r6((side === 'buy' ? cash + feeDollars : cash - feeDollars) / filled),
    fill_ratio: 1, shares_unfilled: 0, bound: 'assumed',
    assumption: 'unlimited size available at one price — no depth, no walk'
  };
}

/**
 * Naive against real, on the number that decides whether a trade is worth
 * placing: expected profit in dollars.
 *
 * Expected profit per contract = (fair value - effective price) for a buy, and
 * (effective price - fair value) for a sell. The naive side prices the WHOLE
 * requested size at the touch; the real side prices only what the book could
 * absorb, at what walking it cost.
 *
 * `profit_realised_fraction` is the headline: the share of the aspirational
 * edge that survives contact with the book. It is the number that converts a
 * cross-venue dollar figure from what a screen says to what a fill would pay.
 */
export function fillShortfall({ book, side = 'buy', shares, fairValue, limitPrice = null, fee = ZERO_FEE, naivePrice = null } = {}) {
  if (!isNum(shares) || shares <= 0) return { error: 'shares must be a positive number' };
  if (!isNum(fairValue) || fairValue <= 0 || fairValue >= 1) return { error: 'fairValue must lie strictly inside (0,1)' };

  const real = simulateFill({ book, side, shares, limitPrice, fee });
  if (real.error) return real;

  const touch = real.touch_price;
  const assumedPrice = naivePrice ?? touch;
  const naive = naiveFill({ price: assumedPrice, shares, side, fee });
  if (naive.error) return naive;

  const edgePerShare = (eff) => (side === 'buy' ? fairValue - eff : eff - fairValue);
  const naiveProfit = naive.shares_filled * edgePerShare(naive.effective_price);
  const realProfit = real.shares_filled > 0 ? real.shares_filled * edgePerShare(real.effective_price) : 0;

  const slippage = real.avg_price != null && touch != null
    ? (side === 'buy' ? real.avg_price - touch : touch - real.avg_price) : null;

  return {
    version: EXECUTION_FILL_VERSION,
    side, shares_requested: shares, fair_value: r4(fairValue),
    naive: { price: r6(assumedPrice), shares_filled: r6(naive.shares_filled),
      cash: naive.cash, expected_profit: r6(naiveProfit),
      basis: naivePrice != null ? 'caller-supplied single price (e.g. the mid)' : 'touch price' },
    actual: { avg_price: real.avg_price, effective_price: real.effective_price,
      shares_filled: real.shares_filled, cash: real.cash, fee: real.fee,
      levels_consumed: real.levels_consumed, worst_price: real.worst_price,
      expected_profit: r6(realProfit), bound: real.bound },
    fill_ratio: real.fill_ratio,
    shares_unfilled: real.shares_unfilled,
    shares_beyond_known_book: real.shares_beyond_known_book,
    slippage_vs_touch: r6(slippage),
    slippage_bps_of_stake: real.cash > 0 && slippage != null ? r4(10000 * slippage / real.avg_price) : null,
    profit_realised_fraction: naiveProfit !== 0 ? r4(realProfit / naiveProfit) : null,
    profit_shortfall: r6(naiveProfit - realProfit),
    capped_by: real.stopped_by,
    truncated_book: real.truncated_book,
    note: real.bound === 'best_case'
      ? 'The stored book ran out before the size did. Everything above is the BEST case: the ' +
        'unfilled remainder is unknown, not zero, and any price it could have filled at is worse ' +
        'than the one reported here. ' + POLYMARKET_LADDER_NOTE
      : null
  };
}

/* ------------------------------------------------------------------ combinations */

/**
 * A multi-leg position is only as large as its thinnest leg.
 *
 * This is the whole point of the exercise for combinatorial arbitrage. A
 * screen that finds a mispricing across four legs and reports it in dollars is
 * quoting a number that assumes every leg fills at its touch in unlimited
 * size. In reality the position is an all-or-nothing package: leg sizes are
 * locked in a ratio, and the executable multiple is the MINIMUM across legs of
 * (what that leg's book can absorb / what that leg needs). One 15-share leg
 * caps the entire structure at 15 shares no matter how deep the other three
 * are, and the dollar figure collapses by the same factor.
 *
 * @param {object} opts
 * @param {Array} opts.legs - each {key, book, side, ratio, fairValue, fee?, limitPrice?}
 *   `ratio` is how many contracts of this leg one unit of the package needs.
 * @param {number} opts.units - desired packages
 */
export function combinationFill({ legs = [], units = 1 } = {}) {
  if (!legs.length) return { error: 'no legs supplied' };
  if (!isNum(units) || units <= 0) return { error: 'units must be a positive number' };

  // How many packages each leg can support on its own.
  const capacity = legs.map(leg => {
    const ratio = isNum(leg.ratio) && leg.ratio > 0 ? leg.ratio : 1;
    const ladder = leg.side === 'sell' ? (leg.book?.bids ?? []) : (leg.book?.asks ?? []);
    const probe = ladder.length
      ? walkLadder(ladder, { shares: units * ratio, limitPrice: leg.limitPrice ?? null,
        side: leg.side ?? 'buy', truncated: Boolean(leg.book?.truncated) })
      : { shares_filled: 0, bound: 'exact', levels_available: 0 };
    return { key: leg.key, ratio, units_supported: probe.shares_filled / ratio,
      bound: probe.bound, levels_available: probe.levels_available };
  });

  const executableUnits = Math.min(...capacity.map(c => c.units_supported));
  const binding = capacity.filter(c => Math.abs(c.units_supported - executableUnits) < 1e-9).map(c => c.key);
  const anyBounded = capacity.some(c => c.bound === 'best_case');

  const fills = legs.map(leg => {
    const ratio = isNum(leg.ratio) && leg.ratio > 0 ? leg.ratio : 1;
    const want = executableUnits * ratio;
    if (!(want > 0)) {
      return { key: leg.key, side: leg.side ?? 'buy', shares_filled: 0, cash: 0,
        avg_price: null, expected_profit: 0 };
    }
    const f = simulateFill({ book: leg.book, side: leg.side ?? 'buy', shares: want,
      limitPrice: leg.limitPrice ?? null, fee: leg.fee ?? ZERO_FEE });
    const edge = isNum(leg.fairValue) && f.effective_price != null
      ? ((leg.side === 'sell' ? f.effective_price - leg.fairValue : leg.fairValue - f.effective_price) * f.shares_filled)
      : null;
    return { key: leg.key, side: leg.side ?? 'buy', shares_filled: f.shares_filled,
      cash: f.cash, fee: f.fee, avg_price: f.avg_price, effective_price: f.effective_price,
      levels_consumed: f.levels_consumed, expected_profit: r6(edge) };
  });

  // The aspirational number: the desired units, every leg at its own touch.
  const aspirational = legs.map(leg => {
    const ratio = isNum(leg.ratio) && leg.ratio > 0 ? leg.ratio : 1;
    const ladder = leg.side === 'sell' ? (leg.book?.bids ?? []) : (leg.book?.asks ?? []);
    const touch = ladder.length ? ladder[0].price : null;
    if (touch == null || !isNum(leg.fairValue)) return null;
    const n = naiveFill({ price: touch, shares: units * ratio, side: leg.side ?? 'buy', fee: leg.fee ?? ZERO_FEE });
    const edge = (leg.side === 'sell' ? n.effective_price - leg.fairValue : leg.fairValue - n.effective_price);
    return { key: leg.key, expected_profit: n.shares_filled * edge, cash: n.cash };
  });

  const realProfit = fills.reduce((s, f) => s + (f.expected_profit ?? 0), 0);
  const naiveProfit = aspirational.reduce((s, a) => s + (a?.expected_profit ?? 0), 0);

  return {
    version: EXECUTION_FILL_VERSION,
    units_requested: units,
    units_executable: r6(executableUnits),
    execution_ratio: units > 0 ? r4(executableUnits / units) : null,
    binding_legs: binding,
    per_leg_capacity: capacity.map(c => ({ key: c.key, units_supported: r6(c.units_supported),
      bound: c.bound, levels_available: c.levels_available })),
    legs: fills,
    total_cash: r6(fills.reduce((s, f) => s + (f.side === 'sell' ? -f.cash : f.cash), 0)),
    total_fees: r6(fills.reduce((s, f) => s + (f.fee ?? 0), 0)),
    aspirational_expected_profit: r6(naiveProfit),
    realistic_expected_profit: r6(realProfit),
    profit_realised_fraction: naiveProfit !== 0 ? r4(realProfit / naiveProfit) : null,
    bound: anyBounded ? 'best_case' : 'exact',
    note: 'A package fills in a fixed ratio, so its size is the MINIMUM over legs of what each ' +
      "leg's book can absorb. The binding leg sets the size for all of them." +
      (anyBounded ? ' At least one leg came from a truncated (touch-only) book, so the executable ' +
        'size above is a LOWER bound and the profit a BEST case.' : '')
  };
}
