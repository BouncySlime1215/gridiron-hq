/**
 * Append-only multi-book quote tape.
 *
 * A spread and its price are one instrument. This archive preserves both,
 * together with provider snapshot time and bookmaker update time. Consensus
 * rows from game_lines may describe a market, but they never count as genuine
 * multi-book evidence.
 */
import crypto from 'node:crypto';
import { db, rows, run } from '../db/index.js';
import { gameOdds, hasKey } from './odds-api.js';

export const QUOTE_TAPE_VERSION = 'nfl-quote-tape-v1';
const HISTORICAL_ENDPOINT = 'https://api.the-odds-api.com/v4/historical/sports/americanfootball_nfl/odds';

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_quote_batches (
    batch_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    snapshot_at TEXT NOT NULL,
    previous_snapshot_at TEXT,
    next_snapshot_at TEXT,
    mode TEXT NOT NULL,
    markets TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    events INTEGER NOT NULL,
    quotes INTEGER NOT NULL,
    raw_hash TEXT NOT NULL,
    tape_version TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS nfl_quote_tape (
    quote_id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_event_id TEXT NOT NULL,
    commence_time TEXT NOT NULL,
    snapshot_at TEXT NOT NULL,
    book_updated_at TEXT,
    bookmaker_key TEXT NOT NULL,
    bookmaker_title TEXT,
    market TEXT NOT NULL,
    period TEXT NOT NULL,
    side_key TEXT NOT NULL,
    side_name TEXT NOT NULL,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    line REAL,
    american_price INTEGER NOT NULL,
    implied_probability REAL NOT NULL,
    raw_json TEXT NOT NULL,
    tape_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(batch_id) REFERENCES nfl_quote_batches(batch_id) ON DELETE RESTRICT
  );
  CREATE INDEX IF NOT EXISTS idx_nfl_quote_event_time
    ON nfl_quote_tape(provider_event_id,market,snapshot_at);
  CREATE INDEX IF NOT EXISTS idx_nfl_quote_match_time
    ON nfl_quote_tape(home_team,away_team,commence_time,snapshot_at);
  CREATE TRIGGER IF NOT EXISTS nfl_quote_batches_no_update BEFORE UPDATE ON nfl_quote_batches
    BEGIN SELECT RAISE(ABORT, 'quote batches are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_quote_batches_no_delete BEFORE DELETE ON nfl_quote_batches
    BEGIN SELECT RAISE(ABORT, 'quote batches are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_quote_tape_no_update BEFORE UPDATE ON nfl_quote_tape
    BEGIN SELECT RAISE(ABORT, 'quote tape is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_quote_tape_no_delete BEFORE DELETE ON nfl_quote_tape
    BEGIN SELECT RAISE(ABORT, 'quote tape is immutable'); END;
`);

const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical(value[key])]));
  return value;
};
const sha = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const americanProbability = price => price > 0 ? 100 / (price + 100) : Math.abs(price) / (Math.abs(price) + 100);
const r4 = value => value == null || !Number.isFinite(value) ? null : +value.toFixed(4);

function sideKey(market, outcome, event) {
  if (market === 'totals') return /^over$/i.test(outcome.name) ? 'over'
    : /^under$/i.test(outcome.name) ? 'under' : String(outcome.name).toLowerCase();
  if (outcome.name === event.home_team) return 'home';
  if (outcome.name === event.away_team) return 'away';
  if (/draw/i.test(outcome.name)) return 'draw';
  return String(outcome.name).toLowerCase().replace(/\s+/g, '_');
}

function unwrap(payload, requestedAt) {
  if (Array.isArray(payload)) return { events: payload, snapshotAt: requestedAt,
    previous: null, next: null, mode: 'current' };
  return { events: payload?.data ?? [], snapshotAt: payload?.timestamp ?? requestedAt,
    previous: payload?.previous_timestamp ?? null, next: payload?.next_timestamp ?? null,
    mode: 'historical' };
}

export function ingestQuoteSnapshot(payload, { provider = 'the-odds-api', requestedAt = new Date().toISOString(),
  sourceRef = 'live_api', markets = 'spreads,totals,h2h' } = {}) {
  const packet = unwrap(payload, requestedAt);
  const rawHash = sha(payload), batchId = sha({ provider, snapshot: packet.snapshotAt, rawHash, markets });
  const existing = rows('SELECT * FROM nfl_quote_batches WHERE batch_id=?', batchId)[0];
  if (existing) return { existing: true, batch_id: batchId, events: existing.events, quotes: existing.quotes };
  const createdAt = new Date().toISOString();
  const pending = [];
  for (const event of packet.events) {
    if (!event.id || !event.commence_time || !event.home_team || !event.away_team) continue;
    for (const book of event.bookmakers ?? []) {
      for (const market of book.markets ?? []) {
        for (const outcome of market.outcomes ?? []) {
          const price = Number(outcome.price);
          if (!Number.isFinite(price) || price === 0) continue;
          const record = {
            batch_id: batchId, provider, provider_event_id: String(event.id),
            commence_time: event.commence_time, snapshot_at: packet.snapshotAt,
            book_updated_at: market.last_update ?? book.last_update ?? null,
            bookmaker_key: book.key, bookmaker_title: book.title ?? null,
            market: market.key, period: 'full_game', side_key: sideKey(market.key, outcome, event),
            side_name: outcome.name, home_team: event.home_team, away_team: event.away_team,
            line: outcome.point == null ? null : Number(outcome.point), american_price: price,
            implied_probability: americanProbability(price), raw: { event_id: event.id,
              bookmaker: book.key, market: market.key, outcome }
          };
          pending.push({ ...record, quote_id: sha(record) });
        }
      }
    }
  }
  db.exec('BEGIN');
  try {
    run(`INSERT INTO nfl_quote_batches
      (batch_id,provider,requested_at,snapshot_at,previous_snapshot_at,next_snapshot_at,mode,
       markets,source_ref,events,quotes,raw_hash,tape_version,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, batchId, provider, requestedAt, packet.snapshotAt,
    packet.previous, packet.next, packet.mode, markets, sourceRef, packet.events.length,
    pending.length, rawHash, QUOTE_TAPE_VERSION, createdAt);
    for (const quote of pending) run(`INSERT OR IGNORE INTO nfl_quote_tape
      (quote_id,batch_id,provider,provider_event_id,commence_time,snapshot_at,book_updated_at,
       bookmaker_key,bookmaker_title,market,period,side_key,side_name,home_team,away_team,line,
       american_price,implied_probability,raw_json,tape_version,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, quote.quote_id, quote.batch_id,
    quote.provider, quote.provider_event_id, quote.commence_time, quote.snapshot_at,
    quote.book_updated_at, quote.bookmaker_key, quote.bookmaker_title, quote.market, quote.period,
    quote.side_key, quote.side_name, quote.home_team, quote.away_team, quote.line,
    quote.american_price, quote.implied_probability, JSON.stringify(quote.raw),
    QUOTE_TAPE_VERSION, createdAt);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { existing: false, batch_id: batchId, snapshot_at: packet.snapshotAt,
    events: packet.events.length, quotes: pending.length, mode: packet.mode };
}

export async function captureCurrentQuoteTape({ markets = 'spreads,totals,h2h' } = {}) {
  if (!hasKey()) return { skipped: true, reason: 'ODDS_API_KEY is optional and not configured' };
  const requestedAt = new Date().toISOString();
  const payload = await gameOdds({ markets, ttlMs: 0 });
  if (!payload) return { error: 'odds provider returned no current snapshot' };
  return ingestQuoteSnapshot(payload, { requestedAt, markets, sourceRef: 'current_odds_endpoint' });
}

async function fetchHistorical(date, { markets = 'spreads,totals,h2h', regions = 'us' } = {}) {
  const key = process.env.ODDS_API_KEY;
  if (!key) return { skipped: true, reason: 'ODDS_API_KEY is optional and not configured' };
  const url = new URL(HISTORICAL_ENDPOINT);
  url.searchParams.set('apiKey', key); url.searchParams.set('regions', regions);
  url.searchParams.set('markets', markets); url.searchParams.set('oddsFormat', 'american');
  url.searchParams.set('dateFormat', 'iso'); url.searchParams.set('date', date);
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`historical odds ${date} -> HTTP ${response.status}`);
  return response.json();
}

export async function backfillHistoricalQuoteTape({ dates, markets = 'spreads,totals,h2h',
  regions = 'us' } = {}) {
  if (!Array.isArray(dates) || !dates.length) return { error: 'explicit ISO snapshot dates are required' };
  const results = [];
  for (const date of [...new Set(dates)].sort()) {
    const payload = await fetchHistorical(date, { markets, regions });
    if (payload?.skipped) return payload;
    results.push(ingestQuoteSnapshot(payload, { requestedAt: new Date().toISOString(), markets,
      sourceRef: `${HISTORICAL_ENDPOINT}?date=${encodeURIComponent(date)}` }));
  }
  return { requested: dates.length, ingested: results.filter(item => !item.existing).length, results };
}

function priceValue(price) {
  return price > 0 ? price / 100 : 100 / Math.abs(price);
}

export function quoteSurface({ homeTeam, awayTeam, commenceTime = null, market = 'spreads',
  sideKey: wantedSide = null, at: atTime = null } = {}) {
  const args = [homeTeam, awayTeam, market];
  let where = `home_team=? AND away_team=? AND market=?`;
  if (commenceTime) { where += ' AND commence_time=?'; args.push(commenceTime); }
  if (wantedSide) { where += ' AND side_key=?'; args.push(wantedSide); }
  if (atTime) { where += ' AND snapshot_at<=?'; args.push(atTime); }
  const quotes = rows(`SELECT * FROM nfl_quote_tape WHERE ${where}
    ORDER BY snapshot_at DESC,bookmaker_key,line,american_price DESC`, ...args);
  const latestAt = quotes[0]?.snapshot_at;
  const latest = latestAt ? quotes.filter(quote => quote.snapshot_at === latestAt) : [];
  return { home_team: homeTeam, away_team: awayTeam, market, at: atTime,
    snapshots: new Set(quotes.map(quote => quote.snapshot_at)).size,
    latest_at: latestAt ?? null, books: new Set(latest.map(quote => quote.bookmaker_key)).size,
    quotes: latest };
}

export function closingQuotes(providerEventId, { maxAgeMinutes = 90 } = {}) {
  const event = rows(`SELECT commence_time FROM nfl_quote_tape WHERE provider_event_id=? LIMIT 1`,
  providerEventId)[0];
  if (!event) return { available: false, reason: 'event absent from quote tape' };
  const earliest = new Date(new Date(event.commence_time).getTime() - maxAgeMinutes * 60000).toISOString();
  const latest = rows(`SELECT MAX(snapshot_at) at FROM nfl_quote_tape
    WHERE provider_event_id=? AND snapshot_at<=? AND snapshot_at>=?`,
  providerEventId, event.commence_time, earliest)[0]?.at;
  if (!latest) return { available: false, reason: 'no pre-kickoff snapshot inside closing window' };
  const quotes = rows(`SELECT * FROM nfl_quote_tape WHERE provider_event_id=? AND snapshot_at=?`,
  providerEventId, latest);
  return { available: true, commence_time: event.commence_time, close_at: latest,
    age_minutes: r4((new Date(event.commence_time) - new Date(latest)) / 60000),
    books: new Set(quotes.map(quote => quote.bookmaker_key)).size, quotes };
}

export function bestExecutableQuote(providerEventId, { market, sideKey: wantedSide, line = null,
  at: atTime = null } = {}) {
  const args = [providerEventId, market, wantedSide];
  let where = 'provider_event_id=? AND market=? AND side_key=?';
  if (line != null) { where += ' AND line=?'; args.push(line); }
  if (atTime) { where += ' AND snapshot_at<=?'; args.push(atTime); }
  const snapshot = rows(`SELECT MAX(snapshot_at) at FROM nfl_quote_tape WHERE ${where}`, ...args)[0]?.at;
  if (!snapshot) return null;
  const quotes = rows(`SELECT * FROM nfl_quote_tape WHERE ${where} AND snapshot_at=?
    ORDER BY american_price DESC`, ...args, snapshot);
  const best = quotes[0];
  return best ? { ...best, decimal_payout: r4(1 + priceValue(best.american_price)),
    books_compared: new Set(quotes.map(quote => quote.bookmaker_key)).size } : null;
}

export function quoteTapeCoverage() {
  const total = rows(`SELECT COUNT(*) quotes,COUNT(DISTINCT batch_id) batches,
      COUNT(DISTINCT provider_event_id) events,COUNT(DISTINCT bookmaker_key) books,
      MIN(snapshot_at) first_at,MAX(snapshot_at) last_at FROM nfl_quote_tape`)[0];
  const byMarket = rows(`SELECT market,COUNT(*) quotes,COUNT(DISTINCT provider_event_id) events,
      COUNT(DISTINCT bookmaker_key) books FROM nfl_quote_tape GROUP BY market ORDER BY quotes DESC`);
  const genuine = Number(total?.books ?? 0) >= 2 && Number(total?.batches ?? 0) >= 2;
  return { version: QUOTE_TAPE_VERSION, ...total, by_market: byMarket,
    genuine_multi_book_history: genuine,
    production_eligible: false,
    requirement: 'forward CLV needs repeated pre-kickoff snapshots from at least two books' };
}
