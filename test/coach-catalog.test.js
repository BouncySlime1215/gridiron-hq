/**
 * The Coach catalog — the single statement of what Coach may read and what
 * each table means.
 *
 * Coach answers "any question" by retrieving rows. That only works if it knows
 * what is in the database, and it is only safe if it cannot name something that
 * is not. Today's assistant (server/services/nfl-page-explain.js) has neither:
 * its six tools are betting tools, its glossary file was deleted by the 09-17
 * UI teardown and the read silently falls back to a placeholder string
 * (nfl-page-explain.js:32) while the system prompt still instructs the model to
 * "use these words and these meanings exactly". A vocabulary that is promised
 * and not supplied is filled in from training, which is the hallucination this
 * catalog exists to remove.
 *
 * What is asserted here:
 *  - every table the catalog describes actually exists in the schema, so Coach
 *    can never cite a table that is not there;
 *  - every entry states its grain, its meaning in plain words, how it is
 *    refreshed and whether it is collected automatically or by hand — the last
 *    one is what lets an answer show its data age rather than implying freshness
 *    (league_transactions_raw is collected by hand and nothing used to say so);
 *  - column lists are read live from the database, never hand-copied, so the
 *    catalog cannot drift into describing a column that was renamed;
 *  - the tables behind Nick's three example questions (who the depth is, what
 *    the coach's scheme is, what the game script looks like) are all covered;
 *  - coverage is reportable: what is in the database and not yet catalogued is
 *    a list Coach can be honest about, not a silent blind spot.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-catalog-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { rows } = await import('../server/db/index.js');
const {
  COACH_TABLES, COLLECTION_MODES, catalogEntry, readableTables, catalog, catalogCoverage
} = await import('../server/services/coach/catalog.js');

// The migrations have to run: decision_recommendations is migration 020, and a
// database with only the declared schema does not have it.
await (await import('../server/db/migrate.js')).runMigrations();

// Seven catalogued tables are created when their service module is imported
// rather than by a migration, so they are absent from a database nobody has
// touched. Importing the modules here is exactly what the server does at boot,
// and it is the difference between testing the catalog and testing an empty
// database.
await import('../server/services/manager-signals.js');
await import('../server/services/manager-archetypes.js');
await import('../server/services/manager-identity.js');
await import('../server/services/coach/audit.js');
await import('../server/services/coach/people/context.js');

const liveTables = new Set(rows(`SELECT name FROM sqlite_master WHERE type='table'`).map(r => r.name));

test('every catalogued table exists, unless only a script creates it', () => {
  // The exemption is narrow on purpose, and the tests below close the hole it
  // would otherwise open: a fabricated table with no creator still fails here,
  // and a fabricated creator fails the file check. Three tables are genuinely
  // absent on a machine where nobody has run the script that builds them, and
  // pretending otherwise would mean either dropping them from the catalog —
  // leaving Coach unable to say they exist at all — or asserting something
  // false.
  const missing = readableTables().filter(name => !liveTables.has(name) && !builtByAScript(name));
  assert.deepEqual(missing, [], `catalogued but absent from the database: ${missing.join(', ')}`);
});

test('every entry states grain, meaning, freshness and collection mode', () => {
  for (const name of readableTables()) {
    const entry = catalogEntry(name);
    assert.ok(entry.grain?.trim(), `${name} has no grain`);
    assert.ok(entry.means?.trim(), `${name} has no plain-words meaning`);
    assert.ok(entry.freshness?.trim(), `${name} does not say how it is refreshed`);
    assert.ok(COLLECTION_MODES.includes(entry.collection),
      `${name} collection "${entry.collection}" is not one of ${COLLECTION_MODES.join(', ')}`);
  }
});

test('collection mode distinguishes hand-collected data, so an answer can show its age', () => {
  const modes = new Set(readableTables().map(name => catalogEntry(name).collection));
  assert.ok(modes.has('auto'), 'nothing is marked automatically refreshed');
  assert.ok(modes.has('by_hand'), 'nothing is marked hand-collected — the whole point of the field');
});

test('columns are read from the live database, not hand-copied', () => {
  const entry = catalogEntry('players');
  const live = rows(`PRAGMA table_info(players)`).map(c => c.name);
  assert.deepEqual(entry.columns, live);
  assert.ok(entry.columns.length > 0);
});

test('a table that is not catalogued is not readable and has no entry', () => {
  assert.equal(catalogEntry('nfl_bet_log'), null);
  assert.equal(catalogEntry('no_such_table_anywhere'), null);
  assert.ok(!readableTables().includes('no_such_table_anywhere'));
});

test("the tables behind Nick's three example questions are covered", () => {
  const readable = new Set(readableTables());
  // "who the depth is"
  assert.ok(readable.has('nfl_depth'), 'depth chart is not readable');
  // "what the coach scheme is like"
  assert.ok(readable.has('nfl_teams'), 'team scheme and staff are not readable');
  // "what the game script is looking like"
  assert.ok(readable.has('game_lines'), 'the market view of game script is not readable');
  assert.ok(readable.has('gamescript_model'), 'the modelled game script is not readable');
});

test('coverage names what is present and not yet catalogued, and never contradicts itself', () => {
  const coverage = catalogCoverage();
  assert.equal(coverage.catalogued, readableTables().length);
  assert.ok(coverage.in_database >= coverage.catalogued);
  for (const name of coverage.uncatalogued) {
    assert.ok(liveTables.has(name), `${name} reported uncatalogued but is not in the database`);
    assert.ok(!readableTables().includes(name), `${name} is both catalogued and uncatalogued`);
  }
  assert.equal(coverage.missing_from_database.length, 0,
    `catalogued, absent and claiming no creator: ${coverage.missing_from_database.join(', ')}`);
  // Absent-because-nobody-ran-the-script is a separate bucket, and it must be
  // exactly the tables whose creator is a script. A table that slid from one
  // bucket to the other would otherwise look like nothing happened.
  const byScript = readableTables().filter(builtByAScript);
  for (const name of coverage.not_built_yet) {
    assert.ok(byScript.includes(name), `${name} is reported not-built-yet but no script creates it`);
    assert.ok(!liveTables.has(name), `${name} is reported not-built-yet but it is in the database`);
  }
});

test('the full catalog is serialisable and carries no Map or Set', () => {
  const full = catalog();
  const json = JSON.parse(JSON.stringify(full));
  assert.deepEqual(Object.keys(json).sort(), readableTables().slice().sort());
  for (const [name, entry] of Object.entries(json)) {
    assert.ok(Array.isArray(entry.columns), `${name} columns did not survive JSON`);
  }
});

test('COACH_TABLES is frozen, so no caller can widen what Coach may read at runtime', () => {
  assert.ok(Object.isFrozen(COACH_TABLES));
});

test('a table holding credentials declares them, so they can be withheld', () => {
  // leagues carries the ESPN session cookies (espn_s2, swid) alongside the
  // league settings Coach genuinely needs. CLAUDE.md: a secret never reaches a
  // log or a message. The catalog is where that is written down once.
  const leagues = catalogEntry('leagues');
  assert.ok(leagues, 'leagues must be readable — Coach cannot answer a league question without it');
  for (const secret of ['espn_s2', 'swid']) {
    assert.ok(leagues.redact.includes(secret), `${secret} is not marked for redaction`);
  }
  assert.ok(leagues.columns.includes('name'), 'the useful columns are still described');
});

test('every redacted column named by the catalog actually exists on its table', () => {
  for (const name of readableTables()) {
    if (builtByAScript(name)) continue;   // no table here, so no columns to check
    const entry = catalogEntry(name);
    for (const column of entry.redact) {
      assert.ok(entry.columns.includes(column),
        `${name}.${column} is marked redacted but is not a column of ${name}`);
    }
  }
});

test('every stat the lexicon names sits in a table Coach is allowed to read', async () => {
  // These two lists drifted the moment the lexicon grew: stat-names.js named
  // columns of off_ngs_season, off_pfr_adv_season, off_qbr_season and
  // off_depth_chart while the catalog did not list any of them, so Coach could
  // label a number it could not retrieve. A stat with a careful plain-English
  // explanation and no way to fetch it is worse than one with neither: it
  // invites a question that can only be answered from training.
  const { STAT_FIELDS } = await import('../server/services/coach/stat-names.js');
  const readable = new Set(readableTables());
  const unreadable = [...new Set(Object.keys(STAT_FIELDS).map(field => field.split('.')[0]))]
    .filter(table => !readable.has(table));
  assert.deepEqual(unreadable, [],
    `the lexicon names columns of tables Coach cannot read: ${unreadable.join(', ')}`);
});

// --- how a table comes to exist -------------------------------------------
//
// Eleven tables in this repository are created by no migration. Seven are
// created when a service module is imported, one on its first write, and three
// only by a script somebody has to run. That last bucket is why a fresh clone
// behaves differently from Nick's Mac, and why "catalogued" and "present" are
// not the same claim. The catalog has to say which, or Coach will write a
// perfectly legal SELECT against a table that is simply not there and report
// SQLite's own error as though the question were malformed.

const DECLARED_DDL = ['server/db/schema', 'server/migrations']
  .flatMap(dir => fs.readdirSync(dir).filter(f => f.endsWith('.js'))
    .map(f => fs.readFileSync(path.join(dir, f), 'utf8')))
  .join('\n');

/** Does the declared schema — the schema files or a migration — create it? */
const declared = table =>
  new RegExp(`CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?["'\`]?${table}["'\`]?\\s*\\(`, 'i')
    .test(DECLARED_DDL);

/** A table only a script creates is legitimately absent here. Nobody ran the script. */
const builtByAScript = name => /scripts\//.test(catalogEntry(name).created_at_runtime_by ?? '');

test('a table the declared schema does not create says who does, and one it creates says nothing', () => {
  for (const name of readableTables()) {
    const entry = catalogEntry(name);
    if (declared(name)) {
      assert.equal(entry.created_at_runtime_by, null,
        `${name} is created by the declared schema, so it must not claim a runtime creator`);
    } else {
      assert.ok(entry.created_at_runtime_by?.trim(),
        `${name} is in neither the schema files nor a migration, and does not say what creates it`);
    }
  }
});

test('every file a runtime creator names exists, and one of them holds the CREATE TABLE', () => {
  // The string is prose so it can explain WHEN the table appears, but the paths
  // inside it are checked: a creator that has been renamed or deleted must fail
  // here rather than mislead a reader a year from now.
  for (const name of readableTables()) {
    const said = catalogEntry(name).created_at_runtime_by;
    if (!said) continue;
    const paths = said.match(/[\w./-]+\.m?js/g) ?? [];
    assert.ok(paths.length, `${name} names no file as its creator: ${said}`);
    for (const file of paths) {
      assert.ok(fs.existsSync(file), `${name} names ${file}, which does not exist`);
    }
    const ddl = paths.some(file =>
      new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+["'\`]?${name}\\b`, 'i')
        .test(fs.readFileSync(file, 'utf8')));
    assert.ok(ddl, `none of the files ${name} names contains its CREATE TABLE`);
  }
});

test('the audit of Coach’s own answers is readable, but the answers themselves are withheld', () => {
  // coach_answers holds answer_json, ledger_json and plan_json. Letting a
  // generated SELECT read those would let a number from one turn's ledger
  // arrive in the next turn dressed as retrieved evidence, which is the pooling
  // hazard verify.js exists to stop, one level up. The audit columns — did it
  // verify, did it retry, how many numbers were checked — carry no football
  // number and are the ones worth asking about.
  const entry = catalogEntry('coach_answers');
  assert.ok(entry, 'coach_answers must be readable so "how often does Coach fail its own check" is answerable');
  for (const blob of ['answer_json', 'ledger_json', 'plan_json']) {
    assert.ok(entry.redact.includes(blob), `${blob} is not withheld`);
  }
  assert.ok(entry.columns.includes('numbers_checked'), 'the audit columns are still described');
});
