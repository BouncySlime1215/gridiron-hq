/**
 * Loads the precomputed TeamRankings power-rating lookup
 * (`scripts/export-teamrankings-features.mjs`) into a Map keyed by
 * `season|week|home`, so `nfl-ensemble.js`'s synchronous `predict(ctx)` loop
 * can read a plain number instead of touching the live research database.
 * `componentPredictionStream` calls every component in a tight loop across
 * the entire historical replay with no `await` anywhere in it -- reading a
 * database per game there would turn one joint-fit call into thousands of
 * queries against a database this app does not even own a write connection
 * to (the ratings live in the read-only fantasy-football-dashboard research
 * DB, not `server/data.sqlite`).
 *
 * Mirrors `nfl-market-correction-lookup.js` exactly in shape: same
 * `DEFAULT_LOOKUP_PATH` convention, same env override, same never-throws
 * loader, same `null`-means-abstain lookup function.
 *
 * `research_only`: this is exactly what feeds the `teamrankings_predictive`
 * `challengerOnly` component in `nfl-ensemble.js`'s `MODELS` list (once that
 * entry is added -- this file does not add it), structurally excluded from
 * every live-blended pick until explicitly promoted.
 *
 * WHY EACH ENTRY IS ALREADY A DIFFERENCE, NOT TWO RATINGS. The export script
 * resolves each team's admissible rating (the most recent week strictly
 * before the game's own week -- see that script's header for why the game's
 * own week is not used) and subtracts before writing the entry, exactly the
 * way `market-correction-lookup.json`'s entries are already a single margin
 * value keyed by `season|week|home` rather than two raw numbers. This module
 * never re-derives a difference itself; it only reads the one that was
 * computed offline.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from '../platform/paths.js';

const DEFAULT_LOOKUP_PATH = path.join(DATA_ROOT, 'research', 'teamrankings-lookup.json');

/**
 * `GRIDIRON_TEAMRANKINGS_LOOKUP` overrides the file, for the same isolation
 * reason `GRIDIRON_MARKET_CORRECTION_LOOKUP` exists: a real export keyed by
 * real team codes across real seasons would otherwise collide with the
 * synthetic ensemble fixture's key space in any fixture-based test.
 * `test/offline-guard.mjs` defaults this to a path that does not exist for
 * every test run; a test that wants a lookup writes its own scratch file and
 * points here at it.
 */
export function lookupPath() {
  return process.env.GRIDIRON_TEAMRANKINGS_LOOKUP || DEFAULT_LOOKUP_PATH;
}

let _cache = null;

/**
 * @returns {{map: Map<string, number>, meta: object|null}} `meta` is null
 *   when no export has ever been run or the file is unreadable/corrupt --
 *   the caller reads an empty map and every lookup returns `null` (abstain),
 *   exactly like every other missing-evidence component in
 *   `nfl-ensemble.js`. This never throws.
 */
export function loadTeamrankingsLookup() {
  if (_cache) return _cache;
  const map = new Map();
  let meta = null;
  try {
    const payload = JSON.parse(fs.readFileSync(lookupPath(), 'utf8'));
    meta = {
      schema: payload.schema, source: payload.source,
      db_path: payload.db_path, min_season: payload.min_season,
      through_season: payload.through_season,
      games: payload.games, entries_with_rating: payload.entries_with_rating,
    };
    for (const e of payload.entries ?? []) {
      if (e.rating_diff == null) continue;
      map.set(`${e.season}|${e.week}|${e.home}`, e.rating_diff);
    }
  } catch {
    // No export yet, or an unreadable/corrupt file -- abstain everywhere
    // rather than throwing.
  }
  _cache = { map, meta };
  return _cache;
}

/** `null` means no admissible prior-week rating for one or both teams --
 * missing evidence, never a guessed number. */
export function teamrankingsRatingDiff(season, week, home) {
  const { map } = loadTeamrankingsLookup();
  return map.get(`${season}|${week}|${home}`) ?? null;
}

export function clearTeamrankingsLookupCache() { _cache = null; }
