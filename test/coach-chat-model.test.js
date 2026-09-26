/**
 * COACH-CHAT, the model path (a stand-in client; no network, no spend).
 *
 * The 502 found 2026-09-25: a live Coach turn on claude-sonnet-5 spent five
 * rounds on lookups, and the last round (tool_choice none) came back as a
 * thinking block alone (stop_reason end_turn, no text). parseJson read only the
 * first text block, found none, and the route answered 502 "AI response
 * contained no JSON text block". Pinned here, with the response shapes that
 * call produced (types only, no text from it):
 *   - every round asks for the answer schema (output_config.format json_schema)
 *   - parseJson reads every text block after thinking, strips fences, finds the
 *     object inside a sentence, and says what came back when there is no text
 *   - a turn that ends on thinking alone gets ONE answer-only round, then the
 *     answer ships (verified as always); a second empty turn is still a 502
 *   - a chat turn sends the recent turns, the summary and the focus as context,
 *     routes the model per message, logs its cost under the Coach budget, and a
 *     spent budget becomes a plain answer with $0 chips instead of an error
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-chat-model-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_ANTHROPIC_API_KEY = 'test-key-not-a-real-one';
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
process.env.GRIDIRON_COACH_BRIEF_ENABLED = '1';
process.env.GRIDIRON_WARROOM_ENABLED = '1';
const PLANS_FILE = path.join(temp, 'plans.json');
fs.copyFileSync(new URL('./fixtures/warroom-contract/producer-plans.json', import.meta.url), PLANS_FILE);
process.env.GRIDIRON_WARROOM_PLANS = PLANS_FILE;
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const { run, row, rows } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { setAnthropicClientForTesting, parseJson } = await import('../server/services/claude.js');
const { askCoach, ANSWER_SCHEMA, COACH_MODEL } = await import('../server/services/coach/ask.js');
const { chatTurn, CHAT_MODELS } = await import('../server/services/coach/chat.js');
const { setDailyBudget } = await import('../server/services/llm-budget.js');
await import('../server/routes/coach.js');

run(`INSERT OR IGNORE INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (4, 'espn', 'fx-4', 2026, 'Fixture', '1', 4, 1, '{}', '2026-09-23 01:00:00')`);
run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (9801, 'coach-chat-model', 'Reader')`);
run(`INSERT OR IGNORE INTO players (id, name, position) VALUES (901, 'Fixture Receiver', 'WR')`);

const usage = { input_tokens: 100, output_tokens: 50 };
const thinking = { type: 'thinking', thinking: '', signature: 'sig' };
const toolUse = (name, input, id = 'tu1') => ({ content: [thinking, { type: 'tool_use', id, name, input }], stop_reason: 'tool_use', usage });
const thinkingOnly = () => ({ content: [thinking], stop_reason: 'end_turn', usage });
const says = object => ({ content: [thinking, { type: 'text', text: JSON.stringify(object) }], stop_reason: 'end_turn', usage });

function scripted(...replies) {
  const sent = [];
  let turn = 0;
  return { sent, messages: { create: async body => {
    sent.push(structuredClone(body));
    const reply = replies[turn++];
    if (!reply) throw new Error(`the stand-in client ran out of replies at turn ${turn}`);
    return typeof reply === 'function' ? reply(body) : reply;
  } } };
}
test.afterEach(() => setAnthropicClientForTesting(null));

/* ---------------------------------------------------------- parseJson */

test('parseJson: thinking first, fences, split blocks, a sentence around the object', () => {
  assert.deepEqual(parseJson({ content: [thinking, { type: 'text', text: '```json\n{"a":1}\n```' }] }), { a: 1 });
  assert.deepEqual(parseJson({ content: [thinking, { type: 'text', text: '{"a":' }, { type: 'text', text: '[1,2]}' }] }), { a: [1, 2] });
  assert.deepEqual(parseJson({ content: [{ type: 'text', text: 'Here it is: {"t":"a } inside"} — done.' }] }), { t: 'a } inside' });
  assert.throws(() => parseJson({ content: [thinking], stop_reason: 'end_turn' }),
    e => e.code === 'no_text' && /content: thinking; stop_reason: end_turn/.test(e.message));
  assert.throws(() => parseJson({ content: [{ type: 'text', text: 'no object here' }] }), SyntaxError);
});

/* --------------------------------------------------------- the 502 fix */

test('every round asks for the answer schema', async () => {
  const client = scripted(
    toolUse('sql_select', { sql: 'SELECT name FROM players WHERE id = 901' }),
    says({ claims: [{ text: 'Fixture Receiver is on the list.', cites: ['r1#0.name'] }], refusals: [], as_of: null }));
  setAnthropicClientForTesting(client);
  const out = await askCoach({ question: 'who is player 901' });
  assert.equal(out.verification.ok, true);
  for (const body of client.sent) assert.deepEqual(body.output_config?.format, { type: 'json_schema', schema: ANSWER_SCHEMA });
});

test('a turn that ends on thinking alone gets one answer-only round, and the answer ships', async () => {
  const client = scripted(
    toolUse('sql_select', { sql: 'SELECT name FROM players WHERE id = 901' }),
    thinkingOnly(),
    says({ claims: [{ text: 'Fixture Receiver is on the list.', cites: ['r1#0.name'] }], refusals: [], as_of: null }));
  setAnthropicClientForTesting(client);
  const out = await askCoach({ question: 'who is player 901' });
  assert.equal(out.verification.ok, true);
  assert.equal(out.answer.claims.length, 1);
  const nudge = client.sent[2].messages.at(-1);
  assert.equal(nudge.role, 'user', 'the thinking-only turn is not replayed; the nudge joins the last user turn');
  assert.match(JSON.stringify(nudge.content), /ended without the answer/);
});

test('the same on the last round: the extra answer round runs, then the answer ships', async () => {
  const { MAX_TOOL_ROUNDS } = await import('../server/services/coach/ask.js');
  const tools = Array.from({ length: MAX_TOOL_ROUNDS - 1 }, (_, i) => toolUse('sql_select', { sql: 'SELECT name FROM players WHERE id = 901' }, `tu${i}`));
  const client = scripted(...tools, thinkingOnly(),
    says({ claims: [], refusals: ['Coach does not read that.'], as_of: null }));
  setAnthropicClientForTesting(client);
  const out = await askCoach({ question: 'who is player 901' });
  assert.deepEqual(out.answer.refusals, ['Coach does not read that.']);
  assert.equal(client.sent.length, MAX_TOOL_ROUNDS + 1);
  assert.deepEqual(client.sent.at(-1).tool_choice, { type: 'none' });
});

test('two empty turns in a row are still a 502 that says what came back', async () => {
  setAnthropicClientForTesting(scripted(thinkingOnly(), thinkingOnly()));
  await assert.rejects(askCoach({ question: 'who is player 901' }), e => e.status === 502 && /stop_reason: end_turn/.test(e.message));
});

/* ------------------------------------------------------ chat, model on */

const shaped = (verdict, extra = {}) => says({ verdict: { text: verdict, cites: [] }, stance: 'none', basis: '', why: [], risks: [],
  refusals: [verdict], as_of: null, ...extra });
const routed = intent => says({ intent });

test('a chat turn carries the conversation, is routed, answers in the shaped format and logs cost under the Coach budget', async () => {
  // Turn 1 is a starter (no model); turn 2 is free text: no rule matches, so Haiku routes it, then the model answers.
  setAnthropicClientForTesting(scripted());
  const first = await chatTurn({ userId: 9801, leagueId: 4, question: "What's my next move?", hasModel: true,
    context: { surface: 'war_room', league: 4 } });
  assert.equal(first.cost_usd, 0);
  const client = scripted(routed('ABOUT'), shaped('Coach does not read his mood.'));
  setAnthropicClientForTesting(client);
  const second = await chatTurn({ userId: 9801, leagueId: 4, question: 'is he in a good mood?', hasModel: true,
    context: { surface: 'war_room', league: 4 } });
  assert.deepEqual(second.answer.refusals, ['Coach does not read his mood.']);
  assert.equal(second.answer.shape.verdict.text, 'Coach does not read his mood.');
  assert.equal(second.route.intent, 'ABOUT');
  assert.equal(second.route.by, 'model');
  assert.equal(client.sent[0].model, 'claude-haiku-4-5-20251001', 'the router is the cheap model');
  assert.equal(client.sent[1].model, COACH_MODEL);
  const prompt = JSON.stringify(client.sent[1].messages[0].content);
  assert.match(prompt, /THE CONVERSATION SO FAR/);
  assert.match(prompt, /What's my next move\?/);
  assert.match(prompt, /CURRENT FOCUS/);
  assert.match(prompt, new RegExp(first.thread.focus.move_id));
  const logged = rows(`SELECT feature, model FROM ai_usage ORDER BY id DESC LIMIT 2`).map(r => `${r.feature}|${r.model}`);
  assert.deepEqual(logged, [`coach:chat|${COACH_MODEL}`, 'coach:route|claude-haiku-4-5-20251001']);
});

test('a trade DO question goes to the strongest model with no routing call; a plain question to the Coach model', async () => {
  const client = scripted(shaped('No move clears.'), routed('ABOUT'), shaped('Coach does not read that.'));
  setAnthropicClientForTesting(client);
  await chatTurn({ userId: 9801, leagueId: 4, question: 'should I trade for a running back this week?', hasModel: true, context: { league: 4 } });
  await chatTurn({ userId: 9801, leagueId: 4, question: 'which of my league-mates has the deepest bench at running back right now?', hasModel: true, context: { league: 4 } });
  assert.equal(client.sent[0].model, 'claude-opus-5-5', 'DO on a trade: Opus, routed by rule ($0)');
  assert.equal(client.sent[1].model, 'claude-haiku-4-5-20251001', 'no rule: the cheap router');
  assert.equal(client.sent[2].model, COACH_MODEL);
});

test("a spent Coach budget is a plain answer with chips, not an error, and no call is made", async () => {
  setDailyBudget('coach', 0.0001);
  const client = scripted();
  setAnthropicClientForTesting(client);
  const out = await chatTurn({ userId: 9801, leagueId: 4, question: 'which of my league-mates has the deepest bench at running back right now?',
    hasModel: true, context: { league: 4 } });
  assert.equal(out.over_budget, true);
  assert.match(out.answer.refusals[0], /AI limit for Coach is used up/);
  assert.doesNotMatch(out.answer.refusals[0], /\$/, 'no dollar amount on screen');
  assert.ok(out.thread.followups.length >= 2);
  assert.equal(client.sent.length, 0);
  setDailyBudget('coach', 1);
});

test('an account out of credits: a plain answer with chips, and the failure logged at 0 cost', async () => {
  const credit = Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'), { status: 400 });
  setAnthropicClientForTesting({ messages: { create: async () => { throw credit; } } });
  const out = await chatTurn({ userId: 9801, leagueId: 4, question: 'which of my league-mates has the deepest bench at running back right now?',
    hasModel: true, context: { league: 4 } });
  assert.equal(out.ai_unavailable, true);
  assert.match(out.answer.refusals[0], /AI is unavailable right now/);
  assert.ok(out.thread.followups.length >= 2);
  const r = rows(`SELECT feature, cost_usd, error FROM ai_usage ORDER BY id DESC LIMIT 1`)[0];
  assert.deepEqual({ ...r }, { feature: 'coach:route', cost_usd: 0, error: 'credit' });
});
