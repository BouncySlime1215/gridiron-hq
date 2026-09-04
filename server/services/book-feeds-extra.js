/**
 * Two more free multi-book quote feeds, beside book-feeds.js.
 *
 *   rotowire – Rotowire's NFL odds table (`nfl-games.php?week=N`): one JSON
 *              row per team per game with every book's spread, total and
 *              moneyline *and their prices*. It is the only free JSON source
 *              found for Circa's lines (`circasports_*`), which is the reason
 *              this file exists. Also DraftKings, FanDuel, BetMGM, Caesars,
 *              BetRivers, Hard Rock, Fanatics, theScore and Betr.
 *   sbr      – sportsbookreview.com's Next.js data route, one document per
 *              odds type (pointspread / totals / money-line) with eight books
 *              (BetMGM, bet365, DraftKings, FanDuel, Fanatics, BetRivers,
 *              Caesars, Hard Rock), each carrying an opening AND a current
 *              line. The build id in the URL rotates on every deploy, so it is
 *              read from the odds page's `__NEXT_DATA__` on each capture.
 *
 * Rows land in `nfl_line_snapshots` in exactly the shape book-feeds.js writes
 * (same `nfl:<utc-date>:<AWAY>@<HOME>` key, full team names, `provider` =
 * 'free:<name>') so every board reads them unchanged. SBR's opening lines are
 * returned from the capture under `openers` and not written anywhere yet.
 *
 * Unlike book-feeds.js this file does NOT feed the quote tape — the caller
 * decides whether these two sources earn a place there. FREE_BOOK_FEEDS=0
 * disables both, as it does the first four feeds.
 */
import { teamResolver } from './team-codes.js';
import { rows, run } from '../db/index.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const ENABLED = process.env.FREE_BOOK_FEEDS !== '0';

export const enabled = () => ENABLED;

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const american = v => (v == null || v === '' ? null : num(String(v).replace('+', '')));
const eventKey = (commence, away, home) => `nfl:${String(commence ?? '').slice(0, 10)}:${away}@${home}`;
const iso = v => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

/** Rotowire column prefix -> book key. `best_*` is Rotowire's own best-price column, not a book. */
export const ROTOWIRE_BOOKS = Object.freeze({
  circasports: 'circa', draftkings: 'draftkings', fanduel: 'fanduel', mgm: 'betmgm', betmgm: 'betmgm',
  caesars: 'caesars', betrivers: 'betrivers', hardrock: 'hardrock', fanatics: 'fanatics',
  thescore: 'thescore', betr: 'betr'
});

/** SBR `sportsbook` machine name -> book key. */
export const SBR_BOOKS = Object.freeze({
  betmgm: 'betmgm', bet365: 'bet365', draftkings: 'draftkings', fanduel: 'fanduel', fanatics: 'fanatics',
  bet_rivers_co: 'betrivers', betrivers: 'betrivers', caesars: 'caesars', hardrock: 'hardrock'
});

const SBR_ODDS_TYPES = Object.freeze({ pointspread: 'spreads', totals: 'totals', 'money-line': 'h2h' });

/* ---------------------------------------------------------------- helpers */

async function getJson(url, { headers = {} } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getText(url, { headers = {} } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*', ...headers },
    signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * Rotowire's `gameDate` is an Eastern wall-clock time ("2026-09-09 20:20:00")
 * with no offset. Convert through America/New_York so the UTC date in the
 * event key matches the other feeds (that kickoff is 2026-09-10T00:20Z).
 */
const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function nyOffsetMs(ms) {
  const p = Object.fromEntries(NY.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
}
export function easternToIso(local) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(local ?? ''));
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  let utc = wall - nyOffsetMs(wall);
  utc = wall - nyOffsetMs(utc); // second pass settles a DST-boundary guess
  return new Date(utc).toISOString();
}

/* -------------------------------------------------------------- rotowire */
// Each parser returns [{ home, away, commence_time, book, market, side, line, price, book_updated_at }]
// with `side` as the canonical team abbreviation for spreads/h2h and 'Over'/'Under' for totals.

/**
 * Rotowire sends two rows per game (`homeAway` = 'home' | 'away'), each
 * carrying that team's own spread and moneyline and the game total. Prices
 * are present: `<book>_spreadML`, `<book>_ouML`, `<book>_moneyline`. The
 * total's price on the away row is the Over and on the home row the Under
 * (the visitor sits on the top line of the table; checked against SBR's
 * over/under prices for Caesars and Fanatics on 2026-09-02).
 */
export function parseRotowire(payload, weekMeta = {}, resolve = teamResolver()) {
  const out = [];
  const games = new Map();
  for (const r of Array.isArray(payload) ? payload : []) {
    if (!r?.gameID || (r.homeAway !== 'home' && r.homeAway !== 'away')) continue;
    const g = games.get(r.gameID) ?? {};
    g[r.homeAway] = r;
    games.set(r.gameID, g);
  }
  for (const { home, away } of games.values()) {
    if (!home || !away) continue;
    const h = resolve(home.abbr) ?? resolve(home.name), a = resolve(away.abbr) ?? resolve(away.name);
    if (!h || !a) continue;
    const commence = easternToIso(home.gameDate ?? away.gameDate);
    const base = { home: h.abbr, away: a.abbr, commence_time: commence, book_updated_at: null };
    for (const [prefix, book] of Object.entries(ROTOWIRE_BOOKS)) {
      if (!(`${prefix}_spread` in home) && !(`${prefix}_ou` in home) && !(`${prefix}_moneyline` in home)) continue;
      const bk = { ...base, book };
      for (const [row, side] of [[home, h.abbr], [away, a.abbr]]) {
        const line = num(row[`${prefix}_spread`]), price = american(row[`${prefix}_spreadML`]);
        if (line != null && price != null) out.push({ ...bk, market: 'spreads', side, line, price });
        const ml = american(row[`${prefix}_moneyline`]);
        if (ml != null) out.push({ ...bk, market: 'h2h', side, line: null, price: ml });
      }
      const total = num(home[`${prefix}_ou`]) ?? num(away[`${prefix}_ou`]);
      const over = american(away[`${prefix}_ouML`]), under = american(home[`${prefix}_ouML`]);
      if (total != null && over != null) out.push({ ...bk, market: 'totals', side: 'Over', line: total, price: over });
      if (total != null && under != null) out.push({ ...bk, market: 'totals', side: 'Under', line: total, price: under });
    }
  }
  if (weekMeta?.week != null) for (const q of out) q.week = weekMeta.week;
  return out;
}

/* ------------------------------------------------------------------- sbr */

/** The `__NEXT_DATA__` build id from an SBR page; it changes on every deploy. */
export function sbrBuildId(html) {
  const m = /"buildId":"([^"]+)"/.exec(String(html ?? ''));
  return m ? m[1] : null;
}

function sbrLineQuotes(line, market, g) {
  const q = [];
  if (!line) return q;
  if (market === 'spreads') {
    const hl = num(line.homeSpread), al = num(line.awaySpread), hp = american(line.homeOdds), ap = american(line.awayOdds);
    if (hl != null && hp != null) q.push({ market, side: g.home, line: hl, price: hp });
    if (al != null && ap != null) q.push({ market, side: g.away, line: al, price: ap });
  } else if (market === 'totals') {
    const t = num(line.total), o = american(line.overOdds), u = american(line.underOdds);
    if (t != null && o != null) q.push({ market, side: 'Over', line: t, price: o });
    if (t != null && u != null) q.push({ market, side: 'Under', line: t, price: u });
  } else if (market === 'h2h') {
    const hp = american(line.homeOdds), ap = american(line.awayOdds);
    if (hp != null) q.push({ market, side: g.home, line: null, price: hp });
    if (ap != null) q.push({ market, side: g.away, line: null, price: ap });
  }
  return q;
}

/**
 * One SBR Next.js data document (a single odds type). Returns the CURRENT
 * lines as quotes; each quote also carries `opening` ({line, price} or null)
 * so the capture can report openers without a second parse.
 */
export function parseSbr(payload, oddsType, resolve = teamResolver()) {
  const market = SBR_ODDS_TYPES[oddsType];
  if (!market) throw new Error(`unknown SBR oddsType ${oddsType}`);
  const out = [];
  for (const table of payload?.pageProps?.oddsTables ?? []) {
    for (const row of table?.oddsTableModel?.gameRows ?? []) {
      const gv = row.gameView ?? {};
      const h = resolve(gv.homeTeam?.fullName) ?? resolve(gv.homeTeam?.shortName);
      const a = resolve(gv.awayTeam?.fullName) ?? resolve(gv.awayTeam?.shortName);
      if (!h || !a) continue;
      const g = { home: h.abbr, away: a.abbr, commence_time: iso(gv.startDate) };
      for (const view of row.oddsViews ?? []) {
        const book = SBR_BOOKS[view?.sportsbook];
        if (!book) continue;
        const openers = sbrLineQuotes(view.openingLine, market, g);
        for (const q of sbrLineQuotes(view.currentLine, market, g)) {
          const op = openers.find(o => o.side === q.side);
          out.push({ ...g, book, book_updated_at: null, ...q, opening: op ? { line: op.line, price: op.price } : null });
        }
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------- providers */

async function rotowireWeek() {
  if (Number(process.env.NFL_WEEK)) return Number(process.env.NFL_WEEK);
  try {
    const { currentNflWeek } = await import('./weekly-learning.js');
    return currentNflWeek().week ?? null;
  } catch { return null; } // Rotowire defaults to its own current week
}

const PROVIDERS = {
  rotowire: async ({ week } = {}) => {
    const w = week ?? await rotowireWeek();
    const url = `https://www.rotowire.com/betting/nfl/tables/nfl-games.php${w ? `?week=${w}` : ''}`;
    return parseRotowire(await getJson(url, { headers: { Referer: 'https://www.rotowire.com/betting/nfl/' } }), { week: w });
  },
  sbr: async () => {
    const html = await getText('https://www.sportsbookreview.com/betting-odds/nfl-football/');
    const buildId = sbrBuildId(html);
    if (!buildId) throw new Error('SBR buildId not found in __NEXT_DATA__');
    const docs = await Promise.all(Object.keys(SBR_ODDS_TYPES).map(async type => [type, await getJson(
      `https://www.sportsbookreview.com/_next/data/${buildId}/betting-odds/nfl-football/${type}/full-game.json?league=nfl-football&oddsType=${type}&oddsScope=full-game`)]));
    return docs.flatMap(([type, doc]) => parseSbr(doc, type));
  }
};

/* ------------------------------------------------------- provider backoff */

/**
 * Same backoff mechanism as book-feeds.js (see its header for why): a
 * provider that fails is skipped for a while rather than retried on the next
 * tick, doubling from 2 minutes up to a 60-minute cap per consecutive
 * failure, and forgotten as soon as a capture succeeds. Bounded to at most
 * two entries (rotowire, sbr) — cannot grow across a multi-day run.
 */
const BACKOFF_BASE_MS = 2 * 60 * 1000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;
const _providerBackoff = new Map();

function inBackoff(name) {
  const b = _providerBackoff.get(name);
  return Boolean(b && Date.now() < b.until);
}
function backoffRemainingMs(name) {
  const b = _providerBackoff.get(name);
  return b ? Math.max(0, b.until - Date.now()) : 0;
}
function recordProviderFailure(name) {
  const prev = _providerBackoff.get(name) ?? { failures: 0 };
  const failures = prev.failures + 1;
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
  _providerBackoff.set(name, { failures, until: Date.now() + delay });
}
function recordProviderSuccess(name) { _providerBackoff.delete(name); }

export function extraBookFeedBackoffStatus() {
  return Object.fromEntries([..._providerBackoff.entries()]
    .map(([name, b]) => [name, { failures: b.failures, backing_off: inBackoff(name), remaining_ms: backoffRemainingMs(name) }]));
}
export function __resetExtraBookFeedBackoff() { _providerBackoff.clear(); }

/* --------------------------------------------------------------- capture */

// `nfl_line_snapshots` keys on (captured_at, event, book, market, side) with
// no provider column in the key, so a book both feeds carry (DraftKings,
// FanDuel, BetMGM, Caesars, BetRivers, Fanatics, Hard Rock) is kept once per
// capture, as book-feeds.js does. Rotowire wins: it quotes every book with a
// price and is the Circa source; SBR fills in bet365, and Hard Rock when
// Rotowire has no numbers for it.
const PROVIDER_PRIORITY = { rotowire: 0, sbr: 1 };

/** Merge every provider's quotes into one simultaneous, deduplicated set. */
export function mergeExtraQuotes(byProvider) {
  const best = new Map();
  for (const [provider, quotes] of Object.entries(byProvider)) {
    for (const q of quotes) {
      const key = `${eventKey(q.commence_time, q.away, q.home)}|${q.book}|${q.market}|${q.side}`;
      const existing = best.get(key);
      if (!existing || PROVIDER_PRIORITY[provider] < PROVIDER_PRIORITY[existing.provider]) best.set(key, { ...q, provider });
    }
  }
  return [...best.values()];
}

export async function captureExtraBookFeeds({ providers = Object.keys(PROVIDERS), week } = {}) {
  if (!ENABLED) return { skipped: true, reason: 'FREE_BOOK_FEEDS=0' };
  const byProvider = {}, errors = {};
  await Promise.all(providers.map(async name => {
    if (inBackoff(name)) {
      byProvider[name] = [];
      errors[name] = `skipped: backing off ${Math.round(backoffRemainingMs(name) / 1000)}s after a recent failure`;
      return;
    }
    try { byProvider[name] = await PROVIDERS[name]({ week }); recordProviderSuccess(name); }
    catch (error) { errors[name] = error.message; byProvider[name] = []; recordProviderFailure(name); }
  }));
  const merged = mergeExtraQuotes(byProvider);
  const at = new Date().toISOString();
  const nameOf = new Map(rows('SELECT abbr, name FROM nfl_teams').map(t => [t.abbr, t.name]));
  const events = new Set(), books = new Set(), written = {}, byBook = {};
  for (const name of Object.keys(byProvider)) written[name] = 0;
  for (const q of merged) {
    const id = eventKey(q.commence_time, q.away, q.home);
    const homeName = nameOf.get(q.home) ?? q.home, awayName = nameOf.get(q.away) ?? q.away;
    const sideName = q.side === q.home ? homeName : q.side === q.away ? awayName : q.side;
    const result = run(`INSERT INTO nfl_line_snapshots
        (captured_at, event_id, commence_time, home_team, away_team, book, market, side, line, price, provider, book_updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
    at, id, q.commence_time, homeName, awayName, q.book, q.market, sideName, q.line, q.price,
    `free:${q.provider}`, q.book_updated_at ?? null);
    const n = result.changes ?? 0;
    written[q.provider] += n;
    byBook[q.book] = (byBook[q.book] ?? 0) + n;
    events.add(id); books.add(q.book);
  }
  // Every SBR opener from the capture, whichever provider's current line was kept.
  const openers = Object.values(byProvider).flat().filter(q => q.opening).map(q => ({
    event_id: eventKey(q.commence_time, q.away, q.home), book: q.book, market: q.market, side: q.side,
    line: q.opening.line, price: q.opening.price }));
  if (events.size) {
    try { (await import('./nfl-shopping-board.js')).clearShoppingBoardCache(); } catch { /* board cache is best effort */ }
  }
  const parsed = Object.values(byProvider).reduce((s, v) => s + v.length, 0);
  const quotes = Object.values(written).reduce((s, n) => s + n, 0);
  return { captured_at: at, events: events.size, quotes, books: books.size, book_keys: [...books], by_book: byBook,
    providers: Object.fromEntries(Object.entries(byProvider).map(([k, v]) => [k, v.length])), written,
    deduped: parsed - merged.length, openers, errors: Object.keys(errors).length ? errors : undefined, cost: 'free' };
}

export function extraBookFeedStatus() {
  const byProvider = rows(`SELECT provider, COUNT(*) quotes, COUNT(DISTINCT book) books, MAX(captured_at) latest
    FROM nfl_line_snapshots WHERE provider IN ('free:rotowire','free:sbr') GROUP BY provider`);
  const circa = rows(`SELECT captured_at, COUNT(*) quotes FROM nfl_line_snapshots WHERE book='circa'
    GROUP BY captured_at ORDER BY captured_at DESC LIMIT 3`);
  return { enabled: ENABLED, providers: Object.keys(PROVIDERS), by_provider: byProvider, circa_recent: circa,
    backoff: extraBookFeedBackoffStatus(),
    note: 'Rotowire odds table (Circa, DK, FD, MGM, Caesars, BetRivers, Hard Rock, Fanatics, theScore, Betr) and sportsbookreview.com (eight books with openers). Same snapshot table as the other free feeds; not written to the quote tape. Both are undocumented consumer-site endpoints kept on the conservative hourly cadence, and a failing provider backs off instead of retrying immediately — see backoff above. Set FREE_BOOK_FEEDS=0 to disable.' };
}

export const __test = { parseRotowire, parseSbr, sbrBuildId, easternToIso, eventKey,
  inBackoff, recordProviderFailure, recordProviderSuccess, backoffRemainingMs };
