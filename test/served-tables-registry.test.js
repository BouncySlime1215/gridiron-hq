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

const { db, row, run } = await import('../server/db/index.js');
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
    assert.ok(['week', 'season', 'static', 'fit'].includes(e.grain), `${e.table}: bad grain ${e.grain}`);
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

test("every 'fit' entry names the stamp to show and the service that degrades", () => {
  // A fit verdict without these two is unactionable: the reader cannot say WHEN
  // it was fitted, or WHOSE answer is running on a fallback.
  for (const e of entries.filter((x) => x.grain === 'fit')) {
    assert.equal(typeof e.fitted_col, 'string', `${e.table}: fit grain needs fitted_col`);
    assert.equal(typeof e.reader, 'string', `${e.table}: fit grain needs reader`);
    assert.ok(e.reader.endsWith('.js'), `${e.table}: reader should name a file, got ${e.reader}`);
  }
});

test('a fit rule is STRICTLY STRONGER than the row count /api/model/status uses', () => {
  // This is the whole point of the fit grain, and it is the bug that is live
  // today: server/routes/model.js:598-599 reports correlations_fitted and
  // gamescript_fitted as bare SELECT COUNT(*). So insert, for each shape, a row
  // that a count would pass and the real rule must reject.
  //
  // If any of these ever starts returning 1, the registry has been quietly
  // downgraded to a row count and the banner is lying again.
  const bind = { season: 2026, week: 2 };
  const ruleFor = (table) => entries.find((e) => e.table === table).current_rule;
  const verdict = (table) => {
    const r = ruleFor(table);
    return row(r.sql, ...r.params.map((k) => bind[k])).current;
  };

  // A fit that exists but was never activated. active DEFAULT 0.
  run("INSERT INTO shrinkage_fits (fitted_at, through_season) VALUES (datetime('now'), 2025)");
  assert.ok(row('SELECT COUNT(*) AS n FROM shrinkage_fits').n > 0, 'fixture did not insert');
  assert.equal(verdict('shrinkage_fits'), 0,
    'an inactive shrinkage fit reads as fitted -- the rule has become a row count');

  // A candidate that was REJECTED. promoted DEFAULT 0, rejection_reason set.
  run(`INSERT INTO weekly_ensemble_fits
         (data_hash, through_season, through_week, weights_json, sample_size,
          validation_size, rejection_reason)
       VALUES ('hash-rejected', 2026, 2, '{}', 100, 20, 'worse than champion')`);
  assert.equal(verdict('weekly_ensemble_fits'), 0,
    'a rejected ensemble candidate reads as the promoted model');

  // An estimate with no fitted stamp. fitted_at is nullable.
  run("INSERT INTO correlation_estimates (key, correlation, pairs) VALUES ('QB|WR|team', 0.3, 50)");
  assert.equal(verdict('correlation_estimates'), 0,
    'an undated correlation estimate reads as fitted');

  // HALF a model: one of the two targets, correctly stamped.
  run("INSERT INTO gamescript_model (target, b0, fitted_at) VALUES ('pass_att', 1.0, datetime('now'))");
  assert.equal(verdict('gamescript_model'), 0,
    'one fitted target out of two reads as a fitted game-script model');

  // Now promote / complete each one, and the same rules must flip to 1 --
  // otherwise the test above would pass on a rule that can never say yes.
  run('UPDATE shrinkage_fits SET active = 1');
  run("UPDATE weekly_ensemble_fits SET promoted = 1, rejection_reason = NULL");
  run("UPDATE correlation_estimates SET fitted_at = datetime('now')");
  run("INSERT INTO gamescript_model (target, b0, fitted_at) VALUES ('rush_att', 2.0, datetime('now'))");
  for (const t of ['shrinkage_fits', 'weekly_ensemble_fits', 'correlation_estimates', 'gamescript_model']) {
    assert.equal(verdict(t), 1, `${t}: rule cannot say yes even when the fit is real`);
  }
});
