/**
 * The shopping board — where the measured execution edge actually gets surfaced.
 *
 * `nfl-execution-edge.js` already prices a line move against the real NFL margin
 * distribution and picks the best of several quotes (`bestExecution`). Until now
 * nothing called it: the multi-book snapshots were captured into
 * `nfl_line_snapshots` and never read back. This module is the missing join —
 * it reads those snapshots and produces the two things that are worth money
 * without predicting anything:
 *
 *   1. Best-price execution. The same bet, priced across every book that quoted
 *      it at the same instant, ranked by what shopping is worth against the
 *      median book. Measured on this database's own Aug 5 capture, the Jets were
 *      simultaneously available at +2.0/-120 and +3.0/+100 — an 8.7-point EV
 *      swing on an identical bet, decided only by which book you use.
 *
 *   2. Middles. When two books straddle far enough apart, both sides of the same
 *      game can be bet so that a margin landing in the gap wins both. That is
 *      priced here against the empirical margin distribution rather than assumed.
 *
 * THE ONE RULE THIS MODULE MUST NOT BREAK: only ever compare quotes captured at
 * the same instant. Comparing a stale book against a fresh one measures latency
 * and reports it as dispersion, which would manufacture edges that do not exist.
 * Every query below groups on `captured_at` for exactly that reason.
 */
import { rows } from '../db/index.js';
import { bestExecution, impliedProb } from './nfl-execution-edge.js';

const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
const dec = american => (american >= 0 ? 1 + american / 100 : 1 + 100 / -american);

/* ------------------------------------------- signed margin distribution */

let signedCache = null;
/**
 * Empirical distribution of SIGNED final margins from the home team's view.
 *
 * `marginDistribution()` in nfl-execution-edge.js is absolute-value only, which
 * is right for "what is a half point worth" but wrong for a middle: a middle
 * window is directional (it sits between two specific numbers on one side's
 * scale), so collapsing sign would price a window on the favourite the same as
 * the identical window on the underdog.
 */
export function signedMarginDistribution() {
  if (signedCache) return signedCache;
  const g = rows(`SELECT team_score, opp_score FROM game_lines
                  WHERE team_score IS NOT NULL AND opp_score IS NOT NULL AND home = 1`);
  const freq = new Map();
  for (const x of g) {
    const m = x.team_score - x.opp_score;
    freq.set(m, (freq.get(m) ?? 0) + 1);
  }
  const n = g.length || 1;
  signedCache = { n, pmf: new Map([...freq].map(([m, c]) => [m, c / n])) };
  return signedCache;
}

/* ------------------------------------------------- simultaneous quote sets */

/**
 * The most recent capture instant per event that actually carries more than one
 * book, with every quote from that instant.
 *
 * An event whose latest snapshot has a single book is skipped rather than
 * reported with an empty comparison — one book is not a shopping decision, and
 * silently showing it as "best available" would overstate what we know.
 */
let _quoteCache = new Map();
export function clearShoppingBoardCache() { _quoteCache = new Map(); }

export function simultaneousQuotes(market = 'spreads') {
  if (_quoteCache.has(market)) return _quoteCache.get(market);

  // One query, grouped in memory. This used to run a SELECT per event, which on
  // a hundred-event board meant a hundred round trips — and because both the
  // shopping board and the middle finder call it, the hub status endpoint paid
  // that cost twice and took 17 seconds to answer.
  const all = rows(
    `SELECT s.event_id, s.captured_at, s.book, s.side, s.line, s.price AS american_price,
            s.commence_time, s.home_team, s.away_team
     FROM nfl_line_snapshots s
     JOIN (SELECT event_id, MAX(captured_at) AS captured_at
           FROM nfl_line_snapshots WHERE market = ? GROUP BY event_id) latest
       ON latest.event_id = s.event_id AND latest.captured_at = s.captured_at
     WHERE s.market = ?`, market, market);

  const byEvent = new Map();
  for (const q of all) {
    if (!byEvent.has(q.event_id)) {
      byEvent.set(q.event_id, { event_id: q.event_id, captured_at: q.captured_at, market,
        home_team: q.home_team ?? null, away_team: q.away_team ?? null,
        commence_time: q.commence_time ?? null, quotes: [] });
    }
    byEvent.get(q.event_id).quotes.push(q);
  }

  const out = [];
  for (const ev of byEvent.values()) {
    const books = new Set(ev.quotes.map(q => q.book));
    if (books.size < 2) continue;      // one book is not a shopping decision
    out.push({ ...ev, books: books.size });
  }
  _quoteCache.set(market, out);
  return out;
}

/* ------------------------------------------------------- best-price board */

/**
 * Every side of every event, ranked by what shopping it is worth against the
 * median book. This is the honest counterfactual: a bettor without a shopping
 * habit takes whichever book they happen to have open, which is a median book
 * in expectation — not the worst one.
 */
export function shoppingBoard({ market = 'spreads', limit = 40 } = {}) {
  const events = simultaneousQuotes(market);
  const rowsOut = [];

  for (const ev of events) {
    const bySide = new Map();
    for (const q of ev.quotes) {
      if (!q.side) continue;
      if (!bySide.has(q.side)) bySide.set(q.side, []);
      bySide.get(q.side).push(q);
    }
    for (const [side, quotes] of bySide) {
      // Totals are quoted as Over/Under, where the Under wants the LARGER
      // number and the Over wants the smaller — the opposite of taking points
      // on a spread. Getting this backwards would rank the worst book first.
      const takingPoints = market === 'totals' ? /under/i.test(side) : true;
      const exec = bestExecution(quotes, { takingPoints });
      if (!exec) continue;
      rowsOut.push({
        event_id: ev.event_id, captured_at: ev.captured_at, market,
        matchup: ev.away_team && ev.home_team ? `${ev.away_team} at ${ev.home_team}` : ev.event_id,
        commence_time: ev.commence_time, side,
        books_compared: exec.books_compared,
        best_book: exec.best.book,
        best_line: exec.best.line, best_price: exec.best.american_price,
        median_line: exec.median_line,
        line_edge: exec.best.line_edge, price_edge: exec.best.price_edge,
        edge_vs_median: exec.edge_vs_median,
        all: exec.all
      });
    }
  }
  return rowsOut.sort((a, b) => (b.edge_vs_median ?? 0) - (a.edge_vs_median ?? 0)).slice(0, limit);
}

/* ------------------------------------------------------------- middles */

/**
 * Price one middle exactly, over the empirical margin distribution.
 *
 * Both sides are staked one unit. `homeLine` and `awayLine` are each side's
 * BEST available number, from whichever book offers it — that is the whole
 * point: the middle only exists across two books, never at one.
 *
 * Home covers when   margin > -homeLine
 * Away covers when   margin <  awayLine        (margin is signed, home's view)
 * so both cover on   -homeLine < margin < awayLine,  a window of width
 * homeLine + awayLine. A non-positive width means no middle exists.
 */
export function priceMiddle({ homeLine, awayLine, homePrice, awayPrice }) {
  if (![homeLine, awayLine, homePrice, awayPrice].every(Number.isFinite)) return null;
  const width = homeLine + awayLine;
  if (width <= 0) return null;

  const { pmf } = signedMarginDistribution();
  const homeProfit = dec(homePrice) - 1;
  const awayProfit = dec(awayPrice) - 1;

  let ev = 0, pBoth = 0, pPushSide = 0;
  for (const [margin, p] of pmf) {
    // Per side: +profit on a cover, -1 on a loss, 0 when it lands exactly on
    // the number (stake returned). Pushes are the reason a middle is cheaper
    // than it looks — they convert a losing leg into a free one.
    const homeEdge = margin + homeLine;
    const awayEdge = awayLine - margin;
    const home = homeEdge === 0 ? 0 : homeEdge > 0 ? homeProfit : -1;
    const away = awayEdge === 0 ? 0 : awayEdge > 0 ? awayProfit : -1;
    ev += p * (home + away);
    if (homeEdge > 0 && awayEdge > 0) pBoth += p;
    if (homeEdge === 0 || awayEdge === 0) pPushSide += p;
  }

  return {
    width: r4(width),
    hit_probability: r4(pBoth),
    push_probability: r4(pPushSide),
    // Staked two units total, so EV is expressed per unit risked.
    ev_per_unit: r4(ev / 2),
    // A true arb: both sides' no-vig prices sum under 1, profit regardless.
    arbitrage: impliedProb(homePrice) + impliedProb(awayPrice) < 1
  };
}

/**
 * Every event where the two sides' best available numbers straddle far enough
 * apart to create a real window, priced and ranked by EV.
 */
export function findMiddles({ limit = 20 } = {}) {
  const events = simultaneousQuotes('spreads');
  // Hoisted: the distribution is identical for every event, and rebuilding the
  // window scan per game was pure waste on a full board.
  const { pmf } = signedMarginDistribution();
  const marginKeys = [...pmf.keys()];
  const found = [];

  for (const ev of events) {
    if (!ev.home_team || !ev.away_team) continue;
    const pick = team => ev.quotes
      .filter(q => q.side === team && Number.isFinite(q.line) && Number.isFinite(q.american_price))
      // Best number first; on a tie, the better price breaks it.
      .sort((a, b) => b.line - a.line || b.american_price - a.american_price)[0] ?? null;

    const home = pick(ev.home_team), away = pick(ev.away_team);
    if (!home || !away) continue;
    if (home.book === away.book) continue;   // a single book never middles itself

    const priced = priceMiddle({
      homeLine: home.line, awayLine: away.line,
      homePrice: home.american_price, awayPrice: away.american_price
    });
    if (!priced) continue;

    const window = marginKeys
      .filter(m => m > -home.line && m < away.line)
      .sort((a, b) => a - b);

    found.push({
      event_id: ev.event_id, captured_at: ev.captured_at,
      matchup: `${ev.away_team} at ${ev.home_team}`, commence_time: ev.commence_time,
      books_compared: ev.books,
      home: { team: ev.home_team, book: home.book, line: home.line, price: home.american_price },
      away: { team: ev.away_team, book: away.book, line: away.line, price: away.american_price },
      winning_margins: window,
      ...priced
    });
  }
  return found.sort((a, b) => (b.ev_per_unit ?? 0) - (a.ev_per_unit ?? 0)).slice(0, limit);
}

/* --------------------------------------------------------- book hold */

/**
 * What each book actually charges, measured rather than assumed.
 *
 * Hold is the sum of both sides' implied probabilities minus one — the margin
 * the book builds into the price. It is the single largest and most certain
 * cost a bettor pays, it is knowable before placing a bet, and it varies far
 * more between books than most people expect.
 *
 * This matters more than any forecast in this codebase. The model is 0.44
 * points of MAE *worse* than the closing line, so it contributes no edge at
 * all — but moving from the most expensive book measured here to the cheapest
 * is worth over a point of required win rate, with no prediction involved.
 * Reducing the vig is the only lever on this board that is guaranteed to work.
 */
export function bookHold({ market = null, sport = 'nfl' } = {}) {
  // The engine does not know or care what sport it is looking at — a hold is a
  // property of two prices, not of football. `sport` only selects which table
  // the quotes come from and what identifies a single market within it.
  //
  // MLB quotes are player props, so a market is identified by the PLAYER as
  // well as the event; grouping on event alone would pool every batter in a
  // game into one "market" and compute a hold across unrelated bets.
  const quotes = sport === 'mlb'
    ? rows(`SELECT captured_at, event_id, market, book, side, price, selection
            FROM mlb_market_quotes
            WHERE price IS NOT NULL ${market ? 'AND market = ?' : ''}`,
      ...(market ? [market] : []))
    : rows(`SELECT captured_at, event_id, market, book, side, price, NULL AS selection
            FROM nfl_line_snapshots
            WHERE price IS NOT NULL ${market ? 'AND market = ?' : ''}`,
      ...(market ? [market] : []));

  // A hold is only defined for a complete two-sided market from one book at one
  // instant. Pairing across books or across time would measure something else.
  const pairs = new Map();
  for (const q of quotes) {
    const key = `${q.captured_at}|${q.event_id}|${q.market}|${q.selection ?? ''}|${q.book}`;
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key).push(q);
  }

  const byBook = new Map();
  for (const [key, sides] of pairs) {
    if (sides.length !== 2) continue;
    const hold = impliedProb(sides[0].price) + impliedProb(sides[1].price) - 1;
    if (!Number.isFinite(hold)) continue;
    // Book is the LAST key segment. It moved when `selection` was added to
    // support player-prop markets, and reading a fixed index silently reported
    // batter names as sportsbooks.
    const parts = key.split('|');
    const book = parts[parts.length - 1];
    if (!byBook.has(book)) byBook.set(book, []);
    byBook.get(book).push(hold);
  }

  const out = [...byBook.entries()]
    .map(([book, holds]) => {
      const hold = holds.reduce((a, b) => a + b, 0) / holds.length;
      return {
        book, markets_measured: holds.length, hold: r4(hold),
        // On an otherwise fair market, break-even is half the hold above even.
        break_even: r4((1 + hold) / 2),
        // What a zero-edge bettor surrenders per 100 units staked.
        cost_per_100_units: r4((hold / 2) * 100)
      };
    })
    .sort((a, b) => a.hold - b.hold);

  if (!out.length) return { sport, books: [], note: 'no two-sided quotes captured yet' };
  const best = out[0], worst = out[out.length - 1];
  return {
    sport,
    books: out,
    best_book: best.book, worst_book: worst.book,
    spread_in_hold: r4(worst.hold - best.hold),
    // The number that matters: how much lower a win rate the cheap book needs.
    win_rate_saved: r4((worst.hold - best.hold) / 2),
    note: 'Hold is the book\'s built-in margin, measured from two-sided prices at one ' +
      'instant. It is the largest cost a bettor controls without predicting anything.'
  };
}

/* ------------------------------------------------------------- summary */

export function executionBoardSummary() {
  const spreads = shoppingBoard({ market: 'spreads', limit: 200 });
  const middles = findMiddles({ limit: 50 });
  const positive = spreads.filter(r => (r.edge_vs_median ?? 0) > 0);
  const captures = [...new Set(spreads.map(r => r.captured_at))].sort();

  return {
    sides_priced: spreads.length,
    events: new Set(spreads.map(r => r.event_id)).size,
    shoppable_sides: positive.length,
    // Mean over the sides where shopping actually beats the median book. The
    // all-sides mean is the wrong number: half of any dispersion is by
    // definition below median and is not an available edge.
    mean_edge_when_shoppable: positive.length
      ? r4(positive.reduce((s, r) => s + r.edge_vs_median, 0) / positive.length) : null,
    best_edge: positive[0]?.edge_vs_median ?? null,
    middles_found: middles.length,
    positive_ev_middles: middles.filter(m => (m.ev_per_unit ?? 0) > 0).length,
    arbitrage_found: middles.filter(m => m.arbitrage).length,
    latest_capture: captures[captures.length - 1] ?? null,
    stale: captures.length
      ? (Date.now() - new Date(captures[captures.length - 1]).getTime()) / 36e5 > 24 : true,
    note: 'Every comparison is between quotes captured at the same instant. Nothing here ' +
      'forecasts a game — the edge is the price difference between books at one moment.'
  };
}
