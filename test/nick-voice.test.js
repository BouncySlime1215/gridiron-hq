/**
 * VOICE-01: Coach writes Nick's outgoing texts in his voice (coach/voice.js) and COACH-MSG uses it
 * behind GRIDIRON_NICK_VOICE. Fixtures only: every text below is made up for this file, the chat
 * DB is an in-memory / temp fixture, and the plans are test/fixtures/warroom-contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const V = await import('../server/services/coach/voice.js');
const M = await import('../server/services/campaign/messages.js');
const C = await import('../server/services/campaign/message-check.js');
const { validatePlans } = await import('../server/services/campaign/plans-schema.js');

const PLANS = JSON.parse(fs.readFileSync(path.join(REPO, 'test/fixtures/warroom-contract/producer-plans.json'), 'utf8'));
const live = () => PLANS.leagues.filter(e => !e.error && e.next_move?.status === 'ok');

// Made-up texts in a phone register: first capital, u / ur / rn, no closing punctuation.
const FAKE = [
  'U up rn', 'Bet', 'Ur team is cooked lol', "I'm taking the over", 'Nah u good', 'Yea send it',
  'That was insane', "Don't do it bro", 'Lock in tn', 'Ok u win', 'U watching the game', 'Idk man',
  'Gonna check later', "I'll look rn", 'Wanna swap', 'U serious', 'Ur call', 'Lol ok',
];
const fakeRows = (thread = 'thread-a', register = 'league_dm') => FAKE.map((text, i) => ({ text, thread, register, ts: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z` }));
const PROFILE = V.profileOf(FAKE);
const NAMES = { 10: 'Alpha Runner (RB)', 11: 'Bravo Catcher (WR)', 12: 'Charlie Passer (QB)', 13: 'Delta Runner (TE)' };

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

/* ---------------------------------------------------------------- profile */

test('profileOf: shares, swaps and rates from the texts, and no text in the profile', () => {
  const p = PROFILE;
  assert.equal(p.n, FAKE.length);
  assert.equal(p.first_cap, 1);
  assert.equal(p.end_punct, 0);
  assert.equal(p.swaps.you.to, 'u');
  assert.equal(p.swaps.you.share, 1);
  assert.equal(p.swaps['right now'].share, 1);
  assert.ok(p.rates.u > 0 && p.rates.bet > 0);
  assert.ok(p.words.median <= 3);
  const json = JSON.stringify(p);
  for (const t of FAKE.filter(t => t.includes(' '))) assert.ok(!json.includes(t), 'a profile holds no message text');
});

test('burstRuns: consecutive own texts within the gap form one run; another speaker ends it', () => {
  const r = V.burstRuns([
    { is_from_me: 1, ts: '2026-01-01T00:00:00Z' }, { is_from_me: 1, ts: '2026-01-01T00:00:30Z' },
    { is_from_me: 0, ts: '2026-01-01T00:01:00Z' }, { is_from_me: 1, ts: '2026-01-01T00:02:00Z' },
    { is_from_me: 1, ts: '2026-01-01T01:00:00Z' },
  ]);
  assert.deepEqual(r, [2, 1, 1]);
});

test('buildVoiceProfiles: all, phone, registers, and a thread profile only past MIN_THREAD texts', () => {
  const big = Array.from({ length: V.MIN_THREAD }, (_, i) => ({ text: `U there ${i}`, thread: 'thread-big', register: 'league_dm' }));
  const scopes = V.buildVoiceProfiles([...fakeRows('thread-small'), ...big, { text: 'Hello there.', thread: 'x', register: 'other_group' }]);
  const names = scopes.map(s => s.scope);
  for (const s of ['all', 'phone', 'register:league_dm', 'register:other_group', 'thread:thread-big']) assert.ok(names.includes(s), s);
  assert.ok(!names.includes('thread:thread-small'));
  assert.equal(scopes.find(s => s.scope === 'phone').n, FAKE.length + V.MIN_THREAD);
});

test('registerOf: league chat and league DMs are the phone registers', () => {
  assert.equal(V.registerOf('messages', 'group'), 'league_group');
  assert.equal(V.registerOf('messages', 'dm'), 'league_dm');
  assert.equal(V.registerOf('messages_ext', 'fantasy_group'), 'league_group');
  assert.equal(V.registerOf('messages_ext', 'group_other'), 'other_group');
  assert.equal(V.registerOf('messages_ext', 'dm'), 'other_dm');
});

/* ---------------------------------------------------------------- styler */

test('styleText: bursts, swaps, casing and no closing punctuation; names and positions untouched', () => {
  const draft = 'Hey man! Looks like you could use a little help at RB, and Alpha Runner would slot right in. Would you do Alpha Runner for Bravo Catcher? No worries if not.';
  const r = V.styleText(draft, PROFILE, { keep: ['Alpha Runner', 'Bravo Catcher'] });
  assert.ok(r.bursts.length >= 2 && r.bursts.length <= V.MAX_BURSTS, r.text);
  assert.equal(r.text, r.bursts.join('\n'));
  assert.ok(!/\bhey\b/i.test(r.text));
  assert.ok(!/\byou\b/i.test(r.text), 'you -> u');
  assert.ok(/\bRB\b/.test(r.text) && r.text.includes('Alpha Runner') && r.text.includes('Bravo Catcher'));
  for (const b of r.bursts) assert.ok(!/[.!]$/.test(b), b);
  assert.deepEqual(V.styleText(draft, PROFILE, { keep: ['Alpha Runner', 'Bravo Catcher'] }), r, 'deterministic');
});

test('styleText: numbers and Team N pass through; apostrophes follow the profile', () => {
  const r = V.styleText("I'm thinking Team 7 at 4%. Don't wait.", PROFILE);
  assert.ok(r.text.includes('Team 7') && r.text.includes('4%'));
  assert.ok(r.text.includes("I'm"), 'apostrophes kept: this profile keeps them');
  const desk = V.styleText("I'm thinking. Don't wait.", { ...PROFILE, apostrophe: 0.1 });
  assert.ok(!desk.text.includes("'"), desk.text);
});

test('surnamePairs: only surnames no other player carries', () => {
  const all = ['Alpha Runner', 'Bravo Catcher', 'Delta Runner', 'Echo Brown Jr.', 'Brown Fox'];
  const pairs = V.surnamePairs(all, ['Alpha Runner', 'Bravo Catcher', 'Echo Brown Jr.']);
  assert.deepEqual(pairs, [['Bravo Catcher', 'Catcher']]);
  const r = V.styleText('Would you do Bravo Catcher for Alpha Runner?', PROFILE, { keep: ['Alpha Runner', 'Bravo Catcher'], short: pairs });
  assert.ok(r.text.includes('Catcher') && !r.text.includes('Bravo') && r.text.includes('Alpha Runner'), r.text);
});

/* ---------------------------------------------------------------- retrieval + model */

test('similar: TF-IDF neighbours, same thread first', () => {
  const idx = V.buildIndex([...fakeRows('thread-a'), { text: 'U up rn or what', thread: 'thread-b', register: 'league_dm' }]);
  const top = V.similar(idx, 'are you up right now u', { thread: 'thread-b', k: 2 });
  assert.equal(top[0], 'U up rn or what');
  assert.ok(top.length === 2);
});

test('rewrite: rules without a model or without the paid opt-in; model text only when it passes the check', async () => {
  const voice = { profiles: new Map([['phone', PROFILE]]), index: V.buildIndex(fakeRows()) };
  const draft = 'Would you do Alpha Runner for Bravo Catcher?';
  const keep = ['Alpha Runner', 'Bravo Catcher'];
  const facts = C.factsFor({ names: NAMES, ids: ['10', '11'] });
  const check = t => C.checkMessage(t, facts).ok;
  const r0 = await V.rewrite(draft, { voice, keep, check, env: {} });
  assert.equal(r0.source, V.VOICE_SOURCE);
  let prompt = null;
  const good = async ({ prompt: p }) => { prompt = p; return 'U do Alpha Runner for Bravo Catcher'; };
  const off = await V.rewrite(draft, { voice, keep, check, callModel: good, env: { GRIDIRON_NICK_VOICE: '1' } });
  assert.equal(off.source, V.VOICE_SOURCE, 'no paid opt-in: no model call');
  assert.equal(prompt, null);
  const on = { GRIDIRON_NICK_VOICE: '1', GRIDIRON_ALLOW_PAID_RUN: '1' };
  const r1 = await V.rewrite(draft, { voice, keep, check, callModel: good, env: on });
  assert.equal(r1.source, 'voice.model');
  assert.ok(prompt.includes('Style guide') && prompt.includes('Alpha Runner') && r1.examples > 0);
  const bad = await V.rewrite(draft, { voice, keep, check, callModel: async () => 'U do Charlie Passer for Bravo Catcher', env: on });
  assert.equal(bad.source, V.VOICE_SOURCE);
  assert.match(bad.fallback, /failed the check/);
  const thrown = await V.rewrite(draft, { voice, keep, check, callModel: async () => { throw new Error('down'); }, env: on });
  assert.match(thrown.fallback, /model call failed: down/);
});

test('resolveProfile: thread, then register, then phone', () => {
  const t = { n: 1 }, r = { n: 2 }, ph = { n: 3 };
  const voice = { profiles: new Map([['thread:a', t], ['register:league_group', r], ['phone', ph]]) };
  assert.equal(V.resolveProfile(voice, { thread: 'a' }), t);
  assert.equal(V.resolveProfile(voice, { thread: 'b' }), ph);
  assert.equal(V.resolveProfile(voice, { register: 'league_group' }), r);
});

/* ---------------------------------------------------------------- chat DB + builder script */

function fixtureChatDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE messages (msg_id INTEGER, chat_kind TEXT, chat_name TEXT, handle TEXT, name TEXT,
             is_from_me INTEGER, ts_utc TEXT, text TEXT, is_tapback INTEGER, is_reply INTEGER);
           CREATE TABLE messages_ext (msg_id INTEGER, chat_kind TEXT, chat_name TEXT, handle TEXT, name TEXT, is_from_me INTEGER,
             ts_utc TEXT, text TEXT, is_tapback INTEGER, is_reply INTEGER, source_chat_kind TEXT, chat_participants_count INTEGER);`);
  const ins = db.prepare('INSERT INTO messages (msg_id, chat_kind, chat_name, is_from_me, ts_utc, text, is_tapback) VALUES (?, ?, ?, ?, ?, ?, ?)');
  FAKE.forEach((t, i) => ins.run(i, i % 3 ? 'dm' : 'group', i % 3 ? 'thread-a' : 'league', 1, `2026-01-01T00:0${i % 10}:${10 + i}Z`, t, 0));
  ins.run(100, 'dm', 'thread-a', 0, '2026-01-01T00:00:05Z', 'made-up reply', 0);
  ins.run(101, 'dm', 'thread-a', 1, '2026-01-01T00:00:06Z', 'Loved a message', 1);
  db.prepare('INSERT INTO messages_ext (msg_id, chat_kind, chat_name, is_from_me, ts_utc, text, is_tapback, source_chat_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(200, 'group', 'other', 1, '2026-01-02T00:00:00Z', 'Made up other text', 0, 'group_other');
  db.close();
}

test('readMine: own texts only, tapbacks and blanks out, registers tagged', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-')), 'chat.sqlite');
  fixtureChatDb(file);
  const db = new DatabaseSync(file, { readOnly: true });
  const mine = V.readMine(db);
  db.close();
  assert.equal(mine.length, FAKE.length + 1);
  assert.ok(mine.some(r => r.register === 'other_group'));
  assert.ok(mine.every(r => r.text !== 'Loved a message' && r.text !== 'made-up reply'));
});

test('build-nick-voice.mjs: writes nick_voice_profile into the given DB; --dry-run writes nothing; prints no text', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-')), 'chat.sqlite');
  fixtureChatDb(file);
  const run = extra => execFileSync(process.execPath, [path.join(REPO, 'scripts/build-nick-voice.mjs'), '--db', file, ...extra], { encoding: 'utf8' });
  const dry = JSON.parse(run(['--dry-run']));
  assert.equal(dry.written, false);
  let db = new DatabaseSync(file, { readOnly: true });
  assert.equal(V.readProfiles(db).size, 0, 'absent table reads as empty');
  db.close();
  const out = run([]);
  for (const t of FAKE.filter(t => t.includes(' '))) assert.ok(!out.includes(t));
  db = new DatabaseSync(file, { readOnly: true });
  const profiles = V.readProfiles(db);
  db.close();
  assert.ok(profiles.has('phone') && profiles.has('all') && profiles.has('register:league_dm'));
  assert.equal(profiles.get('phone').n, FAKE.length);
});

/* ---------------------------------------------------------------- COACH-MSG wiring */

test('checkBursts: every burst is checked on its own; the total keeps the length limit', () => {
  const facts = C.factsFor({ names: NAMES, ids: ['10', '11'] });
  assert.equal(C.checkBursts('Had an idea\nU do Alpha Runner for Bravo Catcher', facts).ok, true);
  const bad = C.checkBursts('Had an idea\nU do Charlie Passer for Bravo Catcher', facts);
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /Charlie Passer/);
  assert.equal(C.checkBursts(`a\n${'b'.repeat(C.MAX_CHARS)}`, facts).ok, false);
});

test('COACH-MSG: voice passed but flag off -> the texts are exactly the unstyled ones', () => {
  const voice = { profiles: new Map([['phone', PROFILE]]), forRoster: () => ({ thread: null, register: 'league_dm' }) };
  for (const e of live()) {
    const plain = M.applyCoachMessages(e, { force: true }).entry;
    const r = withEnv({ GRIDIRON_NICK_VOICE: undefined }, () => M.applyCoachMessages(e, { force: true, voice }));
    assert.deepEqual(r.entry, plain);
    assert.equal(r.stats.voiced, 0);
  }
});

test('COACH-MSG: flag on -> outgoing texts in bursts, still grounded, contract still valid', () => {
  const voice = { profiles: new Map([['phone', PROFILE]]), forRoster: () => ({ thread: 'none', register: 'league_dm' }) };
  withEnv({ GRIDIRON_NICK_VOICE: '1' }, () => {
    let voiced = 0, multi = 0;
    for (const e of live()) {
      const { entry, stats } = M.applyCoachMessages(e, { force: true, voice });
      voiced += stats.voiced;
      assert.equal(stats.errors.length, 0, JSON.stringify(stats.errors.slice(0, 2)));
      for (const m of M.targetMoves(entry)) for (const s of m.steps) {
        if (s.message?.source !== M.COACH_SOURCE) continue;
        if (s.message.value.includes('\n')) multi++;
        assert.ok(!/\bWould you\b|^Hey/.test(s.message.value), s.message.value);
        assert.ok(s.message.value.split('\n').length <= V.MAX_BURSTS);
      }
    }
    assert.ok(voiced > 0 && multi > 0);
    const g = M.gradePlansFile(PLANS, { apply: true, voiceFor: () => voice });
    assert.equal(g.totals.ungrounded, 0);
    assert.ok(g.grounded_share > 0.9);
    assert.deepEqual(validatePlans(g.doc).errors ?? [], []);
  });
});

test('coachMessagesFor: loads the voice only with GRIDIRON_NICK_VOICE=1; same texts as passing it in', async () => {
  const voice = { profiles: new Map([['phone', PROFILE]]), forRoster: () => ({ thread: null, register: 'league_dm' }) };
  const e = live()[0];
  let calls = 0;
  const loadVoice = async () => { calls++; return voice; };
  const off = await withEnv({ GRIDIRON_NICK_VOICE: undefined }, () => M.coachMessagesFor(e, { force: true, loadVoice }));
  assert.equal(calls, 0, 'flag off: the chat DB is never opened');
  assert.deepEqual(off.entry, M.applyCoachMessages(e, { force: true }).entry);
  const on = await withEnv({ GRIDIRON_NICK_VOICE: '1' }, () => M.coachMessagesFor(e, { force: true, loadVoice }));
  assert.equal(calls, 1);
  assert.ok(on.stats.voiced > 0);
  const none = await withEnv({ GRIDIRON_NICK_VOICE: '1' }, () => M.coachMessagesFor(e, { force: true, loadVoice: async () => null }));
  assert.deepEqual(none.entry, off.entry, 'no stored profile: unstyled texts');
});

test('styleText: phone punctuation and casing: curly apostrophes, proper nouns kept, sentence starts dropped', () => {
  const phone = { ...PROFILE, curly_apos: 0.9, first_cap: 0, all_lower: 0.1 };
  const r = V.styleText("I'm watching Sunday night. Kickoff is late.", phone);
  assert.ok(r.text.includes('I’m') && !r.text.includes("'"), r.text);
  assert.ok(r.text.includes('Sunday'), 'a capital inside the text stays');
  assert.ok(r.bursts.every(b => !/^[A-Z](?![’'])/.test(b) || /^I[’' ]/.test(b)), r.text);
  const lower = V.styleText('Kickoff is late on Sunday.', { ...PROFILE, all_lower: 0.9, first_cap: 0 });
  assert.equal(lower.text, 'kickoff is late on sunday');
  assert.equal(V.profileOf(['I’m in', "I'm out", 'Don’t']).curly_apos, 0.667);
});
