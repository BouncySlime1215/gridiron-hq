/**
 * Tests for scripts/data-lineage-inventory.mjs — the mechanized version of
 * the September 15-16 "unused-table sweep" (see RUNBOOK.md §10.9, FINAL
 * ORDER #21 in docs/betting-model/plans/LATEST-PLAN.md).
 *
 * Builds a throwaway sqlite db and a throwaway source tree covering all
 * four status tiers (used-in-pick-path / used-outside-pick-path /
 * definition-only / test-only / no-reader), then asserts the report
 * classifies every case correctly. Never touches the real extract or the
 * live research database.
 *
 * The pick-path/definition-only split exists because the first real pilot
 * run (against /tmp/gridiron-extract/real.sqlite) missed
 * `nfl_team_feature_vectors` under a naive "referenced anywhere = used"
 * rule -- `test('buildReport separates pick-path reads ...')` below is the
 * regression test for exactly that miss.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildReport, computeReachableFiles, findReaders, walkSourceFiles } from '../scripts/data-lineage-inventory.mjs';

function makeScratchRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-lineage-'));
  fs.mkdirSync(path.join(root, 'server', 'services'), { recursive: true });
  fs.mkdirSync(path.join(root, 'server', 'db', 'schema'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });

  // pick-path reader of nfl_pick_path_table and of blob key "used_key".
  fs.writeFileSync(
    path.join(root, 'server', 'services', 'nfl-ensemble.js'),
    "db.prepare('SELECT * FROM nfl_pick_path_table').all();\nconst v = row.used_key;\n"
  );
  // non-pick-path prod reader (audit code) of nfl_audit_only_table.
  fs.writeFileSync(
    path.join(root, 'server', 'services', 'nfl-blind-audit.js'),
    "db.prepare('SELECT * FROM nfl_audit_only_table').all();\n"
  );
  // schema-definition-only reference to nfl_definition_only_table.
  fs.writeFileSync(
    path.join(root, 'server', 'db', 'schema', 'nfl-a-to-m.js'),
    "db.exec('CREATE TABLE nfl_definition_only_table (id INTEGER)');\n"
  );
  // test-only reader of nfl_test_only_table.
  fs.writeFileSync(
    path.join(root, 'test', 'fixture.test.js'),
    "db.prepare('SELECT * FROM nfl_test_only_table').all();\n"
  );
  return root;
}

function makeScratchDb() {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-lineage-db-')), 'scratch.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE nfl_pick_path_table (id INTEGER)');
  db.exec('CREATE TABLE nfl_audit_only_table (id INTEGER)');
  db.exec('CREATE TABLE nfl_definition_only_table (id INTEGER)');
  db.exec('CREATE TABLE nfl_test_only_table (id INTEGER)');
  db.exec('CREATE TABLE nfl_no_reader_table (id INTEGER)');
  db.exec('CREATE TABLE nfl_team_week_features (season INTEGER, week INTEGER, team TEXT, opponent TEXT, home INTEGER, features TEXT)');
  db.prepare("INSERT INTO nfl_team_week_features (season, week, team, features) VALUES (2024, 1, 'ABC', ?)")
    .run(JSON.stringify({ used_key: 1, unused_key: 2 }));
  db.close();
  return dbPath;
}

test('walkSourceFiles finds files under the given source dirs, skips excluded dirs', () => {
  const root = makeScratchRepo();
  fs.mkdirSync(path.join(root, 'server', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server', 'node_modules', 'ignored.js'), 'nfl_pick_path_table');
  const files = walkSourceFiles(root, ['server', 'test']);
  assert.ok(files.some((f) => f.endsWith('nfl-ensemble.js')));
  assert.ok(!files.some((f) => f.includes('node_modules')));
});

test('findReaders buckets by pick-path / other-prod / definition-only / test-only', () => {
  const root = makeScratchRepo();
  const files = walkSourceFiles(root, ['server', 'test']);
  const pickPathFiles = [path.join(root, 'server', 'services', 'nfl-ensemble.js')];
  const readers = findReaders(
    ['nfl_pick_path_table', 'nfl_audit_only_table', 'nfl_definition_only_table', 'nfl_test_only_table', 'nfl_no_reader_table'],
    files,
    [],
    pickPathFiles
  );
  assert.equal(readers.get('nfl_pick_path_table').pickPathReaders.length, 1);
  assert.equal(readers.get('nfl_audit_only_table').otherProdReaders.length, 1);
  assert.equal(readers.get('nfl_audit_only_table').pickPathReaders.length, 0);
  assert.equal(readers.get('nfl_definition_only_table').definitionOnlyReaders.length, 1);
  assert.equal(readers.get('nfl_definition_only_table').otherProdReaders.length, 0);
  assert.equal(readers.get('nfl_test_only_table').testOnlyReaders.length, 1);
  assert.equal(readers.get('nfl_no_reader_table').pickPathReaders.length, 0);
  assert.equal(readers.get('nfl_no_reader_table').otherProdReaders.length, 0);
  assert.equal(readers.get('nfl_no_reader_table').testOnlyReaders.length, 0);
});

test('word-boundary matching does not false-positive a longer identifier sharing a prefix', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-lineage-wb-'));
  fs.mkdirSync(path.join(root, 'server'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server', 'x.js'), 'nfl_team_week_features_v2');
  const files = walkSourceFiles(root, ['server']);
  const readers = findReaders(['nfl_team_week_features'], files, []);
  assert.equal(readers.get('nfl_team_week_features').otherProdReaders.length, 0);
  assert.equal(readers.get('nfl_team_week_features').pickPathReaders.length, 0);
});

test('buildReport separates pick-path reads from audit-only / definition-only / test-only / no-reader, and only the pick-path tier counts as used', () => {
  const root = makeScratchRepo();
  const dbPath = makeScratchDb();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const report = buildReport({
      db,
      root,
      tablePrefix: 'nfl_',
      blobSample: 100,
      pickPathFiles: ['server/services/nfl-ensemble.js'],
    });

    const byName = Object.fromEntries(report.tables.map((t) => [t.table, t.status]));
    assert.equal(byName.nfl_pick_path_table, 'used-in-pick-path');
    assert.equal(byName.nfl_audit_only_table, 'used-outside-pick-path');
    assert.equal(byName.nfl_definition_only_table, 'definition-only');
    assert.equal(byName.nfl_test_only_table, 'test-only');
    assert.equal(byName.nfl_no_reader_table, 'no-reader');

    // Everything except the genuine pick-path reader counts as "unused" --
    // this is the regression test for the 2026-09-16 pilot-run miss.
    assert.ok(!report.unusedTables.includes('nfl_pick_path_table'));
    for (const t of ['nfl_audit_only_table', 'nfl_definition_only_table', 'nfl_test_only_table', 'nfl_no_reader_table']) {
      assert.ok(report.unusedTables.includes(t), `expected ${t} in unusedTables`);
    }

    const blob = report.blobs.find((b) => b.table === 'nfl_team_week_features');
    assert.ok(blob, 'expected the known blob column to be scanned');
    assert.ok(blob.unusedKeys.includes('unused_key'));
    assert.ok(!blob.unusedKeys.includes('used_key'));
  } finally {
    db.close();
  }
});

test('buildReport resolves relative pick-path files against root, not process.cwd()', () => {
  const root = makeScratchRepo();
  const dbPath = makeScratchDb();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const originalCwd = process.cwd();
  try {
    process.chdir(os.tmpdir()); // deliberately NOT root
    const report = buildReport({
      db,
      root,
      tablePrefix: 'nfl_',
      blobSample: 100,
      pickPathFiles: ['server/services/nfl-ensemble.js'],
    });
    const row = report.tables.find((t) => t.table === 'nfl_pick_path_table');
    assert.equal(row.status, 'used-in-pick-path', 'relative pick-path file must resolve against root, not cwd');
  } finally {
    process.chdir(originalCwd);
    db.close();
  }
});

test('computeReachableFiles follows the import graph transitively, ignores bare package specifiers, and terminates on a cycle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-lineage-graph-'));
  fs.mkdirSync(path.join(root, 'server', 'services'), { recursive: true });
  const entry = path.join(root, 'server', 'services', 'entry.js');
  const mid = path.join(root, 'server', 'services', 'mid.js');
  const leaf = path.join(root, 'server', 'services', 'leaf.js');
  const orphan = path.join(root, 'server', 'services', 'orphan.js');
  fs.writeFileSync(entry, "import { x } from './mid.js';\nimport sqlite from 'node:sqlite';\n");
  fs.writeFileSync(mid, "import { y } from './leaf.js';\nimport { z } from './mid.js';\n"); // self-import cycle
  fs.writeFileSync(leaf, "db.prepare('SELECT * FROM nfl_transitively_reachable').all();\n");
  fs.writeFileSync(orphan, "db.prepare('SELECT * FROM nfl_never_imported').all();\n");

  const reachable = computeReachableFiles([entry], root);
  assert.ok(reachable.has(entry));
  assert.ok(reachable.has(mid));
  assert.ok(reachable.has(leaf), 'leaf.js is imported by mid.js, two hops from entry');
  assert.ok(!reachable.has(orphan), 'orphan.js is never imported by anything reachable from entry');
});

test('buildReport separately regression-checks: a table read only by a module the pick path imports (two hops away) still counts as used-in-pick-path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-lineage-2hop-'));
  fs.mkdirSync(path.join(root, 'server', 'services'), { recursive: true });
  const entry = path.join(root, 'server', 'services', 'nfl-ensemble.js');
  const helper = path.join(root, 'server', 'services', 'nfl-devig.js');
  fs.writeFileSync(entry, "import { devig } from './nfl-devig.js';\n");
  fs.writeFileSync(helper, "db.prepare('SELECT * FROM nfl_two_hop_table').all();\n");

  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-lineage-2hop-db-')), 'scratch.sqlite');
  const setup = new DatabaseSync(dbPath);
  setup.exec('CREATE TABLE nfl_two_hop_table (id INTEGER)');
  setup.close();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const report = buildReport({ db, root, tablePrefix: 'nfl_', blobSample: 100, pickPathFiles: ['server/services/nfl-ensemble.js'] });
    const row = report.tables.find((t) => t.table === 'nfl_two_hop_table');
    assert.equal(row.status, 'used-in-pick-path');
  } finally {
    db.close();
  }
});

test('buildReport does not let reachability through a DB-bootstrap import grant pick-path status to a schema-definition-only table', () => {
  // Regression test: the entry point imports db/index.js, which imports the
  // schema files that CREATE every table -- if reachability alone granted
  // pick-path status, EVERY table would show as used-in-pick-path via this
  // one bootstrap chain, exactly the false negative the definition-only
  // tier exists to prevent.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-lineage-bootstrap-'));
  fs.mkdirSync(path.join(root, 'server', 'services'), { recursive: true });
  fs.mkdirSync(path.join(root, 'server', 'db', 'schema'), { recursive: true });
  const entry = path.join(root, 'server', 'services', 'nfl-ensemble.js');
  const dbIndex = path.join(root, 'server', 'db', 'index.js');
  const schemaFile = path.join(root, 'server', 'db', 'schema', 'nfl-a-to-m.js');
  fs.writeFileSync(entry, "import { db } from '../db/index.js';\n");
  fs.writeFileSync(dbIndex, "import './schema/nfl-a-to-m.js';\n");
  fs.writeFileSync(schemaFile, "db.exec('CREATE TABLE nfl_bootstrap_only_table (id INTEGER)');\n");

  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-lineage-bootstrap-db-')), 'scratch.sqlite');
  const setup = new DatabaseSync(dbPath);
  setup.exec('CREATE TABLE nfl_bootstrap_only_table (id INTEGER)');
  setup.close();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const report = buildReport({ db, root, tablePrefix: 'nfl_', blobSample: 100, pickPathFiles: ['server/services/nfl-ensemble.js'] });
    const row = report.tables.find((t) => t.table === 'nfl_bootstrap_only_table');
    assert.equal(row.status, 'definition-only', 'a table only CREATEd by a reachable schema file must not count as pick-path');
  } finally {
    db.close();
  }
});

test('buildReport reports a clear error for a known blob table absent from this database, not a crash', () => {
  const root = makeScratchRepo();
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-lineage-empty-')), 'empty.sqlite');
  const setup = new DatabaseSync(dbPath);
  setup.exec('CREATE TABLE nfl_pick_path_table (id INTEGER)');
  setup.close();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const report = buildReport({ db, root, tablePrefix: 'nfl_', blobSample: 100 });
    const missing = report.blobs.find((b) => b.table === 'nfl_team_week_features');
    assert.ok(missing.error);
  } finally {
    db.close();
  }
});
