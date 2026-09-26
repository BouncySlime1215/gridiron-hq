/**
 * COACH-CHAT: Coach holds a conversation, not a list of yes/no answers.
 *
 * Pinned here:
 *   - threads: one active thread per (user, league); "New conversation"
 *     archives it; the last N turns are kept and older ones fold into a
 *     structured summary (ids and counts, never text); N comes from
 *     GRIDIRON_COACH_THREAD_TURNS (default 12) and a bad value is refused
 *   - focus: "why?", "what if he says no?", "the other one" and "what about
 *     <manager> instead" resolve against the thread's focus (pronouns keep it,
 *     a partner switch changes it, a name that fits two managers is asked about)
 *   - $0 follow-ups through the real route with no model key: why, what if he
 *     says no, any other option, the other one, a partner switch; every claim
 *     is cited, grounded (verification ok, nothing dropped), costs $0 and makes
 *     no model call
 *   - no dead ends: unmatched free text says it needs the model and returns
 *     chips, and every chip Coach offers answers from the plan
 *   - Nick's rules: Coach still refuses to send; proposals are only the War
 *     Room's own records (offer.sent, deck.skip), never a send
 *   - the conversation survives a "reopen" (GET /thread) and resets on New
 * Names below are made up (public repo). Plans from the producer fixture (FIX-03).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-chat-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
delete process.env.GRIDIRON_ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
delete process.env.GRIDIRON_COACH_THREAD_TURNS;
process.env.GRIDIRON_COACH_BRIEF_ENABLED = '1';
process.env.GRIDIRON_WARROOM_ENABLED = '1';

const FIXTURE = new URL('./fixtures/warroom-contract/producer-plans.json', import.meta.url);
const PLANS = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const PLANS_FILE = path.join(temp, 'plans.json');
fs.writeFileSync(PLANS_FILE, JSON.stringify(PLANS));
process.env.GRIDIRON_WARROOM_PLANS = PLANS_FILE;

const { run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { setAnthropicClientForTesting } = await import('../server/services/claude.js');
const { default: coachRouter } = await import('../server/routes/coach.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const threads = await import('../server/services/coach/threads.js');
const { followupIntent, focusFor } = await import('../server/services/coach/focus.js');
const { withIdentityTeams } = await import('../server/services/coach/partner.js');
const { routeModel, CHAT_MODELS } = await import('../server/services/coach/chat.js');
const { PRICING } = await import('../server/services/llm-budget.js');

run(`INSERT OR IGNORE INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (4, 'espn', 'fx-4', 2026, 'Fixture', '1', 4, 1, '{}', '2026-09-23 01:00:00')`);
const IDENTITIES = [
  ['1', 'Nico Tester', 'Tester Tigers'], ['2', 'Barnaby Finch', 'Finch Falcons'],
  ['3', 'Quincy Marlowe', 'Marlowe Mariners'], ['4', 'Delphine Oakes', 'Oakes Owls']
];
for (const [roster, espn, team] of IDENTITIES) {
  run(`INSERT OR REPLACE INTO league_member_identity (league_id, roster_id, espn_name, team_name, chat_name, match_method, confidence)
       VALUES (4, ?, ?, ?, NULL, 'fixture', 'confirmed')`, roster, espn, team);
}
const USERS = [9701, 9702, 9703, 9704, 9705, 9706];
for (const id of USERS) {
  run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (?, ?, 'Reader')`, id, `coach-chat-${id}`);
  run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at) VALUES (?, ?, datetime('now','+1 day'))`,
    id, hashSessionToken(`chat-token-${id}`));
}

let modelCalls = 0;
setAnthropicClientForTesting({ messages: { create: async () => { modelCalls += 1; throw new Error('no model in this test'); } } });

const app = express();
app.use(express.json());
app.use('/api/coach', coachRouter);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/coach`;
test.after(() => { server.close(); setAnthropicClientForTesting(null); fs.rmSync(temp, { recursive: true, force: true }); });

const headers = user => ({ 'content-type': 'application/json', authorization: `Bearer chat-token-${user}` });
const say = async (user, question) => {
  const res = await fetch(`${base}/ask`, { method: 'POST', headers: headers(user), body: JSON.stringify({ question, league_id: 4, thread: true,
    context: { surface: 'war_room', route: '/today', league: 4 } }) });
  assert.equal(res.status, 200, `${question}: ${res.status}`);
  return res.json();
};
const texts = body => (body.answer?.claims ?? []).map(c => c.text).join('\n');
function citesResolve(body) {
  const cells = new Set();
  for (const q of body.ledger?.queries ?? []) (q.rows ?? []).forEach((row, i) => Object.keys(row).forEach(k => cells.add(`${q.id}#${i}.${k}`)));
  for (const d of body.ledger?.derived ?? []) cells.add(d.id);
  return (body.answer?.claims ?? []).every(c => c.cites.length && c.cites.every(x => cells.has(x)));
}
const grounded = (body, what) => {
  assert.equal(body.verification?.ok, true, `${what}: ${JSON.stringify(body.verification)}`);
  assert.equal(body.verification?.dropped ?? 0, 0, `${what}: dropped ${JSON.stringify(body.dropped)}`);
  assert.ok(body.answer.claims.length > 0, `${what}: has claims`);
  assert.ok(citesResolve(body), `${what}: every cite resolves`);
  assert.equal(body.cost_usd, 0, `${what}: $0`);
};

const entry = withIdentityTeams(PLANS.leagues.find(e => e.league === 4),
  IDENTITIES.map(([roster_id, espn_name, team_name]) => ({ roster_id, espn_name, team_name, confidence: 'confirmed' })));
const identities = IDENTITIES.map(([roster_id, espn_name, team_name]) => ({ roster_id, espn_name, team_name, confidence: 'confirmed' }));

/* ------------------------------------------------------------ threads */

test('thread storage: one active thread per user and league; New archives it', () => {
  const a = threads.activeThread(9706, 4);
  assert.equal(threads.activeThread(9706, 4).id, a.id, 'the same active thread comes back');
  const b = threads.newThread(9706, 4);
  assert.notEqual(b.id, a.id);
  assert.equal(threads.activeThread(9706, 4).id, b.id);
  assert.throws(() => threads.activeThread(0, 4), /user id/);
});

test('retention: the last N turns stay, older turns fold into an ids-only summary', () => {
  const t = threads.newThread(9706, 4);
  const focus = i => ({ move_id: `M${i}`, partner: String(2 + (i % 2)), players: [String(i)] });
  for (let i = 1; i <= 5; i++) {
    threads.appendTurn(t.id, { question: `secret question text ${i}`, intent: i % 2 ? 'why' : 'if_no',
      reply: { text: `secret reply text ${i}` }, focus: focus(i) }, { limit: 3 });
  }
  const msgs = threads.threadMessages(t.id);
  assert.equal(msgs.filter(m => m.role === 'nick').length, 3, 'three turns kept');
  assert.deepEqual(msgs.filter(m => m.role === 'nick').map(m => m.text), ['secret question text 3', 'secret question text 4', 'secret question text 5']);
  const s = threads.activeThread(9706, 4).summary;
  assert.equal(s.turns_folded, 2);
  assert.deepEqual(s.intents, { why: 1, if_no: 1 });
  assert.deepEqual(s.moves, ['M1', 'M2']);
  assert.deepEqual(s.partners, ['3', '2']);
  assert.doesNotMatch(JSON.stringify(s), /secret/, 'the summary keeps no text');
  assert.equal(threads.activeThread(9706, 4).focus.move_id, 'M5', 'the focus is the last turn\'s');
  assert.match(threads.summaryText(s), /2 earlier turns/);
});

test('the turn limit: default 12, env override, a bad value refused', () => {
  assert.equal(threads.threadTurnLimit({}), 12);
  assert.equal(threads.threadTurnLimit({ GRIDIRON_COACH_THREAD_TURNS: '20' }), 20);
  assert.throws(() => threads.threadTurnLimit({ GRIDIRON_COACH_THREAD_TURNS: 'lots' }), /whole number/);
  assert.throws(() => threads.threadTurnLimit({ GRIDIRON_COACH_THREAD_TURNS: '1' }), /whole number/);
});

/* -------------------------------------------------------------- focus */

test('focus resolution: pronouns keep the focus, a named manager is a partner switch', () => {
  const focus = focusFor(entry.next_move.value, 0, {});
  assert.equal(focus.partner, '3');
  const f = q => followupIntent(q, { focus, entry, identities });
  assert.equal(f('why?').intent, 'why');
  assert.equal(f('why him?').intent, 'why');
  assert.equal(f('ok but why that one').intent, 'why');
  assert.equal(f('what if he says no?').intent, 'if_no');
  assert.equal(f('and if he counters?').intent, 'if_no');
  assert.equal(f('what if he goes quiet').intent, 'if_no');
  assert.deepEqual(f('what about Barnaby instead?'), { intent: 'partner_switch', roster: '2' });
  assert.deepEqual(f('what about team 4'), { intent: 'partner_switch', roster: '4' });
  assert.deepEqual(f('how about the Oakes Owls'), { intent: 'partner_switch', roster: '4' });
  assert.equal(f('the other one'), null, 'no move was discussed before this one, so "the other one" is not a follow-up yet');
  const later = focusFor(entry.alternatives.value[1], 0, focus);
  assert.equal(later.prev_move_id, focus.move_id);
  assert.equal(followupIntent('the other one', { focus: later, entry, identities }).intent, 'other_one');
  assert.equal(f('why is nothing clearing?'), null, 'the starter question keeps its own answer');
  assert.equal(f('what did league-mates say lately?'), null);
});

test('a name that fits two managers is asked about, never guessed', () => {
  const twin = [...identities, { roster_id: '5', espn_name: 'Barnaby Lowe', team_name: 'Lowe Lynx', confidence: 'confirmed' }];
  const e = withIdentityTeams(entry, twin);
  const out = followupIntent('what about Barnaby instead', { focus: {}, entry: e, identities: twin });
  assert.equal(out.intent, 'partner_switch');
  assert.equal(out.roster, undefined);
  assert.equal(out.ambiguous.length, 2);
});

test('model routing: short follow-ups cheap, trade analysis strongest, the rest normal', () => {
  const focus = { move_id: 'M1', partner: '3' };
  assert.equal(routeModel('why him?', { focus, turns: 2 }), CHAT_MODELS.followup);
  assert.equal(routeModel('why him?', { focus: {}, turns: 0 }), CHAT_MODELS.normal, 'no thread yet: not a follow-up');
  assert.equal(routeModel('analyze this trade for me', { focus, turns: 2 }), CHAT_MODELS.deep);
  assert.equal(routeModel('which of my league-mates has the deepest bench at running back right now', { focus, turns: 2 }), CHAT_MODELS.normal);
  for (const m of Object.values(CHAT_MODELS)) assert.ok(Object.hasOwn(PRICING, m), `${m} is priced`);
});

/* ------------------------------------------------ $0 conversation, via the route */

test('a conversation at $0: next move, why, what if no, other option, the other one, a partner switch', async () => {
  const U = 9701;
  const before = modelCalls;
  const first = await say(U, "What's my next move?");
  grounded(first, 'next move');
  assert.equal(first.thread.focus.partner, '3');
  const moveId = first.thread.focus.move_id;
  assert.ok(moveId);
  assert.ok(first.thread.followups.length >= 2 && first.thread.followups.length <= 3, 'two or three chips');

  const why = await say(U, 'why?');
  grounded(why, 'why');
  assert.equal(why.intent, 'why');
  assert.match(texts(why), /^Why: /m);
  assert.match(texts(why), /^His side: /m);
  assert.doesNotMatch(texts(why), /\.js|\bE1\b|_/, 'no engine asides');
  assert.equal(why.thread.focus.move_id, moveId, 'a pronoun follow-up keeps the focus');

  const no = await say(U, 'what if he says no?');
  grounded(no, 'if no');
  assert.match(texts(no), /^If he says no: /m);
  assert.match(texts(no), /^If he counters: /m);
  assert.match(texts(no), /^If he goes quiet/m);
  assert.match(texts(no), /Quincy Marlowe/, 'the partner is named from the identity rows');

  const other = await say(U, 'any other option?');
  grounded(other, 'other option');
  assert.notEqual(other.thread.focus.move_id, moveId, 'the next card is now the focus');
  assert.equal(other.thread.focus.prev_move_id, moveId);

  const back = await say(U, 'the other one');
  grounded(back, 'the other one');
  assert.equal(back.intent, 'other_one');
  assert.equal(back.thread.focus.move_id, moveId, 'back to the first move');

  const sw = await say(U, 'what about Barnaby instead?');
  grounded(sw, 'partner switch');
  assert.equal(sw.intent, 'partner_switch');
  assert.equal(sw.thread.focus.partner, '2');
  assert.match(texts(sw), /Barnaby Finch/);

  const swWhy = await say(U, 'what about team 3');
  grounded(swWhy, 'switch back by team number');
  assert.equal(swWhy.thread.focus.partner, '3');
  assert.equal(modelCalls, before, 'no model call');
});

test('no dead ends: free text says it needs the model and every chip it offers answers from the plan', async () => {
  const U = 9702;
  await say(U, "What's my next move?");
  const free = await say(U, 'tell me a joke about my league');
  assert.equal(free.answer.claims.length, 0);
  assert.match(free.answer.refusals.join(' '), /needs the AI model/);
  assert.ok(free.thread.followups.length >= 2, 'chips are offered');
  for (const chip of free.thread.followups) {
    const out = await say(U, chip);
    grounded(out, `chip "${chip}"`);
  }
});

test("Nick's rules: Coach refuses to send; proposals are the War Room's own records only", async () => {
  const U = 9703;
  const first = await say(U, "What's my next move?");
  const kinds = first.thread.proposals.map(p => p.kind);
  assert.deepEqual(kinds, ['offer.sent', 'deck.skip']);
  for (const p of first.thread.proposals) {
    assert.match(p.rules, /never sends|rules stay on/);
    assert.equal(p.payload.move_id, first.thread.focus.move_id);
  }
  const send = await say(U, 'send it to him for me');
  assert.equal(send.answer.claims.length, 0);
  assert.ok(send.answer.refusals.length, 'the send is refused');
  assert.deepEqual(send.thread.proposals, [], 'a refusal proposes nothing');
});

test('the conversation survives reopening and resets on New conversation', async () => {
  const U = 9704;
  await say(U, "What's my next move?");
  await say(U, 'why?');
  const open = await (await fetch(`${base}/thread/4`, { headers: headers(U) })).json();
  assert.equal(open.messages.length, 4);
  assert.deepEqual(open.messages.map(m => m.who), ['nick', 'coach', 'nick', 'coach']);
  assert.ok(open.messages[3].claims.length && open.messages[3].followups.length, 'a stored reply keeps its claims and chips');
  assert.equal(open.thread.focus.partner, '3');
  const other = await (await fetch(`${base}/thread/4`, { headers: headers(9705) })).json();
  assert.equal(other.messages.length, 0, 'another user sees none of it');
  const fresh = await (await fetch(`${base}/thread/4/new`, { method: 'POST', headers: headers(U) })).json();
  assert.equal(fresh.messages.length, 0);
  assert.deepEqual(fresh.thread.focus, {});
  assert.ok(fresh.starters.length >= 2);
  const again = await say(U, 'why?');
  grounded(again, 'why in a fresh thread falls back to the next move');
});

test('the spend endpoint reports the Coach budget for today', async () => {
  const body = await (await fetch(`${base}/spend`, { headers: headers(9705) })).json();
  assert.equal(body.model_on, false);
  assert.equal(typeof body.spent_today_usd, 'number');
});
