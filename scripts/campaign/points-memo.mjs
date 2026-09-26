/**
 * PRODUCER-SPEED (plan item 32): the planner under 60 s with SEARCH-WIDE on, the same plan.
 *
 * Two changes, both behind GRIDIRON_PRODUCER_SPEED=1 (its own flag: preview mode does NOT turn it on)
 * and only on top of PRODUCER-FAST's fast lineups:
 *   1. pointsMemo: a roster's lineup totals (week -> Float64Array[run]) are kept per world, keyed by the
 *      roster's ids in order (lineup ties break on it). Every rescore solved each changed roster twice
 *      (once in the adapter, once again inside tradeImpact), and the search re-solves the same
 *      post-trade roster for every path that shares a leg. A hit returns the very array the first solve
 *      made; nothing reads it but playSeasons and seasonAvg, which never write to it.
 *   2. season-sim.js#regularSeasonTable (tradeImpactWorld `fastSeasons`): the regular season on index
 *      arrays, the same doubles.
 * The contract is PRODUCER-FAST's: the whole planner result byte-equal with the flag off.
 */
export const PRODUCER_SPEED_ENV = 'GRIDIRON_PRODUCER_SPEED';
/** On only with GRIDIRON_PRODUCER_SPEED=1; anything else (preview mode included) is off. */
export const producerSpeedEnabled = (env = process.env) => env?.[PRODUCER_SPEED_ENV] === '1';
/** Rosters kept per world: ~weeks x runs x 8 bytes each (~160 KB at 17 weeks x 1200 runs), so ~40 MB; the hits are mostly the in-rescore repeat, so a small bound keeps nearly all of them. */
export const POINTS_MEMO_MAX = 256;

/**
 * solve(w, players) -> week -> Float64Array[run] (season-sim.js#teamPointsFast). Returns the same
 * signature, memoised per world (keyed on the world's draws, which every spread copy of it shares)
 * and bounded by `max` (least recently used out). stats: { hits, misses, evicted }.
 */
export function pointsMemo(solve, { max = POINTS_MEMO_MAX } = {}) {
  const byWorld = new WeakMap();
  const stats = { hits: 0, misses: 0, evicted: 0 };
  const memo = (w, players) => {
    let m = byWorld.get(w.draws);
    if (!m) { m = new Map(); byWorld.set(w.draws, m); }
    const key = players.map(p => p.id).join(',');
    const hit = m.get(key);
    if (hit) { stats.hits++; m.delete(key); m.set(key, hit); return hit; }
    stats.misses++;
    const out = solve(w, players);
    m.set(key, out);
    if (m.size > max) { m.delete(m.keys().next().value); stats.evicted++; }
    return out;
  };
  memo.stats = stats;
  return memo;
}
