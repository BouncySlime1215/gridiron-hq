/**
 * The one place Coach runs a query it wrote itself.
 *
 * Nick's ask is that any question can be asked. Over 215 tables that cannot be
 * done with hand-written tools alone, so the model writes a SELECT — and the
 * moment a model writes SQL against the live database, "the prompt says not to"
 * stops being a control. Three guards, each of which holds on its own:
 *
 *  1. THE CONNECTION IS READ-ONLY. A second DatabaseSync is opened on the same
 *     file with readOnly:true, so SQLite refuses a write at the storage layer
 *     even if every check below were bypassed or buggy.
 *  2. THE STATEMENT IS CHECKED. One statement, SELECT or WITH, over tables the
 *     catalog describes, with no redacted column mentioned anywhere in it. A
 *     table Coach may not read is NAMED in the refusal, so the boundary is
 *     visible instead of looking like an empty result.
 *  3. VALUES ARE BOUND. Parameters only (CLAUDE.md), so a value that looks like
 *     SQL is a value.
 *
 * Which tables a statement reads is not guessed from the text alone: the
 * statement is prepared first and SQLite is asked, via StatementSync#columns(),
 * which real table each output column came from. Aliases and subqueries resolve
 * correctly because SQLite resolved them. A token scan runs beside it to catch
 * a table that is joined but projects no column, and the two are unioned —
 * neither is trusted alone.
 *
 * A refusal and a broken query stay different things. A refusal is policy and
 * retrying it is pointless; a SQLite error is feedback the model can act on by
 * fixing its query. Both throw, with different types, and neither is swallowed
 * (CLAUDE.md: errors are handled or they throw).
 */
import { DatabaseSync } from 'node:sqlite';
import { dbPath } from '../../db/index.js';
import { COACH_TABLES, catalogEntry } from './catalog.js';

/** Policy said no. The model should not retry this query. */
export class CoachQueryRefused extends Error {
  constructor(message) { super(message); this.name = 'CoachQueryRefused'; this.kind = 'policy'; }
}

/** SQLite said no. The model can fix this and try again. */
export class CoachQueryFailed extends Error {
  constructor(message) { super(message); this.name = 'CoachQueryFailed'; this.kind = 'sql'; }
}

/** How many rows a single Coach query may bring back before it is truncated. */
export const DEFAULT_MAX_ROWS = 200;

let connection = null;

/**
 * The read-only connection. Opened lazily, after the main db module has created
 * the file and run migrations, and reopened if the path changes under a test.
 */
export function coachDb() {
  if (connection?.path === dbPath) return connection.db;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  connection = { path: dbPath, db };
  return db;
}

/**
 * Statements that are never a read, plus the two that would widen what a
 * read-only connection can reach: ATTACH brings another database file into
 * scope, PRAGMA reaches the engine rather than the data.
 */
const FORBIDDEN = Object.freeze([
  'insert', 'update', 'delete', 'drop', 'create', 'alter', 'replace', 'attach',
  'detach', 'pragma', 'vacuum', 'reindex', 'analyze', 'begin', 'commit',
  'rollback', 'savepoint', 'release'
]);

/** Identifier-ish tokens, lowercased. Used for table and keyword scanning. */
function tokens(sql) {
  return (sql.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []);
}

/** Strip string literals and comments so their contents never read as SQL. */
function stripped(sql) {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

/**
 * One statement only. A trailing semicolon is fine; a second statement is not.
 * Semicolons inside string literals have already been removed by stripped().
 */
function assertSingleStatement(bare) {
  const trimmed = bare.trim().replace(/;\s*$/, '');
  if (trimmed.includes(';')) {
    throw new CoachQueryRefused('Coach runs one statement at a time; this query contains more than one.');
  }
  return trimmed;
}

function assertReadOnlyShape(statement) {
  const first = tokens(statement)[0];
  if (first !== 'select' && first !== 'with') {
    throw new CoachQueryRefused(
      `Coach may only run SELECT (or WITH ... SELECT); this query starts with "${first ?? '(nothing)'}".`);
  }
  const found = tokens(statement).filter(token => FORBIDDEN.includes(token));
  if (found.length) {
    throw new CoachQueryRefused(
      `Coach may only read; this query uses ${[...new Set(found)].join(', ').toUpperCase()}.`);
  }
}

/** Every catalogued or existing table name the statement's tokens mention. */
function tablesMentioned(statement) {
  const mentioned = new Set();
  const seen = new Set(tokens(statement));
  for (const name of Object.keys(COACH_TABLES)) if (seen.has(name)) mentioned.add(name);
  for (const { name } of coachDb()
    .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view')`).all()) {
    if (seen.has(name)) mentioned.add(name);
  }
  return mentioned;
}

function assertNoRedactedColumn(statement, tables) {
  const seen = new Set(tokens(statement));
  for (const table of tables) {
    const entry = catalogEntry(table);
    if (!entry) continue;
    for (const column of entry.redact) {
      if (seen.has(column.toLowerCase())) {
        throw new CoachQueryRefused(
          `${table}.${column} is withheld from Coach and cannot be selected or filtered on.`);
      }
    }
  }
}

function assertAllReadable(tables) {
  const forbidden = [...tables].filter(name => !Object.hasOwn(COACH_TABLES, name)).sort();
  if (forbidden.length) {
    throw new CoachQueryRefused(
      `Coach does not read ${forbidden.join(', ')}. Readable tables are listed in the catalog; ` +
      'say the answer is not available from what Coach reads rather than working around this.');
  }
}

/**
 * Prepare the statement and ask SQLite which real tables its output columns
 * came from. This is the authoritative half of the table check — it sees
 * through aliases, subqueries and CTEs because SQLite resolved them.
 */
function prepareOrFail(statement) {
  try {
    return coachDb().prepare(statement);
  } catch (e) {
    throw new CoachQueryFailed(explainAbsentTable(e.message));
  }
}

/**
 * SQLite says "no such table: coach_person_variables", which reads to a model
 * exactly like a misspelling — and the model's next move is to apologise and
 * guess a different name. For a table the catalog describes, the truth is
 * different and more useful: the question was fine, the data has not been
 * built on this machine, and something specific builds it. Only catalogued
 * tables get the fuller sentence; an unknown name keeps SQLite's wording,
 * because the creator sentence says something about how this app is put
 * together and an uncatalogued name should learn nothing.
 */
function explainAbsentTable(message) {
  const match = /no such table:\s*([A-Za-z_][A-Za-z0-9_]*)/i.exec(message ?? '');
  const entry = match && catalogEntry(match[1]);
  if (!entry?.created_at_runtime_by) return message;
  return `${match[1]} is in Coach's catalog but has not been built on this machine. `
    + `${entry.created_at_runtime_by}. Say the answer is not available here and what would `
    + 'produce it, rather than trying a different table.';
}

function sourceTables(prepared) {
  let described;
  try { described = prepared.columns(); }
  catch { return { tables: new Set(), columns: [] }; }
  const tables = new Set();
  const columns = [];
  for (const column of described) {
    if (column.table) tables.add(column.table);
    columns.push({ name: column.name, table: column.table ?? null, column: column.column ?? null });
  }
  return { tables, columns };
}

function assertNoRedactedOutput(columns) {
  for (const column of columns) {
    if (!column.table || !column.column) continue;
    const entry = catalogEntry(column.table);
    if (entry?.redact.includes(column.column)) {
      throw new CoachQueryRefused(
        `${column.table}.${column.column} is withheld from Coach and cannot be selected.`);
    }
  }
}

/**
 * Run one read for Coach.
 *
 * @param {string} sql a single SELECT or WITH ... SELECT
 * @param {unknown[]} params bound values, in order
 * @param {{maxRows?: number}} options
 * @returns {{sql:string, params:unknown[], tables:string[], columns:string[],
 *   rows:object[], row_count:number, truncated:boolean, max_rows:number,
 *   provenance:Record<string,{collection:string, freshness:string, grain:string}>}}
 * @throws {CoachQueryRefused} the query is outside what Coach may run
 * @throws {CoachQueryFailed} SQLite rejected the query
 */
export function safeSelect(sql, params = [], { maxRows = DEFAULT_MAX_ROWS } = {}) {
  if (typeof sql !== 'string' || !sql.trim()) {
    throw new CoachQueryRefused('Coach was given no query to run.');
  }
  if (!Array.isArray(params)) {
    throw new CoachQueryRefused('Coach binds parameters as an array, in order.');
  }
  if (!Number.isInteger(maxRows) || maxRows < 1) {
    throw new CoachQueryRefused(`maxRows must be a positive whole number, got ${maxRows}.`);
  }

  const bare = assertSingleStatement(stripped(sql));
  assertReadOnlyShape(bare);
  const mentioned = tablesMentioned(bare);
  assertAllReadable(mentioned);
  assertNoRedactedColumn(bare, mentioned);

  const statement = sql.trim().replace(/;\s*$/, '');
  const prepared = prepareOrFail(statement);
  const { tables: projected, columns } = sourceTables(prepared);
  assertAllReadable(projected);
  assertNoRedactedOutput(columns);

  const tables = [...new Set([...mentioned, ...projected])].sort();
  const out = [];
  let truncated = false;
  try {
    for (const row of prepared.iterate(...params)) {
      if (out.length >= maxRows) { truncated = true; break; }
      out.push({ ...row });
    }
  } catch (e) {
    throw new CoachQueryFailed(e.message);
  }

  const provenance = {};
  for (const table of tables) {
    const entry = catalogEntry(table);
    if (entry) provenance[table] = { collection: entry.collection, freshness: entry.freshness, grain: entry.grain };
  }

  return {
    sql: statement,
    params: [...params],
    tables,
    columns: columns.map(c => c.name),
    rows: out,
    row_count: out.length,
    truncated,
    max_rows: maxRows,
    provenance
  };
}
