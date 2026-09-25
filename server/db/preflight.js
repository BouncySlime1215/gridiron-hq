/**
 * Schema repairs that have to happen BEFORE the migration runner, not inside
 * it.
 *
 * server/migrations/027_decision_tape.js widens the execution ledger's status
 * and state vocabularies so an opportunity that never became a bet can record
 * why. SQLite cannot ALTER a CHECK constraint, so the only way to widen one is
 * to rebuild the table — and rebuilding `nfl_execution_opportunities` means
 * dropping it once its rows have been copied into the replacement. With
 * foreign keys enabled, DROP TABLE first performs an implicit DELETE of every
 * row, and each of those deletes fires the ON DELETE CASCADE that
 * `nfl_execution_lifecycle_events` declares against the parent. The cascaded
 * child deletes then reach the lifecycle table's append-only BEFORE DELETE
 * trigger, which does exactly what it was written to do:
 *
 *     lifecycle events are append-only — record a new state instead
 *
 * On a database holding even one lifecycle event that abort takes down the
 * whole migration. runMigrations() is awaited before any route module is
 * imported (server/index.js), so the application then cannot start at all.
 * The evidence itself survives — migrate() rolls its transaction back — but
 * the installation is pinned at 026 and every later boot fails identically.
 *
 * The standard SQLite recipe for a table rebuild is to suspend foreign keys
 * around it, and that recipe is the reason this file exists instead of another
 * numbered migration: `PRAGMA foreign_keys` is silently ignored inside a
 * transaction, and db/index.js's migrate() wraps every migration in
 * BEGIN IMMEDIATE … COMMIT. A migration that "disables" foreign keys and then
 * rebuilds the parent gets the identical abort — with the worse failure mode
 * lurking behind it that on a database whose append-only trigger has gone
 * missing, the cascade succeeds and silently deletes the evidence instead of
 * refusing.
 *
 * A later migration cannot rescue an earlier one that prevents startup either:
 * 030 never gets to run, because 027 aborts first. So the repair has to happen
 * earlier than any migration — here, called from runMigrations() before the
 * first file is applied, outside any transaction, where the pragma still means
 * something.
 *
 * What this deliberately does not do is take over 027's work. It performs the
 * one rebuild 027 cannot safely perform for itself, and stops. 027 already
 * guards each of its rebuilds by reading the stored schema back, so it finds
 * that half already done and skips it, then adds `decision_event_id` and
 * rebuilds the lifecycle child exactly as it does on a fresh database
 * (dropping a child table cascades into nothing, so that half was always
 * safe). A database repaired here and a database created from scratch end at
 * the same schema.
 *
 * Repairs are versioned the way migrations are: a name is allocated once,
 * never renumbered, appended to REPAIRS below, and every application is
 * recorded in `schema_preflight`. Unlike a migration, though, the recorded row
 * is an audit trail rather than the decision — each repair re-inspects the
 * live schema on every boot and does nothing unless that schema still shows
 * the damage. That is what makes running this on every startup free and safe,
 * including on installations already past 027 and on ones that have never had
 * these tables at all.
 */

import { inspectWithdrawn, widenTradeOutcomesStatus } from './trade-outcomes-withdrawn.js';

const OPPORTUNITY_TABLE = 'nfl_execution_opportunities';
const LIFECYCLE_TABLE = 'nfl_execution_lifecycle_events';
const REBUILD_TABLE = 'nfl_execution_opportunities_preflight_027';

export const OPPORTUNITY_CASCADE_REPAIR = 'preflight_027_execution_opportunity_cascade';
export const TRADE_OUTCOMES_WITHDRAWN_REPAIR = 'preflight_105_trade_outcomes_withdrawn';

/** The vocabulary 027 widens `status` to. Kept here in full so the rebuilt table is byte-comparable with 027's own. */
const STATUS_VOCABULARY = ['offered', 'observed', 'decision', 'refreshed', 'accepted', 'settled',
  'passed', 'expired', 'cancelled'];

/**
 * Every column `nfl_execution_opportunities` can legitimately have at the
 * moment this repair runs: 023's original set plus 026's three forecast
 * columns. An installation can be at 023, 024, 025 or 026 when it first boots
 * into this repair, so the rebuild copies the intersection of this list with
 * what the table actually has rather than assuming any particular one — and
 * refuses outright, below, if the table carries a column this list has never
 * heard of, because silently dropping an unrecognized column is precisely the
 * kind of quiet evidence loss the repair exists to prevent.
 *
 * `decision_event_id` is absent on purpose. 027 adds it, by ALTER, only after
 * it has created `nfl_decision_events` for it to reference; adding it here
 * would leave a foreign key pointing at a table that does not exist yet, and
 * every insert into the ledger would fail in the window between this repair
 * and that migration.
 */
const OPPORTUNITY_COLUMNS = [
  ['id', `TEXT PRIMARY KEY`],
  ['created_at', `TEXT NOT NULL DEFAULT (datetime('now'))`],
  ['contract_key', `TEXT NOT NULL`],
  ['contract_hash', `TEXT`],
  ['event_key', `TEXT`],
  ['matchup', `TEXT`],
  ['market', `TEXT NOT NULL`],
  ['side', `TEXT NOT NULL`],
  ['participant', `TEXT`],
  ['decision_source', `TEXT NOT NULL`],
  ['status', `TEXT NOT NULL DEFAULT 'offered'\n    CHECK(status IN (${STATUS_VOCABULARY.map(s => `'${s}'`).join(',')}))`],
  ['note', `TEXT`],
  ['model_line', `REAL`],
  ['model_probability', `REAL`],
  ['market_line_at_decision', `REAL`],
];

const objectSql = (database, name) =>
  database.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(name)?.sql ?? '';

const countRows = (database, table) =>
  database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;

/**
 * Is this database about to walk into the cascade abort?
 *
 * Four things have to be true at once, and all four are read from the live
 * schema rather than from schema_migrations: the ledger exists, its parent has
 * not been widened yet, the child still declares the cascading reference, and
 * the child actually holds rows for that cascade to take. Reading the schema
 * instead of the migration log means this also covers an installation that is
 * already past 027 but somehow never got the rebuild — and means a healthy
 * database answers "nothing to do" in three cheap catalogue queries.
 *
 * Note what is NOT in the predicate: whether the append-only trigger is still
 * installed. A database missing that trigger is in more danger, not less —
 * there the cascade does not abort, it quietly deletes the lifecycle evidence
 * and the migration reports success. The repair has to run in both cases.
 */
function inspectOpportunityCascade(database) {
  const parentSql = objectSql(database, OPPORTUNITY_TABLE);
  const childSql = objectSql(database, LIFECYCLE_TABLE);
  if (!parentSql || !childSql) return null;
  if (STATUS_VOCABULARY.every(status => parentSql.includes(`'${status}'`))) return null;
  if (!new RegExp(`REFERENCES\\s+${OPPORTUNITY_TABLE}`, 'i').test(childSql)) return null;
  const events = countRows(database, LIFECYCLE_TABLE);
  if (!events) return null;
  return { opportunities: countRows(database, OPPORTUNITY_TABLE), lifecycle_events: events };
}

/**
 * The rebuild itself, run with foreign keys suspended and inside a
 * transaction the caller owns.
 *
 * Indexes and triggers attached to the parent are read out of sqlite_master
 * first and replayed verbatim afterwards, because dropping a table drops
 * everything attached to it. Replaying the stored SQL rather than a hardcoded
 * list means an installation that has picked up an extra index keeps it.
 *
 * The copy is verified before the original is dropped — matching row counts,
 * and set difference in both directions across every copied column, which is
 * the strongest statement available in SQL that the two tables hold the same
 * rows. Anything unexpected throws, the caller rolls back, and the
 * installation is left exactly as it was rather than half-rebuilt.
 */
function rebuildOpportunityParent(database) {
  const present = database.prepare(`PRAGMA table_info(${OPPORTUNITY_TABLE})`).all().map(column => column.name);
  const unknown = present.filter(name => !OPPORTUNITY_COLUMNS.some(([column]) => column === name));
  if (unknown.length) {
    throw new Error(`${OPPORTUNITY_TABLE} carries column(s) this repair cannot preserve: ${unknown.join(', ')}. `
      + `Refusing rather than rebuilding the table without them.`);
  }
  const columns = OPPORTUNITY_COLUMNS.filter(([column]) => present.includes(column));
  const names = columns.map(([column]) => column).join(', ');
  const carried = database.prepare(`SELECT type, name, sql FROM sqlite_master
    WHERE tbl_name = ? AND sql IS NOT NULL AND type IN ('index', 'trigger')`).all(OPPORTUNITY_TABLE);

  database.exec(`CREATE TABLE ${REBUILD_TABLE} (\n${columns.map(([column, declaration]) => `  ${column} ${declaration}`).join(',\n')}\n)`);
  database.exec(`INSERT INTO ${REBUILD_TABLE} (${names}) SELECT ${names} FROM ${OPPORTUNITY_TABLE} ORDER BY rowid`);

  const original = countRows(database, OPPORTUNITY_TABLE);
  const copied = countRows(database, REBUILD_TABLE);
  const difference = database.prepare(`SELECT
      (SELECT COUNT(*) FROM (SELECT ${names} FROM ${OPPORTUNITY_TABLE}
        EXCEPT SELECT ${names} FROM ${REBUILD_TABLE})) AS lost,
      (SELECT COUNT(*) FROM (SELECT ${names} FROM ${REBUILD_TABLE}
        EXCEPT SELECT ${names} FROM ${OPPORTUNITY_TABLE})) AS invented`).get();
  if (original !== copied || difference.lost || difference.invented) {
    throw new Error(`rebuilt ${OPPORTUNITY_TABLE} does not match the original `
      + `(${original} rows in, ${copied} out, ${difference.lost} lost, ${difference.invented} invented)`);
  }

  database.exec(`DROP TABLE ${OPPORTUNITY_TABLE}`);
  database.exec(`ALTER TABLE ${REBUILD_TABLE} RENAME TO ${OPPORTUNITY_TABLE}`);
  for (const object of carried) database.exec(object.sql);

  // Scoped to the child on purpose. A whole-database foreign_key_check on a
  // real installation can surface long-standing violations in tables this
  // repair never touched, and refusing to start over one of those would be a
  // new outage rather than a fix.
  const violations = database.prepare(`PRAGMA foreign_key_check(${LIFECYCLE_TABLE})`).all();
  if (violations.length) {
    throw new Error(`${LIFECYCLE_TABLE} lost its link to ${OPPORTUNITY_TABLE} during the rebuild: `
      + `${violations.length} orphaned event(s)`);
  }
  return {
    opportunities: copied,
    lifecycle_events: countRows(database, LIFECYCLE_TABLE),
    carried_objects: carried.map(object => object.name),
  };
}

const REPAIRS = [{
  name: OPPORTUNITY_CASCADE_REPAIR,
  inspect: inspectOpportunityCascade,
  summarize: finding => `widening ${OPPORTUNITY_TABLE}.status ahead of 027 so its rebuild cannot cascade into `
    + `${finding.lifecycle_events} append-only lifecycle event(s)`,
  run: rebuildOpportunityParent,
}, {
  // #409: trade_outcomes.status gains 'withdrawn'. trade_outcomes is a foreign-key parent, so
  // an existing database is rebuilt here, with foreign keys suspended (trade-outcomes-withdrawn.js).
  name: TRADE_OUTCOMES_WITHDRAWN_REPAIR,
  inspect: inspectWithdrawn,
  summarize: finding => `widening ${finding.table}.status with 'withdrawn' (${finding.rows} row(s) copied through)`,
  run: database => widenTradeOutcomesStatus(database),
}];

function ensureLedger(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_preflight (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now')),
    detail_json TEXT
  )`);
}

/**
 * Turn foreign keys off and hand back the function that puts them back the way
 * they were.
 *
 * The read-back is not defensive noise: it is the only way to find out that
 * this was called inside an open transaction, where SQLite accepts the pragma
 * and ignores it. Every guarantee below depends on the enforcement actually
 * being off, so a repair that discovers it is still on must refuse loudly
 * instead of proceeding into a cascade.
 */
function suspendForeignKeys(database) {
  const enabled = database.prepare('PRAGMA foreign_keys').get()?.foreign_keys ? 1 : 0;
  database.exec('PRAGMA foreign_keys = OFF');
  if (database.prepare('PRAGMA foreign_keys').get()?.foreign_keys) {
    throw new Error('preflight refused: foreign keys could not be suspended, which means this ran inside an '
      + 'open transaction, where PRAGMA foreign_keys is silently ignored. Preflight repairs must run before '
      + 'any transaction is opened.');
  }
  return () => database.exec(`PRAGMA foreign_keys = ${enabled ? 'ON' : 'OFF'}`);
}

/** Which versioned repairs this database currently needs. Pure inspection: it writes nothing. */
export function planPreflightRepairs(database) {
  const planned = [];
  for (const repair of REPAIRS) {
    const finding = repair.inspect(database);
    if (finding) planned.push({ name: repair.name, summary: repair.summarize(finding), finding, run: repair.run });
  }
  return planned;
}

/**
 * Apply planned repairs, each in its own transaction, with foreign keys
 * suspended for the duration and restored however it ends.
 *
 * Each repair commits separately and on purpose. A repair is a pure widening —
 * it adds permitted values and copies every row through unchanged — so a
 * committed repair followed by a failed migration leaves a database that is
 * still correct, still complete, and one restart away from finishing. Rolling
 * the repair back alongside an unrelated migration failure would only
 * guarantee the same cascade abort on the next boot.
 */
export function applyPreflightRepairs(database, repairs = planPreflightRepairs(database)) {
  if (!repairs.length) return [];
  ensureLedger(database);
  const restoreForeignKeys = suspendForeignKeys(database);
  const applied = [];
  try {
    for (const repair of repairs) {
      console.log(`[db] preflight ${repair.name}: ${repair.summary}`);
      database.exec('BEGIN IMMEDIATE');
      try {
        const detail = repair.run(database, repair.finding);
        database.prepare(`INSERT INTO schema_preflight (name, detail_json) VALUES (?, ?)`)
          .run(repair.name, JSON.stringify({ ...repair.finding, ...detail }));
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw new Error(`preflight ${repair.name} failed and was rolled back: ${error.message}`, { cause: error });
      }
      console.log(`[db] preflight ${repair.name}: done`);
      applied.push(repair.name);
    }
  } finally {
    restoreForeignKeys();
  }
  return applied;
}
