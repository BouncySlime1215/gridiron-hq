import { db as defaultDb } from '../db/index.js';
import * as registry from './source-registry.js';
import { MARKET_FRESH_MINUTES } from './dynasty-value-history.js';

// A fixed fragment written in this file (never built from input): the fc_value rows of player_metrics.
const FC_VALUE_SCOPE = "source = 'fc_value'";

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
 *   - `unknown` — the rule could not be asked. NOT a pass.
 *
 * `stale` and `empty` are deliberately different: 2021-2025 with no 2026 is a
 * pipeline that stopped, an empty table is one that never started, and a "data
 * healthy" light that collapses them tells you nothing about which to fix.
 *
 * `unknown` exists for the same reason one layer down. This check used to fall
 * back to `row_count > 0` whenever it could not read a rule, so a table it had
 * never actually asked about reported `fresh` — "I could not ask" and "the
 * answer is yes" came out as the same word. Any table with a row in it passed,
 * and `stale` was unreachable. A check that cannot run says so.
 *
 * ## The registry, and where its SQL comes from
 *
 * Each entry is developer-authored, from `source-registry.js`'s `servedTables()`
 * once the data thread exports it, and until then from `FALLBACK_REGISTRY`
 * below. An entry carries a plain sentence for the panel and a current-data rule
 * in one of two shapes:
 *
 *   - `{ sql, params }` — a complete query returning one truthy/falsy column,
 *     which is what `servedTables()` emits.
 *   - `{ predicate, bind }` — a bare WHERE fragment run against this entry's
 *     table, which is what `FALLBACK_REGISTRY` carries.
 *
 * Both are supported because both ship. The rule TEXT in either shape comes only
 * from this code registry, never from a value; the placeholder VALUES (season,
 * week) are bound by name, never interpolated. The table and column NAMES are
 * the only identifiers this file splices into SQL, and they are validated
 * against an identifier pattern regardless — so an entry that ever carried
 * `x; DROP TABLE y` is rejected before it runs rather than trusted because "the
 * registry is ours". No string-built SQL from a value; no identifier that is
 * not a bare identifier.
 */

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STATUSES = ['fresh', 'stale', 'empty', 'unknown'];

/**
 * The grain vocabulary, taken from `source-registry.js` rather than invented
 * here. Verified on `claude/project-thread-o3wt2p-freshness-evaluator` @
 * e3a8676, `evaluateServedTable` line 623.
 *
 * It is not decoration. Grain decides what the sentence under a behind row
 * says, and these are four different failures: a weekly feed missed a week, a
 * season-grained table has nothing for the season being played, a static table
 * stopped being refreshed at all, and a fit store means a named model is
 * answering on a fallback right now.
 *
 * An entry that states no grain gets `null`, which is the fifth case and the
 * one worth being careful about. This file used to default it to 'feed' — a
 * positive claim on the panel about a table nobody had classified.
 */
const GRAINS = ['week', 'season', 'static', 'fit'];

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

const nonEmpty = v => typeof v === 'string' && v.trim() !== '';

/**
 * Which of the two rule shapes this entry carries, or null for none.
 *
 * null is the load-bearing return: it is what a `{}`, a missing key, or an
 * entry whose shape this file does not recognise comes back as, and the caller
 * turns it into `unknown` rather than into a verdict.
 */
function ruleShape(rule) {
  if (!rule || typeof rule !== 'object') return null;
  if (nonEmpty(rule.sql)) return 'sql';
  if (nonEmpty(rule.predicate)) return 'predicate';
  return null;
}

/**
 * Ask one rule whether the table holds current data. Returns a boolean, or
 * throws — the caller reports a throw as `unknown` with the reason, so one
 * malformed registry entry cannot take the whole panel down with it.
 *
 * The `sql` shape is read as "first column of the first row is truthy", which
 * is what a `CASE WHEN EXISTS (...) THEN 1 ELSE 0 END` query yields. No row at
 * all is false, not an error: a query that matched nothing is a stale table.
 */
function askRule({ shape, rule, table, entry, context, database }) {
  // One contract, one implementation: when the registry exports its own
  // evaluator, that is the definition of the rule and this file defers to it.
  // Feature-detected rather than imported outright, exactly as `servedTables()`
  // is, because the evaluator lands on a different branch than this file and a
  // hard import would make this module unloadable until that one merges. It
  // throws on any rule it cannot run, which is the same contract as below; the
  // caller turns that into `unknown` with the reason.
  if (shape === 'sql' && typeof registry.evaluateServedTable === 'function') {
    return registry.evaluateServedTable(entry, {
      season: context.currentSeason, week: context.currentWeek, database
    }).current;
  }
  if (shape === 'sql') {
    const params = Array.isArray(rule.params) ? rule.params : [];
    const placeholders = (rule.sql.match(/\?/g) ?? []).length;
    if (placeholders !== params.length) {
      throw new Error(`rule has ${placeholders} placeholders but binds ${params.length} values`);
    }
    const row = database.prepare(rule.sql).get(...bindValues(params, context));
    if (!row) return false;
    const first = Object.values(row)[0];
    return Boolean(first);
  }
  const bind = Array.isArray(rule.bind) ? rule.bind : [];
  const n = database.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${rule.predicate}`)
    .get(...bindValues(bind, context)).n;
  return n > 0;
}

/**
 * One table's freshness. Pure over its inputs: takes the database and the
 * current season/week so a test can pin "today" without the wall clock.
 */
export function tableFreshness(entry, { currentSeason, currentWeek, database = defaultDb }) {
  const table = ident(entry.table, 'table');
  const rule = entry.current_rule ?? {};
  const shape = ruleShape(rule);

  // Pre-flight, for the WHERE-fragment shape only: an arity mismatch here is a
  // malformed literal in this file's own FALLBACK_REGISTRY, catchable without
  // touching the database, and it throws so it cannot ship unnoticed. Anything
  // that only fails once the rule RUNS is handled below instead, as a reported
  // fault — a registry arriving from another module must not be able to throw
  // the panel away.
  if (shape === 'predicate') {
    const bind = Array.isArray(rule.bind) ? rule.bind : [];
    const placeholders = (rule.predicate.match(/\?/g) ?? []).length;
    if (placeholders !== bind.length) {
      throw new Error(`data-freshness: ${table} rule has ${placeholders} placeholders but binds ${bind.length} values`);
    }
  }

  const base = {
    table,
    label: entry.label ?? table,
    // grain distinguishes a data feed from a fit-artifact store; reader names
    // the model that consumes a fit. Both are optional passthrough from the
    // registry — a feed leaves them at 'feed'/null. They exist because a
    // feed-only registry has the banner's own bug one layer up: a model can
    // read a stale or wrong-season fit and still answer while its store reads
    // fresh. The VERDICT for a fit store is still coverage, never a timestamp —
    // fresh means a fit exists for the current season, and the fitted_at only
    // populates last_write for display.
    grain: entry.grain ?? null,
    reader: entry.reader ?? null,
    row_count: 0,
    earliest: null,
    latest: null,
    last_write: null,
    current_rule: rule.description ?? rule.text ?? null,
    status: 'empty',
    // Whether the table is in this database at all. `status` folds "absent" into
    // `empty` for the panel; a reader that has to say WHICH absence it is reads this
    // field instead of parsing `note` (tableState below).
    present: false,
    note: null
  };

  // A table that is not in this database is a real answer (empty, with why),
  // not an exception to swallow. Anything else that the reads throw is a fault
  // and is allowed to propagate — a freshness check that hid a broken query
  // would be the silent-catch bug this whole feature exists to end.
  const present = database.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  if (!present) return { ...base, note: 'table not present in this database' };
  base.present = true;

  // `scope`: an optional fixed WHERE fragment from this file's registry, for a table that holds
  // several sources' rows (player_metrics), so the counts and stamps are that source's only.
  const where = typeof entry.scope === 'string' && entry.scope.trim() !== '' ? ` WHERE ${entry.scope}` : '';
  base.row_count = database.prepare(`SELECT COUNT(*) AS n FROM ${table}${where}`).get().n;
  if (base.row_count === 0) return base;

  // Order by a real timestamp when the table has one, else by the season
  // column, so "earliest/latest" means the same thing the panel shows.
  const orderCol = entry.updated_col ? ident(entry.updated_col, 'updated_col')
    : entry.season_col ? ident(entry.season_col, 'season_col') : null;
  if (orderCol) {
    const span = database.prepare(
      `SELECT MIN(${orderCol}) AS lo, MAX(${orderCol}) AS hi FROM ${table}${where}`).get();
    base.earliest = span.lo;
    base.latest = span.hi;
  }
  if (entry.updated_col) {
    base.last_write = database.prepare(
      `SELECT MAX(${ident(entry.updated_col, 'updated_col')}) AS w FROM ${table}${where}`).get().w ?? null;
  }

  // No rule, or one in a shape this file does not know, is a fault and not a
  // verdict. The old code fell through to `row_count > 0` here, which reported
  // `fresh` for a table it had never asked a question about.
  if (shape === null) {
    base.status = 'unknown';
    base.note = 'no usable current-data rule for this table — freshness was not checked';
    return base;
  }

  try {
    base.status = askRule({
      shape, rule, table, entry,
      context: { currentSeason, currentWeek },
      database
    }) ? 'fresh' : 'stale';
  } catch (e) {
    // Reported, never swallowed: the row keeps its counts and says in words that
    // its rule could not be run. Silence here would read as "current" on the
    // panel, which is the bug this module exists to end.
    base.status = 'unknown';
    base.note = `current-data rule could not be evaluated: ${e.message}`;
  }
  return base;
}

/**
 * One table's state, for a READER to carry on the output it already returns: the
 * same verdict as tableFreshness, with the one distinction its `status` folds away
 * made a field.
 *
 *   table_absent  not in this database (nothing ever created it here)
 *   empty         present, zero rows (its writer never ran here)
 *   stale         rows, none satisfying the entry's current-data rule
 *   fresh         at least one row satisfies it
 *   unknown       the rule could not be asked (tableFreshness says why in `note`)
 *
 * Built for the hand-fed fantasy tables (S-18), where a reader that returns an empty
 * collection reads downstream as a fact about football ("not trending", "never
 * reversed") when it is a fact about a writer nobody ran.
 */
export function tableState(entry, { currentSeason = null, currentWeek = null, database = defaultDb } = {}) {
  const f = tableFreshness(entry, { currentSeason, currentWeek, database });
  return {
    table: f.table,
    state: f.present ? f.status : 'table_absent',
    rows: f.row_count,
    last_write: f.last_write,
    rule: f.current_rule
  };
}

/**
 * The hand-fed fantasy tables (S-18): three tables that change only when a person
 * runs something, each read by a product surface that has to say which absence it
 * works from. ONE entry per table, and the served-table registry wins: when
 * source-registry.js exports `servedTables()` with an entry for a table, that entry
 * is the rule (servedTableEntry below) and the one here is dead weight to delete.
 *
 * The roster-snapshot and correlation entries are copied verbatim from that registry
 * as it stands on claude/project-thread-o3wt2p-freshness-evaluator @ e3a86764
 * (source-registry.js:436-447 and :505-517, PR #104), so a reader and the Data Health
 * panel give one verdict on the same input, before and after that PR merges. Both are
 * coverage rules, which is also this module's own contract for a fit store (see
 * `grain` in tableFreshness). The registry has no trending entry: its 2-day window is
 * hand-set (Sleeper looks back 24 hours; #104's news_items uses the same two days)
 * and is the one guess in this list.
 */
export const HAND_FED_ENTRIES = Object.freeze([
  Object.freeze({
    table: 'league_roster_snapshots',
    season_col: 'season', week_col: null, updated_col: null, grain: 'week',
    current_rule: Object.freeze({
      text: 'Roster history is current when this season has at least one '
        + 'snapshot. It is an append-only record, so the question is whether '
        + 'we started collecting this season, not whether it moved today.',
      sql: 'SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS current '
        + 'FROM league_roster_snapshots WHERE season = ?',
      params: Object.freeze(['season'])
    })
  }),
  Object.freeze({
    table: 'correlation_estimates',
    season_col: null, week_col: null, updated_col: 'fitted_at',
    grain: 'fit', fitted_col: 'fitted_at', reader: 'correlation.js',
    current_rule: Object.freeze({
      text: 'Correlations are fitted when estimates exist AND carry a fitted '
        + 'stamp. fitted_at is nullable, so a row written without one is an '
        + 'estimate nobody can date.',
      sql: 'SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS current '
        + 'FROM correlation_estimates WHERE fitted_at IS NOT NULL',
      params: Object.freeze([])
    })
  }),
  Object.freeze({
    table: 'trending_players',
    label: 'Sleeper trending adds and drops',
    season_col: null, week_col: null, updated_col: 'fetched_at', grain: 'week',
    current_rule: Object.freeze({
      description: 'fetched in the last 2 days (Sleeper looks back 24 hours; hand-set window)',
      predicate: "julianday(fetched_at) >= julianday('now', '-2 days')",
      bind: Object.freeze([])
    })
  })
]);

/**
 * The one entry a reader asks about a table: the served-table registry's when it
 * exports one for that table, else HAND_FED_ENTRIES. A table with neither is a
 * developer error, not a state, so it throws.
 */
export function servedTableEntry(table) {
  const entry = servedTablesRegistry().find(e => e?.table === table)
    ?? HAND_FED_ENTRIES.find(e => e.table === table);
  if (!entry) throw new Error(`data-freshness: no served-table entry for "${table}"`);
  return entry;
}

/**
 * tableState for a table by name, from servedTableEntry. The caller supplies the
 * season / week its rule binds, from the producer the Data Health route uses
 * (weekly-learning.js currentNflWeek). A bound value the caller did not supply would
 * bind NULL, match nothing and read `stale`, a claim about the data made from a
 * missing input, so that case is `unknown`.
 */
export function servedTableState(table, { currentSeason = null, currentWeek = null, database = defaultDb } = {}) {
  const entry = servedTableEntry(table);
  const rule = entry.current_rule ?? {};
  const binds = [...(Array.isArray(rule.params) ? rule.params : []), ...(Array.isArray(rule.bind) ? rule.bind : [])];
  const given = { season: currentSeason, week: currentWeek };
  const unsupplied = binds.some(name => name in given && given[name] == null);
  const s = tableState(entry, { currentSeason, currentWeek, database });
  return unsupplied && (s.state === 'fresh' || s.state === 'stale') ? { ...s, state: 'unknown' } : s;
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
    grain: 'week',
    season_col: 'season',
    week_col: 'week',
    updated_col: null,
    current_rule: {
      description: 'Has weekly usage rows for the season being played, up to the current week.',
      predicate: 'season = ? AND week <= ?',
      bind: ['season', 'week']
    }
  },
  // FC-SNAP: the market price every trade card is gated, ranked and labelled on. Its
  // job (scheduler.js fantasycalc_dynasty) runs daily, so the rule is an AGE, not a week:
  // MARKET_FRESH_MINUTES (the daily budget plus the refresh loop's slack), never a second
  // constant. No retired_at filter is needed: a retired row is one the latest pull did not
  // return, so its fetched_at is older than that pull's by construction.
  {
    table: 'dynasty_values',
    label: 'FantasyCalc market values',
    grain: 'static',
    season_col: null,
    week_col: null,
    updated_col: 'fetched_at',
    current_rule: {
      description: `Fetched from FantasyCalc in the last ${MARKET_FRESH_MINUTES / 60} hours.`,
      predicate: `julianday(fetched_at) >= julianday('now', '-${MARKET_FRESH_MINUTES} minutes')`,
      bind: []
    }
  },
  // The redraft half: player_metrics source 'fc_value', the value Nick's hard rules are priced on
  // (fc-value.js, the one reader never-give.js gates every trade surface with). It had no entry, so
  // a stale overpay currency never showed on the panel. Written by the daily fantasycalc_values job
  // (scheduler.js), so the same age rule and window as the market price above.
  {
    table: 'player_metrics',
    label: 'FantasyCalc redraft values (your trade rules)',
    grain: 'static',
    season_col: null,
    week_col: null,
    updated_col: 'fetched_at',
    current_rule: {
      description: `FantasyCalc redraft values fetched in the last ${MARKET_FRESH_MINUTES / 60} hours.`,
      predicate: `${FC_VALUE_SCOPE} AND julianday(fetched_at) >= julianday('now', '-${MARKET_FRESH_MINUTES} minutes')`,
      bind: []
    },
    // player_metrics holds every source's metrics (ADP, Sleeper rank, ...); the counts and the
    // last-write stamp on the panel are this source's only.
    scope: FC_VALUE_SCOPE
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

export { STATUSES, GRAINS };
