/**
 * HUB-PUBLISH-PEOPLE: people.profile and people.counterpart publish through the engine hub.
 *
 * A daemon tick (not a request) writes one row per manager per field, typed unknown where
 * there is no read; the hub read helper returns exactly what the direct reader / counterpart
 * model return (field by field); people.* fields have exactly one registered producer; and
 * the producers stay out of the daemon unless GRIDIRON_HUB_PEOPLE (or preview) is on.
 *
 * Fixtures only: leagues 41 (chat corpus) and 42 (none), invented names, no chat text.
 * The private chat DB is never read: GRIDIRON_CHAT_DB_PATH points at a temp fixture.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-hub-people-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const CHAT_PATH = path.join(temp, 'chat.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = CHAT_PATH;
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.GRIDIRON_PROCESS_ROLE = 'test';
delete process.env.GRIDIRON_HUB_PEOPLE;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = '2026-09-24T12:00:00.000Z';

/* ------------------------------------------------------------------ chat fixture */
function profile(i, extra = {}) {
  return {
    headline: `SECRET-HEADLINE-${i}`,
    says_no: { how: 'plain', does_his_no_hold: 'rarely (sentence)', evidence: ['SECRET-EVIDENCE'] },
    praise_means: { reading: 'marketing — hypes', why: 'w', hypes_before_selling: true, evidence: ['e'] },
    techniques: [{ name: 'SECRET-TECHNIQUE', how_he_does_it: 'h', evidence: ['e'], how_often: 'often (8)' }],
    calibration: { enthusiasm_scale: 's', inflation: 'moderate' },
    roster_read: { really_untouchable: [], quietly_available: [], overvalues: [], undervalues: [], reasoning: 'r' },
    what_moves_him: ['m'], how_to_approach: 'a', confidence: 'High.', caveats: ['c'],
    as_of: '2026-09-22', messages_read: 100 + i,
    ...extra,
  };
}
{
  const chat = new DatabaseSync(CHAT_PATH);
  chat.exec(`CREATE TABLE negotiation_profiles (name TEXT PRIMARY KEY, profile_json TEXT NOT NULL, messages_read INTEGER,
      corpus_hash TEXT, model TEXT, built_at TEXT NOT NULL);
    CREATE TABLE manager_notes (name TEXT, note TEXT, source TEXT, noted_at TEXT);`);
  const np = chat.prepare('INSERT INTO negotiation_profiles VALUES (?,?,?,?,?,?)');
  const rows = [
    ['ME', profile(0)],
    ['Person B', profile(1, { values_talk: { wants: [{ player: 'Fixture Two', at: '2026-09-22T00:00:00Z', n: 4 }] } })],
    ['Person C', profile(2, { messages_read: 5 })], // quiet: typed unknown
    ['Person D', profile(3, { nick_override: { contactable: false, note: 'SECRET-NOTE' } })],
  ];
  for (const [name, p] of rows) np.run(name, JSON.stringify(p), p.messages_read, `hash${p.messages_read}`, 'fixture-model', '2026-09-22 05:00:00');
  chat.prepare('INSERT INTO manager_notes VALUES (?,?,?,?)').run('Person B', 'SECRET-NICK-NOTE', 'nick-chat-1', '2026-09-21');
  chat.close();
}

/* ------------------------------------------------------------------ app fixture */
const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await import('../server/services/manager-identity.js'); // league_member_identity DDL
await runMigrations();
db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, tx_id))`);
run(`INSERT INTO leagues(id, platform, league_id, season, name, my_team_id) VALUES
  (41, 'espn', 'fx-41', 2026, 'L41', '1'), (42, 'espn', 'fx-42', 2026, 'L42', '2')`);
['ME', 'Person B', 'Person C', 'Person D'].forEach((name, i) => run(`INSERT INTO league_member_identity (league_id,
    roster_id, espn_member_id, espn_name, team_name, chat_name, match_method, confidence)
    VALUES (41, ?, ?, ?, ?, ?, 'fixture', 'confirmed')`, String(i + 1), `{M${i}}`, `Espn ${i}`, `Team ${i + 1}`, name));
const lineup = (league, team, player, name) => run(`INSERT INTO league_roster_snapshots (league_id, season,
    scoring_period_id, team_id, espn_player_id, player_id, player_name, position, lineup_slot_id, lineup_slot, is_starter,
    on_roster, source, first_seen_at, changed_at) VALUES (?, 2026, 3, ?, ?, ?, ?, 'RB', 2, 'RB', 1, 1, 'live',
    '2026-09-20T10:00:00.000Z', '2026-09-20T10:00:00.000Z')`, league, team, player, player, name);
lineup(41, 1, 9102, 'Fixture Two'); lineup(41, 2, 9101, 'Fixture One'); lineup(41, 3, 9103, 'Fixture Three');
lineup(41, 4, 9104, 'Fixture Four'); lineup(41, 5, 9105, 'Fixture Five'); // team 5: no chat identity
lineup(42, 1, 9201, 'Fixture Six'); lineup(42, 2, 9202, 'Fixture Seven');

const registry = await import('../server/services/engine/registry.js');
const people = await import('../server/services/engine/producers/people.js');
const hub = await import('../server/services/people/hub-read.js');
const reader = await import('../server/services/people/profile-reader.js');
const cpm = await import('../server/services/people/counterpart.js');
const { daemonProducers } = await import('../server/services/engine/producers/index.js');
const { buildDag } = await import('../server/services/engine/daemon/dag.js');
const { runTick } = await import('../server/services/engine/daemon/tick.js');

const withEnv = (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  }
};
const peopleRows = () => db.prepare(`SELECT field, league_id, entity_id, value, health FROM engine_state
    WHERE field LIKE 'people.%' ORDER BY id`).all();

/* ------------------------------------------------------------------ flag */
test('flag: default off keeps the daemon DAG as it was; =1 or preview adds both producers; =0 vetoes preview', () => {
  const names = () => buildDag(daemonProducers()).order.map(p => p.name);
  withEnv({ GRIDIRON_HUB_PEOPLE: null, GRIDIRON_PREVIEW_UNCONFIRMED: null }, () =>
    assert.deepEqual(names(), ['calendar', 'league', 'gamescript']));
  withEnv({ GRIDIRON_HUB_PEOPLE: '1' }, () =>
    assert.deepEqual(names(), ['calendar', 'league', 'gamescript', 'people-profile', 'people-counterpart']));
  withEnv({ GRIDIRON_HUB_PEOPLE: null, GRIDIRON_PREVIEW_UNCONFIRMED: '1' }, () => {
    assert.equal(people.hubPeopleFlag().preview, true);
    assert.ok(names().includes('people-counterpart'));
  });
  withEnv({ GRIDIRON_HUB_PEOPLE: '0', GRIDIRON_PREVIEW_UNCONFIRMED: '1' }, () =>
    assert.deepEqual(names(), ['calendar', 'league', 'gamescript']));
});

test('before any tick the hub read is unavailable with a reason, never an empty ok', async () => {
  const r = await hub.hubPeopleProfile(41);
  assert.equal(r.available, false);
  assert.match(r.reason, /no people\.profile rows/);
  assert.equal(peopleRows().length, 0);
});

/* ------------------------------------------------------------------ the tick */
let firstTick;
test('one daemon tick writes one row per manager per field, typed unknown where there is no read', async () => {
  const dag = withEnv({ GRIDIRON_HUB_PEOPLE: '1' }, () => buildDag(daemonProducers()).order);
  firstTick = await runTick({ database: db, dag, now: new Date(NOW), heartbeat: () => {} });
  assert.deepEqual(firstTick.failed, []);
  const rows = peopleRows();
  const count = (field, league) => new Set(rows.filter(r => r.field === field && r.league_id === league).map(r => r.entity_id)).size;
  assert.equal(count('people.profile', 41), 5, 'teams 1-5: self + 4 managers');
  assert.equal(count('people.counterpart', 41), 5);
  assert.equal(count('people.profile', 42), 2);
  assert.equal(count('people.counterpart', 42), 2);

  const at = (field, id) => rows.filter(r => r.field === field && r.entity_id === id).at(-1);
  const v = (field, id) => JSON.parse(at(field, id).value);
  assert.equal(v('people.profile', '41:1').scope, 'self');
  assert.equal(v('people.profile', '41:2').status, 'ok');
  assert.equal(v('people.profile', '41:2').labels.does_his_no_hold, 'rarely');
  assert.equal(v('people.profile', '41:2').source, 'server/services/people/profile-reader.js');
  assert.equal(v('people.profile', '41:3').status, 'unknown');
  assert.match(v('people.profile', '41:3').reason, /quiet in chat/);
  assert.equal(v('people.profile', '41:5').status, 'unknown');
  assert.equal(v('people.profile', '41:5').reason, 'no confirmed chat identity');
  // League 42 has no chat corpus: null value, absence typed unknown.
  assert.equal(at('people.profile', '42:1').value, null);
  assert.equal(JSON.parse(at('people.profile', '42:1').health).absence.status, 'unknown');
  // Counterparts: self typed absent; Nick's not-contactable read reaches the model.
  assert.equal(at('people.counterpart', '41:1').value, null);
  assert.match(JSON.parse(at('people.counterpart', '41:1').health).absence.reason, /not a counterparty/);
  assert.equal(v('people.counterpart', '41:4').override.exclude, true);
  assert.equal(v('people.counterpart', '41:2').wants.length, 1);
  assert.equal(v('people.counterpart', '41:2').source, 'server/services/people/counterpart.js');
  assert.equal(v('people.counterpart', '41:2').model_now, '2026-09-24T00:00:00.000Z');
  // Labels and counts only: no chat text, no names, no note text on the hub.
  const all = JSON.stringify(rows.map(r => r.value));
  for (const s of ['SECRET', 'Person B', 'Fixture Two', 'ME"']) assert.ok(!all.includes(s), `hub row carries ${s}: ${all.slice(Math.max(0, all.indexOf(s) - 200), all.indexOf(s) + 40)}`);
  // Written by the daemon's runs, recorded in engine_runs.
  const runs = db.prepare(`SELECT producer, error, ms FROM engine_runs WHERE tick_id = ? AND producer LIKE 'people-%' AND finished_at IS NOT NULL`).all(firstTick.tick_id);
  assert.deepEqual(runs.map(r => r.producer).sort(), ['people-counterpart', 'people-profile']);
  assert.ok(runs.every(r => r.error == null));
});

test('the counterpart row cites the profile row it was built beside', () => {
  const r = db.prepare(`SELECT reason_chain FROM engine_state WHERE field = 'people.counterpart' AND entity_id = '41:2'`).get();
  const p = db.prepare(`SELECT id FROM engine_state WHERE field = 'people.profile' AND entity_id = '41:2'`).get();
  assert.deepEqual(JSON.parse(r.reason_chain).contributions[0].state_ids, [Number(p.id)]);
});

test('an unchanged world the same day writes nothing (write-on-change)', async () => {
  const before = peopleRows().length;
  const dag = withEnv({ GRIDIRON_HUB_PEOPLE: '1' }, () => buildDag(daemonProducers()).order);
  const t = await runTick({ database: db, dag, now: new Date('2026-09-24T12:10:00.000Z'), heartbeat: () => {} });
  assert.deepEqual(t.failed, []);
  assert.equal(peopleRows().length, before);
});

/* ------------------------------------------------------------------ parity */
test('the hub read equals the direct reader and counterpart model, field by field', async () => {
  const later = { asOf: '2026-09-24T13:00:00.000Z' };
  assert.equal((await hub.hubPeopleProfile(41, { asOf: '2026-09-24T11:00:00.000Z' })).available, false, 'as-of: nothing before the tick');
  const hp = await hub.hubPeopleProfile(41, later);
  const hc = await hub.hubPeopleCounterpart(41, later);
  assert.equal(hp.available, true);
  assert.equal(hp.self_roster, '1');
  const league = (await people.peopleLeagues()).find(l => l.id === 41);
  const direct = await people.directPeople(league, { asOf: hc.as_of, people: await reader.peopleProfile(41) });
  const json = x => JSON.parse(JSON.stringify(x));
  for (const roster of ['2', '3', '4']) {
    assert.deepEqual(hp.byRoster.get(roster).value, json(people.profileLabels(direct.people.byRoster.get(roster))), `profile ${roster}`);
    assert.deepEqual(hc.byRoster.get(roster).value,
      json(people.counterpartValue(direct.counterparts.get(roster), { modelNow: direct.now })), `counterpart ${roster}`);
  }
  assert.deepEqual(hp.self.value, json(people.profileLabels(direct.people.self, { scope: 'self' })));
  // Each entry carries source + as_of.
  assert.equal(hp.byRoster.get('2').producer, 'people-profile');
  assert.equal(hp.byRoster.get('2').as_of, NOW);
  // The rehydrated models give consumers the same answers as the direct ones.
  const fromHub = hub.counterpartsFromHub(hc);
  for (const team of ['2', '3', '4', '5']) {
    const d = direct.counterparts.get(team);
    const h = fromHub.get(team);
    assert.deepEqual(cpm.targetTilt(fromHub, team, '9101', ['9102']), cpm.targetTilt(direct.counterparts, team, '9101', ['9102']), `tilt ${team}`);
    const pr = { p: 0.4, basis: 'fixture' };
    assert.deepEqual(cpm.respondsAdjust(pr, h, ['9102'], { baseAnchor: 0.6 }), cpm.respondsAdjust(pr, d, ['9102'], { baseAnchor: 0.6 }), `responds ${team}`);
    assert.deepEqual(cpm.priceCap(h), cpm.priceCap(d));
  }
  // A league without a corpus reads available, every entry typed absent.
  const h42 = await hub.hubPeopleProfile(42, later);
  assert.equal(h42.available, true);
  assert.equal(h42.self.value, null);
  assert.equal(h42.self.absence.status, 'unknown');
  // Its one counterparty still gets a model: typed unknown (no chat feature), reply prior kept.
  const m42 = hub.counterpartsFromHub(await hub.hubPeopleCounterpart(42, later));
  assert.deepEqual([...m42.keys()], ['1']);
  assert.equal(m42.get('1').status, 'unknown');
  assert.equal(m42.get('1').reply_prior.ignore, cpm.M6_REPLY_PRIOR.ignore);
});

/* ------------------------------------------------------------------ ratchet */
test('ratchet: every people.* field has exactly one registered producer, declared in producers/people.js', () => {
  const walk = dir => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? (d.name === 'node_modules' ? [] : walk(path.join(dir, d.name)))
      : /\.(m?js)$/.test(d.name) ? [path.join(dir, d.name)] : []);
  const files = [...walk('server'), ...walk('scripts')];
  const decl = new Map();
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of src.matchAll(/registerField\(\s*['"](people\.[^'"]+)['"]/g)) decl.set(m[1], [...(decl.get(m[1]) ?? []), f]);
    for (const m of src.matchAll(/registerProducer\(\s*\{[\s\S]*?\n\}\);/g)) {
      for (const fm of m[0].matchAll(/\bfield:\s*['"](people\.[^'"]+)['"]/g)) decl.set(fm[1], [...(decl.get(fm[1]) ?? []), f]);
    }
  }
  // Known-nonzero control: the grep finds both fields.
  assert.deepEqual([...decl.keys()].sort(), ['people.counterpart', 'people.profile']);
  for (const [field, where] of decl) {
    assert.deepEqual(where, ['server/services/engine/producers/people.js'], `${field} declared in ${where.join(', ')}`);
  }
  // At runtime: one producer each, and nobody else may claim them.
  assert.equal(registry.fieldSpec('people.profile').producer, 'people-profile');
  assert.equal(registry.fieldSpec('people.counterpart').producer, 'people-counterpart');
  assert.throws(() => registry.registerField('people.profile', { producer: 'someone-else', version: '1' }), /one producer/);
  // In the database: engine_fields names the same one producer.
  const stored = db.prepare(`SELECT field, producer FROM engine_fields WHERE field LIKE 'people.%' ORDER BY field`).all();
  assert.deepEqual(stored.map(r => [r.field, r.producer]), [['people.counterpart', 'people-counterpart'], ['people.profile', 'people-profile']]);
});
