/**
 * READER-SWITCH: counterparty-pricing reads people.profile through the one
 * reader (server/services/people/profile-reader.js), so its Nick read and
 * people.profile can no longer disagree.
 *
 * Before the switch, negotiationProfilesFor ran its own nickRead: it read notes
 * from EVERY source and inferred buyer/active/contactable from their wording.
 * The reader reads only notes whose source starts 'nick-chat-', takes keys only
 * from a JSON note, and never reads meaning into free text. On the local copy
 * the two disagreed on `buyer` for one manager, whose pattern is fixture
 * Person B below: a nick_override without `buyer`, a free-text nick-chat note
 * and a free-text 'nick' note that both say he is selling. Old: buyer=false
 * (from the note wording). The one rule: buyer unknown (null).
 *
 * Invented names, no chat text; GRIDIRON_CHAT_DB_PATH points at a temp fixture.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-cp-reader-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const CHAT_PATH = path.join(temp, 'chat.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = CHAT_PATH;
process.env.SCHEDULER_DISABLED = '1';

function profile(i, extra = {}) {
  return {
    headline: `Person ${i} headline.`,
    says_no: { how: 'plain', does_his_no_hold: 'usually', evidence: ['e'] },
    praise_means: { reading: 'belief', why: 'w', evidence: ['e'] },
    techniques: [{ name: 't', how_he_does_it: 'h', evidence: ['e'], how_often: 'often' }],
    calibration: { enthusiasm_scale: 's', inflation: 'mild' },
    what_moves_him: ['m'], how_to_approach: 'a', confidence: 'medium', caveats: ['c'],
    messages_read: 80 + i,
    ...extra,
  };
}

const PROFILES = [
  ['ME', profile(0)],
  // The disagreement pattern: override present, no buyer key in it.
  ['Person B', profile(1, { nick_override: { active: true } })],
  ['Person C', profile(2)],
  ['Person D', profile(3, { nick_override: { buyer: 'yes' } })],
  ['Person E', profile(4)],
];

const chat = new DatabaseSync(CHAT_PATH);
chat.exec(`
  CREATE TABLE negotiation_profiles (name TEXT PRIMARY KEY, profile_json TEXT NOT NULL, messages_read INTEGER,
    corpus_hash TEXT, model TEXT, built_at TEXT NOT NULL);
  CREATE TABLE manager_notes (name TEXT, note TEXT, source TEXT, noted_at TEXT);
`);
const np = chat.prepare('INSERT INTO negotiation_profiles VALUES (?,?,?,?,?,?)');
for (const [name, p] of PROFILES) np.run(name, JSON.stringify(p), p.messages_read, `h-${name}`, 'm', '2026-09-22 05:00:00');
const mn = chat.prepare('INSERT INTO manager_notes VALUES (?,?,?,?)');
mn.run('Person B', 'selling, rebuilding for next year', 'nick-chat-2026-09-23', '2026-09-23');
mn.run('Person B', 'not a buyer this year', 'nick', '2026-09-20');
mn.run('Person C', '{"buyer": false, "trades": "probably none"}', 'nick-chat-2026-09-23', '2026-09-23');
mn.run('Person D', '{"buyer": false}', 'nick-chat-2026-09-23', '2026-09-23'); // override says buyer
mn.run('Person E', '{"buyer": false}', 'chat', '2026-09-23');                 // not a nick-chat note
chat.close();

const { run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await import('../server/services/manager-identity.js'); // league_member_identity DDL
const pricing = await import('../server/services/counterparty-pricing.js');
const reader = await import('../server/services/people/profile-reader.js');
await runMigrations();

run(`INSERT INTO leagues(id, platform, league_id, season, name, my_team_id) VALUES (51, 'espn', 'fx-51', 2026, 'L51', '1')`);
PROFILES.map(([n]) => n).forEach((name, i) => run(`INSERT INTO league_member_identity (league_id, roster_id,
    espn_member_id, espn_name, team_name, chat_name, match_method, confidence)
    VALUES (51, ?, ?, ?, ?, ?, 'fixture', 'confirmed')`, String(i + 1), `{M${i}}`, `Espn ${i}`, `Team ${i + 1}`, name));

test('READER-SWITCH: free-text notes never set buyer (the disagreement pattern)', () => {
  const b = pricing.negotiationProfilesFor(51).nickByRoster.get('2');
  assert.equal(b.buyer, null, 'a note saying "selling" is kept as text, not read as buyer=false');
  assert.equal(b.active, true, 'the override still applies');
  assert.equal(b.deprioritised, false);
  assert.equal(b.notes.length, 1, "only the nick-chat note is kept; the 'nick' source note is not read");
});

test('READER-SWITCH: a JSON nick-chat note sets keys; the override beats it; other sources are ignored', () => {
  const r = pricing.negotiationProfilesFor(51);
  assert.equal(r.nickByRoster.get('3').buyer, false);
  assert.equal(r.nickByRoster.get('3').sources.buyer, 'manager_notes');
  assert.equal(r.nickByRoster.get('3').deprioritised, true);
  assert.equal(r.nickByRoster.get('4').buyer, true, 'nick_override beats the note');
  assert.equal(r.nickByRoster.get('4').sources.buyer, 'nick_override');
  assert.equal(r.nickByRoster.has('5'), false, "a 'chat' source note is not Nick's read");
  assert.equal(r.byRoster.get('5').nick, null);
});

test('READER-SWITCH: counterparty-pricing and people.profile agree on every roster', async () => {
  const r = pricing.negotiationProfilesFor(51);
  const p = await reader.peopleProfile(51);
  assert.equal(p.available, true);
  for (const rid of ['2', '3', '4', '5']) {
    assert.deepEqual(r.nickByRoster.get(rid) ?? null, p.byRoster.get(rid).nick, `roster ${rid}`);
    assert.equal(r.byRoster.get(rid).profile.says_no.does_his_no_hold, p.byRoster.get(rid).profile.says_no.does_his_no_hold);
  }
});

test('READER-SWITCH: the loader keeps its shape (byRoster, self, invalid, unmapped)', () => {
  const r = pricing.negotiationProfilesFor(51);
  assert.equal(r.available, true);
  assert.deepEqual([...r.byRoster.keys()].sort(), ['2', '3', '4', '5']);
  assert.equal(r.self.name, 'ME');
  assert.equal(r.self.roster_id, '1');
  assert.equal(r.self.scope, 'how the league chat sees Nick');
  assert.deepEqual(Object.keys(r.byRoster.get('2')).sort(),
    ['built_at', 'corpus_hash', 'messages_read', 'model', 'name', 'nick', 'profile', 'roster_id', 'unparsed']);
  assert.deepEqual(r.invalid, []);
  assert.deepEqual(r.unmapped, []);
  assert.equal(pricing.negotiationProfilesFor(99).available, false, 'no trusted identity: unavailable');
});
