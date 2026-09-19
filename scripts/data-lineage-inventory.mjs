/**
 * Mechanized version of "the unused-table sweep" — the single biggest
 * source of new ideas in the September 15-16 data-integrity session, done
 * by hand that time (`nfl_team_feature_vectors`, `nfl_player_feature_vectors`,
 * the 183-key `nfl_team_week_features.features` blob, `nfl_pfr_adv`
 * pass/rec kinds, etc). Nick's concern after that session: "I don't want to
 * suddenly find a pile of unused data again" — this script exists so the
 * next such pile is caught by a scheduled run, not by someone happening to
 * list tables by hand. See docs/betting-model/plans/LATEST-PLAN.md FINAL
 * ORDER #21 and RUNBOOK.md §10.9.
 *
 * WHAT IT CHECKS, two levels:
 *   1. Table-level: every `nfl_%` table in the schema — is its name
 *      referenced anywhere in server/, scripts/, research/, test/? A table
 *      with zero references in server/+scripts/+research/ (test/ alone
 *      does not count as "used") is a candidate for the same kind of find
 *      as `nfl_team_feature_vectors` was.
 *   2. JSON-blob-key-level, for a short hand-maintained list of known blob
 *      columns (`nfl_team_week_features.features`, `nfl_player_week_features.features`,
 *      `nfl_pfr_adv.stats` partitioned by `kind`) — every distinct key
 *      found in a sample of rows, checked the same way. This is the
 *      "JSON-blob-key-diff" item the plan calls out by name (LATEST-PLAN.md,
 *      "The same pattern, found twice more in five more minutes of looking").
 *
 * WHY A PURE-JS WALK, NOT `grep -r`. Keeps this dependency-free and
 * deterministic under `node --test` (a mocked temp source tree, no shelling
 * out). Word-boundary regex (`\b<name>\b`) avoids `nfl_team_week_features`
 * false-matching inside `nfl_team_week_features_v2` — underscores and
 * digits are `\w`, so `\b` will not fall inside a longer identifier that
 * merely starts with the same prefix.
 *
 * FOUR-TIER STATUS, most-concerning first (a name gets exactly one, by the
 * strongest evidence found). **This split exists because the first pilot
 * run against the real extract on 2026-09-16 missed `nfl_team_feature_vectors`/
 * `nfl_player_feature_vectors` under a naive "referenced anywhere = used"
 * rule** — both are referenced only by `server/db/schema/*` (the CREATE
 * TABLE) and by the writer/audit code that builds and displays them, never
 * by anything that computes a prediction, which is exactly the case this
 * script exists to catch:
 *   - `used-in-pick-path` — referenced by `nfl-ensemble.js`, `nfl-auto-picks.js`,
 *     `player-week-engine.js`, OR ANY FILE THEY IMPORT, transitively
 *     (`computeReachableFiles` walks the `import`/`require` graph — a flat
 *     3-file equality check was tried first and wrongly flagged 121/129
 *     tables, including plainly-legitimate execution/audit tables read by
 *     other services in the same request path). See `DEFAULT_PICK_PATH_FILES`,
 *     extend with `--pick-path-file` for a new forecasting entry point. The
 *     only tier that means "the model actually reads this."
 *   - `used-outside-pick-path` — a real reader (audit, display, backfill,
 *     the ingestion writer) but never the pick path. THE finding class.
 *   - `definition-only` — appears only in a `server/db/schema/*` CREATE
 *     TABLE statement; nothing, not even audit code, ever queries it.
 *   - `test-only` / `no-reader` — self-explanatory, worst case.
 * `unusedTables`/`unusedKeys` include everything except `used-in-pick-path`.
 *
 * WHAT IT DOES NOT DO. It does not compute row counts (the live 16GB DB
 * makes COUNT(*) expensive and it's not this script's job) and it does not
 * judge whether a `used-in-pick-path` table is used CORRECTLY — only
 * whether the pick path reads it at all. See the recurring checklist's
 * other items (batch-timestamp, tag-dedup, coverage-trend, duplicate-
 * formula) for that.
 *
 * KNOWN NOISE, measured on the real extract 2026-09-16: 70 of 129 tables
 * came back `used-outside-pick-path` or worse. Reading the list by hand,
 * most are legitimately non-feature infrastructure (execution logs, audit
 * runs, teaser-price ledgers) that was never meant to feed a forecast — a
 * true negative, not a finding. A real minority (`nfl_team_feature_vectors`,
 * `nfl_player_feature_vectors`, `nfl_odds_archive`, `nfl_officials`,
 * `nfl_play_charting`, `nfl_feature_dictionary`) are exactly the class this
 * script exists to catch, and are already FINAL ORDER items (#7, #10, #14,
 * #19). This script does not yet distinguish the two — that would need a
 * curated "candidate feature table" allowlist the way `KNOWN_BLOB_COLUMNS`
 * is curated, not attempted here for time. Read the `.md` report by eye
 * before treating its `unusedTables` list as an action queue.
 *
 * Usage:
 *   node scripts/data-lineage-inventory.mjs \
 *     --db /path/to/read-only-database.sqlite \
 *     --out docs/evidence/2026-09-16/data-lineage-report.json \
 *     [--prev docs/evidence/2026-09-01/data-lineage-report.json] \
 *     [--table-prefix nfl_] \
 *     [--blob-sample 500] \
 *     [--pick-path-file server/services/some-new-forecaster.js ...]
 *
 * The database is ALWAYS opened read-only (`node:sqlite` `DatabaseSync`
 * with `{ readOnly: true }`) — see export-teamrankings-features.mjs for why
 * this must never go through server/db/index.js, which applies this app's
 * own migrations on open.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);

// Known JSON-blob columns worth a key-level diff, hand-maintained because
// discovering "which columns are secretly wide JSON blobs" is itself a
// judgment call — this list grows as the recurring sweep finds more.
export const KNOWN_BLOB_COLUMNS = [
  { table: 'nfl_team_week_features', column: 'features', partitionBy: null },
  { table: 'nfl_player_week_features', column: 'features', partitionBy: null },
  { table: 'nfl_pfr_adv', column: 'stats', partitionBy: 'kind' },
];

const DEFAULT_SOURCE_DIRS = ['server', 'scripts', 'research', 'test'];
const SCAN_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.py']);
const EXCLUDE_DIR_NAMES = new Set([
  'node_modules', '.git', 'dist', 'coverage', '.venv', '__pycache__', 'client',
]);
// Table/schema DEFINITION files: a CREATE TABLE statement is not a read.
// Crediting these as "readers" is exactly how the pilot run on 2026-09-16
// missed `nfl_team_feature_vectors`/`nfl_player_feature_vectors` (both
// referenced only in schema files + the writer that builds them + audit/
// display code, never by anything that computes a prediction) -- fixed by
// splitting "used somewhere" from "used in the pick path" below.
const DEFINITION_ONLY_PATH_FRAGMENTS = [`${path.sep}db${path.sep}schema${path.sep}`];

// The live pick-serving ENTRY POINTS, named in the September 16 plan
// (LATEST-PLAN.md, "Unused-table sweep"). These are only the entry files --
// `computeReachableFiles` below walks their `import`/`require` graph to find
// everything they actually pull in (devig, calibration, contracts, etc), so
// a table read by a module `nfl-ensemble.js` imports transitively still
// counts as pick-path. A hardcoded 3-file EQUALITY check was tried first and
// wrongly flagged 121/129 tables as unused, including plainly-legitimate
// audit/execution-log tables (nfl_bet_log, nfl_execution_log, ...) that are
// correctly read by other services, not these three files directly --
// fixed by reachability instead of exact membership.
export const DEFAULT_PICK_PATH_FILES = [
  'server/services/nfl-ensemble.js',
  'server/services/nfl-auto-picks.js',
  'server/services/player-week-engine.js',
];

const IMPORT_SPEC_RE = /(?:import\s+(?:[^'"]+?\s+from\s+)?|export\s+(?:[^'"]+?\s+from\s+)?|require\s*\(\s*)['"]([^'"]+)['"]/g;

/** Extract relative import/require specifiers ('./x', '../y') from JS source. */
function extractRelativeImports(text) {
  const specs = [];
  let m;
  IMPORT_SPEC_RE.lastIndex = 0;
  while ((m = IMPORT_SPEC_RE.exec(text))) {
    const spec = m[1];
    if (spec.startsWith('.')) specs.push(spec);
  }
  return specs;
}

/** Resolve a relative import specifier to an actual file on disk, or null. */
function resolveImport(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, path.join(base, 'index.js')];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/**
 * BFS over the `import`/`require` graph starting from `entryFiles`, relative
 * specifiers only (bare package imports like 'node:sqlite' are not
 * followed). Returns the Set of absolute file paths reachable from the
 * entry points, entry points themselves included -- "everything that
 * actually runs when a pick gets computed," which is what "pick path" means
 * for this script's purpose. Capped at 2000 files as a runaway backstop;
 * this codebase is nowhere near that from 3 entry points.
 */
export function computeReachableFiles(entryFiles, root) {
  const resolved = entryFiles.map((f) => (path.isAbsolute(f) ? f : path.join(root, f))).filter((f) => fs.existsSync(f));
  const seen = new Set(resolved);
  const queue = [...resolved];
  while (queue.length && seen.size < 2000) {
    const file = queue.shift();
    const text = safeRead(file);
    if (!text) continue;
    for (const spec of extractRelativeImports(text)) {
      const target = resolveImport(file, spec);
      if (target && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return seen;
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Collects every occurrence of a repeatable flag, e.g. multiple --pick-path-file. */
function argAll(name) {
  const out = [];
  for (let i = 0; i < process.argv.length - 1; i += 1) {
    if (process.argv[i] === name) out.push(process.argv[i + 1]);
  }
  return out;
}

function fail(message) {
  console.error(JSON.stringify({ ok: false, reason: message }));
  process.exit(1);
}

/** Recursively list scannable source files under `root` (repo-relative). */
export function walkSourceFiles(root, sourceDirs = DEFAULT_SOURCE_DIRS) {
  const out = [];
  for (const dir of sourceDirs) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    walk(abs);
  }
  return out;

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (EXCLUDE_DIR_NAMES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) {
        out.push(full);
      }
    }
  }
}

/**
 * For each name in `names`, find every file (from `files`) that contains it
 * as a whole word, excluding `excludeFiles` (this script itself, the report
 * output). Returns Map(name -> {
 *   pickPathReaders, otherProdReaders, definitionOnlyReaders, testOnlyReaders
 * }) — four buckets, checked in that priority order per file (a pick-path
 * file that also happens to be under db/schema/ counts as pick-path, etc):
 *   - pickPathReaders: files in `pickPathFiles` (the live forecasting path)
 *   - definitionOnlyReaders: files under `server/db/schema/` — a CREATE
 *     TABLE statement is not a read
 *   - testOnlyReaders: test files (dir literally named "test", or
 *     test_*.py / *.test.js)
 *   - otherProdReaders: everything else (audit/display/backfill code,
 *     ingestion writers) — a real reference, but not evidence the
 *     forecasting path uses it
 */
export function findReaders(names, files, excludeFiles = [], pickPathFiles = DEFAULT_PICK_PATH_FILES) {
  const excludeSet = new Set(excludeFiles.map((f) => path.resolve(f)));
  const pickPathSet = new Set(pickPathFiles.map((f) => path.resolve(f)));
  const contents = files
    .filter((f) => !excludeSet.has(path.resolve(f)))
    .map((f) => ({
      file: f,
      text: safeRead(f),
      isPickPath: pickPathSet.has(path.resolve(f)),
      isDefinitionOnly: isDefinitionFile(f),
      isTest: isTestFile(f),
    }));

  const result = new Map();
  for (const name of names) {
    const re = new RegExp(`\\b${escapeRegExp(name)}\\b`);
    const buckets = { pickPathReaders: [], otherProdReaders: [], definitionOnlyReaders: [], testOnlyReaders: [] };
    for (const { file, text, isPickPath, isDefinitionOnly, isTest } of contents) {
      if (!text || !re.test(text)) continue;
      if (isPickPath) buckets.pickPathReaders.push(file);
      else if (isDefinitionOnly) buckets.definitionOnlyReaders.push(file);
      else if (isTest) buckets.testOnlyReaders.push(file);
      else buckets.otherProdReaders.push(file);
    }
    result.set(name, buckets);
  }
  return result;
}

function isTestFile(file) {
  const base = path.basename(file);
  return file.split(path.sep).includes('test') || /^test_/.test(base) || /\.test\.(js|mjs|cjs)$/.test(base);
}

function isDefinitionFile(file) {
  return DEFINITION_ONLY_PATH_FRAGMENTS.some((frag) => file.includes(frag));
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Status string shared by table-level and key-level entries, most-concerning
 * first. 'used-outside-pick-path' is the specific class of finding this
 * script exists to catch — something with a real prod reader (not just a
 * schema definition, not just a test) that the forecasting path never
 * touches, the same shape as `nfl_team_feature_vectors` on 2026-09-16.
 */
function statusFor({ pickPathReaders, otherProdReaders, definitionOnlyReaders, testOnlyReaders }) {
  if (pickPathReaders.length > 0) return 'used-in-pick-path';
  if (otherProdReaders.length > 0) return 'used-outside-pick-path';
  if (definitionOnlyReaders.length > 0) return 'definition-only';
  if (testOnlyReaders.length > 0) return 'test-only';
  return 'no-reader';
}

const CONCERNING_STATUSES = new Set(['used-outside-pick-path', 'definition-only', 'test-only', 'no-reader']);

export function buildReport({ db, root, tablePrefix = 'nfl_', blobSample = 500, sourceDirs = DEFAULT_SOURCE_DIRS, pickPathFiles = DEFAULT_PICK_PATH_FILES }) {
  const scriptSelf = THIS_FILE;
  const files = walkSourceFiles(root, sourceDirs);
  // Pick-path entries are given relative to the repo root, not CWD — resolve
  // them against `root` explicitly (findReaders' own path.resolve() would
  // otherwise resolve against process.cwd(), silently breaking whenever
  // this is invoked from anywhere but the repo root).
  const resolvedPickPathFiles = pickPathFiles.map((f) => (path.isAbsolute(f) ? f : path.join(root, f)));
  // Walk the import graph from the entry points so a table read by a module
  // the entry points import (devig, calibration, contracts, ...) counts as
  // pick-path too, not just the entry files themselves. Definition-only files
  // (server/db/schema/*) are EXCLUDED even when reachable -- the entry points
  // reach them via the DB-bootstrap import chain (server/db/index.js applying
  // migrations), and a CREATE TABLE statement being reachable is not evidence
  // the pick path reads that table. This was caught by the same pilot run
  // that motivated the definition-only tier in the first place --
  // `nfl_team_feature_vectors`/`nfl_player_feature_vectors` briefly came back
  // as used-in-pick-path this way before this filter was added.
  const reachablePickPathFiles = [...computeReachableFiles(resolvedPickPathFiles, root)]
    .filter((f) => !isDefinitionFile(f));

  const tableRows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ORDER BY name")
    .all(`${tablePrefix}%`);
  const tableNames = tableRows.map((r) => r.name);
  const tableReaders = findReaders(tableNames, files, [scriptSelf], reachablePickPathFiles);

  const tables = tableNames.map((name) => {
    const readers = tableReaders.get(name);
    return { table: name, ...readers, status: statusFor(readers) };
  });

  const blobs = [];
  for (const { table, column, partitionBy } of KNOWN_BLOB_COLUMNS) {
    if (!tableNames.includes(table)) {
      blobs.push({ table, column, error: 'table not present in this database' });
      continue;
    }
    let rows;
    try {
      const sql = partitionBy
        ? `SELECT ${partitionBy} AS partition, ${column} AS blob FROM ${table} WHERE ${column} IS NOT NULL LIMIT ?`
        : `SELECT ${column} AS blob FROM ${table} WHERE ${column} IS NOT NULL LIMIT ?`;
      rows = db.prepare(sql).all(blobSample);
    } catch (exc) {
      blobs.push({ table, column, error: `query failed: ${exc.message}` });
      continue;
    }

    const keysByPartition = new Map(); // partition (or '__all__') -> Set(key)
    let parseFailures = 0;
    for (const row of rows) {
      const partition = partitionBy ? String(row.partition) : '__all__';
      let parsed;
      try {
        parsed = JSON.parse(row.blob);
      } catch {
        parseFailures += 1;
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      if (!keysByPartition.has(partition)) keysByPartition.set(partition, new Set());
      const set = keysByPartition.get(partition);
      for (const key of Object.keys(parsed)) set.add(key);
    }

    for (const [partition, keySet] of keysByPartition) {
      const keys = [...keySet].sort();
      const readers = findReaders(keys, files, [scriptSelf], reachablePickPathFiles);
      const keyEntries = keys.map((key) => {
        const r = readers.get(key);
        return { key, ...r, status: statusFor(r) };
      });
      blobs.push({
        table,
        column,
        partition: partitionBy ? partition : null,
        rowsSampled: rows.filter((r) => (partitionBy ? String(r.partition) === partition : true)).length,
        parseFailures,
        totalKeys: keys.length,
        unusedKeys: keyEntries.filter((k) => CONCERNING_STATUSES.has(k.status)).map((k) => k.key),
        keys: keyEntries,
      });
    }
  }

  const unusedTables = tables.filter((t) => CONCERNING_STATUSES.has(t.status)).map((t) => t.table);
  const unusedBlobKeyCount = blobs.reduce((sum, b) => sum + (b.unusedKeys ? b.unusedKeys.length : 0), 0);

  return {
    generatedNote: 'timestamp intentionally omitted from this pure function; the CLI stamps it before writing',
    tablePrefix,
    tablesScanned: tables.length,
    unusedTables,
    unusedTableCount: unusedTables.length,
    unusedBlobKeyCount,
    tables,
    blobs,
  };
}

function diffAgainstPrev(report, prev) {
  const prevUnusedTables = new Set(prev.unusedTables || []);
  const prevUnusedKeys = new Set();
  for (const b of prev.blobs || []) {
    for (const k of b.unusedKeys || []) prevUnusedKeys.add(`${b.table}.${b.column}${b.partition ? `[${b.partition}]` : ''}.${k}`);
  }
  const currentUnusedKeys = new Set();
  for (const b of report.blobs) {
    for (const k of b.unusedKeys || []) currentUnusedKeys.add(`${b.table}.${b.column}${b.partition ? `[${b.partition}]` : ''}.${k}`);
  }
  return {
    newlyUnusedTables: report.unusedTables.filter((t) => !prevUnusedTables.has(t)),
    nowUsedTables: [...prevUnusedTables].filter((t) => !report.unusedTables.includes(t)),
    newlyUnusedBlobKeys: [...currentUnusedKeys].filter((k) => !prevUnusedKeys.has(k)),
  };
}

function toMarkdown(report, diff) {
  const lines = [];
  lines.push(`# Data lineage inventory — ${report.generatedAt}`);
  lines.push('');
  lines.push(`Scanned ${report.tablesScanned} tables matching \`${report.tablePrefix}%\`.`);
  lines.push(`**${report.unusedTableCount} table(s) with no reader in server/scripts/research** (test-only or none).`);
  lines.push(`**${report.unusedBlobKeyCount} JSON-blob key(s) with no reader**, across ${KNOWN_BLOB_COLUMNS.length} tracked blob columns.`);
  lines.push('');
  if (report.unusedTables.length) {
    lines.push('## Unused tables');
    for (const t of report.unusedTables) {
      const row = report.tables.find((x) => x.table === t);
      const note = row.otherProdReaders.length
        ? ` (referenced outside the pick path by: ${row.otherProdReaders[0]})`
        : row.definitionOnlyReaders.length ? ' (schema definition only)'
        : row.testOnlyReaders.length ? ` (test-only reader: ${row.testOnlyReaders[0]})` : '';
      lines.push(`- \`${t}\` — ${row.status}${note}`);
    }
    lines.push('');
  }
  for (const b of report.blobs) {
    if (b.error) {
      lines.push(`## \`${b.table}.${b.column}\` — ${b.error}`);
      continue;
    }
    if (!b.unusedKeys.length) continue;
    const label = b.partition ? `${b.table}.${b.column} [kind='${b.partition}']` : `${b.table}.${b.column}`;
    lines.push(`## \`${label}\` — ${b.unusedKeys.length}/${b.totalKeys} keys unused`);
    lines.push(b.unusedKeys.map((k) => `\`${k}\``).join(', '));
    lines.push('');
  }
  if (diff) {
    lines.push('## Diff vs previous run');
    lines.push(`- Newly unused tables: ${diff.newlyUnusedTables.length ? diff.newlyUnusedTables.join(', ') : 'none'}`);
    lines.push(`- Tables that gained a reader since last run: ${diff.nowUsedTables.length ? diff.nowUsedTables.join(', ') : 'none'}`);
    lines.push(`- Newly unused blob keys: ${diff.newlyUnusedBlobKeys.length ? diff.newlyUnusedBlobKeys.join(', ') : 'none'}`);
  }
  return lines.join('\n') + '\n';
}

function main() {
  const dbPath = arg('--db');
  const out = arg('--out');
  if (!dbPath || !out) {
    console.error('usage: node scripts/data-lineage-inventory.mjs --db <path> --out <path> '
      + '[--prev <path>] [--table-prefix nfl_] [--blob-sample 500]');
    process.exit(2);
  }
  const prevPath = arg('--prev');
  const tablePrefix = arg('--table-prefix', 'nfl_');
  const blobSample = Number(arg('--blob-sample', '500'));
  const extraPickPathFiles = argAll('--pick-path-file');
  const pickPathFiles = extraPickPathFiles.length
    ? [...DEFAULT_PICK_PATH_FILES, ...extraPickPathFiles]
    : DEFAULT_PICK_PATH_FILES;
  const root = path.resolve(path.dirname(THIS_FILE), '..');

  let db;
  try {
    db = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
  } catch (exc) {
    fail(`could not open --db ${dbPath} read-only: ${exc.message}`);
    return;
  }

  const report = buildReport({ db, root, tablePrefix, blobSample, pickPathFiles });
  report.generatedAt = new Date().toISOString();

  let diff = null;
  if (prevPath && fs.existsSync(prevPath)) {
    const prev = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
    diff = diffAgainstPrev(report, prev);
    report.diffVsPrev = diff;
  }

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  const mdPath = out.replace(/\.json$/, '.md');
  fs.writeFileSync(mdPath, toMarkdown(report, diff));

  console.log(JSON.stringify({
    ok: true,
    out,
    md: mdPath,
    tablesScanned: report.tablesScanned,
    unusedTableCount: report.unusedTableCount,
    unusedBlobKeyCount: report.unusedBlobKeyCount,
    newlyUnusedTables: diff ? diff.newlyUnusedTables : undefined,
    newlyUnusedBlobKeys: diff ? diff.newlyUnusedBlobKeys : undefined,
  }, null, 2));
}

if (process.argv[1] === THIS_FILE) {
  main();
}
