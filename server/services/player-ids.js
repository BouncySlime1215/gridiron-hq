/**
 * One place that knows a player is the same player.
 *
 * This database carries a player under at least four identifiers and no two
 * tables agree on which to use:
 *
 *   players.id            an internal integer, used by rosters and usage
 *   players.gsis_id       "00-0033553", used by nflverse-derived tables
 *   players.espn_id       used by depth charts and league syncs
 *   players.sleeper_id    used by one platform's rosters
 *
 * Every cross-table lookup therefore needs a translation, and the translation
 * kept being skipped — silently, because a join across two integer-vs-string id
 * spaces does not error, it returns nothing. Three separate features shipped
 * with that exact bug:
 *
 *   The touchdown-regression model joined weekly features to usage on ids with
 *   ZERO overlap. Every player got zero touchdowns, every fitted rate kept its
 *   seed, and the board filled with "every star in the league is unlucky".
 *
 *   The football-context injury picture joined the injury report to usage the
 *   same way, so every player's usage share came back 0, every injury scored as
 *   costing nothing, and the summary always read "close to healthy on offence"
 *   no matter who was out.
 *
 *   The confluence layer and the regression roster-join fell back to matching on
 *   normalised NAMES, which works until two players share one.
 *
 * The bridge to fix all of it was already in the schema — `players.gsis_id` is
 * populated for 8,605 of 8,709 rows — and nothing was reading it. So this is not
 * new data, it is the missing habit: one module, memoised, that every
 * cross-table player lookup goes through.
 */
import { rows } from '../db/index.js';
import { cached, fingerprint } from './compute-cache.js';

/**
 * The full translation table, built once per data change.
 *
 * Fingerprinted on `players` rather than time-based, so a sync rebuilds it and
 * nothing else does.
 */
function table() {
  return cached('player-id-map', fingerprint([{ table: 'players', stamp: 'id' }]), () => {
    const all = rows(
      `SELECT id, name, position, gsis_id, espn_id, sleeper_id FROM players`);
    const byInternal = new Map();
    const byGsis = new Map();
    const byEspn = new Map();
    const bySleeper = new Map();
    // Names are kept as a LAST resort and deliberately record collisions rather
    // than silently keeping the last writer — two players sharing a normalised
    // name is exactly the case a name match gets wrong.
    const byName = new Map();
    const nameCollisions = new Set();

    for (const p of all) {
      byInternal.set(p.id, p);
      if (p.gsis_id) byGsis.set(String(p.gsis_id), p);
      if (p.espn_id != null) byEspn.set(String(p.espn_id), p);
      if (p.sleeper_id != null) bySleeper.set(String(p.sleeper_id), p);
      const n = normalise(p.name);
      if (!n) continue;
      if (byName.has(n)) nameCollisions.add(n);
      else byName.set(n, p);
    }
    return { byInternal, byGsis, byEspn, bySleeper, byName, nameCollisions, count: all.length };
  });
}

/** Lowercase, letters only — "Ja'Marr Chase" and "JaMarr Chase" are one player. */
export function normalise(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * Resolve any identifier to the canonical player row.
 *
 * @param value  an internal id, a GSIS id, an ESPN id, a Sleeper id, or a name
 * @param kind   optional hint. Given one, only that space is consulted, which is
 *   what you want when a value could plausibly be two things — an all-digit
 *   string is a valid internal id AND a valid ESPN id.
 */
export function resolvePlayerId(value, kind = null) {
  if (value == null) return null;
  const t = table();
  const s = String(value);

  if (kind === 'internal') return t.byInternal.get(Number(value)) ?? null;
  if (kind === 'gsis') return t.byGsis.get(s) ?? null;
  if (kind === 'espn') return t.byEspn.get(s) ?? null;
  if (kind === 'sleeper') return t.bySleeper.get(s) ?? null;
  if (kind === 'name') {
    const n = normalise(value);
    // A colliding name resolves to nothing rather than to a coin flip.
    return t.nameCollisions.has(n) ? null : (t.byName.get(n) ?? null);
  }

  // No hint: try the unambiguous spaces first, in order of how distinctive they
  // are. A GSIS id has a fixed shape and cannot be confused with anything else.
  if (/^\d{2}-\d{7}$/.test(s)) return t.byGsis.get(s) ?? null;
  if (t.byInternal.has(Number(value))) return t.byInternal.get(Number(value));
  if (t.byEspn.has(s)) return t.byEspn.get(s);
  if (t.bySleeper.has(s)) return t.bySleeper.get(s);
  const n = normalise(value);
  if (n && !t.nameCollisions.has(n)) return t.byName.get(n) ?? null;
  return null;
}

/** GSIS id for anything resolvable, or null. */
export const toGsis = (value, kind = null) => resolvePlayerId(value, kind)?.gsis_id ?? null;
/** Internal id for anything resolvable, or null. */
export const toInternal = (value, kind = null) => resolvePlayerId(value, kind)?.id ?? null;

/**
 * Build a lookup from one id space to another for a whole list at once.
 *
 * Cheaper and, more importantly, harder to misuse than calling `resolvePlayerId`
 * inside a loop — a caller doing that per row tends to hide the resolution rate,
 * and the resolution rate is the number that reveals a broken join.
 */
export function mapIds(values, { from = null, to = 'internal' } = {}) {
  const out = new Map();
  let resolved = 0;
  for (const v of values ?? []) {
    const p = resolvePlayerId(v, from);
    if (!p) { out.set(v, null); continue; }
    resolved++;
    out.set(v, to === 'gsis' ? p.gsis_id : to === 'espn' ? p.espn_id
      : to === 'sleeper' ? p.sleeper_id : to === 'player' ? p : p.id);
  }
  return {
    map: out, resolved, total: (values ?? []).length,
    rate: (values ?? []).length ? +(resolved / values.length).toFixed(3) : null
  };
}

/**
 * Health of the bridge itself.
 *
 * Worth checking after any sync: a resolution rate that quietly falls is the
 * shape every one of the bugs above had, and none of them raised an error.
 */
export function idCoverage() {
  const t = table();
  return {
    players: t.count,
    with_gsis: t.byGsis.size,
    with_espn: t.byEspn.size,
    with_sleeper: t.bySleeper.size,
    gsis_coverage: t.count ? +(t.byGsis.size / t.count).toFixed(3) : null,
    name_collisions: t.nameCollisions.size,
    colliding_names: [...t.nameCollisions].slice(0, 20),
    note: 'A name match is the last resort and resolves to nothing when two players share one. ' +
      'Every cross-table player lookup should route through this rather than joining raw ids: an ' +
      'integer-to-string join across these spaces returns no rows and no error, which is how three ' +
      'separate features shipped silently broken.'
  };
}
