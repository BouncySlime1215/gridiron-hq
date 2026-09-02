/**
 * Historical multi-book opening and closing quotes, with timestamps.
 *
 * PROFITABILITY_PLAN Priority 3: "preserve genuine multi-book opening,
 * intermediate and closing quotes with capture timestamps; never manufacture
 * historical prices from a consensus row." Two council roles could not report
 * on 2022–2025 for exactly this reason: the line-movement reader needs a
 * stored opening-to-decision pair and the price shopper needs the per-book
 * quotes that were on the board before kickoff. game_lines carried only
 * nflverse's single closing consensus for those seasons.
 *
 * OddsTrader's odds service (the aggregator book-feeds.js already reads for
 * live prices) answers a past `startDate` with each event's `openingLines`
 * and `currentLines` — the last quote each book posted before kickoff — per
 * book, with the book's own timestamp. Those are recorded quotes, not
 * reconstructions. This module stores them three ways:
 *   1. `nfl_odds_archive`: the raw per-book open/close rows (provenance).
 *   2. `nfl_line_snapshots` with provider `archive:oddstrader` and
 *      `captured_at` = the book's timestamp, so the existing cutoff-bounded
 *      readers (the price shopper's `shoppingFor`, closing-line value) see
 *      them exactly as they see a live capture.
 *   3. `game_lines.open_spread` / `open_total` where null, from the median
 *      opening line across books, so the line-movement reader's
 *      opening-to-decision pairs exist for those seasons.
 */
import { db, rows, run } from '../db/index.js';
import { teamResolver } from './team-codes.js';

export const ODDS_ARCHIVE_VERSION = 'oddstrader-archive-v1';
// The books the archive answers for; more than this and the request URL is refused.
export const ARCHIVE_PAIDS = Object.freeze({
  10: 'pinnacle', 36: 'unibet', 20: 'betanysports', 8: 'betonlineag', 9: 'sportsbetting', 29: 'lowvig',
  84: 'bovada', 3: 'bookmaker', 82: 'bodog', 15: 'mybookieag', 28: 'everygame'
});

db.exec(`CREATE TABLE IF NOT EXISTS nfl_odds_archive (
  eid INTEGER NOT NULL,
  season INTEGER, week INTEGER,
  home TEXT NOT NULL, away TEXT NOT NULL,
  commence_time TEXT NOT NULL,
  book TEXT NOT NULL, market TEXT NOT NULL, side TEXT NOT NULL,
  phase TEXT NOT NULL,
  line REAL, price INTEGER NOT NULL,
  book_updated_at TEXT,
  source TEXT NOT NULL DEFAULT 'oddstrader',
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (eid, book, market, side, phase)
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_nfl_odds_archive_game ON nfl_odds_archive(season, week, home)`);

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const iso = ms => (Number.isFinite(Number(ms)) ? new Date(Number(ms)).toISOString() : null);

function archiveQuery(startMs) {
  const paids = Object.keys(ARCHIVE_PAIDS).join(',');
  return `{ eventsByDateByLeagueGroup( leagueGroups: [{ mtid: [401,402,83], lid: 16, spid: 4 }], showEmptyEvents: true, ` +
    `marketTypeLayout: "PARTICIPANTS", ic: false, startDate: ${startMs}, timezoneOffset: -4, nof: true, hl: true, ` +
    `sort: {by: ["lid", "dt", "des"], order: ASC} ) { events { eid des dt es participants { partid ih source { ... on Team { abbr nam } } } ` +
    `currentLines(paid: [${paids}]) openingLines(paid: [${paids}]) } } }`;
}

/** One event's lines -> flat quote rows with phase 'open' | 'close'. Pure. */
export function parseArchiveEvents(payload, resolve = teamResolver()) {
  const out = [];
  for (const e of payload?.data?.eventsByDateByLeagueGroup?.events ?? []) {
    const home = e.participants?.find(p => p.ih), away = e.participants?.find(p => !p.ih);
    const h = resolve(home?.source?.abbr) ?? resolve(home?.source?.nam);
    const a = resolve(away?.source?.abbr) ?? resolve(away?.source?.nam);
    if (!h || !a || h.abbr === a.abbr) continue;
    const commence = iso(e.dt);
    if (!commence) continue;
    for (const [phase, lines] of [['open', e.openingLines], ['close', e.currentLines]]) {
      for (const l of lines ?? []) {
        const book = ARCHIVE_PAIDS[l.paid];
        if (!book) continue;
        const price = num(l.ap), line = num(l.adj);
        if (price == null) continue;
        const base = { eid: Number(e.eid), home: h.abbr, away: a.abbr, home_name: h.name, away_name: a.name,
          commence_time: commence, book, phase, price, book_updated_at: iso(l.tim) };
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
  }
  return out;
}

/** The stored game a quote belongs to: same home team, kickoff within a day. */
function gameFor(quote) {
  const day = quote.commence_time.slice(0, 10);
  return rows(`SELECT season,week,team home,opponent away,gameday,open_spread,open_total FROM game_lines
    WHERE home=1 AND team=? AND opponent=? AND gameday BETWEEN date(?, '-1 day') AND date(?, '+1 day') LIMIT 1`,
  quote.home, quote.away, day, day)[0] ?? null;
}

const median = list => {
  const sorted = [...list].sort((x, y) => x - y);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Store parsed quotes; returns counts. Pure of the network. */
export function storeArchiveQuotes(quotes, { fetchedAt = new Date().toISOString() } = {}) {
  const archiveStmt = db.prepare(`INSERT INTO nfl_odds_archive
    (eid,season,week,home,away,commence_time,book,market,side,phase,line,price,book_updated_at,source,fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'oddstrader',?)
    ON CONFLICT(eid,book,market,side,phase) DO UPDATE SET line=excluded.line, price=excluded.price,
      book_updated_at=excluded.book_updated_at, season=excluded.season, week=excluded.week, fetched_at=excluded.fetched_at`);
  const snapshotStmt = db.prepare(`INSERT OR IGNORE INTO nfl_line_snapshots
    (captured_at, event_id, commence_time, home_team, away_team, book, market, side, line, price, provider, book_updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const gameCache = new Map();
  let archived = 0, snapshots = 0, unmatched = 0;
  const openers = new Map();
  db.exec('BEGIN');
  try {
    for (const q of quotes) {
      const key = `${q.home}|${q.away}|${q.commence_time.slice(0, 10)}`;
      if (!gameCache.has(key)) gameCache.set(key, gameFor(q));
      const game = gameCache.get(key);
      if (!game) { unmatched++; continue; }
      const r = archiveStmt.run(q.eid, game.season, game.week, q.home, q.away, q.commence_time, q.book, q.market, q.side,
        q.phase, q.line, q.price, q.book_updated_at, fetchedAt);
      archived += Number(r.changes ?? 0);
      // Snapshot rows carry the book's own timestamp as captured_at so a cutoff
      // query sees only what was on the board before kickoff.
      const capturedAt = q.book_updated_at ?? q.commence_time;
      const sideName = q.market === 'spreads' || q.market === 'h2h'
        ? (q.side === q.home ? q.home_name : q.away_name) : q.side;
      const s = snapshotStmt.run(capturedAt, `archive:${q.eid}:${q.phase}`, q.commence_time, q.home_name, q.away_name,
        q.book, q.market, sideName, q.line, q.price, 'archive:oddstrader', q.book_updated_at);
      snapshots += Number(s.changes ?? 0);
      if (q.phase === 'open') {
        const o = openers.get(key) ?? { game, spreads: [], totals: [] };
        if (q.market === 'spreads' && q.side === q.home) o.spreads.push(q.line);
        if (q.market === 'totals' && q.side === 'Over') o.totals.push(q.line);
        openers.set(key, o);
      }
    }
    let openersFilled = 0;
    for (const { game, spreads, totals } of openers.values()) {
      const openSpread = median(spreads), openTotal = median(totals);
      if (openSpread == null && openTotal == null) continue;
      // Only fills a blank: an opener recorded by a direct feed is never overwritten.
      const r = run(`UPDATE game_lines SET open_spread=COALESCE(open_spread, ?), open_total=COALESCE(open_total, ?)
        WHERE season=? AND week=? AND ((team=? AND opponent=?) OR (team=? AND opponent=?))
          AND (open_spread IS NULL OR open_total IS NULL)`,
      openSpread, openTotal, game.season, game.week, game.home, game.away, game.away, game.home);
      openersFilled += Number(r.changes ?? 0);
    }
    db.exec('COMMIT');
    return { archived, snapshots, openers_filled: openersFilled, unmatched, games: gameCache.size };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

async function fetchArchive(startMs) {
  const url = `https://www.oddstrader.com/odds-v2/odds-v2-service?query=${encodeURIComponent(archiveQuery(startMs))}`;
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' }, signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`oddstrader archive ${res.status}`);
  const text = await res.text();
  if (!text.startsWith('{')) throw new Error('oddstrader archive returned a non-JSON page');
  return JSON.parse(text);
}

/**
 * Backfill every game week in the seasons given. One request per distinct
 * game day is enough because the service answers with the events on and
 * after `startDate`; requests are spaced so the aggregator is not hammered.
 */
export async function backfillOddsArchive({ seasons = [2022, 2023, 2024, 2025], pauseMs = 1200, onProgress = null } = {}) {
  const days = rows(`SELECT DISTINCT gameday FROM game_lines WHERE home=1 AND gameday IS NOT NULL
    AND season IN (${seasons.map(() => '?').join(',')}) ORDER BY gameday`, ...seasons).map(r => r.gameday);
  // Thursday-to-Monday slates: one request per game day, but skip a day whose
  // events already came back in the previous request.
  const seen = new Set();
  const totals = { requests: 0, archived: 0, snapshots: 0, openers_filled: 0, unmatched: 0, failures: [] };
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    if (seen.has(day)) continue;
    const startMs = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
    try {
      const payload = await fetchArchive(startMs);
      totals.requests++;
      const quotes = parseArchiveEvents(payload);
      for (const q of quotes) seen.add(q.commence_time.slice(0, 10));
      const stored = storeArchiveQuotes(quotes);
      for (const k of ['archived', 'snapshots', 'openers_filled', 'unmatched']) totals[k] += stored[k];
      if (onProgress) onProgress({ current: i + 1, total: days.length, day, ...totals });
    } catch (error) {
      totals.failures.push({ day, error: error.message });
    }
    if (pauseMs) await new Promise(resolve => setTimeout(resolve, pauseMs));
  }
  return { version: ODDS_ARCHIVE_VERSION, seasons, days: days.length, ...totals };
}

export function oddsArchiveStatus() {
  const bySeason = rows(`SELECT season, COUNT(DISTINCT eid) games, COUNT(DISTINCT book) books,
    SUM(phase='open') open_rows, SUM(phase='close') close_rows FROM nfl_odds_archive GROUP BY season ORDER BY season`);
  const openers = rows(`SELECT season, COUNT(*) games, SUM(open_spread IS NOT NULL) with_open_spread
    FROM game_lines WHERE home=1 AND season>=2021 GROUP BY season ORDER BY season`);
  return { version: ODDS_ARCHIVE_VERSION, by_season: bySeason, openers, books: Object.values(ARCHIVE_PAIDS),
    provenance: 'Recorded per-book opening and pre-kickoff quotes from the OddsTrader archive with the book\'s own timestamps; ' +
      'never a consensus row turned into prices.' };
}
