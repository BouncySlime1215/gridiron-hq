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
import { isFreshQuote } from './book-feeds.js';
import { validAmericanPrice } from './nfl-execution-validation.js';
import { quoteClockValid, SHOPPING_MAX_AGE_MS } from './nfl-quote-clock.js';

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
 * Every book's OWN most recent quote per event, bounded to a capture window
 * around whichever book was polled last for that event.
 *
 * Books are polled on separate schedules (a live 90-second tier, an hourly
 * tier, and so on), so their `captured_at` values for the same event
 * legitimately differ by minutes even when every one of them is still the
 * current standing price. An exact-equality join on the event's single
 * MAX(captured_at) silently dropped every book except whichever provider
 * happened to be polled last -- on a board with staggered tiers that could be
 * nearly every book, not the stale ones this function actually needs to
 * exclude.
 *
 * A book whose OWN latest quote trails the event's freshest book by more than
 * `CAPTURE_WINDOW_MS` is still excluded -- that book genuinely has not been
 * repolled recently enough to belong in the same comparison, which is the
 * real thing "one book is not a shopping decision" is protecting against.
 *
 * Sharing a bounded window controls for OUR poll latency, not for the
 * aggregator's: a book's own price can sit uncached in the aggregator's
 * response for days after it moved (`book-feeds.js#isFreshQuote`), so a quote
 * with a stale `book_updated_at` is dropped here too before two books are
 * ever compared as if both were live.
 */
const CAPTURE_WINDOW_MS = 5 * 60 * 1000;

let _quoteCache = new Map();
export function clearShoppingBoardCache() { _quoteCache = new Map(); }

export function simultaneousQuotes(market = 'spreads') {
  // Cache the stored sets, not their permission to be shown as current.
  // Time must be checked on every read, including when ingestion has stopped.
  if (_quoteCache.has(market)) return _quoteCache.get(market).filter(q => quoteClockValid(q));

  // One query, grouped in memory. This used to run a SELECT per event, which on
  // a hundred-event board meant a hundred round trips — and because both the
  // shopping board and the middle finder call it, the hub status endpoint paid
  // that cost twice and took 17 seconds to answer.
  //
  // Grouped by (event_id, book) rather than event_id alone: each book
  // contributes only its own latest row, not whichever book's latest happens
  // to be the newest across the whole event.
  const all = rows(
    `SELECT s.event_id, s.captured_at, s.book, s.side, s.line, s.price AS american_price,
            s.commence_time, s.home_team, s.away_team, s.book_updated_at
     FROM nfl_line_snapshots s
     JOIN (SELECT event_id, book, MAX(captured_at) AS captured_at
           FROM nfl_line_snapshots WHERE market = ? GROUP BY event_id, book) latest
       ON latest.event_id = s.event_id AND latest.book = s.book AND latest.captured_at = s.captured_at
     WHERE s.market = ?`, market, market);

  const byEvent = new Map();
  for (const q of all) {
    if (!isFreshQuote(q.captured_at, q.book_updated_at)) continue;
    if (!byEvent.has(q.event_id)) {
      byEvent.set(q.event_id, { event_id: q.event_id, captured_at: q.captured_at, market,
        home_team: q.home_team ?? null, away_team: q.away_team ?? null,
        commence_time: q.commence_time ?? null, quotes: [] });
    }
    const ev = byEvent.get(q.event_id);
    // Track the freshest capture actually seen for this event so the window
    // below is bounded to real data, not to whichever row arrived first.
    if (Date.parse(q.captured_at) > Date.parse(ev.captured_at)) ev.captured_at = q.captured_at;
    const { book_updated_at, ...quote } = q;
    ev.quotes.push(quote);
  }

  const out = [];
  for (const ev of byEvent.values()) {
    const freshest = Date.parse(ev.captured_at);
    const withinWindow = ev.quotes.filter(q => freshest - Date.parse(q.captured_at) <= CAPTURE_WINDOW_MS);
    const books = new Set(withinWindow.map(q => q.book));
    if (books.size < 2) continue;      // one book is not a shopping decision
    out.push({ ...ev, quotes: withinWindow, books: books.size });
  }
  _quoteCache.set(market, out);
  return out.filter(q => quoteClockValid(q));
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
      // bestExecution() only checks Number.isFinite(american_price) before it
      // starts converting prices to decimal odds, and that conversion THROWS
      // on anything below 100 in magnitude (nfl-execution-edge.js's
      // assertRealPrice) -- including a captured 0, which is finite. One bad
      // snapshot row used to crash the whole board's request, every event and
      // every side, rather than just being dropped from this one comparison.
      const realPriceQuotes = quotes.filter(q => validAmericanPrice(q.american_price));
      const exec = bestExecution(realPriceQuotes, { takingPoints });
      if (!exec) continue;

      // Codex correction C05 gave `bestExecution` an explicit refusal: when no
      // valid spread distribution exists, it returns `best: null` and a reason
      // instead of ranking books by a number it could not compute. The side is
      // still boarded -- dropping it would hide a coverage gap behind an empty
      // list -- but it carries the refusal rather than a fabricated best book.
      if (!exec.best) {
        rowsOut.push({
          event_id: ev.event_id, captured_at: ev.captured_at, market,
          matchup: ev.away_team && ev.home_team ? `${ev.away_team} at ${ev.home_team}` : ev.event_id,
          commence_time: ev.commence_time, side,
          books_compared: exec.books_compared,
          best_book: null, best_line: null, best_price: null, median_line: exec.median_line,
          line_edge: null, price_edge: null,
          win_probability: null, loss_probability: null, push_probability: null,
          expected_net_return: null, edge_vs_median: null, qualified: false,
          unpriceable_reason: exec.reason,
          all: exec.all
        });
        continue;
      }

      rowsOut.push({
        event_id: ev.event_id, captured_at: ev.captured_at, market,
        matchup: ev.away_team && ev.home_team ? `${ev.away_team} at ${ev.home_team}` : ev.event_id,
        commence_time: ev.commence_time, side,
        books_compared: exec.books_compared,
        best_book: exec.best.book,
        best_line: exec.best.line, best_price: exec.best.american_price,
        median_line: exec.median_line,
        line_edge: exec.best.line_edge, price_edge: exec.best.price_edge,
        // Codex audit finding E5: the exact three-state breakdown behind
        // line_edge, so a downstream consumer (execution-slate-reasoning.js)
        // can compute real price-aware EV instead of re-deriving a
        // probability from the ranking-only line_edge scalar.
        win_probability: exec.best.win_probability, loss_probability: exec.best.loss_probability,
        push_probability: exec.best.push_probability,
        // Codex correction C05 got this right WITHIN one side: rank the books
        // quoting a single event/side by expected net return at each book's
        // own line and price, under one distribution, rather than by the old
        // `line_edge * 2 + price_edge` heuristic that once ranked +2.5/+100
        // above +3/-150 while its own computed EVs were -0.1500 and -0.1417.
        // Kept here as a diagnostic.
        expected_net_return: exec.best.expected_net_return,
        // GIANT PLAN 29. `expected_net_return` is NOT safe to sort or lead a
        // display with ACROSS different sides and events, and this board used
        // to do exactly that. It carries the reference LINE's own historical
        // cover rate -- the same "underdog bias" the 2026-09-10 audit found
        // baked into `coverProbabilities` (+6.5 covers 53.53% historically,
        // +10 covers 55.28%, both above the 52.38% break-even purely on
        // twenty years of who that number happened to favour). That bias is
        // identical for every book quoting one side, so it cancels out of a
        // WITHIN-side ranking -- comparing books at the same reference line --
        // but this board's leaderboard compares DIFFERENT sides and events,
        // each sitting at its own reference line with its own bias level, and
        // `expected_net_return` would put the board's largest historical dog
        // bias at the top regardless of whether that particular book actually
        // shopped any better than its own median. `edge_vs_median` is
        // `bestExecution`'s answer to that: this book's expected return minus
        // what blindly taking the median book's own line and price would have
        // returned, both under the identical distribution, so the shared bias
        // term cancels and what is left is the genuine improvement from
        // shopping. This is the field the board now leads on.
        edge_vs_median: exec.best.edge_vs_median,
        // How this row was ranked. `price_only` means the module could not
        // value the NUMBER on this contract and compared prices at the most
        // common one instead — true for moneylines (no number) and totals (a
        // total is not a margin).
        ranked_by: exec.ranked_by ?? 'edge_vs_median',
        compared_at_line: exec.compared_at_line ?? null,
        // NOT an edge over the market. These probabilities are implied by the
        // market's own reference line, so a positive number here means a
        // better obtainable contract than the median book, never a profitable
        // bet. `qualified` stays false until a qualified forecast supplies the
        // distribution.
        qualified: exec.qualified === true,
        all: exec.all
      });
    }
  }
  return rowsOut
    .sort((a, b) => {
      // GIANT PLAN 29: lead on edge_vs_median (within-side improvement over
      // the median book), not the absolute expected_net_return -- see the
      // long comment above where each row is built for why the absolute
      // number is not comparable across sides. A row with no distribution at
      // all (price_only, or fully unpriceable) has neither field and sorts
      // last either way.
      const av = a.edge_vs_median, bv = b.edge_vs_median;
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return bv - av;
    })
    .slice(0, limit);
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
  // "Shoppable" means this book's contract beats the median book's, measured
  // as expected net return under one distribution. It is a statement about
  // execution quality, not about beating the market.
  const shoppable = spreads.filter(r => r.expected_net_return != null
    && r.line_edge != null && (r.line_edge > 0 || (r.price_edge ?? 0) > 0));
  const captures = [...new Set(spreads.map(r => r.captured_at))].sort();

  return {
    sides_priced: spreads.length,
    events: new Set(spreads.map(r => r.event_id)).size,
    shoppable_sides: shoppable.length,
    // GIANT PLAN 29. THE LEADING NUMBERS. `edge_vs_median` is the honest
    // within-side improvement from shopping (see the long comment in
    // `shoppingBoard` above) -- it is safe to average and to headline because,
    // unlike `expected_net_return`, it does not carry the reference line's own
    // historical cover-rate bias. This is what `betting-hub.js` now puts in
    // the human-facing headline.
    mean_edge_vs_median_when_shoppable: shoppable.length
      ? r4(shoppable.reduce((s, r) => s + (r.edge_vs_median ?? 0), 0) / shoppable.length) : null,
    best_edge_vs_median: spreads[0]?.edge_vs_median ?? null,
    // Mean over the sides where shopping actually beats the median book. The
    // all-sides mean is the wrong number: half of any dispersion is by
    // definition below median and is not an available improvement.
    //
    // KEPT AS A DIAGNOSTIC ONLY, not the lead. `expected_net_return` (and
    // therefore this mean, and `best_expected_return` below) is the ABSOLUTE
    // return implied by each side's own reference line, which the
    // 2026-09-10 audit measured as carrying a real historical underdog bias
    // -- it is not comparable across different sides/events and must not be
    // used to rank or headline this board. See `mean_edge_vs_median_when_shoppable`
    // and `best_edge_vs_median` above for the numbers that are safe to lead with.
    mean_expected_return_when_shoppable: shoppable.length
      ? r4(shoppable.reduce((s, r) => s + r.expected_net_return, 0) / shoppable.length) : null,
    best_expected_return: spreads[0]?.expected_net_return ?? null,
    // Nothing on this board is a qualified edge. Reported explicitly so a
    // reader cannot infer profitability from a positive number above.
    qualified: false,
    qualification_note: 'expected returns here are computed against the market\'s own reference line. ' +
      'They rank obtainable contracts and measure execution quality; they are not evidence of an edge. ' +
      '`edge_vs_median` isolates the shopping improvement itself; `expected_net_return` additionally ' +
      'carries that reference line\'s own historical cover-rate level and is not comparable across sides.',
    middles_found: middles.length,
    positive_ev_middles: middles.filter(m => (m.ev_per_unit ?? 0) > 0).length,
    arbitrage_found: middles.filter(m => m.arbitrage).length,
    latest_capture: captures[captures.length - 1] ?? rows('SELECT MAX(captured_at) at FROM nfl_line_snapshots')[0]?.at ?? null,
    stale: captures.length === 0,
    max_capture_age_minutes: SHOPPING_MAX_AGE_MS / 60000,
    note: 'Every comparison is between quotes captured at the same instant. Nothing here ' +
      'proves positive expected profit. The price advantage is relative to other books; confirm the offered price before acting.'
  };
}
