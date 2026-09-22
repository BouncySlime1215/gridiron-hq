/**
 * A "data healthy" light has to answer the question it claims to answer.
 *
 * The banner it replaces asked the wrong one. `/model/setup-status` checked
 * `last_status === 'never run'` on each source — did the job ever run — and a
 * job that ran once and wrote zero current rows is not "never run", so the app
 * reported healthy while `player_week_usage` held 2021-2025 and nothing for the
 * season being played. A connection is not freshness. Rows for the current week
 * are.
 *
 * So this module reads the served tables themselves, not the sync log, and for
 * each one answers exactly one of:
 *
 *   - `empty`  — the table holds nothing at all (or is not present in this DB).
 *   - `stale`  — it holds rows, but none satisfy its current-data rule.
 *   - `fresh`  — at least one row satisfies the rule.
 *
 * The type specimen, pinned first, is the one the old banner got wrong and the
 * one the acceptance criterion names: a table with data for past seasons and a
 * live connection, asked about today, must not come back `fresh`.
 *
 * The rule for each table is developer-authored, not user input: a plain
 * sentence for the panel and a WHERE fragment with `?` placeholders whose values
 * are bound, never interpolated. The table and column names are the only
 * identifiers, they come from a fixed code registry, and they are validated
 * against an identifier pattern anyway, so a registry that ever carried a
 * string like `x; DROP TABLE` is rejected rather than run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-data-freshness-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db } = await import('../server/db/index.js');
const { dataFreshness, tableFreshness, FALLBACK_REGISTRY, servedTablesRegistry } =
  await import('../server/services/data-freshness.js');

const SEASON = 2026, WEEK = 3;

// player_week_usage is created by the legacy schema when the db opens; only
// has_updated is ours to make. Inserts name columns so the real table's extra
// columns do not matter.
db.exec(`CREATE TABLE IF NOT EXISTS has_updated (id INTEGER, season INTEGER, week INTEGER, updated_at TEXT);`);
db.prepare(`INSERT INTO players (id, name, position) VALUES (1, 'Test Player', 'WR')`).run();
const pwu = (season, week) => db.prepare(`INSERT INTO player_week_usage (player_id, season, week) VALUES (1, ?, ?)`).run(season, week);

const clear = () => { for (const t of ['player_week_usage', 'has_updated']) db.prepare(`DELETE FROM ${t}`).run(); };

const RULE = {
  description: 'Has rows for the current season, up to the week being played.',
  predicate: 'season = ? AND week <= ?',
  bind: ['season', 'week']
};
const entry = (over = {}) => ({
  table: 'player_week_usage', label: 'Weekly player usage',
  season_col: 'season', week_col: 'week', updated_col: null, current_rule: RULE, ...over
});
const ctx = () => ({ currentSeason: SEASON, currentWeek: WEEK, database: db });
const one = over => tableFreshness(entry(over), ctx());

test('a table with rows for past seasons only is stale, never fresh — the specimen the banner got wrong', () => {
  clear();
  for (const s of [2023, 2024, 2025]) pwu(s, 1);
  const f = one();
  assert.equal(f.status, 'stale', 'a connection with no current rows was reported fresh');
  assert.notEqual(f.status, 'fresh');
  assert.equal(f.row_count, 3, 'the row count is not the whole table');
});

test('a current-season row up to the current week is fresh', () => {
  clear();
  pwu(SEASON, WEEK);
  assert.equal(one().status, 'fresh');
});

test('a current-season row from a FUTURE week does not count as current', () => {
  clear();
  pwu(SEASON, WEEK + 5);
  assert.equal(one().status, 'stale', 'a week that has not been played yet was treated as current data');
});

test('an empty table is empty, not stale and not fresh', () => {
  clear();
  assert.equal(one().status, 'empty');
  assert.equal(one().row_count, 0);
});

test('a table not present in this database is empty with a note, not a thrown error', () => {
  const f = tableFreshness(entry({ table: 'no_such_table' }), ctx());
  assert.equal(f.status, 'empty');
  assert.match(f.note ?? '', /not present|no such/i, 'a missing table is not explained');
});

test('row_count, earliest and latest reflect the data', () => {
  clear();
  for (const s of [2023, 2024, 2025]) pwu(s, 1);
  const f = one();
  assert.equal(f.row_count, 3);
  assert.equal(String(f.earliest), '2023');
  assert.equal(String(f.latest), '2025');
});

test('last_write is the max of the updated column when one exists, and null when it does not', () => {
  clear();
  db.prepare(`INSERT INTO has_updated VALUES (1, ?, 1, '2026-09-19T10:00:00Z')`).run(SEASON);
  db.prepare(`INSERT INTO has_updated VALUES (2, ?, 2, '2026-09-20T10:00:00Z')`).run(SEASON);
  const withCol = tableFreshness(entry({ table: 'has_updated', updated_col: 'updated_at' }), ctx());
  assert.equal(withCol.last_write, '2026-09-20T10:00:00Z');
  assert.equal(one().last_write, null, 'a table with no updated column invented a write time');
});

test('the plain-sentence rule is carried through verbatim for the panel', () => {
  clear();
  assert.equal(one().current_rule, RULE.description);
});

test('a registry table name that is not a bare identifier is rejected, not interpolated', () => {
  assert.throws(() => tableFreshness(entry({ table: 'player_week_usage; DROP TABLE has_updated' }), ctx()),
    /identifier/i, 'a non-identifier table name was allowed into the query');
});

test('a predicate whose placeholder count does not match its bind list is rejected', () => {
  assert.throws(() => tableFreshness(entry({ current_rule: { ...RULE, bind: ['season'] } }), ctx()),
    /placeholder|bind/i, 'a predicate with the wrong number of bound values was run anyway');
});

test('the acceptance criterion on the fallback registry: player_week_usage is not fresh on 2021-2025-only data', () => {
  clear();
  for (const s of [2021, 2022, 2023, 2024, 2025]) pwu(s, 1);
  const entry = FALLBACK_REGISTRY.find(e => e.table === 'player_week_usage');
  assert.ok(entry, 'the fallback registry has no player_week_usage entry');
  assert.notEqual(tableFreshness(entry, ctx()).status, 'fresh',
    'the fallback registry reports fresh on data with no current season');
});

test('dataFreshness returns one row per registry entry, each with the full shape', () => {
  clear();
  const report = dataFreshness({ registry: [entry()], currentSeason: SEASON, currentWeek: WEEK, database: db });
  assert.equal(report.length, 1);
  for (const k of ['table', 'label', 'row_count', 'earliest', 'latest', 'last_write', 'current_rule', 'status']) {
    assert.ok(k in report[0], `the report row is missing ${k}`);
  }
});

test('servedTablesRegistry falls back to the built-in registry until source-registry exports servedTables', () => {
  const reg = servedTablesRegistry();
  assert.ok(Array.isArray(reg) && reg.length > 0, 'no registry available at all');
  assert.ok(reg.some(e => e.table === 'player_week_usage'), 'the registry does not cover player_week_usage');
});

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/**
 * Second grain: fit-artifact stores, not just feeds.
 *
 * The model-audit thread's reconciliation found that a feed-only registry has
 * the banner's own bug one layer up — a model can read a stale or wrong-season
 * fit and still answer, and the store still reads "fresh" because rows exist.
 * So an entry carries an optional grain (one of source-registry.js's four) and the model that
 * reads it, and — this is the part that must not regress — a fit store's verdict
 * is still COVERAGE, not a timestamp: fresh means a fit exists FOR THE CURRENT
 * season, never merely that a fit ran recently. A recent fitted_at over
 * last-season-only fits is exactly the stale-fit trap, and it must read stale.
 */
const fitEntry = (over = {}) => ({
  table: 'has_updated', label: 'Correlation estimates',
  grain: 'fit', reader: 'nfl-ensemble',
  season_col: 'season', week_col: null, updated_col: 'updated_at',
  current_rule: {
    description: 'A fit exists for the season being played.',
    predicate: 'season = ?', bind: ['season']
  }, ...over
});

test('grain and reader are carried through so a fit store is distinguishable from a feed', () => {
  clear();
  db.prepare(`INSERT INTO has_updated VALUES (1, ?, NULL, '2026-09-01T00:00:00Z')`).run(SEASON);
  const f = tableFreshness(fitEntry(), ctx());
  assert.equal(f.grain, 'fit');
  assert.equal(f.reader, 'nfl-ensemble');
});

/**
 * This test used to assert the default was `'feed'`, and that assertion was
 * wrong rather than merely superseded. `source-registry.js` — the producer, and
 * so the source of truth for this field — emits `'week' | 'season' | 'static' |
 * 'fit'`, with no `'feed'` in it. Defaulting an entry that states no grain to a
 * member of a vocabulary it does not belong to put a claim on the panel that
 * nobody had made: it told the reader this table is a feed, on no evidence.
 *
 * `null` is the honest value, and the banner renders it as a sentence that names
 * no cadence. See test/data-freshness-grain.test.js for the vocabulary itself.
 */
test('an entry with no grain gets null rather than a guessed default', () => {
  clear();
  pwu(SEASON, WEEK);
  const f = one();
  assert.notEqual(f.grain, 'feed', 'the retired default is back');
  assert.equal(f.grain, null);
  assert.equal(f.reader, null);
});

test('a fit store is stale when its only fit is last season, even with a recent fitted_at', () => {
  clear();
  // A fit for 2025 only, fitted just now. Timestamp-fresh, coverage-stale.
  db.prepare(`INSERT INTO has_updated VALUES (1, 2025, NULL, '2026-09-20T23:59:00Z')`).run();
  const f = tableFreshness(fitEntry(), ctx());
  assert.equal(f.status, 'stale', 'a recent fitted_at over a last-season fit was called fresh — the stale-fit trap');
  assert.equal(f.last_write, '2026-09-20T23:59:00Z', 'the fitted_at is still shown, just not used for the verdict');
});

test('a fit store is fresh when a fit exists for the current season', () => {
  clear();
  db.prepare(`INSERT INTO has_updated VALUES (1, ?, NULL, '2026-08-01T00:00:00Z')`).run(SEASON);
  assert.equal(tableFreshness(fitEntry(), ctx()).status, 'fresh');
});
