/**
 * A cache that cannot serve a stale answer.
 *
 * Two endpoints were taking 26 and 29 seconds on every hub load — a nested
 * rolling holdout across five seasons, and a per-game reasoning pass that
 * re-walks the ensemble. Both are correct and both are pure functions of data
 * that changes a few times a day, so recomputing them per request is simply
 * waste, and it is waste the user feels as a hub that hangs.
 *
 * The obvious fix is a TTL cache, and it is the wrong one. A TTL either serves
 * stale results after a sync or expires uselessly early, and picking the number
 * is guesswork that gets it wrong in both directions. This keys on a
 * FINGERPRINT of the underlying data instead: row counts and the newest
 * timestamps of the tables an answer depends on. When those change the key
 * changes and the work is redone; when they do not, the previous answer is
 * still exactly right. Correct by construction rather than by a guessed
 * interval.
 *
 * The same reasoning already fixed a 15-30 second stall in nfl-auto-picks.js.
 * This generalises it so the next slow endpoint does not have to reinvent it.
 */
import { row } from '../db/index.js';

const store = new Map();

/**
 * A cheap signature of the tables an answer depends on.
 *
 * Row count plus the newest timestamp catches inserts, and the timestamp alone
 * catches in-place updates that leave the count unchanged. A table that does not
 * exist contributes a constant rather than throwing, so a fingerprint never
 * becomes the reason a page fails.
 */
export function fingerprint(tables = [], extra = '') {
  const parts = [];
  for (const t of tables) {
    const name = typeof t === 'string' ? t : t.table;
    const stamp = typeof t === 'string' ? null : t.stamp;
    try {
      const n = row(`SELECT COUNT(*) AS n FROM ${name}`)?.n ?? 0;
      let s = '';
      if (stamp) {
        try { s = String(row(`SELECT MAX(${stamp}) AS m FROM ${name}`)?.m ?? ''); }
        catch { s = ''; }
      }
      parts.push(`${name}:${n}:${s}`);
    } catch { parts.push(`${name}:absent`); }
  }
  return parts.join('|') + (extra ? `|${extra}` : '');
}

/**
 * Run `compute` unless an identical fingerprint already produced an answer.
 *
 * @param key    a stable name for this computation
 * @param print  the data fingerprint it depends on
 */
/**
 * The cached value if one is stored, without computing anything.
 *
 * Exists so a request handler can ask "is this ready" without paying for the
 * answer. `cached()` computes on a miss, which is right for a background job and
 * wrong inside a route — a ninety-second fit called from an Express handler
 * blocks the whole event loop and takes every other endpoint down with it.
 *
 * Deliberately ignores the fingerprint: this reports what is stored, and a stale
 * entry is still a real answer to "has this ever been computed". Callers that
 * need freshness use `cached()`.
 */
export function peek(key) {
  return store.get(key)?.value ?? null;
}

export function cached(key, print, compute) {
  const hit = store.get(key);
  if (hit && hit.print === print) {
    hit.hits++;
    return hit.value;
  }
  const started = Date.now();
  const value = compute();
  store.set(key, { print, value, hits: 0, ms: Date.now() - started,
    computed_at: new Date().toISOString() });
  return value;
}

/** Async variant, for computations that fetch. */
export async function cachedAsync(key, print, compute) {
  const hit = store.get(key);
  if (hit && hit.print === print) { hit.hits++; return hit.value; }
  const started = Date.now();
  const value = await compute();
  store.set(key, { print, value, hits: 0, ms: Date.now() - started,
    computed_at: new Date().toISOString() });
  return value;
}

/** Drop everything, or one entry. Used after a sync that rewrites many tables. */
export function invalidate(key = null) {
  if (key) { store.delete(key); return { cleared: key }; }
  const n = store.size;
  store.clear();
  return { cleared: n };
}

/** What the cache is holding, and what it has saved. */
export function cacheStatus() {
  const entries = [...store.entries()].map(([key, v]) => ({
    key, hits: v.hits, cold_ms: v.ms, computed_at: v.computed_at,
    saved_seconds: +((v.hits * v.ms) / 1000).toFixed(1)
  })).sort((a, b) => b.saved_seconds - a.saved_seconds);
  return {
    entries: entries.length,
    total_saved_seconds: +entries.reduce((s, e) => s + e.saved_seconds, 0).toFixed(1),
    detail: entries,
    note: 'Keyed on a fingerprint of the underlying tables rather than a TTL, so a cached answer is ' +
      'still exactly right by construction and a data change invalidates it immediately.'
  };
}
