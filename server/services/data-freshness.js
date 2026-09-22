import { db as defaultDb } from '../db/index.js';
import * as registry from './source-registry.js';

/**
 * Whether the data the app serves is actually current — read from the tables
 * themselves, not from the sync log.
 *
 * This exists because the light it replaces read the wrong thing. The old
 * `/model/setup-status` banner checked `last_status === 'never run'` on each
 * source: did the job ever run. A job that ran once and wrote zero rows for the
 * season being played is not "never run", so the app reported healthy while
 * `player_week_usage` held 2021-2025 and nothing for 2026. A live connection is
 * not freshness; a row for the current week is.
 *
 * So each served table gets exactly one verdict, from its own rows:
 *
 *   - `empty` — the table holds nothing, or is not present in this database.
 *   - `stale` — it holds rows, but none satisfy its current-data rule.
 *   - `fresh` — at least one row satisfies the rule.
 *
 * `stale` and `empty` are deliberately different: 2021-2025 with no 2026 is a
 * pipeline that stopped, an empty table is one that never started, and a "data
 * healthy" light that collapses them tells you nothing about which to fix.
 *
 * ## The registry, and where its SQL comes from
 *
 * Each entry is developer-authored, from `source-registry.js`'s `servedTables()`
 * once the data thread exports it, and until then from `FALLBACK_REGISTRY`
 * below. An entry carries a plain sentence for the panel and a WHERE fragment
 * with `?` placeholders; the placeholder VALUES (season, week) are bound, never
 * interpolated. The table and column NAMES are the only identifiers that reach
 * the SQL text, they come only from this code registry, and they are validated
 * against an identifier pattern regardless — so an entry that ever carried
 * `x; DROP TABLE y` is rejected before it runs rather than trusted because "the
 * registry is ours". No string-built SQL from a value; no identifier that is
 * not a bare identifier.
 */

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STATUSES = ['fresh', 'stale', 'empty'];

function ident(name, role) {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    throw new Error(`data-freshness: ${role} "${name}" is not a bare SQL identifier`);
  }
  return name;
}

/** Resolve a rule's bind names to the request's context values, in order. */
function bindValues(bind, { currentSeason, currentWeek }) {
  const map = { season: currentSeason, week: currentWeek };
  return bind.map(name => {
    if (!(name in map)) throw new Error(`data-freshness: rule binds unknown value "${name}"`);
    return map[name];
  });
}

/**
 * One table's freshness. Pure over its inputs: takes the database and the
 * current season/week so a test can pin "today" without the wall clock.
 */
export function tableFreshness(entry, { currentSeason, currentWeek, database = defaultDb }) {
  const table = ident(entry.table, 'table');
  const rule = entry.current_rule ?? {};
  const bind = Array.isArray(rule.bind) ? rule.bind : [];
  const predicate = String(rule.predicate ?? '');
  const placeholders = (predicate.match(/\?/g) ?? []).length;
  if (placeholders !== bind.length) {
    throw new Error(`data-freshness: ${table} rule has ${placeholders} placeholders but binds ${bind.length} values`);
  }

  const base = {
    table,
    label: entry.label ?? table,
    row_count: 0,
    earliest: null,
    latest: null,
    last_write: null,
    current_rule: rule.description ?? null,
    status: 'empty',
    note: null
  };

  // A table that is not in this database is a real answer (empty, with why),
  // not an exception to swallow. Anything else that the reads throw is a fault
  // and is allowed to propagate — a freshness check that hid a broken query
  // would be the silent-catch bug this whole feature exists to end.
  const present = database.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  if (!present) return { ...base, note: 'table not present in this database' };

  base.row_count = database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  if (base.row_count === 0) return base;

  // Order by a real timestamp when the table has one, else by the season
  // column, so "earliest/latest" means the same thing the panel shows.
  const orderCol = entry.updated_col ? ident(entry.updated_col, 'updated_col')
    : entry.season_col ? ident(entry.season_col, 'season_col') : null;
  if (orderCol) {
    const span = database.prepare(
      `SELECT MIN(${orderCol}) AS lo, MAX(${orderCol}) AS hi FROM ${table}`).get();
    base.earliest = span.lo;
    base.latest = span.hi;
  }
  if (entry.updated_col) {
    base.last_write = database.prepare(
      `SELECT MAX(${ident(entry.updated_col, 'updated_col')}) AS w FROM ${table}`).get().w ?? null;
  }

  const currentCount = predicate
    ? database.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${predicate}`)
        .get(...bindValues(bind, { currentSeason, currentWeek })).n
    : base.row_count;
  base.status = currentCount > 0 ? 'fresh' : 'stale';
  return base;
}

/** Freshness for every entry in a registry. */
export function dataFreshness({ registry: reg = servedTablesRegistry(), currentSeason, currentWeek, database = defaultDb }) {
  return reg.map(entry => tableFreshness(entry, { currentSeason, currentWeek, database }));
}

/**
 * The single entry the acceptance criterion is written against, live until the
 * data thread's `servedTables()` lands. It MUST report not-fresh on today's
 * data: `player_week_usage` has no rows for the current season.
 */
export const FALLBACK_REGISTRY = [
  {
    table: 'player_week_usage',
    label: 'Weekly player usage',
    season_col: 'season',
    week_col: 'week',
    updated_col: null,
    current_rule: {
      description: 'Has weekly usage rows for the season being played, up to the current week.',
      predicate: 'season = ? AND week <= ?',
      bind: ['season', 'week']
    }
  }
];

/**
 * The served-table registry to measure. Prefers `servedTables()` from
 * source-registry.js once the data thread exports it (a non-empty array of the
 * entry shape above); falls back to the single-entry registry until then, so
 * the light is honest on day one rather than waiting for the full list.
 */
export function servedTablesRegistry() {
  const supplied = typeof registry.servedTables === 'function' ? registry.servedTables() : null;
  return Array.isArray(supplied) && supplied.length > 0 ? supplied : FALLBACK_REGISTRY;
}

export { STATUSES };
