// The freshness banner this registry feeds exists because the old "data healthy"
// banner checked that the database answered, not that it held rows. Production
// carries ZERO 2026 rows in player_week_usage and the old banner still read
// green. So the load-bearing claim here is not "the list is nice" -- it is:
//
//   1. every rule's SQL actually parses and names columns that exist, and
//   2. on an empty database every rule says NOT current.
//
// (2) is the regression test for the bug itself. A rule that returns 1 on an
// empty table is the fake banner rebuilt in a new place.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-served-tables-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db, row } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { servedTables } = await import('../server/services/source-registry.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const BINDABLE = new Set(['season', 'week']);
const entries = servedTables();

test('the registry is not empty and every table name is distinct', () => {
  assert.ok(entries.length > 0, 'servedTables() returned nothing');
  const names = entries.map((e) => e.table);
  assert.equal(new Set(names).size, names.length, `duplicate table entry: ${names}`);
});

test('every entry carries the full contract shape', () => {
  for (const e of entries) {
    assert.equal(typeof e.table, 'string', 'table must be a string');
    assert.ok(['week', 'season', 'static'].includes(e.grain), `${e.table}: bad grain ${e.grain}`);
    assert.ok(e.current_rule, `${e.table}: no current_rule`);
    assert.equal(typeof e.current_rule.text, 'string', `${e.table}: rule text missing`);
    assert.ok(e.current_rule.text.length > 20, `${e.table}: rule text is not a sentence`);
    assert.equal(typeof e.current_rule.sql, 'string', `${e.table}: rule sql missing`);
    assert.ok(Array.isArray(e.current_rule.params), `${e.table}: params must be an array`);
    // Declared columns are only descriptive, but a lie here misleads the consumer.
    for (const key of ['season_col', 'week_col', 'updated_col']) {
      assert.ok(e[key] === null || typeof e[key] === 'string', `${e.table}: ${key} must be a string or null`);
    }
  }
});

test('the bind order matches the number of placeholders, and binds only season or week', () => {
  for (const e of entries) {
    const placeholders = (e.current_rule.sql.match(/\?/g) || []).length;
    assert.equal(
      placeholders, e.current_rule.params.length,
      `${e.table}: sql has ${placeholders} placeholders but params declares ${e.current_rule.params.length}`,
    );
    for (const p of e.current_rule.params) {
      assert.ok(BINDABLE.has(p), `${e.table}: params names '${p}', which the consumer cannot supply`);
    }
  }
});

test('every rule runs against the real migrated schema and returns one current column', () => {
  // This is the check that a typo'd table or column cannot survive. It runs the
  // rule as written, so a column that does not exist throws here rather than in
  // the banner on Nick's screen.
  const bind = { season: 2026, week: 2 };
  for (const e of entries) {
    const params = e.current_rule.params.map((p) => bind[p]);
    let result;
    try {
      result = row(e.current_rule.sql, ...params);
    } catch (err) {
      assert.fail(`${e.table}: rule sql failed against the migrated schema -- ${err.message}`);
    }
    assert.ok(result, `${e.table}: rule returned no row; it must always return exactly one`);
    assert.ok('current' in result, `${e.table}: rule must alias its column 'current', got ${Object.keys(result)}`);
    assert.ok(
      result.current === 0 || result.current === 1,
      `${e.table}: rule must return 0 or 1, got ${JSON.stringify(result.current)}`,
    );
  }
});

test('on an empty database every table reads NOT current -- the fake-banner regression', () => {
  const bind = { season: 2026, week: 2 };
  for (const e of entries) {
    const params = e.current_rule.params.map((p) => bind[p]);
    const result = row(e.current_rule.sql, ...params);
    assert.equal(
      result.current, 0,
      `${e.table}: says current on an empty database. That is the "data healthy" bug rebuilt.`,
    );
  }
});
