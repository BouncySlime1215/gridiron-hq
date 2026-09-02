/**
 * Where to actually place a bet, and what it saved.
 *
 * This is the only module in the project built on a measured positive. Every
 * forecasting result here is negative — twenty-two models, five seasons, ~2,600
 * graded bets, and a closing-line-value r-squared of 0.0016 — but book hold
 * spans 3.09% at lowvig to 5.54% at betrivers, and that 2.45-point spread comes
 * straight off the win rate you need. It is worth 1.22 points, it requires
 * being right about nothing, and until now nothing in this codebase claimed it.
 *
 * `shoppingBoard()` already ranked lines. What was missing is the step after:
 * given a bet you have decided to make, say where it goes, price the
 * alternative, and then keep score. The last part matters most — a tool that
 * recommends and never checks itself is how the rest of this project ended up
 * with twenty-one models nobody had graded.
 *
 * WHAT THIS DOES NOT DO: decide what to bet. It takes the bet as given. Every
 * attempt in this repo to pick sides has failed its own audit, so the executor
 * deliberately has no opinion about which side is right — only about where a
 * decided bet should be placed.
 */
import { rows, row, run } from '../db/index.js';
import { simultaneousQuotes } from './nfl-shopping-board.js';
import { lineMoveValue } from './nfl-execution-edge.js';

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

run(`CREATE TABLE IF NOT EXISTS nfl_execution_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  routed_at    TEXT NOT NULL,
  event_id     TEXT,
  matchup      TEXT,
  market       TEXT NOT NULL,
  side         TEXT NOT NULL,
  stake_units  REAL NOT NULL,
  chosen_book  TEXT NOT NULL,
  chosen_line  REAL,
  chosen_price INTEGER,
  median_price INTEGER,
  worst_price  INTEGER,
  books_compared INTEGER,
  saved_vs_median_pct REAL,
  saved_vs_worst_pct  REAL,
  note         TEXT
)`);

/** American odds to implied probability, vig included. */
export const impliedProbability = odds => {
  if (!Number.isFinite(odds)) return null;
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
};

/** Profit on a one-unit stake at these odds. */
export const payoutPerUnit = odds => {
  if (!Number.isFinite(odds)) return null;
  return odds > 0 ? odds / 100 : 100 / Math.abs(odds);
};

/**
 * The break-even win rate a price demands.
 *
 * This is the number that actually matters when comparing books, and it is why
 * hold is worth arguing about: -110 needs 52.38% and -105 needs 51.22%. That
 * 1.16-point gap is larger than any forecasting edge this project has ever
 * measured, and it is available by clicking a different website.
 */
export const breakEvenRate = odds => {
  const p = payoutPerUnit(odds);
  return p == null ? null : 1 / (1 + p);
};

const median = a => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Rank every book for one side of one market.
 *
 * Ranks on the actual payout, not on the book's overall hold. A book with a
 * great average hold can still post the worst number on any given game, and
 * routing on reputation rather than the live price is how a shopping edge gets
 * given back.
 *
 * For spreads, a better LINE beats a better price — half a point through a key
 * number is worth far more than five cents of juice — so lines are compared
 * first and price only breaks ties at equal lines.
 */
export function rankBooks(quotes, { market = 'spreads', takingPoints = true } = {}) {
  // The snapshot table spells this `american_price`; accept a plain `price`
  // too so a caller can hand in quotes from anywhere.
  const priceOf = q => (Number.isFinite(q.american_price) ? q.american_price : q.price);
  const usable = quotes.filter(q => Number.isFinite(priceOf(q)));
  if (!usable.length) return null;

  const raw = usable.map(q => ({
    book: q.book, line: q.line, price: priceOf(q),
    break_even: r4(breakEvenRate(priceOf(q))),
    payout_per_unit: r4(payoutPerUnit(priceOf(q)))
  }));

  // A common reference every quote is scored against: the median line at the
  // median price. It is synthetic — no book necessarily posts it — which is
  // exactly what makes it a fair yardstick.
  //
  // The median price is taken in PROBABILITY space, not in American odds.
  // American odds are discontinuous at +/-100 — there is no such price as -5 —
  // so averaging +100 and -110 produces a number that is not a price at all.
  // Doing it naively made one two-book route report a 45-point loss against the
  // field, which is how the bug surfaced.
  const medBreakEven = median(raw.map(s2 => breakEvenRate(s2.price)).filter(Number.isFinite));
  const medPrice = median(raw.map(s2 => s2.price));
  const medLine = median(raw.map(s2 => s2.line).filter(Number.isFinite));

  /**
   * Total advantage of a quote over a reference, in probability.
   *
   * Ranking by line first and price second is a heuristic, and a wrong one: a
   * book offering half a point more at -140 is worse than the field at -110,
   * because the price penalty (about six points of break-even) dwarfs what half
   * a point off a key number is worth. Scoring line and price on the SAME scale
   * — probability — is the only comparison that can see that, and it is why
   * routing was reporting a mean saving of -0.0156 against the median.
   *
   * Line differences are converted through the empirical margin distribution,
   * so half a point across 3 is correctly worth several times half a point
   * across 8.
   */
  const advantage = (q, refBreakEven, refLine) => {
    const priceEdge = (refBreakEven ?? 0) - (breakEvenRate(q.price) ?? 0);
    // lineMoveValue is unsigned (it only measures how much a move is worth, not
    // which direction), so the direction has to be supplied here: more points
    // is better when taking them, fewer is better when giving them. Without
    // this every book scored the same positive lineEdge regardless of which
    // way its number differed from the field, so the book furthest from the
    // median in EITHER direction could rank first — including the worst number
    // on the board.
    const lineEdge = Number.isFinite(refLine) && Number.isFinite(q.line)
      ? (takingPoints
          ? (q.line > refLine ? lineMoveValue(refLine, q.line) : -lineMoveValue(q.line, refLine))
          : (q.line < refLine ? lineMoveValue(refLine, q.line) : -lineMoveValue(q.line, refLine)))
      : 0;
    return priceEdge + lineEdge;
  };

  const scored = raw
    .map(q => ({ ...q, edge_vs_median: r4(advantage(q, medBreakEven, medLine)) }))
    .sort((a, b) => (b.edge_vs_median ?? 0) - (a.edge_vs_median ?? 0));

  const best = scored[0], worst = scored[scored.length - 1];

  return {
    market, books_compared: scored.length,
    best, worst, median_price: medPrice, median_line: medLine,
    // Savings expressed in the only unit that matters: how much less often you
    // now have to be right.
    saved_vs_median_pct: best.edge_vs_median,
    saved_vs_worst_pct: r4(advantage(best, breakEvenRate(worst.price), worst.line)),
    all: scored
  };
}

/**
 * Route one decided bet to the book that pays most for it.
 *
 * @param side  the exact side string as the odds feed spells it
 */
export function routeBet({ eventId = null, matchup = null, market = 'spreads', side,
  stakeUnits = 1 } = {}) {
  if (!side) return { error: 'a side is required — this routes a decided bet, it does not pick one' };

  const events = simultaneousQuotes(market);
  const ev = events.find(e => (eventId && e.event_id === eventId)
    || (matchup && `${e.away_team} at ${e.home_team}`.toLowerCase().includes(String(matchup).toLowerCase())));
  if (!ev) {
    return { error: `no simultaneous quotes stored for that game in ${market}`,
      events_available: events.length,
      hint: 'Line snapshots are metered; the archive may not cover this game.' };
  }

  const quotes = ev.quotes.filter(q => q.side && String(q.side).toLowerCase() === String(side).toLowerCase());
  if (!quotes.length) {
    return { error: `no quotes for side "${side}"`,
      sides_available: [...new Set(ev.quotes.map(q => q.side))].filter(Boolean) };
  }

  const takingPoints = market === 'totals' ? /under/i.test(side) : true;
  const ranked = rankBooks(quotes, { market, takingPoints });
  if (!ranked) return { error: 'no usable prices for that side' };

  const stakeDollars = stakeUnits * 100;
  const bestProfit = (ranked.best.payout_per_unit ?? 0) * stakeDollars;
  const medProfit = (payoutPerUnit(ranked.median_price) ?? 0) * stakeDollars;

  return {
    matchup: `${ev.away_team} at ${ev.home_team}`,
    event_id: ev.event_id, captured_at: ev.captured_at,
    market, side, stake_units: stakeUnits,
    place_at: ranked.best.book,
    line: ranked.best.line, price: ranked.best.price,
    break_even_needed: ranked.best.break_even,
    books_compared: ranked.books_compared,
    versus_median: {
      price: ranked.median_price,
      win_rate_saved: ranked.saved_vs_median_pct,
      extra_profit_per_win: r2(bestProfit - medProfit)
    },
    versus_worst: {
      book: ranked.worst.book, price: ranked.worst.price,
      win_rate_saved: ranked.saved_vs_worst_pct
    },
    all_books: ranked.all,
    note: 'Ranked on the live price for THIS side, not on the book\'s average hold — a book with a ' +
      'good reputation can still post the worst number on any given game. For spreads a better line ' +
      'outranks a better price, because half a point through a key number is worth more than five ' +
      'cents of juice.'
  };
}

/**
 * Route an entire slate at once.
 *
 * The realistic use: you have decided which games to bet, and this says where
 * each one goes and what the routing is worth in aggregate.
 */
export function routeSlate({ market = 'spreads', limit = 40 } = {}) {
  const events = simultaneousQuotes(market);
  const routes = [];
  for (const ev of events.slice(0, limit)) {
    const bySide = new Map();
    for (const q of ev.quotes) {
      if (!q.side) continue;
      if (!bySide.has(q.side)) bySide.set(q.side, []);
      bySide.get(q.side).push(q);
    }
    for (const [side, quotes] of bySide) {
      const takingPoints = market === 'totals' ? /under/i.test(side) : true;
      const ranked = rankBooks(quotes, { market, takingPoints });
      if (!ranked || ranked.books_compared < 2) continue;
      routes.push({
        matchup: `${ev.away_team} at ${ev.home_team}`, event_id: ev.event_id,
        side, place_at: ranked.best.book,
        line: ranked.best.line, price: ranked.best.price,
        books_compared: ranked.books_compared,
        win_rate_saved_vs_median: ranked.saved_vs_median_pct,
        win_rate_saved_vs_worst: ranked.saved_vs_worst_pct
      });
    }
  }

  const savedMed = routes.map(r => r.win_rate_saved_vs_median).filter(Number.isFinite);
  const savedWorst = routes.map(r => r.win_rate_saved_vs_worst).filter(Number.isFinite);
  const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const byBook = {};
  for (const r of routes) byBook[r.place_at] = (byBook[r.place_at] ?? 0) + 1;

  return {
    market, routes_found: routes.length,
    mean_win_rate_saved_vs_median: r4(avg(savedMed)),
    mean_win_rate_saved_vs_worst: r4(avg(savedWorst)),
    books_used: Object.entries(byBook).sort((a, b) => b[1] - a[1])
      .map(([book, n]) => ({ book, routed: n })),
    routes: routes.sort((a, b) => (b.win_rate_saved_vs_worst ?? 0) - (a.win_rate_saved_vs_worst ?? 0)),
    note: 'Savings are in win-rate points. Betting the median book instead of the best one costs ' +
      'the "vs median" figure on every wager, forever, regardless of how good the picks are.'
  };
}

/**
 * Record a routing decision so the tool can be held to account later.
 *
 * The point is not bookkeeping. Every other component in this project was
 * trusted for a long time before anyone graded it, and every one of them turned
 * out to be worth nothing. This one is logged from the first day so its claim
 * is checkable rather than asserted.
 */
export function logExecution(route, { note = null } = {}) {
  if (route?.error) return { error: route.error };
  run(`INSERT INTO nfl_execution_log
       (routed_at, event_id, matchup, market, side, stake_units, chosen_book, chosen_line,
        chosen_price, median_price, worst_price, books_compared, saved_vs_median_pct,
        saved_vs_worst_pct, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  new Date().toISOString(), route.event_id ?? null, route.matchup ?? null,
  route.market, route.side, route.stake_units ?? 1, route.place_at,
  route.line ?? null, route.price ?? null,
  route.versus_median?.price ?? null, route.versus_worst?.price ?? null,
  route.books_compared ?? null,
  route.versus_median?.win_rate_saved ?? null,
  route.versus_worst?.win_rate_saved ?? null, note);
  return { logged: true, matchup: route.matchup, book: route.place_at };
}

/** What routing has actually saved, cumulatively. */
export function executionLedger({ limit = 100 } = {}) {
  const log = rows(`SELECT * FROM nfl_execution_log ORDER BY routed_at DESC LIMIT ?`, limit);
  const total = row(`SELECT COUNT(*) AS n, SUM(stake_units) AS units,
                            AVG(saved_vs_median_pct) AS med, AVG(saved_vs_worst_pct) AS worst
                     FROM nfl_execution_log`) ?? {};
  const byBook = rows(`SELECT chosen_book, COUNT(*) AS n FROM nfl_execution_log
                       GROUP BY chosen_book ORDER BY n DESC`);
  return {
    bets_routed: total.n ?? 0,
    units_staked: r2(total.units ?? 0),
    mean_win_rate_saved_vs_median: r4(total.med),
    mean_win_rate_saved_vs_worst: r4(total.worst),
    books_used: byBook,
    recent: log,
    note: (total.n ?? 0) === 0
      ? 'Nothing routed yet. This ledger exists so the shopping claim can be checked later rather ' +
        'than taken on faith — which is more than any forecasting component here got.'
      : 'Savings compound across every bet and do not depend on any pick being right.'
  };
}
