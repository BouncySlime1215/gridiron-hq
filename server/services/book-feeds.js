/**
 * Free multi-book quote feeds — the closing line without the credit meter.
 *
 * The Odds API is metered and this project's month is gone by Week 1. The
 * books' own sites, and one aggregator, publish the same numbers through
 * public JSON endpoints that cost nothing and need no account. Four are read
 * here, each isolated so one failing never blocks the others:
 *
 *   oddstrader  – the aggregator sbrscrape (github.com/nkgilley/sbrscrape)
 *                 reads; one request returns ~11 books (pinnacle, bovada,
 *                 lowvig, betonline, heritage, bodog, unibet, …) with a
 *                 per-book change timestamp.
 *   pinnacle    – Pinnacle's guest API. The sharp reference nfl-sharp.js is
 *                 built around, previously reachable only through the Odds
 *                 API's `eu` region at 4 credits a call.
 *   kambi       – the platform behind BetRivers (US); spreads, totals, ML.
 *   bovada      – Bovada's coupon endpoint; spreads, totals, ML.
 *
 * Everything lands in `nfl_line_snapshots` in exactly the row shape
 * line-shopping.js writes (book, market, side, line, price) plus `provider`
 * and `book_updated_at`, so the shopping board, the sharp board, steam
 * detection, the specialists' movement feature and bet routing all read it
 * unchanged. Every run also feeds the immutable quote tape.
 *
 * The same game is keyed identically across providers
 * (`nfl:<utc-date>:<AWAY>@<HOME>`), so a single capture holds every book for
 * a game in one simultaneous quote set. A book that appears in two feeds is
 * kept once, from the more direct source.
 *
 * These are undocumented endpoints used by the books' own web pages. They
 * are polled gently (hourly by default) with an ordinary browser user agent;
 * set FREE_BOOK_FEEDS=0 to disable. If a feed changes shape it reports
 * `events: 0` with the error, never a malformed row.
 */
import { teamResolver } from './team-codes.js';
import { db, rows, run } from '../db/index.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const ENABLED = process.env.FREE_BOOK_FEEDS !== '0';

export const enabled = () => ENABLED;

const ODDSTRADER_BOOKS = Object.freeze({
  10: 'pinnacle', 8: 'betonlineag', 9: 'sportsbetting', 16: 'gtbets', 28: 'everygame', 29: 'lowvig',
  36: 'unibet', 44: 'heritage', 82: 'bodog', 84: 'bovada', 3: 'bookmaker', 20: 'betanysports',
  38: 'justbet', 65: 'betus', 92: 'everygame', 83: 'betnow', 15: 'mybookieag', 35: 'betcris',
  45: 'wynnbet', 54: 'resorts', 22: 'sugarhouse', 18: '888sport', 5: 'williamhill_us',
  78: 'fanduel', 91: 'draftkings'
});
const ODDSTRADER_PAIDS = Object.keys(ODDSTRADER_BOOKS).join(',');
// Direct feeds outrank the aggregator's copy of the same book.
const PROVIDER_PRIORITY = { pinnacle: 0, bovada: 1, kambi: 2, oddstrader: 3 };

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const american = v => { const n = num(String(v ?? '').replace('+', '')); return n; };

/* ------------------------------------------------------------- team names */

// The resolver lives in team-codes.js (the one map); re-exported for existing callers.
export { teamResolver, clearTeamResolverCache } from './team-codes.js';

const eventKey = (commence, away, home) => `nfl:${String(commence ?? '').slice(0, 10)}:${away}@${home}`;

/* ------------------------------------------------------------- providers */
// Each parser returns [{ home, away, commence_time, book, market, side, line, price, book_updated_at }]
// with `side` as the canonical team abbreviation for spreads/h2h and 'Over'/'Under' for totals.

async function getJson(url, { headers = {} } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function parseOddstrader(payload, resolve = teamResolver()) {
  const out = [];
  const events = payload?.data?.eventsByDateByLeagueGroup?.events ?? [];
  for (const e of events) {
    if (e.es && e.es !== 'scheduled') continue;
    const home = e.participants?.find(p => p.ih), away = e.participants?.find(p => !p.ih);
    const h = resolve(home?.source?.abbr) ?? resolve(home?.source?.nam);
    const a = resolve(away?.source?.abbr) ?? resolve(away?.source?.nam);
    if (!h || !a) continue;
    const commence = Number.isFinite(Number(e.dt)) ? new Date(Number(e.dt)).toISOString() : null;
    for (const l of e.currentLines ?? []) {
      const book = ODDSTRADER_BOOKS[l.paid];
      if (!book) continue;
      const price = num(l.ap), line = num(l.adj);
      if (price == null) continue;
      const updated = Number.isFinite(Number(l.tim)) ? new Date(Number(l.tim)).toISOString() : null;
      const base = { home: h.abbr, away: a.abbr, commence_time: commence, book, book_updated_at: updated, price };
      if (l.mtid === 401 && line != null) {
        const side = l.partid === home.partid ? h.abbr : l.partid === away.partid ? a.abbr : null;
        if (side) out.push({ ...base, market: 'spreads', side, line });
      } else if (l.mtid === 402 && line != null) {
        const side = l.partid === 15143 ? 'Over' : l.partid === 15144 ? 'Under' : null;
        if (side) out.push({ ...base, market: 'totals', side, line });
      } else if (l.mtid === 83) {
        const side = l.partid === home.partid ? h.abbr : l.partid === away.partid ? a.abbr : null;
        if (side) out.push({ ...base, market: 'h2h', side, line: null });
      }
    }
  }
  return out;
}

export function parsePinnacle(matchups, markets, resolve = teamResolver()) {
  const out = [];
  const games = new Map();
  for (const m of matchups ?? []) {
    if (m.type !== 'matchup' || m.parent || m.parentId) continue;
    const home = m.participants?.find(p => p.alignment === 'home');
    const away = m.participants?.find(p => p.alignment === 'away');
    const h = resolve(home?.name), a = resolve(away?.name);
    if (!h || !a) continue;
    games.set(m.id, { home: h.abbr, away: a.abbr, commence_time: m.startTime ?? null });
  }
  for (const mk of markets ?? []) {
    const g = games.get(mk.matchupId);
    if (!g || mk.period !== 0 || mk.isAlternate) continue;
    const base = { ...g, book: 'pinnacle', book_updated_at: null };
    for (const p of mk.prices ?? []) {
      const price = num(p.price);
      if (price == null) continue;
      if (mk.type === 'spread') {
        const side = p.designation === 'home' ? g.home : p.designation === 'away' ? g.away : null;
        if (side && num(p.points) != null) out.push({ ...base, market: 'spreads', side, line: num(p.points), price });
      } else if (mk.type === 'total') {
        const side = p.designation === 'over' ? 'Over' : p.designation === 'under' ? 'Under' : null;
        if (side && num(p.points) != null) out.push({ ...base, market: 'totals', side, line: num(p.points), price });
      } else if (mk.type === 'moneyline') {
        const side = p.designation === 'home' ? g.home : p.designation === 'away' ? g.away : null;
        if (side) out.push({ ...base, market: 'h2h', side, line: null, price });
      }
    }
  }
  return out;
}

export function parseKambi(payload, resolve = teamResolver()) {
  const out = [];
  for (const e of payload?.events ?? []) {
    const ev = e.event ?? {};
    const h = resolve(ev.homeName), a = resolve(ev.awayName);
    if (!h || !a) continue;
    const base = { home: h.abbr, away: a.abbr, commence_time: ev.start ?? null, book: 'betrivers' };
    for (const offer of e.betOffers ?? []) {
      const type = offer.betOfferType?.name, criterion = offer.criterion?.label ?? '';
      const fullGame = !/1st|2nd|half|quarter|1h|2h/i.test(criterion);
      if (!fullGame) continue;
      for (const o of offer.outcomes ?? []) {
        const price = american(o.oddsAmerican);
        if (price == null) continue;
        const updated = o.changedDate ?? null;
        const line = o.line == null ? null : Number(o.line) / 1000;
        if (type === 'Handicap') {
          const side = resolve(o.participant ?? o.label);
          if (side && line != null) out.push({ ...base, market: 'spreads', side: side.abbr, line, price, book_updated_at: updated });
        } else if (type === 'Over/Under' && /Total Points/i.test(criterion)) {
          const side = o.type === 'OT_OVER' ? 'Over' : o.type === 'OT_UNDER' ? 'Under' : null;
          if (side && line != null) out.push({ ...base, market: 'totals', side, line, price, book_updated_at: updated });
        } else if (type === 'Match') {
          const side = resolve(o.participant);
          if (side) out.push({ ...base, market: 'h2h', side: side.abbr, line: null, price, book_updated_at: updated });
        }
      }
    }
  }
  return out;
}

export function parseBovada(payload, resolve = teamResolver()) {
  const out = [];
  for (const block of Array.isArray(payload) ? payload : []) {
    for (const ev of block.events ?? []) {
      const home = ev.competitors?.find(c => c.home), away = ev.competitors?.find(c => !c.home);
      const h = resolve(home?.name), a = resolve(away?.name);
      if (!h || !a) continue;
      const commence = Number.isFinite(Number(ev.startTime)) ? new Date(Number(ev.startTime)).toISOString() : null;
      const base = { home: h.abbr, away: a.abbr, commence_time: commence, book: 'bovada', book_updated_at: null };
      for (const m of ev.displayGroups?.[0]?.markets ?? []) {
        if (m.period?.description && !/game/i.test(m.period.description)) continue;
        for (const o of m.outcomes ?? []) {
          const price = american(o.price?.american === 'EVEN' ? 100 : o.price?.american);
          if (price == null) continue;
          if (/spread/i.test(m.description)) {
            const side = resolve(o.description);
            const line = num(o.price?.handicap);
            if (side && line != null) out.push({ ...base, market: 'spreads', side: side.abbr, line, price });
          } else if (/^total$/i.test(m.description)) {
            const side = o.type === 'O' ? 'Over' : o.type === 'U' ? 'Under' : null;
            const line = num(o.price?.handicap);
            if (side && line != null) out.push({ ...base, market: 'totals', side, line, price });
          } else if (/moneyline/i.test(m.description)) {
            const side = resolve(o.description);
            if (side) out.push({ ...base, market: 'h2h', side: side.abbr, line: null, price });
          }
        }
      }
    }
  }
  return out;
}

const PROVIDERS = {
  oddstrader: async () => {
    const ts = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
    const query = `{ eventsByDateByLeagueGroup( leagueGroups: [{ mtid: [401,402,83], lid: 16, spid: 4 }], showEmptyEvents: true, marketTypeLayout: "PARTICIPANTS", ic: false, startDate: ${ts}, timezoneOffset: -4, nof: true, hl: true, sort: {by: ["lid", "dt", "des"], order: ASC} ) { events { eid lid spid des dt es participants { eid partid psid ih rot source { ... on Team { tmid lid nam nn sn abbr cit } } } currentLines(paid: [${ODDSTRADER_PAIDS}]) } } }`;
    return parseOddstrader(await getJson(`https://www.oddstrader.com/odds-v2/odds-v2-service?query=${encodeURIComponent(query)}`));
  },
  pinnacle: async () => {
    const headers = { 'x-api-key': 'CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R' };
    const [matchups, markets] = await Promise.all([
      getJson('https://guest.api.arcadia.pinnacle.com/0.1/leagues/889/matchups', { headers }),
      getJson('https://guest.api.arcadia.pinnacle.com/0.1/leagues/889/markets/straight', { headers })
    ]);
    return parsePinnacle(matchups, markets);
  },
  kambi: async () => parseKambi(await getJson(
    'https://eu-offering-api.kambicdn.com/offering/v2018/rsiusny/listView/american_football/nfl/all/all/matches.json?lang=en_US&market=US&useCombined=true')),
  bovada: async () => parseBovada(await getJson(
    'https://www.bovada.lv/services/sports/event/coupon/events/A/description/football/nfl?marketFilterId=def&preMatchOnly=true&eventsLimit=50&lang=en'))
};

/* --------------------------------------------------------------- capture */

/** Merge every provider's quotes into one simultaneous, deduplicated set. */
export function mergeQuotes(byProvider) {
  const best = new Map(); // key -> quote
  for (const [provider, quotes] of Object.entries(byProvider)) {
    for (const q of quotes) {
      const key = `${eventKey(q.commence_time, q.away, q.home)}|${q.book}|${q.market}|${q.side}`;
      const existing = best.get(key);
      if (!existing || PROVIDER_PRIORITY[provider] < PROVIDER_PRIORITY[existing.provider]) {
        best.set(key, { ...q, provider });
      }
    }
  }
  return [...best.values()];
}

export async function captureBookFeeds({ providers = Object.keys(PROVIDERS) } = {}) {
  if (!ENABLED) return { skipped: true, reason: 'FREE_BOOK_FEEDS=0' };
  const byProvider = {}, errors = {};
  await Promise.all(providers.map(async name => {
    try { byProvider[name] = await PROVIDERS[name](); } catch (error) { errors[name] = error.message; byProvider[name] = []; }
  }));
  const merged = mergeQuotes(byProvider);
  const at = new Date().toISOString();
  const nameOf = new Map(rows('SELECT abbr, name FROM nfl_teams').map(t => [t.abbr, t.name]));
  let written = 0;
  const events = new Map();
  for (const q of merged) {
    const id = eventKey(q.commence_time, q.away, q.home);
    const homeName = nameOf.get(q.home) ?? q.home, awayName = nameOf.get(q.away) ?? q.away;
    const sideName = q.side === q.home ? homeName : q.side === q.away ? awayName : q.side;
    const result = run(`INSERT INTO nfl_line_snapshots
        (captured_at, event_id, commence_time, home_team, away_team, book, market, side, line, price, provider, book_updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
    at, id, q.commence_time, homeName, awayName, q.book, q.market, sideName, q.line, q.price,
    `free:${q.provider}`, q.book_updated_at ?? null);
    written += result.changes ?? 0;
    // Odds-API-shaped payload so the immutable quote tape gets a real producer.
    const ev = events.get(id) ?? { id, commence_time: q.commence_time, home_team: homeName, away_team: awayName, bookmakers: new Map() };
    const bk = ev.bookmakers.get(q.book) ?? { key: q.book, title: q.book, last_update: q.book_updated_at ?? at, markets: new Map() };
    const mk = bk.markets.get(q.market) ?? { key: q.market, last_update: q.book_updated_at ?? at, outcomes: [] };
    mk.outcomes.push({ name: sideName, point: q.line, price: q.price });
    bk.markets.set(q.market, mk); ev.bookmakers.set(q.book, bk); events.set(id, ev);
  }
  let tape = null;
  if (events.size) {
    try {
      const { ingestQuoteSnapshot } = await import('./nfl-quote-tape.js');
      const payload = [...events.values()].map(ev => ({ ...ev,
        bookmakers: [...ev.bookmakers.values()].map(bk => ({ ...bk, markets: [...bk.markets.values()] })) }));
      tape = ingestQuoteSnapshot(payload, { provider: 'free-book-feeds', requestedAt: at,
        markets: 'spreads,totals,h2h', sourceRef: 'book_feeds' });
    } catch (error) { tape = { error: error.message }; }
    try { (await import('./nfl-shopping-board.js')).clearShoppingBoardCache(); } catch { /* board cache is best effort */ }
  }
  const books = [...new Set(merged.map(q => q.book))];
  return { captured_at: at, events: events.size, quotes: written, books: books.length, book_keys: books,
    providers: Object.fromEntries(Object.entries(byProvider).map(([k, v]) => [k, v.length])),
    errors: Object.keys(errors).length ? errors : undefined, tape, cost: 'free' };
}

export function bookFeedStatus() {
  const latest = rows(`SELECT captured_at, COUNT(DISTINCT event_id) events, COUNT(DISTINCT book) books, COUNT(*) quotes
    FROM nfl_line_snapshots WHERE provider LIKE 'free:%' GROUP BY captured_at ORDER BY captured_at DESC LIMIT 5`);
  const byProvider = rows(`SELECT provider, COUNT(*) quotes, MAX(captured_at) latest
    FROM nfl_line_snapshots WHERE provider LIKE 'free:%' GROUP BY provider`);
  return { enabled: ENABLED, providers: Object.keys(PROVIDERS), recent_captures: latest, by_provider: byProvider,
    note: 'Public book endpoints, polled hourly with a browser user agent. Set FREE_BOOK_FEEDS=0 to disable. These feed the same snapshot table and quote tape as the Odds API and cost nothing.' };
}

export const __test = { parseOddstrader, parsePinnacle, parseKambi, parseBovada, mergeQuotes, eventKey };
