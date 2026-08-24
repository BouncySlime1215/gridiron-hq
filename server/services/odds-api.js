/**
 * The Odds API client — the only paid feed in this project.
 *
 * Credits are finite (the free tier is 500/month) and every request against an
 * event costs one credit per market per region, so this caches hard and never
 * fetches on its own. Nothing here runs on a timer or on page load: a fetch
 * happens only when a route explicitly asks for one and the cached copy has
 * aged out. Cached responses are stored in SQLite so a server restart doesn't
 * silently re-spend the month's budget.
 *
 * Everything degrades cleanly without a key. hasKey() is false, fetches return
 * null, and callers fall back to model-only output rather than erroring — which
 * is what makes the props board work before a key exists and light up after.
 */
import { db, rows, run } from '../db/index.js';

const BASE = 'https://api.the-odds-api.com/v4';
const SPORT = 'americanfootball_nfl';
const MLB_SPORT = 'baseball_mlb';

db.exec(`
  CREATE TABLE IF NOT EXISTS odds_cache (
    cache_key TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS odds_usage (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    requests_used INTEGER, requests_remaining INTEGER, last_call_at TEXT
  );
`);

export const hasKey = () => Boolean(process.env.ODDS_API_KEY);

/** Player prop markets worth pricing. Each one costs a credit per event. */
export const PROP_MARKETS = [
  'player_pass_yds', 'player_rush_yds', 'player_reception_yds',
  'player_receptions', 'player_anytime_td'
];

function readCache(key, ttlMs) {
  const hit = rows('SELECT payload, fetched_at FROM odds_cache WHERE cache_key = ?', key)[0];
  if (!hit) return null;
  if (Date.now() - new Date(hit.fetched_at).getTime() > ttlMs) return null;
  try { return JSON.parse(hit.payload); } catch { return null; }
}
function writeCache(key, payload) {
  run(`INSERT INTO odds_cache (cache_key, payload, fetched_at) VALUES (?,?,?)
       ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at`,
    key, JSON.stringify(payload), new Date().toISOString());
}

function recordUsage(headers) {
  const used = Number(headers.get('x-requests-used'));
  const remaining = Number(headers.get('x-requests-remaining'));
  if (!Number.isFinite(used) && !Number.isFinite(remaining)) return;
  run(`INSERT INTO odds_usage (id, requests_used, requests_remaining, last_call_at)
       VALUES (1,?,?,?)
       ON CONFLICT(id) DO UPDATE SET requests_used=excluded.requests_used,
         requests_remaining=excluded.requests_remaining, last_call_at=excluded.last_call_at`,
    Number.isFinite(used) ? used : null,
    Number.isFinite(remaining) ? remaining : null,
    new Date().toISOString());
}

export function usage() {
  const u = rows('SELECT * FROM odds_usage WHERE id = 1')[0] ?? null;
  return { has_key: hasKey(), ...(u ?? { requests_used: null, requests_remaining: null, last_call_at: null }) };
}

async function get(path, params, { cacheKey, ttlMs }) {
  if (!hasKey()) return null;
  const cached = readCache(cacheKey, ttlMs);
  if (cached) return cached;

  const qs = new URLSearchParams({ apiKey: process.env.ODDS_API_KEY, ...params });
  const res = await fetch(`${BASE}${path}?${qs}`, { signal: AbortSignal.timeout(25000) });
  recordUsage(res.headers);
  if (!res.ok) {
    // A blown quota or bad key should degrade to model-only, not take a page down.
    if ([401, 422, 429].includes(res.status)) return null;
    throw new Error(`Odds API ${res.status} on ${path}`);
  }
  const data = await res.json();
  writeCache(cacheKey, data);
  return data;
}

/** Upcoming events. Free — the events list does not consume quota. */
export function events({ ttlMs = 6 * 3600e3 } = {}) {
  return sportEvents(SPORT, { ttlMs });
}

export function sportEvents(sport, { ttlMs = 6 * 3600e3 } = {}) {
  return get(`/sports/${sport}/events/`, {}, { cacheKey: `events:${sport}`, ttlMs });
}

/**
 * Game-level markets for the whole slate. One credit per market *per region*,
 * so adding a region multiplies the cost of a call.
 *
 * The eu region is worth its credit despite that: it is the only way to reach
 * Pinnacle, whose number is the closest thing to a true price in this sport.
 * Every US book in the default region is a price-taker by comparison, which is
 * exactly what nfl-sharp.js exploits.
 */
export function gameOdds({ markets = 'h2h,spreads,totals', regions = 'us', ttlMs = 3 * 3600e3 } = {}) {
  return get(`/sports/${SPORT}/odds/`, { regions, markets, oddsFormat: 'american' },
    { cacheKey: `game:${regions}:${markets}`, ttlMs });
}

/**
 * Player props for one event. Costs one credit per market, so callers should
 * request only the markets they will actually show and lean on the long TTL.
 */
export function playerProps(eventId, { markets = PROP_MARKETS, ttlMs = 6 * 3600e3 } = {}) {
  const m = Array.isArray(markets) ? markets.join(',') : markets;
  return get(`/sports/${SPORT}/events/${eventId}/odds/`,
    { regions: 'us', markets: m, oddsFormat: 'american' },
    { cacheKey: `props:${eventId}:${m}`, ttlMs });
}

export function eventOdds(sport, eventId, { markets, ttlMs = 60 * 60e3 } = {}) {
  const m = Array.isArray(markets) ? markets.join(',') : markets;
  return get(`/sports/${sport}/events/${eventId}/odds/`,
    { regions: 'us', markets: m, oddsFormat: 'american' },
    { cacheKey: `event:${sport}:${eventId}:${m}`, ttlMs });
}

export const MLB_MARKETS = ['totals_1st_1_innings', 'batter_total_bases', 'pitcher_strikeouts'];
export const mlbEvents = options => sportEvents(MLB_SPORT, options);
export const mlbEventOdds = (eventId, options = {}) => eventOdds(MLB_SPORT, eventId,
  { markets: MLB_MARKETS, ...options });

/**
 * Flattens the nested bookmaker -> market -> outcome shape into one row per
 * player/market/side, keeping the best available price across books.
 */
export function flattenProps(payload) {
  if (!payload?.bookmakers) return [];
  const best = new Map();
  for (const book of payload.bookmakers) {
    for (const market of book.markets ?? []) {
      for (const o of market.outcomes ?? []) {
        const player = o.description ?? o.name;
        const side = o.description ? o.name : 'Yes';
        const key = [market.key, player, side, o.point ?? ''].join('|');
        const prev = best.get(key);
        if (!prev || o.price > prev.american_price) {
          best.set(key, {
            market: market.key, player, side, line: o.point ?? null,
            american_price: o.price, book: book.key,
            home_team: payload.home_team, away_team: payload.away_team,
            commence_time: payload.commence_time, event_id: payload.id
          });
        }
      }
    }
  }
  return [...best.values()];
}

/** Cache state, so the UI can show what is fresh without spending anything. */
export function cacheStatus() {
  return rows(`SELECT cache_key, fetched_at, LENGTH(payload) AS bytes
               FROM odds_cache ORDER BY fetched_at DESC LIMIT 25`);
}
