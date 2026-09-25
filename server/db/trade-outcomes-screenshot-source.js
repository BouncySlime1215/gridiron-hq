/**
 * SCREENSHOT-OFFERS: trade_outcomes.source may be 'observed_screenshot'.
 *
 * An offer read off an ESPN screenshot posted in the league chat (scripts/chat/
 * screenshot_offers.py parses it on this Mac; scripts/chat/feed_screenshot_offers.mjs
 * records it through trade-outcomes.js#recordScreenshotOffer). It is neither 'observed'
 * (that source promises an ESPN tx id, and 067's CHECK enforces it) nor 'app_proposed'
 * (that one promises a prediction recorded when it was made). A screenshot row has
 * neither, so it gets its own source and a reader that wants only one kind can say so.
 *
 * Same mechanics as 105 (server/db/trade-outcomes-withdrawn.js), for the same reason:
 * SQLite cannot ALTER a CHECK, and trade_outcomes is a foreign-key PARENT, so an existing
 * database is widened by the preflight repair (FK suspended, outside any transaction)
 * and a fresh one by migration 108. Every row, column, index and trigger is copied
 * through unchanged; only the source list gains one value.
 */

export const TABLE = 'trade_outcomes';
export const SCREENSHOT_SOURCE = 'observed_screenshot';
const REBUILD = 'trade_outcomes_rebuild_108';
const SOURCE_LIST = /(CHECK\s*\(\s*source\s+IN\s*\([^)]*'considered_only')(\s*\))/;

const tableSql = database =>
  database.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(TABLE)?.sql ?? null;

/** True when trade_outcomes exists and its source CHECK already allows 'observed_screenshot'. */
export function allowsScreenshotSource(database) {
  const sql = tableSql(database);
  return !!sql && sql.includes(`'${SCREENSHOT_SOURCE}'`);
}

/** Null when nothing to do; else what the widening would change. Pure inspection. */
export function inspectScreenshotSource(database) {
  const sql = tableSql(database);
  if (!sql || sql.includes(`'${SCREENSHOT_SOURCE}'`)) return null;
  if (!SOURCE_LIST.test(sql)) return null; // an unrecognised shape is never guessed at
  return { table: TABLE, rows: database.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get().n };
}

/**
 * Rebuild trade_outcomes with 'observed_screenshot' in its source CHECK. The caller owns
 * the transaction (and, on a database with child rows, has suspended foreign keys).
 */
export function widenTradeOutcomesSource(database) {
  const sql = tableSql(database);
  if (!sql || sql.includes(`'${SCREENSHOT_SOURCE}'`)) return { widened: false, rows: 0 };
  if (!SOURCE_LIST.test(sql)) throw new Error('trade_outcomes source CHECK has an unrecognised shape; not rebuilt');
  const newSql = sql.replace(SOURCE_LIST, `$1, '${SCREENSHOT_SOURCE}'$2`)
    .replace(/^CREATE TABLE\s+(IF NOT EXISTS\s+)?("?)trade_outcomes\2/i, `CREATE TABLE ${REBUILD}`);
  const extras = database.prepare(`SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL`)
    .all(TABLE).map(r => r.sql);
  const cols = database.prepare(`PRAGMA table_info(${TABLE})`).all().map(c => `"${c.name}"`).join(', ');
  const before = database.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get().n;
  const seq = database.prepare(`SELECT seq FROM sqlite_sequence WHERE name = ?`).get(TABLE)?.seq ?? null;
  database.exec(`DROP TABLE IF EXISTS ${REBUILD}`);
  database.exec(newSql);
  database.exec(`INSERT INTO ${REBUILD} (${cols}) SELECT ${cols} FROM ${TABLE}`);
  database.exec(`DROP TABLE ${TABLE}`);
  database.exec(`ALTER TABLE ${REBUILD} RENAME TO ${TABLE}`);
  for (const s of extras) database.exec(s);
  // AUTOINCREMENT: ids never go backwards, so an id a child row once pointed at is never reused.
  if (seq != null) {
    database.prepare(`UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?`).run(seq, TABLE);
  }
  const after = database.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get().n;
  if (after !== before) throw new Error(`trade_outcomes rebuild copied ${after} of ${before} rows`);
  return { widened: true, rows: after };
}
