/**
 * Prediction markets, and the flow inside them.
 *
 * Every negative result in this project comes from the same place: we were
 * modelling the same public information the sportsbooks model, only worse. The
 * closing line is efficient, our disagreement with the opening line has an
 * r-squared of 0.0016 against subsequent movement, and no amount of extra
 * modelling has moved any of it.
 *
 * Prediction markets are a genuinely DIFFERENT information source rather than a
 * better lens on the same one, and that is why they are worth the effort:
 *
 *   - Kalshi is a CFTC-regulated exchange, so its NFL contracts are an order
 *     book rather than a bookmaker's number. Nobody sets the price; it is
 *     whatever two participants agreed on.
 *   - Its public trade feed carries trade SIZE, which side was the aggressor,
 *     and an `is_block_trade` flag. Sportsbook feeds show you a price; this
 *     shows you the transaction that moved it.
 *   - Polymarket settles on-chain, so its positions are public by construction.
 *
 * THE HYPOTHESIS, stated so it can fail: large aggressive flow on an exchange
 * leads sportsbook line movement, because a bookmaker adjusts to informed money
 * while an exchange simply prints it. If true, the block-trade feed is an early
 * warning the sportsbook has not yet reacted to. If false, we are watching the
 * same move arrive by a different route, and this is a data feed with no edge.
 *
 * That test needs accumulated observations to answer, and this module exists to
 * accumulate them. Nothing here claims an edge yet — it claims a measurement
 * that has never been possible before, and both APIs are free and unauthenticated.
 */
import { rows, row, run } from '../db/index.js';

const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const POLY_GAMMA = 'https://gamma-api.polymarket.com';

const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

run(`CREATE TABLE IF NOT EXISTS prediction_market_quotes (
  captured_at TEXT NOT NULL,
  venue       TEXT NOT NULL,
  ticker      TEXT NOT NULL,
  title       TEXT,
  team        TEXT,
  event_key   TEXT,
  yes_price   REAL,
  no_price    REAL,
  open_interest REAL,
  volume      REAL,
  close_time  TEXT,
  PRIMARY KEY (captured_at, venue, ticker)
)`);
run(`CREATE INDEX IF NOT EXISTS idx_pm_ticker ON prediction_market_quotes(ticker, captured_at)`);

run(`CREATE TABLE IF NOT EXISTS prediction_market_flow (
  trade_id    TEXT PRIMARY KEY,
  venue       TEXT NOT NULL,
  ticker      TEXT NOT NULL,
  traded_at   TEXT NOT NULL,
  size        REAL,
  yes_price   REAL,
  no_price    REAL,
  taker_side  TEXT,
  is_block    INTEGER,
  notional    REAL,
  fetched_at  TEXT
)`);
run(`CREATE INDEX IF NOT EXISTS idx_pmflow_ticker ON prediction_market_flow(ticker, traded_at)`);

/**
 * Kalshi NFL game tickers look like `KXNFLGAME-26SEP21NYGLAR-NYG`:
 * series, then a date and the two team codes, then the team this contract is
 * about. Parsing it gives a key that can be joined to our own schedule.
 */
export function parseKalshiNflTicker(ticker) {
  const m = String(ticker ?? '').match(/^KXNFLGAME-(\d{2})([A-Z]{3})(\d{2})([A-Z]{2,3})([A-Z]{2,3})-([A-Z]{2,3})$/);
  if (!m) return null;
  const [, yy, mon, dd, away, home, subject] = m;
  return { away, home, subject, date: `${mon}${dd}`, year: 2000 + Number(yy),
    event_key: `${away}@${home}` };
}

/**
 * Snapshot every open NFL market on Kalshi.
 *
 * Prices come back as dollar strings between 0 and 1, which are already
 * probabilities — no vig to strip, because an exchange does not charge any.
 * That alone makes them directly comparable to a no-vig sportsbook number,
 * which normally takes two prices and an assumption to recover.
 */
export async function captureKalshi({ seriesTicker = 'KXNFLGAME', limit = 200 } = {}) {
  const res = await fetch(`${KALSHI}/markets?limit=${limit}&status=open&series_ticker=${seriesTicker}`,
    { signal: AbortSignal.timeout(45000) });
  if (!res.ok) return { error: `Kalshi returned ${res.status}` };
  const j = await res.json();
  const markets = j.markets ?? [];
  const now = new Date().toISOString();

  let stored = 0;
  const parsed = [];
  for (const m of markets) {
    const t = parseKalshiNflTicker(m.ticker);
    const yes = num(m.yes_bid_dollars) ?? num(m.yes_bid);
    const no = num(m.no_bid_dollars) ?? num(m.no_bid);
    run(`INSERT INTO prediction_market_quotes
         (captured_at, venue, ticker, title, team, event_key, yes_price, no_price,
          open_interest, volume, close_time)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(captured_at, venue, ticker) DO NOTHING`,
    now, 'kalshi', m.ticker, m.title ?? null, t?.subject ?? null, t?.event_key ?? null,
    yes, no, num(m.open_interest_fp) ?? num(m.open_interest), num(m.volume), m.close_time ?? null);
    stored++;
    if (t) parsed.push({ ticker: m.ticker, ...t, yes_price: yes, open_interest: num(m.open_interest_fp) });
  }
  return { venue: 'kalshi', markets_seen: markets.length, stored,
    nfl_games_parsed: parsed.length, sample: parsed.slice(0, 5),
    note: 'Exchange prices are already probabilities — there is no vig to strip, which makes them ' +
      'directly comparable to a no-vig sportsbook number.' };
}

/**
 * Pull the public trade feed and keep the trades big enough to matter.
 *
 * This is the part a sportsbook feed cannot give you. A line move tells you the
 * book reacted; a block trade tells you who made it react, how large, and which
 * side they took. `is_block_trade` is Kalshi's own institutional-size flag.
 */
export async function captureKalshiFlow({ ticker = null, limit = 200, minNotional = 500 } = {}) {
  const url = ticker
    ? `${KALSHI}/markets/trades?limit=${limit}&ticker=${encodeURIComponent(ticker)}`
    : `${KALSHI}/markets/trades?limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
  if (!res.ok) return { error: `Kalshi trades returned ${res.status}` };
  const j = await res.json();
  const trades = j.trades ?? [];
  const now = new Date().toISOString();

  let stored = 0, blocks = 0, large = 0;
  for (const t of trades) {
    const size = num(t.count_fp) ?? num(t.count);
    const yes = num(t.yes_price_dollars) ?? num(t.yes_price);
    const no = num(t.no_price_dollars) ?? num(t.no_price);
    // Notional is size times the price actually paid — a thousand contracts at
    // two cents is not a whale, and counting contracts alone would say it is.
    const paid = t.taker_side === 'no' ? no : yes;
    const notional = size != null && paid != null ? size * paid * 100 : null;
    const isBlock = t.is_block_trade ? 1 : 0;
    if (isBlock) blocks++;
    if (notional != null && notional >= minNotional) large++;
    run(`INSERT INTO prediction_market_flow
         (trade_id, venue, ticker, traded_at, size, yes_price, no_price, taker_side,
          is_block, notional, fetched_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(trade_id) DO NOTHING`,
    String(t.trade_id), 'kalshi', t.ticker, t.created_time ?? now, size, yes, no,
    t.taker_side ?? null, isBlock, notional, now);
    stored++;
  }
  return { venue: 'kalshi', trades_seen: trades.length, stored,
    block_trades: blocks, large_trades: large, min_notional: minNotional,
    note: 'Notional weights size by the price actually paid. A thousand contracts at two cents is ' +
      'not informed money, and counting contracts alone would say otherwise.' };
}

/** Snapshot Polymarket's NFL markets. On-chain settlement makes these public by construction. */
export async function capturePolymarket({ limit = 200 } = {}) {
  const res = await fetch(`${POLY_GAMMA}/markets?limit=${limit}&closed=false&order=volume&ascending=false`,
    { signal: AbortSignal.timeout(45000) });
  if (!res.ok) return { error: `Polymarket returned ${res.status}` };
  const all = await res.json();
  const list = Array.isArray(all) ? all : (all.data ?? []);
  const nfl = list.filter(m => /\bnfl\b|football|touchdown|receiving yards|rushing yards/i
    .test(`${m.question ?? ''} ${m.description ?? ''}`));
  const now = new Date().toISOString();

  let stored = 0;
  for (const m of nfl) {
    let prices = [];
    try { prices = JSON.parse(m.outcomePrices ?? '[]'); } catch { /* leave empty */ }
    run(`INSERT INTO prediction_market_quotes
         (captured_at, venue, ticker, title, team, event_key, yes_price, no_price,
          open_interest, volume, close_time)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(captured_at, venue, ticker) DO NOTHING`,
    now, 'polymarket', String(m.conditionId ?? m.id), m.question ?? null, null, m.slug ?? null,
    num(prices[0]), num(prices[1]), num(m.liquidity), num(m.volume), m.endDate ?? null);
    stored++;
  }
  return { venue: 'polymarket', markets_seen: list.length, nfl_markets: nfl.length, stored,
    sample: nfl.slice(0, 4).map(m => ({ question: (m.question ?? '').slice(0, 70),
      volume: num(m.volume), liquidity: num(m.liquidity) })) };
}

/**
 * Where the exchange disagrees with the sportsbook.
 *
 * Both are probabilities of the same event, so a gap is either an arbitrage, a
 * stale number on one side, or information one venue has absorbed and the other
 * has not. The third is the interesting case and the only one worth building on.
 *
 * Reported as a gap in probability points. A three-point gap on a near-even
 * game is roughly two-thirds of a point of spread, which is real.
 */
export function exchangeVsBook({ minGap = 0.02 } = {}) {
  const latest = rows(
    `SELECT q.* FROM prediction_market_quotes q
     JOIN (SELECT ticker, MAX(captured_at) AS mx FROM prediction_market_quotes
           WHERE venue='kalshi' GROUP BY ticker) l
       ON q.ticker = l.ticker AND q.captured_at = l.mx
     WHERE q.venue='kalshi' AND q.event_key IS NOT NULL AND q.yes_price IS NOT NULL`);
  if (!latest.length) {
    return { error: 'no Kalshi NFL quotes stored yet', hint: 'POST /betting/prediction/capture' };
  }

  // The sportsbook side: most recent reference line per team from the free move log.
  const book = rows(
    `SELECT home_team, away_team, home_spread, observed_at FROM espn_line_moves
     ORDER BY observed_at DESC`);
  const bookByGame = new Map();
  for (const b of book) {
    const k = `${b.away_team}@${b.home_team}`;
    if (!bookByGame.has(k)) bookByGame.set(k, b);
  }

  // Spread to win probability, using the margin standard deviation measured
  // from real games rather than an assumed one.
  const SIGMA = 14.16;
  const normCdf = z => 0.5 * (1 + erf(z / Math.SQRT2));
  const spreadToProb = spread => normCdf(-spread / SIGMA);

  const out = [];
  for (const q of latest) {
    const b = bookByGame.get(q.event_key);
    if (!b || !Number.isFinite(b.home_spread)) continue;
    const t = parseKalshiNflTicker(q.ticker);
    if (!t) continue;
    const bookProb = t.subject === t.home
      ? spreadToProb(b.home_spread) : 1 - spreadToProb(b.home_spread);
    const gap = q.yes_price - bookProb;
    if (Math.abs(gap) < minGap) continue;
    out.push({
      matchup: q.event_key, contract: q.subject ?? t.subject, ticker: q.ticker,
      exchange_probability: r4(q.yes_price), book_probability: r4(bookProb),
      gap: r4(gap), open_interest: q.open_interest,
      leans: gap > 0 ? 'exchange is higher on this team than the book'
        : 'exchange is lower on this team than the book'
    });
  }

  return {
    games_compared: latest.length, disagreements: out.length, min_gap: minGap,
    divergences: out.sort((a, b2) => Math.abs(b2.gap) - Math.abs(a.gap)),
    note: 'The book side is derived from the free ESPN reference spread through a normal model with ' +
      'the measured margin sigma of 14.16, so it is an approximation of a no-vig moneyline rather ' +
      'than a quoted one. Treat small gaps as noise in that conversion; large ones are worth a look.',
    caveat: 'A divergence is not an edge until it is shown that one side systematically leads the ' +
      'other. That is what the flow log is accumulating toward, and it has not been tested yet.'
  };
}

function erf(x) {
  const s = Math.sign(x); x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
    a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  return s * (1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x));
}

/** The biggest recent aggressive orders — the closest thing to a public whale tape. */
export function whaleFlow({ hours = 48, minNotional = 500, limit = 40 } = {}) {
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  const trades = rows(
    `SELECT * FROM prediction_market_flow
     WHERE traded_at >= ? AND (is_block = 1 OR notional >= ?)
     ORDER BY notional DESC LIMIT ?`, since, minNotional, limit);
  const total = row(`SELECT COUNT(*) AS n, SUM(notional) AS v FROM prediction_market_flow
                     WHERE traded_at >= ?`, since) ?? {};
  const blocks = row(`SELECT COUNT(*) AS n FROM prediction_market_flow
                      WHERE traded_at >= ? AND is_block = 1`, since)?.n ?? 0;

  return {
    window_hours: hours, min_notional: minNotional,
    trades_in_window: total.n ?? 0,
    notional_in_window: r4(total.v ?? 0),
    block_trades: blocks,
    top_flow: trades.map(t => ({ ticker: t.ticker, traded_at: t.traded_at,
      size: t.size, notional: r4(t.notional), side: t.taker_side, block: !!t.is_block,
      price: t.taker_side === 'no' ? t.no_price : t.yes_price })),
    note: 'A sportsbook feed shows that a number moved. This shows the transaction that moved it — ' +
      'size, aggressor side, and whether the exchange flagged it as block size.',
    caveat: 'Volume is not information. Whether this flow LEADS sportsbook movement is an open ' +
      'question the log is accumulating toward; treating it as signal before that is measured would ' +
      'repeat the mistake that produced twenty-two failed models here.'
  };
}

/** What the prediction-market corpus currently holds. */
export function predictionMarketStatus() {
  const q = row(`SELECT COUNT(*) AS n, COUNT(DISTINCT ticker) AS tickers,
                        MAX(captured_at) AS last FROM prediction_market_quotes`) ?? {};
  const f = row(`SELECT COUNT(*) AS n, SUM(is_block) AS blocks, MAX(traded_at) AS last
                 FROM prediction_market_flow`) ?? {};
  const byVenue = rows(`SELECT venue, COUNT(DISTINCT ticker) AS tickers, COUNT(*) AS quotes
                        FROM prediction_market_quotes GROUP BY venue`);
  return {
    quotes: q.n ?? 0, distinct_markets: q.tickers ?? 0, last_quote: q.last ?? null,
    trades: f.n ?? 0, block_trades: f.blocks ?? 0, last_trade: f.last ?? null,
    by_venue: byVenue,
    sources: 'Kalshi (CFTC-regulated exchange) and Polymarket (on-chain). Both public, both free, ' +
      'neither requiring a key.',
    ready_for_lead_lag_test: (f.n ?? 0) > 500
  };
}

/**
 * Kalshi's trading fee, which is the whole reason a raw spread comparison lies.
 *
 * Published formula: 0.07 x contracts x price x (1 - price), rounded up to the
 * cent. It peaks at a 50-cent contract — 1.75% — and falls away toward the
 * extremes, which is the opposite shape to a sportsbook's flat vig and matters
 * enormously for where an exchange is actually competitive.
 */
export function kalshiFee(price, contracts = 1) {
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return null;
  return Math.ceil(0.07 * contracts * price * (1 - price) * 100) / 100;
}

/**
 * What each venue really costs, fees included.
 *
 * This is the comparison that matters, and it is easy to get flatteringly
 * wrong. An exchange quotes a two-cent spread where a sportsbook quotes 4.5%
 * hold, which looks like a rout until the exchange's separate trading fee is
 * added — and unlike vig, that fee is largest exactly where most NFL games are
 * priced, near even money.
 *
 * Reported per game rather than in aggregate, because the answer genuinely
 * changes with the price: an exchange is at its worst on a coin-flip and at its
 * best on a lopsided favourite, which is the reverse of where a bettor usually
 * wants to be.
 */
export function venueCostComparison({ bookHolds = null } = {}) {
  const latest = rows(
    `SELECT q.* FROM prediction_market_quotes q
     JOIN (SELECT ticker, MAX(captured_at) AS mx FROM prediction_market_quotes
           WHERE venue='kalshi' GROUP BY ticker) l
       ON q.ticker = l.ticker AND q.captured_at = l.mx
     WHERE q.venue='kalshi' AND q.event_key IS NOT NULL AND q.yes_price IS NOT NULL`);
  if (!latest.length) return { error: 'no Kalshi quotes stored yet' };

  // Group both contracts of each game so the two-sided cost can be computed.
  const byGame = new Map();
  for (const q of latest) {
    if (!byGame.has(q.event_key)) byGame.set(q.event_key, []);
    byGame.get(q.event_key).push(q);
  }

  const games = [];
  for (const [key, sides] of byGame) {
    if (sides.length < 2) continue;
    // yes_price stored is the BID. The ask is what a buyer pays, and it is the
    // bid plus the quoted spread; without the ask stored, approximate the
    // round-trip cost from how far the two bids fall short of 1.
    const bidSum = sides.reduce((a, s) => a + (s.yes_price ?? 0), 0);
    const spreadCost = Math.max(0, 1 - bidSum);
    const mid = sides[0].yes_price ?? 0.5;
    const fee = kalshiFee(mid) ?? 0;
    // Fee is charged on each side of a round trip in the general case; a single
    // directional bet pays it once.
    const totalCost = spreadCost + fee;
    games.push({
      matchup: key,
      implied_price: r4(mid),
      spread_cost: r4(spreadCost),
      fee_at_this_price: r4(fee),
      all_in_cost: r4(totalCost),
      open_interest: sides.reduce((a, s) => a + (s.open_interest ?? 0), 0)
    });
  }
  if (!games.length) return { error: 'no complete two-sided Kalshi games stored' };

  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const meanAllIn = mean(games.map(g => g.all_in_cost));

  // Sportsbook holds measured elsewhere in this project, for comparison.
  const books = bookHolds ?? [
    { book: 'lowvig', hold: 0.0309 }, { book: 'betonlineag', hold: 0.0439 },
    { book: 'draftkings', hold: 0.0459 }, { book: 'betmgm', hold: 0.0466 },
    { book: 'betrivers', hold: 0.0554 }
  ];
  const cheapestBook = books.reduce((a, b) => (b.hold < a.hold ? b : a));

  return {
    games_priced: games.length,
    kalshi_mean_all_in_cost: r4(meanAllIn),
    kalshi_mean_spread_only: r4(mean(games.map(g => g.spread_cost))),
    kalshi_mean_fee: r4(mean(games.map(g => g.fee_at_this_price))),
    cheapest_sportsbook: cheapestBook,
    advantage_vs_cheapest_book: r4(cheapestBook.hold - meanAllIn),
    advantage_vs_worst_book: r4(0.0554 - meanAllIn),
    // Half the hold difference is what comes off the required win rate.
    win_rate_saved_vs_cheapest: r4((cheapestBook.hold - meanAllIn) / 2),
    cheaper_than_every_book: meanAllIn < cheapestBook.hold,
    per_game: games.sort((a, b) => a.all_in_cost - b.all_in_cost).slice(0, 12),
    liquidity_warning: games.filter(g => g.open_interest < 200).length,
    note: 'Fees included, which is the point — an exchange quoting a two-cent spread against a 4.5% ' +
      'hold looks like a rout until its separate fee is added, and that fee peaks near even money ' +
      'where most NFL games are priced.',
    caveats: [
      'These are MONEYLINE contracts. Kalshi does not offer the spread markets most of this project ' +
        'is built around, so it is a substitute for one market rather than all of them.',
      'Open interest runs in the hundreds of contracts. A large bet moves the price against itself, ' +
        'and the quoted cost is only available in size the book can absorb.',
      'An exchange fill is not guaranteed. A sportsbook price is a price; an exchange ask is an ' +
        'offer that may be gone when you reach it.'
    ]
  };
}
