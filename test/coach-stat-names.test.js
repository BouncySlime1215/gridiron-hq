/**
 * One name per stat, everywhere, and an explanation a person who never deals
 * with stats can use.
 *
 * Nick's binding rule for the redesign: every stat gets one normalised name
 * across the whole platform, and an explanation that is detailed rather than
 * "wtf". Today the same quantity appears under different names on different
 * screens because each screen named it itself. This file is the one list —
 * Coach's claims, TeamDetail, the player page and News all read from it.
 *
 * Two properties make it a source of truth rather than a second opinion:
 * every field it names is a real column of a real table (checked against the
 * live schema), and a display name belongs to exactly one concept, so the
 * same words never mean two things.
 *
 * A stat we do NOT store is listed too, with what it would take. Silence
 * there is how a screen ends up inventing a number: "yards per route run"
 * cannot be computed from anything in this database, and saying so is the
 * answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-stats-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { rows } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { STAT_CONCEPTS, STAT_FIELDS, conceptFor, describeField, statLexicon, NOT_STORED } =
  await import('../server/services/coach/stat-names.js');

const columnsOf = table => rows(`SELECT name FROM pragma_table_info(?)`, table).map(c => c.name);

test('every field the lexicon names is a real column of a real table', () => {
  for (const field of Object.keys(STAT_FIELDS)) {
    const [table, column] = field.split('.');
    assert.ok(table && column, `${field} is not table.column`);
    const columns = columnsOf(table);
    assert.ok(columns.length, `${table} does not exist`);
    assert.ok(columns.includes(column), `${table} has no column ${column}`);
  }
});

test('every field points at a concept that exists', () => {
  for (const [field, conceptId] of Object.entries(STAT_FIELDS)) {
    assert.ok(STAT_CONCEPTS[conceptId], `${field} points at unknown concept ${conceptId}`);
  }
});

test('every concept has a display name, a plain sentence and a direction', () => {
  for (const [id, concept] of Object.entries(STAT_CONCEPTS)) {
    assert.ok(concept.name?.trim(), `${id} has no display name`);
    assert.ok(concept.plain?.length > 30, `${id}'s explanation is too short to help anyone`);
    assert.ok(['higher', 'lower', 'neither'].includes(concept.better),
      `${id} does not say which direction is good`);
    assert.ok(concept.unit?.trim(), `${id} has no unit`);
  }
});

test('a display name belongs to exactly one concept, so the same words never mean two things', () => {
  const byName = new Map();
  for (const [id, concept] of Object.entries(STAT_CONCEPTS)) {
    const key = concept.name.toLowerCase();
    assert.ok(!byName.has(key), `"${concept.name}" is used by both ${byName.get(key)} and ${id}`);
    byName.set(key, id);
  }
});

test('the same quantity in two tables resolves to the same name', () => {
  // air-yards share is stored weekly in player_week_usage and per season in
  // off_ngs_season. It is one stat and must read as one stat.
  assert.equal(conceptFor('player_week_usage.air_yards_share').id,
    conceptFor('off_ngs_season.air_yards_share').id);
  assert.equal(conceptFor('player_week_snaps.offense_pct').id,
    conceptFor('nfl_snaps.offense_pct').id);
});

test('describeField gives a screen everything it needs to label a number', () => {
  const described = describeField('player_week_usage.target_share');
  assert.equal(described.name, 'Target share');
  assert.match(described.plain, /\S/);
  assert.equal(described.unit, 'share of 1');
  assert.equal(described.better, 'higher');
  assert.equal(described.field, 'player_week_usage.target_share');
});

test('an unknown field is null, not a guessed label', () => {
  assert.equal(conceptFor('players.name'), null);
  assert.equal(describeField('nonsense.column'), null);
});

test("a stat we do not store says so, and says what it would take", () => {
  const yprr = NOT_STORED.find(s => s.name === 'Yards per route run');
  assert.ok(yprr, 'the most-asked-for missing stat is not listed');
  assert.ok(yprr.needs?.length > 20, 'it does not say what it would take to have it');
  for (const missing of NOT_STORED) {
    assert.ok(missing.plain?.length > 30, `${missing.name} has no explanation`);
    assert.ok(missing.needs?.trim(), `${missing.name} does not say what is missing`);
    assert.ok(!Object.values(STAT_CONCEPTS).some(c => c.name === missing.name),
      `${missing.name} is listed as both stored and not stored`);
  }
});

test('the lexicon serialises for a client with no Maps and no functions', () => {
  const lexicon = statLexicon();
  const json = JSON.parse(JSON.stringify(lexicon));
  assert.deepEqual(Object.keys(json).sort(), ['concepts', 'fields', 'not_stored']);
  assert.ok(json.concepts.target_share.name);
  assert.equal(json.fields['player_week_usage.target_share'], 'target_share');
  assert.ok(Array.isArray(json.not_stored));
});

test('the stats Nick named by hand are all covered one way or the other', () => {
  const named = ['Target share', 'Snap share', 'Air-yards share', 'aDOT', 'WOPR', 'RACR', 'PACR',
    'Catch rate', 'Chance to play', 'Yards per route run', 'Touchdown rate'];
  const known = new Set([
    ...Object.values(STAT_CONCEPTS).map(c => c.name),
    ...NOT_STORED.map(s => s.name)
  ]);
  for (const name of named) assert.ok(known.has(name), `${name} is in neither list`);
});

test('chance to play cannot be shown without its basis', () => {
  // Adopted from the fantasy-plan contract: `availability_basis` travels with
  // `active_probability`, and `default_durability` is a constant rather than a
  // measurement — a claim resting on one has to say so. K and DST always land
  // there, because the availability model covers QB/RB/WR/TE only.
  const basis = STAT_CONCEPTS.availability_basis;
  assert.ok(basis, 'the basis has no entry of its own');
  for (const value of ['fitted', 'durability_prior', 'default_durability']) {
    assert.match(basis.plain, new RegExp(value), `${value} is not explained`);
  }
  assert.match(basis.why, /not a measurement/i);
  assert.match(STAT_CONCEPTS.chance_to_play.why, /basis/i,
    'the chance-to-play entry does not send the reader to the basis');
});

test('the emitted lexicon is the module, not a second copy that has drifted', () => {
  // The whole claim of this file is one name per stat everywhere. A client
  // reading a JSON artifact that no longer matches the module would break that
  // silently, so the artifact is generated and this test is the staleness gate.
  const emit = spawnSync(process.execPath, ['scripts/emit-stat-lexicon.mjs', '--check'],
    { encoding: 'utf8' });
  assert.equal(emit.status, 0,
    `${emit.stderr}${emit.stdout}\nrun: node scripts/emit-stat-lexicon.mjs`);
});
