/**
 * PRODUCER-FAST: the producer's rescore cache, carried between runs.
 *
 * A rescore is a pure function of the world and the changed rosters. The cache is
 * keyed by a content hash of everything a rescore reads from the world (the
 * league row's payload and rules, the rosters and positions, the lineup slots,
 * every week's expected points and K / D/ST points (SIM-KDST) and every run's draws), so an entry is reused only
 * when the numbers it would recompute are the same numbers. A new sync, a new
 * seed, a roster move or a news event that changes a player's pool is a
 * different world and a miss, never a stale hit.
 *
 * File shape (GRIDIRON_WARROOM_RESCORE_CACHE, next to the plans file; local only):
 *   { version: 1, leagues: { "<id>": { "<world print>": { "<state key>": <rescore result> } } } }
 * Each run keeps only the worlds it used (`next`), so the file never grows past one run.
 */
import fs from 'node:fs';
import { stopwatch } from '../../server/services/campaign/run-clock.js';

export const CACHE_VERSION = 1;

/** FNV-1a, fed strings and the raw bytes of typed arrays. */
function hasher() {
  let h = 0x811c9dc5 >>> 0, h2 = 0x01000193 >>> 0;
  const byte = b => { h = Math.imul(h ^ b, 0x01000193) >>> 0; h2 = Math.imul(h2 ^ b, 0x5bd1e995) >>> 0; };
  return {
    str(s) { s = String(s); for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); byte(c & 0xff); byte(c >> 8); } byte(0x1f); },
    doubles(arr) {
      const u = new Uint32Array(arr.buffer, arr.byteOffset, arr.length * 2);
      for (let i = 0; i < u.length; i++) {
        const x = u[i];
        h = Math.imul(h ^ x, 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ x, 0x5bd1e995) >>> 0;
      }
      byte(0x1e);
    },
    hex: () => h.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'),
  };
}

/** Content hash of a tradeImpactWorld (see the header for what it covers). */
export function worldPrint(w, lg) {
  const H = hasher();
  H.str(JSON.stringify(w.key));
  H.str(lg.payload ?? ''); H.str(lg.roster_positions ?? ''); H.str(lg.current_week ?? '');
  const { prep } = w;
  H.str(JSON.stringify(prep.slots)); H.str(JSON.stringify(prep.rules ?? null));
  H.str(JSON.stringify([prep.fromWeek, prep.weeks, prep.bracketWeeks, prep.playoffTeams, prep.medianGame]));
  H.str(JSON.stringify([...(prep.sched ?? new Map())]));
  for (const t of prep.teams) H.str(`${t.roster_id}:${t.players.map(p => `${p.id}/${p.position}`).join(',')}`);
  for (const [week, { byRun, expected, kdst }] of w.draws) {
    H.str(`w${week}`);
    H.str(JSON.stringify([...expected]));
    // SIM-KDST: w.key.kdst carries the flag; the week's K / D/ST points are hashed too.
    H.str(kdst ? JSON.stringify([...kdst]) : 'kdst:off');
    if (byRun.length) H.str(JSON.stringify([...byRun[0].index]));
    for (const d of byRun) H.doubles(d.vals);
  }
  return H.hex();
}

/** Exact key for one rescore: teams in id order, each roster in its own order, the resolved pair. */
export function stateKey(state, a, b) {
  return JSON.stringify([[...state.entries()].map(([t, ids]) => [String(t), ids.map(String)])
    .sort((x, y) => (x[0] > y[0]) - (x[0] < y[0])), String(a), String(b)]);
}

/** Read the cache file: absent -> empty; unreadable or another version -> empty, with the reason. */
export function readRescoreCache(file) {
  if (!fs.existsSync(file)) return { leagues: {}, status: 'absent' };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.version !== CACHE_VERSION || typeof parsed.leagues !== 'object') {
      return { leagues: {}, status: `ignored (version ${parsed?.version ?? 'none'}, want ${CACHE_VERSION})` };
    }
    return { leagues: parsed.leagues, status: 'ok' };
  } catch (e) {
    return { leagues: {}, status: `unreadable (${e.message}); every rescore recomputed` };
  }
}

export function writeRescoreCache(file, leagues) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, leagues }));
  fs.renameSync(tmp, file);
}

/**
 * One league's view of the cache: prev = last run's worlds for this league, next = what this run
 * used (written back). wrap(w, lg, rescore) returns a rescore that reads prev, falls through to the
 * real one on a miss, and records every result it hands out in next.
 */
export function leagueCache(prev = {}) {
  const next = {};
  const stats = { hits: 0, misses: 0, print_ms: 0, worlds: 0 };
  return {
    next, stats,
    wrap(w, lg, rescore, resolveB, now = stopwatch) {
      const t0 = now();
      const fp = worldPrint(w, lg);
      stats.print_ms += now() - t0;
      stats.worlds++;
      const old = prev[fp] ?? {};
      const mine = (next[fp] ??= {});
      return (state, a, b) => {
        const k = stateKey(state, a, resolveB(state, a, b));
        if (Object.hasOwn(mine, k)) { stats.hits++; return mine[k]; }
        if (Object.hasOwn(old, k)) { stats.hits++; mine[k] = old[k]; return old[k]; }
        stats.misses++;
        const r = rescore(state, a, b);
        // Only the JSON form is kept, so a hit is exactly what a later run reads back.
        mine[k] = JSON.parse(JSON.stringify(r));
        return mine[k];
      };
    },
  };
}
