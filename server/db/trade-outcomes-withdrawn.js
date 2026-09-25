/**
 * LEDGER-BACKFILL follow-up (#409 review finding 1): trade_outcomes gets a
 * 'withdrawn' status.
 *
 * Before, a proposal the PROPOSER took back (an ESPN CANCEL by a member, not
 * ESPN's TradeTaskProcessor expiry) was written 'expired', because migration
 * 067's CHECK has no 'withdrawn'. Coach reads Nick's 'expired' rows as the
 * other manager's silence (coach/brief-inputs.js OUTCOME_REPLY) and E2 grades
 * 'expired' as a "no" (eval/e2.js OUTCOME): a withdrawal fed both a false
 * signal. 'withdrawn' is read by neither, so it is not a reply at all.
 *
 * SQLite cannot ALTER a CHECK, so widening it means rebuilding the table, and
 * trade_outcomes is a foreign-key PARENT (campaign_steps, negotiation_threads).
 * A rebuild with child rows present aborts inside a migration's transaction
 * (PRAGMA foreign_keys is ignored there; see server/db/preflight.js). So:
 *   - on an existing database, the preflight repair (FK suspended, before any
 *     migration) widens it;
 *   - on a fresh database the table is created by 067 after preflight, so
 *     migration 105 widens it, which is safe there because no child row exists
 *     yet. If one does, 105 leaves it for the next boot's preflight.
 * Both call widenTradeOutcomesStatus below, so both end at the same schema.
 * Every row, column, index and trigger is copied through unchanged.
 */

export const TABLE = 'trade_outcomes';
export const WITHDRAWN = 'withdrawn';
const REBUILD = 'trade_outcomes_rebuild_105';
const STATUS_LIST = /(CHECK\s*\(\s*status\s+IN\s*\([^)]*'not_proposed')(\s*\))/;

const tableSql = database =>
  database.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(TABLE)?.sql ?? null;

/** True when trade_outcomes exists and its status CHECK already allows 'withdrawn'. */
export function allowsWithdrawn(database) {
  const sql = tableSql(database);
  return !!sql && /'withdrawn'/.test(sql);
}

/** Null when nothing to do; else what the widening would change. Pure inspection. */
export function inspectWithdrawn(database) {
  const sql = tableSql(database);
  if (!sql || /'withdrawn'/.test(sql)) return null;
  if (!STATUS_LIST.test(sql)) return null; // an unrecognised shape is never guessed at
  return { table: TABLE, rows: database.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get().n };
}

/** Rows in other tables that reference trade_outcomes (a rebuild with FKs on would abort on them). */
export function childRows(database) {
  const children = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%REFERENCES trade_outcomes%'`).all();
  let n = 0;
  for (const { name } of children) n += database.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n;
  return n;
}

/**
 * Rebuild trade_outcomes with 'withdrawn' in its status CHECK. The caller owns
 * the transaction (and, on a database with child rows, has suspended foreign keys).
 */
export function widenTradeOutcomesStatus(database) {
  const sql = tableSql(database);
  if (!sql || /'withdrawn'/.test(sql)) return { widened: false, rows: 0 };
  if (!STATUS_LIST.test(sql)) throw new Error('trade_outcomes status CHECK has an unrecognised shape; not rebuilt');
  const newSql = sql.replace(STATUS_LIST, `$1, '${WITHDRAWN}'$2`)
    .replace(/^CREATE TABLE\s+(IF NOT EXISTS\s+)?("?)trade_outcomes\2/i, `CREATE TABLE ${REBUILD}`);
  const extras = database.prepare(`SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL`)
    .all(TABLE).map(r => r.sql);
  const cols = database.prepare(`PRAGMA table_info(${TABLE})`).all().map(c => `"${c.name}"`).join(', ');
  const before = database.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get().n;
  database.exec(`DROP TABLE IF EXISTS ${REBUILD}`);
  database.exec(newSql);
  database.exec(`INSERT INTO ${REBUILD} (${cols}) SELECT ${cols} FROM ${TABLE}`);
  database.exec(`DROP TABLE ${TABLE}`);
  database.exec(`ALTER TABLE ${REBUILD} RENAME TO ${TABLE}`);
  for (const s of extras) database.exec(s);
  const after = database.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get().n;
  if (after !== before) throw new Error(`trade_outcomes rebuild copied ${after} of ${before} rows`);
  return { widened: true, rows: after };
}
