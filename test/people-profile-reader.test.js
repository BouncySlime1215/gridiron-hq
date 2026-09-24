/**
 * FIX-00: the negotiation profiles rebuilt after 2026-09-18 are readable again.
 *
 * The fixture copies the SHAPES of the ten live rows in the private chat DB's
 * negotiation_profiles — which keys each carries, and the kind of sentence each
 * enum slot holds — with invented names and no chat text. Every row was
 * rejected by the v1 schema, so negotiationProfilesFor dropped all ten.
 *
 * Also covers manager_notes (Nick's own notes, same chat DB) and the
 * nick_override object, which beats anything read from the notes.
 *
 * The private chat DB is never read here: GRIDIRON_CHAT_DB_PATH points at a
 * fixture in a temp dir.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-people-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const CHAT_PATH = path.join(temp, 'chat.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = CHAT_PATH;
process.env.SCHEDULER_DISABLED = '1';

// ------------------------------------------------------------ live-row shapes
// v1 body; every enum slot below is overwritten per row with a sentence.
function base(i) {
  return {
    headline: `Person ${i} headline.`,
    says_no: { how: 'plain', hard_no_looks_like: ['x'], soft_no_looks_like: ['y'],
      does_his_no_hold: 'yes', evidence: ['e'] },
    praise_means: { reading: 'belief', why: 'w', hypes_before_selling: false, agrees_with_numbers: 'a',
      evidence: ['e'] },
    techniques: [{ name: 't', how_he_does_it: 'h', evidence: ['e'], how_often: 'often' }],
    calibration: { enthusiasm_scale: 's', baseline_tone: 'b', inflation: 'none' },
    roster_read: { really_untouchable: [], quietly_available: [], overvalues: [], undervalues: [], reasoning: 'r' },
    what_moves_him: ['m'],
    what_shuts_him_down: ['s'],
    how_to_approach: 'a',
    best_bait: 'b',
    confidence: 'medium',
    caveats: ['c'],
  };
}
// The v2 keys every rebuilt row carries.
function v2(i, extra = {}) {
  return {
    ...base(i),
    deal_feelings: { after_win: 'w', after_loss: 'l' },
    values_talk: { claims: ['c'], acts: ['a'] },
    behaviour_vs_words: 'says one thing, does another',
    changes_since_0918: ['more active'],
    as_of: '2026-09-22',
    messages_read: 100 + i,
    nick_override: {},
    ...extra,
  };
}
const CONFIDENCE_SENTENCES = ['medium — corpus is thin before week 2', 'High.', 'low (few trade threads)',
  'moderate', 'medium-high'];
function withSlots(p, { holds, reading, inflation, often }) {
  p.says_no.does_his_no_hold = holds;
  p.praise_means.reading = reading;
  p.calibration.inflation = inflation;
  p.techniques = often.map((o, k) => ({ name: `t${k}`, how_he_does_it: 'h', evidence: ['e'], how_often: o }));
  // Every live row writes a sentence here too (LOCAL run on a5598584: 10/10).
  p.confidence = CONFIDENCE_SENTENCES[p.messages_read % CONFIDENCE_SENTENCES.length];
  return p;
}

const LIVE_SHAPES = [
  ['ME', withSlots(v2(0, { subject: 'self' }),
    { holds: 'usually', reading: 'mixed', inflation: 'mild', often: ['often'] })],
  ['Person B', withSlots(v2(1, { slug: 'person-b', name: 'Person B', aliases: ['PB'] }),
    { holds: 'rarely (Player X is the exception)', reading: 'marketing — hypes before selling',
      inflation: 'moderate', often: ['often (8 offers in the window)', 'twice'] })],
  ['Person C', withSlots(v2(2, { league4_roster_id: 3,
    nick_override: { contactable: true, active: 'yes', difficulty: 'hard', buyer: false, note: 'set by hand' } }),
    { holds: 'Usually, unless the ask is a first', reading: 'belief, mostly', inflation: 'heavy — everything is elite',
      often: ['sometimes (3 times)'] })],
  ['Person D', withSlots(v2(3, { league_roster: { roster_id: '4', team: 'Team 4' } }),
    { holds: 'unknown — too few refusals to say', reading: 'habit; praises everyone',
      inflation: 'mild, with spikes', often: ['once'] })],
  ['Person E', withSlots(v2(4, { league4_roster_id: '5', aliases: [] }),
    { holds: 'yes — held every time', reading: 'hard to say', inflation: 'none that shows',
      often: ['once, in week 2'] })],
  ['Person F', withSlots(v2(5, { relations_note: 'r', security_note: 's', built_from: { messages: 3 } }), { holds: 'rarely', reading: 'mixed: some belief, some marketing',
    inflation: 'unknown', often: ['very often', '3 times'] })],
  ['Person G', withSlots(v2(6, { slug: 'person-g', league4_trade_record: [{ week: 2 }], built_at: '2026-09-22',
    sources: ['chat'] }), { holds: 'usually (two exceptions)',
    reading: 'belief', inflation: 'moderate to heavy', often: ['occasionally'] })],
  ['Person H', withSlots(v2(7, { name: 'Person H', subject: { chat_name: 'Person H' },
    best_bait: { player: 'Player Y', why: 'w' } }),
    { holds: 'mostly holds', reading: 'marketing', inflation: 'low', often: ['frequently'] })],
  ['Person I', withSlots(v2(8, { nick_override: { fan_of: ['Team Z'], trades: 'rarely' } }),
    { holds: 'no — folds when pushed', reading: 'unknown', inflation: 'heavy', often: ['twice'] })],
  ['Person J', withSlots(v2(9, { changes_since_0918: 'none' }),
    { holds: 'Rarely.', reading: 'Marketing.', inflation: 'Moderate.', often: ['Often.'] })],
];

function buildChat(file) {
  const chat = new DatabaseSync(file);
  chat.exec(`
    CREATE TABLE negotiation_profiles (name TEXT PRIMARY KEY, profile_json TEXT NOT NULL, messages_read INTEGER,
      corpus_hash TEXT, model TEXT, built_at TEXT NOT NULL);
    CREATE TABLE manager_notes (name TEXT, note TEXT, source TEXT, noted_at TEXT);
  `);
  const np = chat.prepare('INSERT INTO negotiation_profiles VALUES (?,?,?,?,?,?)');
  for (const [name, p] of LIVE_SHAPES) {
    np.run(name, JSON.stringify(p), p.messages_read, `h-${name}`, 'claude-sonnet-5', '2026-09-22 05:00:00');
  }
  const mn = chat.prepare('INSERT INTO manager_notes VALUES (?,?,?,?)');
  mn.run('Person B', 'inactive since week 2', 'nick', '2026-09-20');
  mn.run('Person B', "doesn't respond to offers", 'chat', '2026-09-21');
  mn.run('Person C', 'unreachable most weekends', 'chat', '2026-09-21');   // override says contactable
  mn.run('Person C', 'selling, rebuilding for next year', 'chat', '2026-09-19'); // override agrees: not a buyer
  mn.run('Person K', 'buyer, win-now', 'nick', '2026-09-21');              // no profile row at all
  chat.close();
}
buildChat(CHAT_PATH);

const { run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await import('../server/services/manager-identity.js'); // league_member_identity DDL
const pricing = await import('../server/services/counterparty-pricing.js');
const reader = await import('../server/services/people/profile-reader.js');
await runMigrations();

run(`INSERT INTO leagues(id, platform, league_id, season, name, my_team_id) VALUES (41, 'espn', 'fx-41', 2026, 'L41', '1')`);
const people = ['ME', 'Person B', 'Person C', 'Person D', 'Person E', 'Person F', 'Person G', 'Person H', 'Person I',
  'Person J', 'Person K'];
people.forEach((name, i) => run(`INSERT INTO league_member_identity (league_id, roster_id, espn_member_id, espn_name,
    team_name, chat_name, match_method, confidence) VALUES (41, ?, ?, ?, ?, ?, 'fixture', 'confirmed')`,
String(i + 1), `{M${i}}`, `Espn ${i}`, `Team ${i + 1}`, name));

// ---------------------------------------------------------------- the fix
test('FIX-00: all ten rebuilt profile shapes are valid and reach a roster', () => {
  const r = pricing.negotiationProfilesFor(41);
  assert.equal(r.available, true);
  assert.deepEqual(r.invalid, [], `rejected: ${JSON.stringify(r.invalid)}`);
  assert.equal(r.byRoster.size + (r.self ? 1 : 0), 10, '10/10 valid');
  assert.equal(r.self?.name, 'ME');
  assert.deepEqual([...r.byRoster.keys()].sort((a, b) => a - b), ['2', '3', '4', '5', '6', '7', '8', '9', '10']);
});

test('FIX-00: enum slots are normalised and the sentence is kept as <slot>_text', () => {
  const b = pricing.negotiationProfilesFor(41).byRoster.get('2').profile;
  assert.equal(b.says_no.does_his_no_hold, 'rarely');
  assert.equal(b.says_no.does_his_no_hold_text, 'rarely (Player X is the exception)');
  assert.equal(b.praise_means.reading, 'marketing');
  assert.equal(b.calibration.inflation, 'mild');
  assert.equal(b.calibration.inflation_text, 'moderate');
  assert.deepEqual(b.techniques.map(t => t.how_often), ['often', 'sometimes']);
  assert.equal(b.techniques[0].how_often_text, 'often (8 offers in the window)');
  assert.equal(b.confidence, 'high');
  assert.equal(b.confidence_text, 'High.');
  const h = pricing.negotiationProfilesFor(41).byRoster.get('8').profile;
  assert.deepEqual(h.best_bait, { player: 'Player Y', why: 'w' }, 'an object best_bait is kept');
});

test('FIX-00: parser cases', () => {
  const h = s => reader.parseHolds(s).value;
  assert.equal(h('yes'), 'yes');
  assert.equal(h('Usually, unless the ask is a first'), 'usually');
  assert.equal(h('rarely (Player X is the exception)'), 'rarely');
  assert.equal(h('Rarely.'), 'rarely');
  assert.equal(h('mostly holds'), 'usually');
  assert.equal(h('no — folds when pushed'), 'rarely');
  assert.equal(h('unknown — too few refusals'), 'unknown');
  assert.deepEqual(reader.parseHolds('hard to say'), { value: 'unknown', parsed: false });

  const o = s => reader.parseHowOften(s).value;
  assert.equal(o('often (8 offers)'), 'often');
  assert.equal(o('very often'), 'often');
  assert.equal(o('sometimes (3 times)'), 'sometimes');
  assert.equal(o('twice'), 'sometimes');
  assert.equal(o('once, in week 2'), 'once');
  assert.equal(o('3 times'), 'sometimes');
  assert.equal(o('1 time'), 'once');
  assert.equal(o('9 times'), 'often');
  assert.equal(o('frequently'), 'often');

  const c = s => reader.parseConfidence(s).value;
  assert.equal(c('High.'), 'high');
  assert.equal(c('medium — corpus is thin'), 'medium');
  assert.equal(c('medium-high'), 'medium');
  assert.equal(c('moderate'), 'medium');
  assert.equal(c('low (few trade threads)'), 'low');
  assert.deepEqual(reader.parseConfidence('hard to say'), { value: 'low', parsed: false },
    'an unparseable confidence is low');
  assert.equal(reader.parseReading('mostly marketing').value, 'marketing', 'a hedge word is skipped');
  assert.equal(reader.parseHolds('mostly holds').value, 'usually', '...unless the parser knows it');

  const f = s => reader.parseInflation(s).value;
  assert.equal(f('moderate'), 'mild');
  assert.equal(f('Moderate.'), 'mild');
  assert.equal(f('none that shows'), 'none');
  assert.equal(f('heavy — everything is elite'), 'heavy');
  assert.equal(f('low'), 'mild');
  assert.deepEqual(reader.parseInflation('depends'), { value: 'unknown', parsed: false });

  const p = s => reader.parseReading(s).value;
  assert.equal(p('marketing — hypes before selling'), 'marketing');
  assert.equal(p('belief, mostly'), 'belief');
  assert.equal(p('habit; praises everyone'), 'habit');
  assert.equal(p('mixed: some of both'), 'mixed');
  assert.deepEqual(reader.parseReading('hard to say'), { value: 'mixed', parsed: false },
    'an unparseable praise reading is mixed');
});

test('FIX-00: an unparsed slot is reported by path, never by its text', () => {
  const e = pricing.negotiationProfilesFor(41).byRoster.get('5');
  assert.equal(e.profile.praise_means.reading, 'mixed');
  assert.ok(e.unparsed.includes('praise_means.reading -> mixed'));
  assert.ok(!JSON.stringify(e.unparsed).includes('hard to say'));
});

test('FIX-00: the schema still rejects what it should', () => {
  const ok = LIVE_SHAPES[1][1];
  assert.deepEqual(reader.readProfile(ok).errors, []);
  const typo = reader.readProfile({ ...ok, nick_overide: {} });
  assert.ok(typo.errors.some(e => /nick_overide: unexpected key/.test(e)));
  const badKey = reader.readProfile({ ...ok, nick_override: { mood: 'x' } });
  assert.ok(badKey.errors.some(e => /nick_override\.mood: unexpected key/.test(e)));
  const badType = reader.readProfile({ ...ok, messages_read: 'many' });
  assert.ok(badType.errors.some(e => /messages_read: expected number/.test(e)));
  const leak = reader.readProfile({ ...ok, deal_feelings: { a: '<parameter name="x">' } });
  assert.ok(leak.errors.some(e => /deal_feelings\.a: leaked tool-call markup/.test(e)));
  const nonString = reader.readProfile({ ...ok, says_no: { ...ok.says_no, does_his_no_hold: 3 } });
  assert.ok(nonString.errors.some(e => /does_his_no_hold: expected string/.test(e)));
  const conf = reader.readProfile({ ...ok, confidence: 7 });
  assert.ok(conf.errors.some(e => /confidence: expected string/.test(e)));
  assert.deepEqual(reader.readProfile('x').errors, ['profile: expected object']);
});

test('FIX-00 / READER-SWITCH: Nick\'s read per roster is the reader\'s one rule', () => {
  // THE rule (profile-reader.js#nickBlock): nick_override, then only notes whose
  // source starts 'nick' (source LIKE 'nick%': 'nick', 'nick+data', 'nick-chat-*').
  // A free-text note is kept as a note, never parsed for meaning (the retired
  // nickRead word rules are gone), and a 'chat' source note is not Nick's word.
  const r = pricing.negotiationProfilesFor(41);
  const b2 = r.byRoster.get('2').nick;
  assert.equal(b2.notes.length, 1, "the 'nick' source note is Nick's; the 'chat' one is not read");
  assert.deepEqual([b2.active, b2.contactable, b2.unreachable], [null, null, false], 'free text sets no flag');

  const c = r.byRoster.get('3').nick;
  assert.equal(c.contactable, true, 'override beats "unreachable" in the notes');
  assert.equal(c.sources.contactable, 'nick_override');
  assert.equal(c.active, true);
  assert.equal(c.difficulty, 'hard');
  assert.equal(c.buyer, false);
  assert.equal(c.sources.buyer, 'nick_override');
  assert.equal(c.note, 'set by hand');

  assert.equal(r.byRoster.get('4').nick, null);
  // A person with only a 'nick' note and no profile still has Nick's block (kept note, no flags).
  assert.equal(r.nickByRoster.get('11').notes.length, 1);
  assert.equal(r.nickByRoster.get('11').buyer, null, 'free text is never parsed into a flag');
  assert.equal(r.nickByRoster.get('3'), r.byRoster.get('3').nick);
  assert.equal(r.nickByRoster.has('1'), false, 'Nick has no read of himself');
});

test('FIX-00: no manager_notes table is not an error', () => {
  const chat = new DatabaseSync(CHAT_PATH);
  chat.exec('ALTER TABLE manager_notes RENAME TO manager_notes_off');
  chat.close();
  try {
    const r = pricing.negotiationProfilesFor(41);
    assert.equal(r.byRoster.size, 9);
    assert.match(r.notes_reason, /no manager_notes table/);
    assert.equal(r.byRoster.get('3').nick.contactable, true, 'the override still applies');
  } finally {
    const c = new DatabaseSync(CHAT_PATH);
    c.exec('ALTER TABLE manager_notes_off RENAME TO manager_notes');
    c.close();
  }
});

// ------------------------------------------------------------ ONE-READER: people.profile
// Shapes only: invented names, no chat text. The live DB had one best_bait as a
// list of strings, which v2 rejected (9/10 valid on the ONE-READER local copy).

test('ONE-READER: a best_bait list of strings is valid', () => {
  const p = { ...LIVE_SHAPES[1][1], best_bait: ['b1', 'b2', 'b3'] };
  assert.deepEqual(reader.readProfile(p).errors, []);
  assert.ok(reader.readProfile({ ...p, best_bait: [1] }).errors.some(e => /best_bait: expected/.test(e)));
});

test('ONE-READER: parseProfileJson is the one parse; it names no stored text', () => {
  assert.deepEqual(reader.parseProfileJson('{"a":1}'), { raw: { a: 1 }, error: null });
  assert.deepEqual(reader.parseProfileJson('{"a":'), { raw: null, error: 'unparseable JSON' });
  assert.deepEqual(reader.parseProfileJson(null), { raw: null, error: 'profile_json: missing' });
});

const nickNote = (name, note, at = '2026-09-23') => ({ name, note, source: 'nick-chat-2026-09-23', noted_at: at });

test('ONE-READER: nickBlock reads nick_override and nick-chat-* notes only; override wins', () => {
  const b = reader.nickBlock({ contactable: false, note: 'n' }, [
    nickNote('X', 'free text is kept, never parsed'),
    nickNote('X', '{"active": true, "contactable": true}'),
    { name: 'X', note: '{"buyer": false}', source: 'chat', noted_at: '2026-09-22' },   // not Nick's: ignored
  ]);
  assert.equal(b.contactable, false, 'override beats the note on the same key');
  assert.equal(b.sources.contactable, 'nick_override');
  assert.equal(b.active, true);
  assert.equal(b.sources.active, 'manager_notes');
  assert.equal(b.buyer, null, 'a non nick-chat source is not Nick\'s block');
  assert.equal(b.unreachable, true);
  assert.equal(b.in_active_pool, false, 'an unreachable manager is never in the pool');
  assert.equal(b.notes.length, 1);
  const pub = reader.publicNick(b);
  assert.equal(pub.notes_n, 2);
  assert.ok(!('notes' in pub) && !('note' in pub), 'no note text in the public block');

  const d = reader.nickBlock({ buyer: 'no', trades: 'probably none', difficulty: 'hard to deal with', active: 'true' });
  assert.deepEqual([d.buyer, d.deprioritised, d.hard, d.active, d.in_active_pool], [false, true, true, true, false]);
  assert.equal(reader.nickBlock(null, []), null);
  assert.deepEqual(reader.nickBlock({ mood: 'x' }), { empty: true, warnings: ['nick_override.mood: unexpected key, ignored'] });
});

test('INT-4: every Nick-authored source counts (nick, nick+data, nick-chat-*); others do not', () => {
  const src = source => ({ name: 'X', note: '{"active": true}', source, noted_at: '2026-09-24' });
  for (const s of ['nick', 'nick+data', 'nick-chat-2026-09-24', 'Nick']) {
    assert.equal(reader.nickBlock(null, [src(s)]).active, true, s);
  }
  for (const s of ['chat', 'model', 'claude', 'not-nick']) assert.equal(reader.nickBlock(null, [src(s)]), null, s);
});

test('INT-4: untouchable notes resolve to player ids on that roster only; unmatched names are said', () => {
  assert.equal(reader.untouchableName('untouchable: Player One (Nick 9/24: no chance he trades him)'), 'Player One');
  assert.equal(reader.untouchableName('Untouchable - Player Two'), 'Player Two');
  assert.equal(reader.untouchableName('he says Player One is untouchable'), null, 'only the note form is parsed');
  const b = reader.nickBlock({ active: true }, [
    { note: 'untouchable: Player One Jr. (Nick 9/24)', source: 'nick-chat-2026-09-24' },
    { note: 'untouchable: Nobody Here', source: 'nick' },
    { note: 'untouchable: Player Three', source: 'chat' }]);            // not Nick's: ignored
  assert.deepEqual(b.untouchable_names, ['Player One Jr.', 'Nobody Here']);
  assert.equal(b.untouchable, null, 'unresolved until matched against a roster');
  const r = reader.resolveUntouchables(b, [{ id: 101, name: 'Player One' }, { id: 102, name: 'Player Three' }]);
  assert.deepEqual(r.untouchable, ['101']);
  assert.deepEqual(r.untouchable_unmatched, ['Nobody Here']);
  assert.deepEqual([...reader.untouchableIds([r, null, { untouchable: ['7'] }])], ['101', '7']);
  const pub = reader.publicNick(r);
  assert.deepEqual([pub.untouchable, pub.untouchable_unmatched_n, 'untouchable_names' in pub], [['101'], 1, false]);
  assert.equal(reader.resolveUntouchables(null, []), null);

  const chat = new DatabaseSync(':memory:');
  chat.exec(`CREATE TABLE negotiation_profiles (name TEXT, profile_json TEXT);
             CREATE TABLE manager_notes (name TEXT, note TEXT, source TEXT, noted_at TEXT);`);
  const ins = chat.prepare('INSERT INTO manager_notes VALUES (?,?,?,?)');
  ins.run('A', 'untouchable: Player One', 'nick-chat-2026-09-24', '2026-09-24');
  ins.run('B', 'untouchable: Player One', 'nick-chat-2026-09-24', '2026-09-24');   // not on B's roster
  const ids = new Map([['1', { chat_name: 'A' }], ['2', { chat_name: 'B' }]]);
  const out = reader.nickBlocksFrom(chat, ids, { playersByRoster: new Map([['1', [{ id: 101, name: 'Player One' }]], ['2', []]]) });
  assert.deepEqual(out.byRoster.get('1').untouchable, ['101']);
  assert.deepEqual([out.byRoster.get('2').untouchable, out.byRoster.get('2').untouchable_unmatched], [[], ['Player One']]);
  chat.close();
});

function shape(i, extra = {}) { return withSlots(v2(i, extra), { holds: 'Rarely.', reading: 'belief', inflation: 'mild', often: ['once'] }); }
const row = (name, p, messagesRead, builtAt = '2026-09-22 05:00:00') => ({ name, profile_json: JSON.stringify(p),
  messages_read: messagesRead, model: 'm', built_at: builtAt, corpus_hash: `h-${name}` });

test('ONE-READER: people.profile types every roster; ONE quiet threshold; nick block on every noted manager', () => {
  assert.equal(reader.QUIET_MESSAGES, 30);
  const ids = new Map([['1', { chat_name: 'ME' }], ['2', { chat_name: 'A' }], ['3', { chat_name: 'B' }],
    ['4', { chat_name: 'C' }], ['5', { chat_name: 'D' }], ['6', { chat_name: 'E' }]]);
  const profiles = [
    row('ME', shape(0), 900),
    row('A', shape(1, { nick_override: { contactable: false } }), 200),
    row('B', shape(2, { nick_override: { active: true } }), 29),         // quiet: one under
    row('C', shape(3), 30),                                              // exactly the threshold: read
    row('D', { ...shape(4), messages_read: 'many' }, 150),               // invalid
    row('Z', shape(5), 100),                                             // no identity
  ];
  const notes = [nickNote('A', 'kept'), nickNote('B', 'kept'), nickNote('E', 'kept'), nickNote('ME', 'kept'),
    { name: 'C', note: 'kept', source: 'nick', noted_at: '2026-09-20' }];
  const r = reader.peopleProfileFromRows({ leagueId: 41, profiles, notes, ids, myTeam: '1' });
  assert.equal(r.field, 'people.profile');
  assert.equal(r.version, reader.READER_VERSION);
  assert.equal(r.self.name, 'ME');
  assert.equal(r.self.nick, null, 'Nick has no block on himself');
  assert.deepEqual([...r.byRoster.keys()], ['2', '3', '4', '5', '6']);
  const e = id => r.byRoster.get(id);
  assert.deepEqual([e('2').status, e('2').nick.contactable, e('2').nick.unreachable], ['ok', false, true]);
  assert.equal(e('3').status, 'unknown');
  assert.match(e('3').reason, /quiet in chat \(29 messages read, under 30\)/);
  assert.equal(e('3').profile, null, 'a quiet manager has no personal read');
  assert.equal(e('3').valid, true);
  assert.equal(e('3').nick.active, true, 'Nick\'s word does not depend on chat volume');
  assert.equal(e('4').status, 'ok');
  assert.equal(e('4').nick.notes.length, 1, "a 'nick' source note is Nick's block too (source LIKE 'nick%')");
  assert.deepEqual([e('5').status, e('5').valid], ['unknown', false]);
  assert.ok(e('5').errors.some(x => /messages_read: expected number/.test(x)));
  assert.deepEqual([e('6').status, e('6').reason], ['unknown', 'no chat profile built for this manager']);
  assert.equal(e('6').nick.notes.length, 1, 'notes without a profile still give a block');
  assert.deepEqual(r.unmapped, ['Z']);
  assert.deepEqual(r.counts, { rosters: 5, ok: 2, unknown: 3, invalid: 1, nick: 4, unreachable: 1 });
  assert.equal(reader.peopleProfileFromRows({ profiles, ids, quietBelow: 20 }).byRoster.get('3').status, 'ok');
  assert.equal(reader.peopleProfileFromRows({ profiles, ids, asOf: '2026-09-21' }).byRoster.get('2').reason,
    'no chat profile built for this manager', 'a profile built after asOf is not visible');
});

test('ONE-READER: peopleProfile reads the chat DB and agrees with negotiationProfilesFor', async () => {
  const r = await reader.peopleProfile(41);
  const old = pricing.negotiationProfilesFor(41);
  assert.equal(r.available, true);
  assert.equal(r.self.name, 'ME');
  assert.deepEqual([...r.byRoster.keys()].filter(k => r.byRoster.get(k).valid).sort(), [...old.byRoster.keys()].sort());
  assert.equal(r.byRoster.get('11').status, 'unknown', 'a person with notes and no profile is typed unknown');
  assert.equal(r.byRoster.get('3').nick.contactable, true, 'nick_override on the stored profile');
  assert.equal(r.byRoster.get('2').nick.notes.length, 1, "only the 'nick' source note is Nick's block");
  const b = r.byRoster.get('2').profile;
  assert.equal(b.says_no.does_his_no_hold, 'rarely');

  const chat = new DatabaseSync(CHAT_PATH);
  chat.exec('ALTER TABLE negotiation_profiles RENAME TO np_off');
  chat.close();
  try {
    const off = await reader.peopleProfile(41);
    assert.equal(off.available, false);
    assert.match(off.reason, /no negotiation_profiles table/);
  } finally {
    const c = new DatabaseSync(CHAT_PATH);
    c.exec('ALTER TABLE np_off RENAME TO negotiation_profiles');
    c.close();
  }
  assert.equal((await reader.peopleProfile(999)).available, false, 'no identities: unavailable, said');
});

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
