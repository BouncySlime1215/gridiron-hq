/**
 * A table that nothing creates, anywhere, was invisible to this map.
 *
 * The scanner built its table universe from CREATE statements and then dropped
 * every read whose table was not in it — one line, `if
 * (!tableUniverse.has(e.table)) continue;`. So a table created somewhere and
 * read wrongly was tracked, and a table created NOWHERE was not there at all:
 * no row, no finding, not even "unclassified". That is the worst case of the
 * category the honest inventory exists for, and it was the one case the map
 * was built not to see.
 *
 * Found by the model-evidence audit thread by hand, not by this map:
 * server/services/nfl-weekly-feature-store-v2.js reads `FROM pbp_participation
 * p JOIN play_by_play b`, and neither name is created in the tree. Those two
 * are the reproduction target below — a rule that cannot produce a finding
 * somebody already made without it has not earned trust.
 *
 * THE FILTER IS THE RULE. A bare "read but not created" sweep returns 44
 * non-test names on this repository and almost none are findings: prose caught
 * inside SQL comments (`FROM the`, `UPDATE a`), SQLite builtins, CTE names read
 * back as tables, DROP TABLE targets correctly gone, and — the dangerous one —
 * views. `nfl_news_signals_current` is a VIEW created at
 * server/migrations/053_nfl_news_signals_versioning.js:118 and read by
 * server/routes/news.js:230, a route in use. A rule that does not know about
 * views reports that as a phantom, and a map that cries wolf gets switched off.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { scan, sqlEdges, tablesReadButNeverCreated } = await import('../scripts/wiring-map.mjs');

const file = (path, tree, sql) => ({ path, tree, sql });
const read = (table, line = 1, handle = 'app') => ({ table, line, handle, structural: true });
const names = (rows) => rows.map((r) => r.table).sort();

test('a table read by product code and created nowhere is reported', () => {
  const out = tablesReadButNeverCreated([
    file('server/services/zz.js', 'server', { creates: [], views: [], ctes: [], writes: [], reads: [read('zz_fixture_absent', 42)] }),
  ]);
  assert.deepEqual(names(out), ['zz_fixture_absent']);
  assert.deepEqual(out[0].sites, ['server/services/zz.js:42']);
});

test('a view is not a phantom', () => {
  const out = tablesReadButNeverCreated([
    file('server/migrations/053_x.js', 'server', { creates: [], views: [{ table: 'zz_fixture_view', line: 9 }], ctes: [], writes: [], reads: [] }),
    file('server/routes/news.js', 'server', { creates: [], views: [], ctes: [], writes: [], reads: [read('zz_fixture_view', 230)] }),
  ]);
  assert.deepEqual(names(out), []);
});

test('a dropped table is gone on purpose, not missing', () => {
  const out = tablesReadButNeverCreated([
    file('server/migrations/042_x.js', 'server', { creates: [], views: [], ctes: [], writes: [{ table: 'zz_fixture_dropped', line: 18, dropped: true }], reads: [read('zz_fixture_dropped', 18)] }),
  ]);
  assert.deepEqual(names(out), []);
});

test('sqlite builtins and table-valued functions are not tables', () => {
  const out = tablesReadButNeverCreated([
    file('server/db/preflight.js', 'server', { creates: [], views: [], ctes: [], writes: [],
      reads: [read('sqlite_master', 104), read('json_each', 19), read('pragma_table_info', 7), read('sqlite_sequence', 8)] }),
  ]);
  assert.deepEqual(names(out), []);
});

test('a CTE name read back in the same statement is not a table', () => {
  const out = tablesReadButNeverCreated([
    file('server/betting/nfl/strategy/teaser-scan.js', 'server',
      { creates: [], views: [], ctes: [{ table: 'ranked', line: 100 }], writes: [], reads: [read('ranked', 105)] }),
  ]);
  assert.deepEqual(names(out), []);
});

test('a read on a foreign database handle is not this repository’s to create', () => {
  const out = tablesReadButNeverCreated([
    file('scripts/luck/jev_luck.mts', 'script', { creates: [], views: [], ctes: [], writes: [], reads: [read('zz_fixture_crawled', 59, 'jev')] }),
  ]);
  assert.deepEqual(names(out), []);
});

test('a name only a test ever reads is not a product finding', () => {
  const out = tablesReadButNeverCreated([
    file('test/zz.test.js', 'test', { creates: [], views: [], ctes: [], writes: [], reads: [read('zz_fixture_test_only', 5)] }),
  ]);
  assert.deepEqual(names(out), []);
});

test('SQL comments inside the query are not read as tables', async () => {
  const src = await readFile(new URL('../server/migrations/035_alt_spread_capture.js', import.meta.url), 'utf8');
  const { strings } = scan(src);
  const { reads } = sqlEdges(strings);
  // The prose in this file's `--` comments produced `the`, `a`, `successes`
  // and `THIS` as table reads. A comment is not a query.
  const prose = reads.map((r) => r.table).filter((t) => ['the', 'a', 'successes', 'THIS', 'this'].includes(t));
  assert.deepEqual(prose, []);
});

test('an English string with SQL words in it is not a query', async () => {
  // Three residual false positives were all prose in template literals that
  // looksSql() accepted: an LLM prompt in server/routes/players.js, a claim
  // string in scripts/model-lab, and a sentence in this very scanner
  // explaining `INSERT ... SELECT *` — which read "FROM a JavaScript array"
  // and reported a table called `a`. The filter is on the STATEMENT, not on a
  // list of English words: a real query carries a structural clause.
  const entries = [];
  for (const q of ['server/routes/players.js', 'scripts/model-lab/audit_corpus.mts', 'scripts/wiring-map.mjs']) {
    const src = await readFile(new URL(`../${q}`, import.meta.url), 'utf8');
    entries.push(file(q, q.startsWith('scripts/') ? 'script' : 'server', sqlEdges(scan(src).strings)));
  }
  const got = names(tablesReadButNeverCreated(entries));
  assert.deepEqual(got.filter((t) => ['a', 'this', 'the'].includes(t)), [], `prose reported as tables: ${got.join(', ')}`);
});

test('a one-word table name is still visible, because six real ones have no underscore', () => {
  // leagues, players, drafts, users, messages and reports are real tables here.
  // Filtering candidates by "must contain an underscore" would have been the
  // cheap way to kill the prose above, and it would have blinded the rule to
  // every table named the way those six are.
  const out = tablesReadButNeverCreated([
    file('server/services/zz.js', 'server', { creates: [], views: [], ctes: [], writes: [],
      reads: [{ table: 'widgets', line: 7, handle: 'app', structural: true }] }),
  ]);
  assert.deepEqual(names(out), ['widgets']);
});

test('the two tables the audit found by hand are reported from the real files', async () => {
  const entries = [];
  for (const p of ['server/services/nfl-weekly-feature-store-v2.js', 'server/services/td-features.js']) {
    const src = await readFile(new URL(`../${p}`, import.meta.url), 'utf8');
    entries.push(file(p, 'server', sqlEdges(scan(src).strings)));
  }
  const out = tablesReadButNeverCreated(entries);
  const got = names(out);
  for (const want of ['pbp_participation', 'play_by_play']) {
    assert.ok(got.includes(want), `expected ${want} among ${got.join(', ')}`);
  }
  // And the sites are citable, which is the only part a reader can check.
  const pbp = out.find((r) => r.table === 'pbp_participation');
  assert.ok(pbp.sites.every((s) => /^server\/services\/[\w.-]+\.js:\d+$/.test(s)), pbp.sites.join(', '));
});
