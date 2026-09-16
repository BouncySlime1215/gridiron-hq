/**
 * Loads the precomputed market-correction lookup
 * (`research/betting/nfl/export_market_correction_lookup.py`) into a Map
 * keyed by `season|week|home`, so `nfl-ensemble.js`'s synchronous
 * `predict(ctx)` loop can read a plain number instead of calling Python
 * live. `componentPredictionStream` calls every component in a tight loop
 * across the entire historical replay with no `await` anywhere in it -- a
 * live subprocess call per game there would turn one joint-fit call into
 * thousands of process spawns.
 *
 * `research_only`: this is exactly what feeds the `market_correction_research`
 * `challengerOnly` component in `nfl-ensemble.js`'s `MODELS` list, which is
 * structurally excluded from every live-blended pick
 * (`blendEligible = includeChallengers || !m.challenger_only`, checked at
 * every point the final margin/total/residual blend is assembled) until
 * explicitly promoted. Nothing here can reach a real pick by construction.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from '../platform/paths.js';

const DEFAULT_LOOKUP_PATH = path.join(DATA_ROOT, 'research', 'market-correction-lookup.json');

/**
 * `GRIDIRON_MARKET_CORRECTION_LOOKUP` overrides the file, and it exists for
 * the same reason `GRIDIRON_DB_PATH` does: isolation. The real export holds
 * out-of-fold predictions for 3,044 real games keyed by season|week|home,
 * and 1,278 of those keys collide with the synthetic ensemble fixture's key
 * space (real team codes, 2015-2024). Without an override, every
 * fixture-based ensemble test would silently read real research values for
 * this component -- weight 0 in the live blend, so no pick moves, but
 * `fitEnsemble`'s diagnostics and the rank report would be measuring real
 * data mixed into a synthetic league. `test/offline-guard.mjs` therefore
 * defaults this to a path that does not exist for every test; a test that
 * wants a lookup writes its own scratch file and points here at it.
 */
export function lookupPath() {
  return process.env.GRIDIRON_MARKET_CORRECTION_LOOKUP || DEFAULT_LOOKUP_PATH;
}

let _cache = null;

/**
 * @returns {{map: Map<string, number>, meta: object|null}} `meta` is null
 *   when no export has ever been run or the file is unreadable/corrupt --
 *   the caller reads an empty map and every lookup returns `null`
 *   (abstain), exactly like every other missing-evidence component in
 *   `nfl-ensemble.js`. This never throws.
 */
export function loadMarketCorrectionLookup() {
  if (_cache) return _cache;
  const map = new Map();
  let meta = null;
  try {
    const payload = JSON.parse(fs.readFileSync(lookupPath(), 'utf8'));
    meta = {
      schema: payload.schema, source: payload.source,
      db_path: payload.db_path, min_test_season: payload.min_test_season,
      games_with_correction: payload.games_with_correction,
      weeks_correction_fitted: payload.weeks_correction_fitted,
      weeks_correction_abstained: payload.weeks_correction_abstained,
    };
    for (const e of payload.entries ?? []) {
      map.set(`${e.season}|${e.week}|${e.home}`, e.market_correction_margin);
    }
  } catch {
    // No export yet, or an unreadable/corrupt file -- abstain everywhere
    // rather than throwing.
  }
  _cache = { map, meta };
  return _cache;
}

/** `null` means no out-of-fold prediction exists for this game -- missing
 * evidence, never a guessed number. */
export function marketCorrectionMargin(season, week, home) {
  const { map } = loadMarketCorrectionLookup();
  return map.get(`${season}|${week}|${home}`) ?? null;
}

export function clearMarketCorrectionLookupCache() { _cache = null; }
