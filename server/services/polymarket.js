/**
 * Polymarket: NFL props, game markets, and the first tradeable venue that is
 * cheaper than a sportsbook.
 *
 * Two gaps close here.
 *
 * PROPS HAVE NEVER BEEN PRICED. The prop CLV archive has always been empty
 * because capturing prop quotes costs Odds API credits and the account has one
 * left. Props are the softest market in this project's reach and the only one
 * never measured against a real price. Polymarket carries roughly 1,800 NFL
 * player-stat markets for free, which makes the measurement possible for the
 * first time.
 *
 * COST. Kalshi looked cheap on spread and turned out to cost 4.15% all-in once
 * its 1.75% fee was added — worse than lowvig. Polymarket charges no trading
 * fee, so its order-book spread IS the cost. That makes it the one venue that
 * can plausibly beat a sportsbook, and it is measured here rather than assumed,
 * because the last venue that looked cheap was not.
 *
 * WHAT TO BE CAREFUL OF, stated up front:
 *   - The `outcomePrices` on the gamma API sum to exactly 1.0000. Those are
 *     midpoints, not executable prices. Only the CLOB order book gives a real
 *     bid and ask, and everything costed here uses the book.
 *   - Most NFL props are SEASON-LONG totals rather than weekly game props, so
 *     they pair with this project's season simulator rather than its weekly
 *     prop model.
 *   - Depth is thin outside the futures markets. A quoted price you cannot get
 *     filled at in size is not a price.
 */
import { rows, row, run } from '../db/index.js';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

run(`CREATE TABLE IF NOT EXISTS polymarket_markets (
  condition_id TEXT PRIMARY KEY,
  question     TEXT,
  event_title  TEXT,
  kind         TEXT,
  player       TEXT,
  stat         TEXT,
  threshold    REAL,
  end_date     TEXT,
  clob_token_yes TEXT,
  clob_token_no  TEXT,
  first_seen   TEXT
)`);
run(`CREATE TABLE IF NOT EXISTS polymarket_quotes (
  captured_at  TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  mid_yes      REAL,
  best_bid     REAL,
  best_ask     REAL,
  bid_size     REAL,
  ask_size     REAL,
  spread       REAL,
  volume       REAL,
  liquidity    REAL,
  PRIMARY KEY (captured_at, condition_id)
)`);
run(`CREATE INDEX IF NOT EXISTS idx_pmq_cond ON polymarket_quotes(condition_id, captured_at)`);

/**
 * Pull out the player, statistic and threshold from a market question.
 *
 * Polymarket writes these to a template — "Will Josh Allen have 7.5+ rushing
 * touchdowns in the 2026-27 NFL regular season" — which parses reliably. The
 * other common shape is a leader market ("finish the season with the most
 * passing yards"), which is a different kind of bet entirely: winner-take-one
 * across a field rather than a threshold, so it is classified separately rather
 * than forced into the same box.
 */
export function parsePolymarketProp(question) {
  const q = String(question ?? '');
  const threshold = q.match(
    /^Will (.+?) have ([\d,\.]+)\+?\s+(receiving yards|rushing yards|passing yards|receptions|rushing touchdowns|receiving touchdowns|passing touchdowns|touchdowns)/i);
  if (threshold) {
    return { kind: 'threshold_prop', player: threshold[1].trim(),
      stat: threshold[3].toLowerCase().replace(/\s+/g, '_'),
      threshold: Number(threshold[2].replace(/,/g, '')) };
  }
  const leader = q.match(/^Will (.+?) finish the .*? with the most (.+?)\?/i);
  if (leader) {
    return { kind: 'leader_prop', player: leader[1].trim(),
      stat: leader[2].toLowerCase().replace(/\s+/g, '_'), threshold: null };
  }
  if (/win the .*(championship|super bowl|conference)/i.test(q)) {
    return { kind: 'futures', player: null, stat: null, threshold: null };
  }
  if (/\bmvp\b|player of the year|rookie of the year/i.test(q)) {
    return { kind: 'award', player: null, stat: null, threshold: null };
  }
  return { kind: 'other', player: null, stat: null, threshold: null };
}

/** Page the events endpoint, which is the only reliable way to filter to NFL. */
async function fetchNflEvents({ maxPages = 8 } = {}) {
  const all = [];
  let offset = 0;
  for (let i = 0; i < maxPages; i++) {
    const res = await fetch(`${GAMMA}/events?limit=100&closed=false&tag_slug=nfl&offset=${offset}`,
      { signal: AbortSignal.timeout(45000) });
    if (!res.ok) break;
    const j = await res.json();
    const list = Array.isArray(j) ? j : (j.data ?? []);
    if (!list.length) break;
    all.push(...list);
    offset += list.length;
    if (list.length < 100) break;
  }
  return all;
}

/** Ingest every open NFL market, classified. */
export async function ingestPolymarketNfl({ maxPages = 8 } = {}) {
  const events = await fetchNflEvents({ maxPages });
  if (!events.length) return { error: 'no NFL events returned from Polymarket' };
  const now = new Date().toISOString();

  let stored = 0, quoted = 0;
  const byKind = {};
  for (const ev of events) {
    for (const m of ev.markets ?? []) {
      const cond = m.conditionId ?? m.id;
      if (!cond) continue;
      const p = parsePolymarketProp(m.question);
      byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;

      let toks = [];
      try { toks = JSON.parse(m.clobTokenIds ?? '[]'); } catch { /* leave empty */ }
      run(`INSERT INTO polymarket_markets
           (condition_id, question, event_title, kind, player, stat, threshold, end_date,
            clob_token_yes, clob_token_no, first_seen)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(condition_id) DO UPDATE SET question=excluded.question`,
      String(cond), m.question ?? null, ev.title ?? null, p.kind, p.player, p.stat, p.threshold,
      m.endDate ?? null, toks[0] ?? null, toks[1] ?? null, now);
      stored++;

      let prices = [];
      try { prices = JSON.parse(m.outcomePrices ?? '[]'); } catch { /* leave empty */ }
      if (prices.length) {
        run(`INSERT INTO polymarket_quotes
             (captured_at, condition_id, mid_yes, volume, liquidity)
             VALUES (?,?,?,?,?) ON CONFLICT(captured_at, condition_id) DO NOTHING`,
        now, String(cond), num(prices[0]), num(m.volume), num(m.liquidity));
        quoted++;
      }
    }
  }
  return { events: events.length, markets_stored: stored, midpoints_quoted: quoted,
    by_kind: byKind,
    note: 'Midpoints only. They sum to exactly 1.0000 and are not executable — call ' +
      'captureOrderBooks() for real bid and ask.' };
}

/**
 * Fetch the real order book for the markets worth trading.
 *
 * This is the step that separates a quoted price from a price you can get. The
 * gamma midpoint always sums to one across both outcomes; the book does not,
 * and the gap between them is the actual cost of entry.
 */
export async function captureOrderBooks({ minVolume = 1000, limit = 60,
  midRange = [0.12, 0.88] } = {}) {
  // Selecting purely by volume picks championship futures priced at half a
  // cent, which are not comparable to a sportsbook side and made the first
  // measurement here run on a single usable market. Mid-price is the filter
  // that matters: a game bet or a prop lives between roughly 0.12 and 0.88, and
  // that is the only range where a spread converts into a comparable cost.
  const markets = rows(
    `SELECT m.condition_id, m.question, m.kind, m.clob_token_yes,
            (SELECT volume FROM polymarket_quotes q WHERE q.condition_id = m.condition_id
             ORDER BY captured_at DESC LIMIT 1) AS volume,
            (SELECT mid_yes FROM polymarket_quotes q WHERE q.condition_id = m.condition_id
             ORDER BY captured_at DESC LIMIT 1) AS mid
     FROM polymarket_markets m
     WHERE m.clob_token_yes IS NOT NULL`)
    .filter(m => (m.volume ?? 0) >= minVolume
      && Number.isFinite(m.mid) && m.mid >= midRange[0] && m.mid <= midRange[1])
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
    .slice(0, limit);
  if (!markets.length) return { error: 'no stored markets above the volume floor', min_volume: minVolume };

  const now = new Date().toISOString();
  let ok = 0;
  const spreads = [];
  for (const m of markets) {
    try {
      const res = await fetch(`${CLOB}/book?token_id=${encodeURIComponent(m.clob_token_yes)}`,
        { signal: AbortSignal.timeout(20000) });
      if (!res.ok) continue;
      const book = await res.json();
      // The API returns bids ascending and asks descending, so the best of each
      // is the LAST element. Taking [0] would read the worst price in the book
      // and report a spread several times too wide.
      const bids = book.bids ?? [], asks = book.asks ?? [];
      const bestBid = bids.length ? bids[bids.length - 1] : null;
      const bestAsk = asks.length ? asks[asks.length - 1] : null;
      if (!bestBid || !bestAsk) continue;
      const bid = num(bestBid.price), ask = num(bestAsk.price);
      if (bid == null || ask == null) continue;
      const spread = ask - bid;
      run(`UPDATE polymarket_quotes SET best_bid=?, best_ask=?, bid_size=?, ask_size=?, spread=?
           WHERE condition_id=? AND captured_at=(SELECT MAX(captured_at) FROM polymarket_quotes
                                                 WHERE condition_id=?)`,
      bid, ask, num(bestBid.size), num(bestAsk.size), spread, m.condition_id, m.condition_id);
      spreads.push({ question: (m.question ?? '').slice(0, 60), kind: m.kind,
        bid, ask, spread: r4(spread), mid: r4((bid + ask) / 2),
        bid_size: num(bestBid.size), ask_size: num(bestAsk.size), volume: m.volume });
      ok++;
    } catch { /* one bad book must not stop the sweep */ }
    await new Promise(r => setTimeout(r, 60));
  }
  return { books_fetched: ok, captured_at: now, spreads: spreads.slice(0, 20),
    note: 'Best bid is the LAST bid and best ask the LAST ask — this API returns them sorted away ' +
      'from the touch, and reading index zero would report a spread several times too wide.' };
}

/**
 * What Polymarket actually costs, against the venues already measured.
 *
 * The comparison that matters, and the one Kalshi failed. There the two-cent
 * spread looked decisive until a 1.75% fee took the all-in cost to 4.15%, worse
 * than lowvig's 3.09%. Polymarket charges no trading fee, so the book spread is
 * the whole cost — but that only helps if the spread is actually tight, which is
 * measured here rather than assumed.
 *
 * Costs are reported on mid-priced contracts separately, because a one-cent
 * spread is 2% on a 50-cent contract and 20% on a 5-cent one. Averaging across
 * both would flatter the venue enormously.
 */
export function polymarketCost({ minVolume = 5000 } = {}) {
  const latest = rows(
    `SELECT q.*, m.question, m.kind FROM polymarket_quotes q
     JOIN polymarket_markets m ON m.condition_id = q.condition_id
     WHERE q.best_bid IS NOT NULL AND q.best_ask IS NOT NULL
       AND q.captured_at = (SELECT MAX(captured_at) FROM polymarket_quotes q2
                            WHERE q2.condition_id = q.condition_id AND q2.best_bid IS NOT NULL)`);
  if (!latest.length) return { error: 'no order books captured yet', hint: 'run captureOrderBooks()' };

  const priced = latest.map(q => {
    const mid = (q.best_bid + q.best_ask) / 2;
    // Round-trip cost as a fraction of the position, which is the number
    // comparable to a sportsbook hold.
    const costFraction = mid > 0 && mid < 1 ? q.spread / mid : null;
    return { question: (q.question ?? '').slice(0, 58), kind: q.kind,
      mid: r4(mid), spread: r4(q.spread), cost_fraction: r4(costFraction),
      depth: Math.min(q.bid_size ?? 0, q.ask_size ?? 0), volume: q.volume };
  }).filter(p => p.cost_fraction != null);

  // Mid-priced contracts are where a game bet actually lives; the extremes are
  // futures and are not comparable to a sportsbook side.
  const midPriced = priced.filter(p => p.mid >= 0.15 && p.mid <= 0.85);
  const meanCostMid = mean(midPriced.map(p => p.cost_fraction));
  const meanSpreadMid = mean(midPriced.map(p => p.spread));

  // The mean across all mid-priced markets is the wrong number and badly
  // misleading. Polymarket is bimodal: a handful of liquid markets quote a
  // one-cent spread (1.3-2.1% cost, genuinely cheaper than any sportsbook) and
  // a long tail of near-empty ones quote whatever, dragging the average to
  // roughly 12%. What matters is the cost in the markets you could actually
  // trade, so cost is reported conditional on depth.
  const DEPTH_TIERS = [
    { name: 'deep (>= 2,000)', min: 2000 },
    { name: 'tradeable (>= 500)', min: 500 },
    { name: 'thin (>= 100)', min: 100 },
    { name: 'all mid-priced', min: 0 }
  ];
  const byDepth = DEPTH_TIERS.map(t => {
    const list = midPriced.filter(p => (p.depth ?? 0) >= t.min);
    return { tier: t.name, markets: list.length,
      mean_cost: r4(mean(list.map(p => p.cost_fraction))),
      median_cost: (() => { const v = list.map(p => p.cost_fraction).sort((a, b) => a - b);
        return v.length ? r4(v[Math.floor(v.length / 2)]) : null; })(),
      beats_cheapest_book: (() => { const mc = mean(list.map(p => p.cost_fraction));
        return mc != null && mc < 0.0309; })() };
  });
  const tradeable = midPriced.filter(p => (p.depth ?? 0) >= 500);
  const meanCostTradeable = mean(tradeable.map(p => p.cost_fraction));

  const BOOKS = { lowvig: 0.0309, draftkings: 0.0459, betrivers: 0.0554 };
  const KALSHI_ALL_IN = 0.0415;

  return {
    markets_priced: priced.length, mid_priced_markets: midPriced.length,
    mean_spread_mid_priced: r4(meanSpreadMid),
    mean_cost_fraction_mid_priced: r4(meanCostMid),
    cost_by_depth: byDepth,
    tradeable_markets: tradeable.length,
    mean_cost_tradeable: r4(meanCostTradeable),
    trading_fee: 0,
    comparison: {
      polymarket_all_in: r4(meanCostMid),
      kalshi_all_in: KALSHI_ALL_IN,
      cheapest_sportsbook: BOOKS.lowvig,
      dearest_sportsbook: BOOKS.betrivers
    },
    // Judged on the markets with real depth, because a tight quote in a market
    // that cannot absorb a bet is not a price you can have.
    cheaper_than_cheapest_book: meanCostTradeable != null && meanCostTradeable < BOOKS.lowvig,
    cheaper_than_kalshi: meanCostTradeable != null && meanCostTradeable < KALSHI_ALL_IN,
    win_rate_saved_vs_cheapest_book: meanCostTradeable == null ? null
      : r4((BOOKS.lowvig - meanCostTradeable) / 2),
    thin_markets: midPriced.filter(p => p.depth < 500).length,
    sample: midPriced.sort((a, b) => a.cost_fraction - b.cost_fraction).slice(0, 12),
    note: 'Costed on mid-priced contracts only. A one-cent spread is 2% of a fifty-cent contract and ' +
      '20% of a five-cent one, so averaging across both would flatter the venue enormously. Polymarket ' +
      'charges no trading fee, which is the whole reason it can beat a book where Kalshi could not.',
    caveat: 'Depth is the binding constraint, not price. A tight quote you cannot fill in size is not ' +
      'a price, and the thin_markets count is how many of these could not absorb a modest bet.'
  };
}

/** What the Polymarket corpus holds. */
export function polymarketStatus() {
  const m = row(`SELECT COUNT(*) AS n FROM polymarket_markets`) ?? {};
  const byKind = rows(`SELECT kind, COUNT(*) AS n FROM polymarket_markets GROUP BY kind ORDER BY n DESC`);
  const q = row(`SELECT COUNT(*) AS n, COUNT(best_bid) AS booked, MAX(captured_at) AS last
                 FROM polymarket_quotes`) ?? {};
  const props = row(`SELECT COUNT(*) AS n FROM polymarket_markets WHERE kind='threshold_prop'`)?.n ?? 0;
  return {
    markets: m.n ?? 0, by_kind: byKind,
    quotes: q.n ?? 0, with_order_book: q.booked ?? 0, last_capture: q.last ?? null,
    threshold_props: props,
    ready_for_prop_clv: (q.n ?? 0) > 200,
    note: 'Threshold props are the ones this project can price — a player and a number. Leader ' +
      'markets ("most passing yards") are winner-take-one across a field and need a different model.'
  };
}


run(`CREATE TABLE IF NOT EXISTS polymarket_price_history (
  condition_id TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  price        REAL NOT NULL,
  PRIMARY KEY (condition_id, ts)
)`);
run(`CREATE INDEX IF NOT EXISTS idx_pmh_ts ON polymarket_price_history(ts)`);

/**
 * Hourly price history, which is the part no sportsbook will ever give us.
 *
 * A book shows today's number. An exchange shows every number it has been, at
 * hourly resolution, going back a month — so a price move can be located in
 * time and matched against whatever happened just before it. That turns "does
 * news move markets, and how fast" from a question needing weeks of forward
 * capture into one answerable from data that already exists.
 */
export async function ingestPriceHistory({ minVolume = 20000, limit = 60, interval = 'max' } = {}) {
  const markets = rows(
    `SELECT m.condition_id, m.clob_token_yes, m.question,
            (SELECT volume FROM polymarket_quotes q WHERE q.condition_id = m.condition_id
             ORDER BY captured_at DESC LIMIT 1) AS volume
     FROM polymarket_markets m WHERE m.clob_token_yes IS NOT NULL`)
    .filter(m => (m.volume ?? 0) >= minVolume)
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
    .slice(0, limit);
  if (!markets.length) return { error: 'no stored markets above the volume floor', min_volume: minVolume };

  let series = 0, points = 0;
  for (const m of markets) {
    try {
      const res = await fetch(
        `${CLOB}/prices-history?market=${encodeURIComponent(m.clob_token_yes)}&interval=${interval}&fidelity=60`,
        { signal: AbortSignal.timeout(25000) });
      if (!res.ok) continue;
      const j = await res.json();
      const hist = j.history ?? [];
      if (!hist.length) continue;
      for (const pt of hist) {
        const t = Number(pt.t), price = Number(pt.p);
        if (!Number.isFinite(t) || !Number.isFinite(price)) continue;
        run(`INSERT INTO polymarket_price_history (condition_id, ts, price)
             VALUES (?,?,?) ON CONFLICT(condition_id, ts) DO NOTHING`,
        m.condition_id, t, price);
        points++;
      }
      series++;
    } catch { /* one bad series must not stop the sweep */ }
    await new Promise(r => setTimeout(r, 70));
  }
  const total = row(`SELECT COUNT(*) AS n, COUNT(DISTINCT condition_id) AS c
                     FROM polymarket_price_history`) ?? {};
  return { series_fetched: series, points_stored: points,
    corpus: { points: total.n ?? 0, markets: total.c ?? 0 },
    note: 'Hourly resolution, roughly a month deep. This is the substrate for asking whether news ' +
      'moves prices and how quickly — a sportsbook feed cannot answer that at all.' };
}

/**
 * Do prices move after news, and how fast?
 *
 * The question this project has been unable to answer. The forward-looking
 * version needs weeks of accumulated line moves; this one is answerable now,
 * because the exchange publishes its own past.
 *
 * For each stored news signal, the price of every liquid NFL market is sampled
 * in the hours before and after publication. A market that reprices AFTER news
 * is a market our feed could in principle have beaten. One that had already
 * moved BEFORE is a market that knew first, and no amount of modelling recovers
 * that.
 *
 * Reported as a distribution rather than a verdict, because the honest answer at
 * present is likely "not enough overlap yet" — the news table holds 26 signals
 * and the price corpus a month.
 */
export function newsPriceResponse({ windowHours = 6, minMove = 0.01 } = {}) {
  const signals = rows(
    `SELECT news_id, player_name, team, signal_type, published_at
     FROM nfl_news_signals WHERE published_at IS NOT NULL ORDER BY published_at DESC`);
  const corpus = row(`SELECT COUNT(*) AS n, MIN(ts) AS lo, MAX(ts) AS hi
                      FROM polymarket_price_history`) ?? {};
  if (!(corpus.n > 0)) {
    return { error: 'no price history stored', hint: 'run ingestPriceHistory() first' };
  }
  if (!signals.length) return { error: 'no news signals stored' };

  const win = windowHours * 3600;
  const observations = [];
  for (const sig of signals) {
    const t0 = Math.floor(new Date(sig.published_at).getTime() / 1000);
    if (!Number.isFinite(t0)) continue;
    // Skip signals outside the price corpus entirely rather than scoring them
    // as "no move" — absence of data is not absence of movement.
    if (t0 < corpus.lo || t0 > corpus.hi) continue;

    const before = rows(
      `SELECT condition_id, price FROM polymarket_price_history
       WHERE ts BETWEEN ? AND ?`, t0 - win, t0);
    const after = rows(
      `SELECT condition_id, price FROM polymarket_price_history
       WHERE ts BETWEEN ? AND ?`, t0, t0 + win);
    if (!before.length || !after.length) continue;

    const priceBefore = new Map(), priceAfter = new Map();
    for (const b of before) priceBefore.set(b.condition_id, b.price);
    for (const a of after) priceAfter.set(a.condition_id, a.price);

    let moved = 0, examined = 0;
    for (const [cond, pb] of priceBefore) {
      const pa = priceAfter.get(cond);
      if (pa == null) continue;
      examined++;
      if (Math.abs(pa - pb) >= minMove) moved++;
    }
    if (examined) {
      observations.push({ player: sig.player_name, team: sig.team, signal: sig.signal_type,
        published_at: sig.published_at, markets_examined: examined, markets_moved: moved,
        move_rate: r4(moved / examined) });
    }
  }

  return {
    signals_stored: signals.length,
    signals_inside_price_corpus: observations.length,
    price_corpus: { points: corpus.n,
      from: corpus.lo ? new Date(corpus.lo * 1000).toISOString() : null,
      to: corpus.hi ? new Date(corpus.hi * 1000).toISOString() : null },
    window_hours: windowHours, min_move: minMove,
    mean_move_rate: r4(mean(observations.map(o => o.move_rate))),
    observations: observations.slice(0, 25),
    sufficient: observations.length >= 20,
    verdict: observations.length < 20
      ? `Only ${observations.length} news signals fall inside the price corpus. The price history goes ` +
        'back about a month and the news table holds few typed signals, so the overlap is thin. This ' +
        'is infrastructure that becomes informative as both sides fill, not a result.'
      : `${observations.length} signals matched to price windows, with ${r4(mean(observations.map(o => o.move_rate)))} ` +
        'of liquid markets repricing within the window.',
    caveat: 'Movement near a news item is not causation. Prices move constantly, so the honest ' +
      'comparison is against the base rate of movement in a window with NO news — which needs enough ' +
      'observations to compute, and does not have them yet.'
  };
}
