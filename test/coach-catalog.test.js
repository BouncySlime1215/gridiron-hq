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

const liveTables = new Set(rows(`SELECT name FROM sqlite_master WHERE type='table'`).map(r => r.name));

test('every catalogued table exists in the schema', () => {
  const missing = readableTables().filter(name => !liveTables.has(name));
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
  assert.equal(coverage.missing_from_database.length, 0);
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
