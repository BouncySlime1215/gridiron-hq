/**
 * ParlayAPI client — a second, independent odds feed alongside odds-api.js.
 *
 * Why this exists: The Odds API's 500-credits/month pool is shared across NFL
 * and MLB, and a runaway MLB capture once burned nearly the whole month in a
 * day (see the note in mlb-pregame.js). ParlayAPI (parlay-api.com) is a
 * separately-billed, separately-metered feed with a much larger free tier
 * (1,000 credits/month, no card required) and a documented endpoint shape
 * that mirrors The Odds API closely enough to reuse the same nested
 * bookmaker -> market -> outcome shape for game odds. Routing MLB through
 * here means MLB no longer has to compete with NFL for the same exhausted
 * budget — but it is still a *finite* monthly pool, so it gets the exact same
 * fail-closed reserve-guard discipline as odds-api.js, not a looser one.
 *
 * Schema/behavior notes (see the 2026-09-04 integration report for how these
 * were verified): confirmed against parlay-api.com/docs at integration time —
 * base URL, auth header, credit costs per endpoint, the flat player-props row
 * shape, and the x-requests-* usage headers. NOT verified against a live call
 * (no real API key was available): the exact game-odds response envelope is
 * documented only as "TOA-shape" (i.e. the same nested shape The Odds API
 * returns), not shown as a full worked example. Treat gameOdds()/eventOdds()
 * parsing as provisional until confirmed against a real response.
 *
 * Everything degrades cleanly without a key: hasKey() is false, every fetch
 * returns null, and callers fall back to whatever other source they already
 * have — same contract as odds-api.js.
 */
import { db, rows, run } from '../db/index.js';

const BASE = 'https://parlay-api.com/v1';
const SPORT = 'americanfootball_nfl';
const MLB_SPORT = 'baseball_mlb';

db.exec(`
  CREATE TABLE IF NOT EXISTS parlay_cache (
    cache_key TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS parlay_usage (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    requests_used INTEGER, requests_remaining INTEGER, requests_last INTEGER, last_call_at TEXT
  );
`);

export const hasKey = () => Boolean(process.env.PARLAY_API_KEY);

/** Player prop markets worth pricing. Documented flat cost of 3 credits regardless of market count. */
export const PROP_MARKETS = [
  'player_pass_yds', 'player_rush_yds', 'player_reception_yds',
  'player_receptions', 'player_anytime_td'
];
export const MLB_PROP_MARKETS = ['batter_total_bases', 'pitcher_strikeouts'];
export const MLB_MARKETS = ['totals_1st_1_innings', 'batter_total_bases', 'pitcher_strikeouts'];

function readCache(key, ttlMs) {
  const hit = rows('SELECT payload, fetched_at FROM parlay_cache WHERE cache_key = ?', key)[0];
  if (!hit) return null;
  if (Date.now() - new Date(hit.fetched_at).getTime() > ttlMs) return null;
  try { return JSON.parse(hit.payload); } catch { return null; }
}
function writeCache(key, payload) {
  run(`INSERT INTO parlay_cache (cache_key, payload, fetched_at) VALUES (?,?,?)
       ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at`,
    key, JSON.stringify(payload), new Date().toISOString());
}

function recordUsage(headers) {
  const used = Number(headers.get('x-requests-used'));
  const remaining = Number(headers.get('x-requests-remaining'));
  const last = Number(headers.get('x-requests-last'));
  if (!Number.isFinite(used) && !Number.isFinite(remaining)) return;
  run(`INSERT INTO parlay_usage (id, requests_used, requests_remaining, requests_last, last_call_at)
       VALUES (1,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET requests_used=excluded.requests_used,
         requests_remaining=excluded.requests_remaining, requests_last=excluded.requests_last,
         last_call_at=excluded.last_call_at`,
    Number.isFinite(used) ? used : null,
    Number.isFinite(remaining) ? remaining : null,
    Number.isFinite(last) ? last : null,
    new Date().toISOString());
}

/**
 * Same reserve-guard discipline as odds-api.js's CREDIT_RESERVE, applied to
 * ParlayAPI's own separate pool. A bigger free tier is not an excuse to skip
 * this — it is exactly the mechanism that would have stopped the original
 * MLB overspend incident, and this is now a second finite budget that can be
 * drained the same way if nothing guards it.
 */
export const CREDIT_RESERVE = Math.max(0, Number(process.env.PARLAY_API_RESERVE) || 50);
let _lastHold = null;

/** Odds endpoint bills markets x regions, exactly like The Odds API. Props/consensus/middles bill a flat 3. */
export function estimateOddsCost(params = {}) {
  const markets = String(params.markets ?? '').split(',').filter(Boolean).length || 1;
  const regions = String(params.regions ?? 'us').split(',').filter(Boolean).length || 1;
  return markets * regions;
}
export const PROPS_COST = 3;

export function reserveStatus() {
  const u = usage();
  const remaining = Number.isFinite(u.requests_remaining) ? u.requests_remaining : null;
  return {
    reserve: CREDIT_RESERVE, requests_remaining: remaining,
    spendable: remaining == null ? null : Math.max(0, remaining - CREDIT_RESERVE),
    exhausted: remaining != null && remaining <= CREDIT_RESERVE,
    last_hold: _lastHold,
    resets: 'ParlayAPI resets usage on the first of every month (per its documented free-tier terms).'
  };
}

export function usage() {
  const u = rows('SELECT * FROM parlay_usage WHERE id = 1')[0] ?? null;
  return { has_key: hasKey(), ...(u ?? { requests_used: null, requests_remaining: null, requests_last: null, last_call_at: null }) };
}

async function get(path, params, { cacheKey, ttlMs, cost, bypassReserve = false }) {
  if (!hasKey()) return null;
  const cached = readCache(cacheKey, ttlMs);
  if (cached) return cached;

  // Fail closed against the reserve, same as odds-api.js: unknown usage (a
  // fresh database, no calls made yet) is allowed through once so the first
  // response can populate the counter.
  const known = rows('SELECT requests_remaining FROM parlay_usage WHERE id = 1')[0]?.requests_remaining;
  if (!bypassReserve && Number.isFinite(known) && known - cost < CREDIT_RESERVE) {
    _lastHold = { at: new Date().toISOString(), path, cost, requests_remaining: known, reserve: CREDIT_RESERVE };
    return null;
  }

  const qs = new URLSearchParams(params);
  const res = await fetch(`${BASE}${path}?${qs}`, {
    headers: { 'X-API-Key': process.env.PARLAY_API_KEY },
    signal: AbortSignal.timeout(25000)
  });
  recordUsage(res.headers);
  if (!res.ok) {
    // A blown quota, bad key, or generic rate-limit should degrade to
    // whatever other source the caller has, not take a page down.
    if ([401, 403, 422, 429].includes(res.status)) return null;
    throw new Error(`ParlayAPI ${res.status} on ${path}`);
  }
  const data = await res.json();
  writeCache(cacheKey, data);
  return data;
}

/** Upcoming events. Documented at 0 credits, so it always bypasses the reserve. */
export function sportEvents(sport, { ttlMs = 6 * 3600e3 } = {}) {
  return get(`/sports/${sport}/events`, {}, { cacheKey: `events:${sport}`, ttlMs, cost: 0, bypassReserve: true });
}
export const events = (options) => sportEvents(SPORT, options);
export const mlbEvents = (options) => sportEvents(MLB_SPORT, options);

/**
 * Game-level markets for a sport's whole slate, or a single event via
 * `eventIds`. Documented cost is markets x regions, same billing shape as
 * The Odds API. The response is documented only as "TOA-shape" (i.e. the
 * same bookmakers -> markets -> outcomes nesting The Odds API returns), not
 * shown as a full worked example — treat this as provisional until a real
 * key confirms it.
 */
export function gameOdds(sport, { markets = 'h2h,spreads,totals', regions = 'us', eventIds, ttlMs = 3 * 3600e3 } = {}) {
  const params = { regions, markets, oddsFormat: 'american' };
  if (eventIds) params.eventIds = Array.isArray(eventIds) ? eventIds.join(',') : eventIds;
  return get(`/sports/${sport}/odds`, params,
    { cacheKey: `game:${sport}:${regions}:${markets}:${params.eventIds ?? ''}`, ttlMs, cost: estimateOddsCost({ markets, regions }) });
}

/**
 * Unlike The Odds API, ParlayAPI has no dedicated per-event odds path — the
 * general `/odds` endpoint takes `eventIds` as a filter and still returns a
 * list (documented behavior). This unwraps that list down to the single
 * matching event so callers written against odds-api.js's `eventOdds` (which
 * returns one event object) don't need to know the difference.
 */
export async function eventOdds(sport, eventId, { markets, regions = 'us', ttlMs = 60 * 60e3 } = {}) {
  const m = Array.isArray(markets) ? markets.join(',') : markets;
  const list = await gameOdds(sport, { markets: m, regions, eventIds: eventId, ttlMs });
  if (!Array.isArray(list)) return list ?? null;
  return list.find(e => e.id === eventId) ?? list[0] ?? null;
}
export const mlbEventOdds = (eventId, options = {}) => eventOdds(MLB_SPORT, eventId, { markets: MLB_MARKETS, ...options });

/**
 * Player props for one event. Documented as a flat 3-credit cost regardless
 * of how many markets are requested, unlike the per-market Odds API billing.
 * The response is a flat array of rows (one row per bookmaker/player/market,
 * carrying both over_price and under_price) — confirmed against a worked
 * example in the docs, not a nested bookmaker/market/outcome tree.
 */
export function playerProps(sport, eventId, { markets = PROP_MARKETS, ttlMs = 6 * 3600e3 } = {}) {
  const m = Array.isArray(markets) ? markets.join(',') : markets;
  return get(`/sports/${sport}/props`, { eventId, markets: m },
    { cacheKey: `props:${sport}:${eventId}:${m}`, ttlMs, cost: PROPS_COST });
}
export const mlbPlayerProps = (eventId, options = {}) => playerProps(MLB_SPORT, eventId, { markets: MLB_PROP_MARKETS, ...options });

/**
 * Flattens ParlayAPI's flat props rows into the same per-player/market/side
 * shape odds-api.js's flattenAllProps produces, so downstream consumers
 * (props CLV pipeline, MLB quote capture) don't need to care which source a
 * quote came from.
 */
export function flattenProps(payload) {
  if (!Array.isArray(payload)) return [];
  const out = [];
  for (const row of payload) {
    for (const [side, price] of [['Over', row.over_price], ['Under', row.under_price]]) {
      if (price == null) continue;
      out.push({
        market: row.market_key, player: row.player, side, line: row.line ?? null,
        american_price: price, book: row.bookmaker,
        home_team: row.home_team, away_team: row.away_team,
        commence_time: row.commence_time, event_id: row.canonical_event_id
      });
    }
  }
  return out;
}

/** Cache state, so the UI can show what is fresh without spending anything. */
export function cacheStatus() {
  return rows(`SELECT cache_key, fetched_at, LENGTH(payload) AS bytes
               FROM parlay_cache ORDER BY fetched_at DESC LIMIT 25`);
}
