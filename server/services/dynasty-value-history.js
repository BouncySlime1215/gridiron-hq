/**
 * The readers of FantasyCalc's market price (FC-SNAP).
 *
 * One writer: `syncDynastyValues` (server/routes/aggregates.js) fills
 *   - `dynasty_values`         the latest price per format/player (upsert), with
 *                              `retired_at` set on rows the latest pull no longer returned;
 *   - `dynasty_value_history`  one append-only row per format/player/UTC day.
 * It runs from the daily `fantasycalc_dynasty` job (scheduler.js) and the league-sync button.
 *
 * This module is the one place the trade surfaces read that price from, so a retired
 * price is skipped everywhere at once and every surface can say how old the price is.
 */
import { rows, row } from '../db/index.js';

/**
 * FantasyCalc's terms ask callers to cache and ideally fetch once a day; the job, the
 * freshness registry and the Trade Lab age line all use this one budget.
 */
export const MARKET_MAX_AGE_MINUTES = 24 * 60;
export const MARKET_SOURCE_URL = 'https://fantasycalc.com';

const tableExists = name =>
  !!row(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`, name);

/**
 * Migration 073 adds `retired_at`. A database opened without running migrations (some
 * narrow test harnesses) has no such column, and on it no row can have been retired,
 * so "not retired" is every row: exact, not a fallback.
 */
const liveClause = () =>
  rows('PRAGMA table_info(dynasty_values)').some(c => c.name === 'retired_at') ? 'retired_at IS NULL' : '1';

/** SQLite 'YYYY-MM-DD HH:MM:SS' (UTC, what datetime('now') writes) or ISO -> Date. */
function parseStamp(s) {
  if (!s) return null;
  const iso = /[TZ]/.test(s) ? s : `${s.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The live (not retired) FantasyCalc price for every player in one format, keyed by
 * player id. Used by trade-engine.js buildAssetUniverse and routes/tradelab.js.
 */
export function currentMarket(formatKey) {
  return new Map(rows(
    `SELECT player_id, value, age, trend30, pos_rank, fetched_at FROM dynasty_values
      WHERE format_key = ? AND ${liveClause()}`, formatKey)
    .map(d => [d.player_id, d]));
}

/**
 * How old one format's market price is. `state` says which absence it is:
 *   table_absent  no dynasty_values table in this database
 *   empty         no live row for this format (never fetched, or every row retired)
 *   stale         newest fetch older than MARKET_MAX_AGE_MINUTES
 *   fresh         otherwise
 */
export function marketAsOf(formatKey, { now = new Date() } = {}) {
  const base = {
    format_key: formatKey, fetched_at: null, age_hours: null, state: 'empty',
    live_rows: 0, retired_rows: 0,
    stale_after_hours: MARKET_MAX_AGE_MINUTES / 60,
    source: 'FantasyCalc', source_url: MARKET_SOURCE_URL
  };
  if (!tableExists('dynasty_values')) return { ...base, state: 'table_absent' };
  const live = liveClause();
  const r = row(`SELECT MAX(CASE WHEN ${live} THEN fetched_at END) AS fetched_at,
                        SUM(CASE WHEN ${live} THEN 1 ELSE 0 END) AS live,
                        SUM(CASE WHEN ${live} THEN 0 ELSE 1 END) AS retired
                   FROM dynasty_values WHERE format_key = ?`, formatKey);
  const at = parseStamp(r?.fetched_at);
  const out = { ...base, live_rows: r?.live ?? 0, retired_rows: r?.retired ?? 0 };
  if (!at) return out;
  const ageHours = (now.getTime() - at.getTime()) / 3.6e6;
  return {
    ...out,
    fetched_at: r.fetched_at,
    age_hours: +ageHours.toFixed(1),
    state: ageHours * 60 > MARKET_MAX_AGE_MINUTES ? 'stale' : 'fresh'
  };
}

/** Every stored day of one player's price in one format, oldest first. */
export function marketHistory(formatKey, playerId, { limit = 400 } = {}) {
  if (!tableExists('dynasty_value_history')) return [];
  return rows(`SELECT captured_on, captured_at, value, redraft_value, trend30, age, pos_rank
                 FROM dynasty_value_history
                WHERE format_key = ? AND player_id = ?
                ORDER BY captured_on
                LIMIT ?`, formatKey, Number(playerId), Math.max(1, Math.min(Number(limit) || 400, 5000)));
}
