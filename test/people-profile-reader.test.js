/**
 * PEOPLE-01: the typed per-roster profile from the one reader.
 *
 * Fixture chat DBs only (test/helpers/people-chat-fixture.js); placeholder
 * people, no names, no message text.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildTodayChat, buildRebuiltChat, seedLeague, LEAGUE, NEW_KEYS } from './helpers/people-chat-fixture.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-people-reader-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'app.sqlite');
const TODAY = path.join(temp, 'today.sqlite');
const REBUILT = path.join(temp, 'rebuilt.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = REBUILT;
process.env.SCHEDULER_DISABLED = '1';
buildTodayChat(TODAY);
buildRebuiltChat(REBUILT);

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await import('../server/services/manager-identity.js');
const reader = await import('../server/services/people/profile-reader.js');
const pricing = await import('../server/services/counterparty-pricing.js');
await runMigrations();
seedLeague(run);

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const withChat = (file, fn) => {
  const saved = process.env.GRIDIRON_CHAT_DB_PATH;
  process.env.GRIDIRON_CHAT_DB_PATH = file;
  try { return fn(); } finally { process.env.GRIDIRON_CHAT_DB_PATH = saved; }
};

test('reader: one typed profile per trusted roster; Nick is self, a likely identity is not attached', () => {
  const r = reader.readPeopleProfiles(LEAGUE);
  assert.equal(r.available, true);
  assert.equal(r.version, reader.PROFILE_READER_VERSION);
  assert.deepEqual([...r.profiles.keys()].sort(), ['2', '3', '4']);
  assert.equal(r.self.chat_name, 'ME');
  assert.equal(r.self.roster_id, '1');
  assert.equal(r.self.status, 'known');
  assert.ok(!r.profiles.has('5'), 'roster 5 is only a likely match');
  assert.equal(r.as_of, '2026-09-23 22:10:00', 'the newest build stamp');
});

test('reader: a known profile carries as_of, messages_read, version, source and every new key', () => {
  const p = reader.readPeopleProfiles(LEAGUE).profiles.get('2');
  assert.equal(p.status, 'known');
  assert.equal(p.reason, null);
  assert.equal(p.as_of, '2026-09-23 22:00:00');
  assert.equal(p.messages_read, 120);
  assert.equal(p.version, reader.PROFILE_READER_VERSION);
  assert.equal(p.row_version, 'h1');
  assert.equal(p.source, 'claude-code-local');
  assert.deepEqual(p.fields.values_talk, NEW_KEYS.values_talk);
  assert.equal(p.fields.behaviour_vs_words, NEW_KEYS.behaviour_vs_words);
  assert.deepEqual(p.fields.changes_since_0918, NEW_KEYS.changes_since_0918);
  assert.equal(p.fields.headline, 'Trades a lot, rarely means no.');
  assert.equal(p.field_sources.headline, 'model');
  assert.equal(p.chat_style.msgs, 400);
  assert.equal(p.sentiment.length, 2);
});

test('reader: nick_override beats manager_notes beats the model read', () => {
  const p = reader.readPeopleProfiles(LEAGUE).profiles.get('2');
  // Model, note and override all speak to how_to_approach: the override wins.
  assert.equal(p.fields.how_to_approach, 'Nick: open low, he always counters.');
  assert.equal(p.field_sources.how_to_approach, 'nick_override');
  // Model and note speak to best_bait: the note wins.
  assert.equal(p.fields.best_bait, 'note: a young WR');
  assert.equal(p.field_sources.best_bait, 'manager_notes');
  // Override of a new key.
  assert.deepEqual(p.fields.deal_feelings, { urgency: 'low' });
  assert.equal(p.field_sources.deal_feelings, 'nick_override');
  assert.deepEqual(p.nick_override.deal_feelings, { urgency: 'low' });
  assert.equal(p.nick_notes.length, 3, 'every note is attached, including one that names no field');
});

test('reader: thin chat is typed absence, not a neutral profile', () => {
  const p = reader.readPeopleProfiles(LEAGUE).profiles.get('3');
  assert.equal(p.status, 'unknown');
  assert.match(p.reason, /thin chat: the profile read 12 messages, under 30/);
  assert.equal(p.messages_read, 12);
  for (const [k, v] of Object.entries(p.fields)) assert.ok(reader.isUnknown(v), `${k} is unknown`);
  assert.deepEqual(p.field_sources, {});
});

test('reader: entity_map attaches a profile stored under an alias; notes under the alias follow', () => {
  const p = reader.readPeopleProfiles(LEAGUE).profiles.get('4');
  assert.equal(p.status, 'known');
  assert.equal(p.chat_name, 'P-Charlie');
  assert.equal(p.messages_read, 200);
  assert.deepEqual(p.fields.what_moves_him, ['note: rapport']);
  assert.equal(p.field_sources.what_moves_him, 'manager_notes');
  assert.deepEqual(p.fields.values_talk, NEW_KEYS.values_talk);
  assert.ok(reader.isUnknown(p.fields.deal_feelings), 'a key his profile lacks is unknown, not empty');
  assert.match(p.fields.deal_feelings.reason, /no deal_feelings/);
});

test('reader: on main\'s shape the new keys are unknown and an invalid profile is an unknown person', () => {
  const r = withChat(TODAY, () => reader.readPeopleProfiles(LEAGUE));
  assert.equal(r.sources.manager_notes, 'absent');
  assert.equal(r.sources.entity_map, 'absent');
  const a = r.profiles.get('2');
  assert.equal(a.status, 'known');
  for (const k of reader.EXTENSION_KEYS) assert.ok(reader.isUnknown(a.fields[k]), `${k} unknown before the rebuild`);
  const c = r.profiles.get('4');
  assert.equal(c.status, 'unknown');
  assert.match(c.reason, /failed validation/);
  assert.ok(reader.isUnknown(c.fields.headline));
});

test('reader: no chat DB and no trusted identity are two different absences', () => {
  const gone = withChat(path.join(temp, 'missing.sqlite'), () => reader.readPeopleProfiles(LEAGUE));
  assert.equal(gone.available, false);
  assert.equal(gone.reason, 'chat DB not found');
  assert.equal(gone.profiles.size, 0);
  const none = reader.readPeopleProfiles(999);
  assert.equal(none.available, false);
  assert.match(none.reason, /no confirmed chat identities/);
});

test('reader: a manager_notes table of an unknown shape is reported, not guessed at', () => {
  const odd = path.join(temp, 'odd.sqlite');
  buildTodayChat(odd);
  const c = new DatabaseSync(odd);
  c.exec(`CREATE TABLE manager_notes (who TEXT, words TEXT)`);
  c.close();
  const r = withChat(odd, () => reader.readPeopleProfiles(LEAGUE));
  assert.equal(r.sources.manager_notes, 'unrecognised');
  assert.equal(r.profiles.get('2').nick_notes.length, 0);
});

test('reader: a bad override key costs that key only, never the profile', () => {
  const bad = path.join(temp, 'bad-override.sqlite');
  buildRebuiltChat(bad);
  const c = new DatabaseSync(bad);
  const stored = JSON.parse(c.prepare(`SELECT profile_json FROM negotiation_profiles WHERE name = 'P-Alpha'`).get()
    .profile_json);
  stored.nick_override = { confidence: 'certain', mystery: 1, best_bait: 'override bait' };
  c.prepare(`UPDATE negotiation_profiles SET profile_json = ? WHERE name = 'P-Alpha'`).run(JSON.stringify(stored));
  c.close();
  const p = withChat(bad, () => reader.readPeopleProfiles(LEAGUE)).profiles.get('2');
  assert.equal(p.status, 'known');
  assert.equal(p.fields.confidence, 'medium', 'the invalid override value is dropped');
  assert.equal(p.fields.best_bait, 'override bait');
  assert.ok(p.warnings.some(w => /confidence/.test(w)));
  assert.ok(p.warnings.some(w => /mystery: unexpected key/.test(w)));
});

test('pricing reads through the reader: core keys only, override applied, new keys never leak into the served profile', () => {
  const r = pricing.negotiationProfilesFor(LEAGUE);
  assert.equal(r.available, true);
  const alpha = r.byRoster.get('2').profile;
  assert.equal(alpha.how_to_approach, 'Nick: open low, he always counters.');
  for (const k of [...reader.EXTENSION_KEYS, 'nick_override']) assert.ok(!(k in alpha), `${k} is not served`);
  assert.deepEqual([...r.byRoster.keys()].sort(), ['2', '3', '4'], 'the aliased profile attaches');
  assert.equal(pricing.negotiationProfileErrors({ ...alpha, ...NEW_KEYS }).length, 0,
    'the rebuilt keys are not "unexpected" to the validator');
});
