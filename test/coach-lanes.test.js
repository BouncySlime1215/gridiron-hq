/**
 * COACH-LANES: the numbers lane and the people lane, then one reply (a stand-in
 * client; no network, no spend).
 *
 * Pinned here:
 *   - lanes A and B run in parallel; B is skipped (and there is no synthesis)
 *     when nobody is in focus
 *   - a disagreement comes back as its own line ("numbers say X; chat suggests Y")
 *   - the synthesis passes verify.js or is not shown: an unsupported number
 *     falls back to lane A plus lane B's lines under "From chat, unverified"
 *   - raw chat text never reaches a Coach prompt: a speech-shaped value in a
 *     stored profile is dropped before lane B is asked
 *   - each lane logs its model and cost in ai_usage under its own feature
 * Names are made up (public repo); plans from the producer fixture.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-lanes-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_ANTHROPIC_API_KEY = 'test-key-not-a-real-one';
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
delete process.env.GRIDIRON_COACH_LANES;
process.env.GRIDIRON_COACH_PRELOAD = '0'; // lane 1's ledger ids stay r1.. here; the bundle has its own test (coach-preload)
process.env.GRIDIRON_COACH_BRIEF_ENABLED = '1';
process.env.GRIDIRON_WARROOM_ENABLED = '1';
const PLANS_FILE = path.join(temp, 'plans.json');
fs.copyFileSync(new URL('./fixtures/warroom-contract/producer-plans.json', import.meta.url), PLANS_FILE);
process.env.GRIDIRON_WARROOM_PLANS = PLANS_FILE;
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const { run, rows } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { setAnthropicClientForTesting } = await import('../server/services/claude.js');
const { chatTurn } = await import('../server/services/coach/chat.js');
const { setBrainSources } = await import('../server/services/coach/brain-tools.js');
const { clearLaneCache, safeSignal, PEOPLE_LABEL, LANE_MODELS } = await import('../server/services/coach/lanes.js');
const { setJevAsk } = await import('../server/services/coach/jev-lane.js');
await import('../server/routes/coach.js');

run(`INSERT OR IGNORE INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (4, 'espn', 'fx-4', 2026, 'Fixture', '1', 4, 1, '{}', '2026-09-23 01:00:00')`);
run(`INSERT OR IGNORE INTO players (id, name, position) VALUES (901, 'Fixture Receiver', 'WR')`);
// Made-up manager names: the Jev state must carry none of them.
const MANAGER_NAMES = ['Quincy Marlowe', 'Marlowe Mariners', 'Barnaby Finch'];
run(`INSERT OR REPLACE INTO league_member_identity (league_id, roster_id, espn_name, team_name, chat_name, match_method, confidence)
     VALUES (4, '3', 'Quincy Marlowe', 'Marlowe Mariners', NULL, 'fixture', 'confirmed')`);
run(`INSERT OR REPLACE INTO league_member_identity (league_id, roster_id, espn_name, team_name, chat_name, match_method, confidence)
     VALUES (4, '2', 'Barnaby Finch', 'Finch Falcons', NULL, 'fixture', 'confirmed')`);
let nextUser = 9900;
const newUser = () => { const id = ++nextUser; run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (?, ?, 'Reader')`, id, `lanes-${id}`); return id; };

const SENTINEL = "lol i'd never trade him SENTINEL-CHAT-LINE";
setBrainSources({ profiles: () => ({ status: 'ok', reason: null, as_of: Date.now(), byRoster: new Map([['3', {
  roster_id: '3', status: 'ok', reason: null,
  negotiation: { status: 'ok', messages_read: 12, confidence: 'medium',
    values_talk: { status: 'ok', wants: [{ player: 'P21 (WR)' }], shopping: [{ player: SENTINEL }], untouchable: [] } },
  override: { status: 'none', exclude: false, deprioritize: false, toughen: false },
  chat: { status: 'unknown', reason: 'no chat-openness read' } }]]) }) });
test.after(() => setBrainSources({ profiles: null }));

const usage = { input_tokens: 100, output_tokens: 50 };
const text = obj => ({ content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: JSON.stringify(obj) }], stop_reason: 'end_turn', usage });
const tool = () => ({ content: [{ type: 'tool_use', id: 'tu1', name: 'sql_select', input: { sql: 'SELECT name FROM players WHERE id = 901' } }], stop_reason: 'tool_use', usage });
const laneOf = body => {
  const sys = JSON.stringify(body.system ?? '');
  if (sys.includes('people lane of Coach')) return 'people';
  if (sys.includes("write Coach's one reply") || sys.includes("write Coach's one answer to Nick")) return 'synth';
  if (sys.includes('Classify a fantasy-football')) return 'route';
  return 'numbers';
};

/** A client answering each lane from its own script, recording every body and when each call started and ended. */
function lanesClient({ synth, gateBoth = false }) {
  const sent = [];
  const events = [];
  let numbersTurn = 0;
  let started = 0;
  let release;
  const both = new Promise(r => { release = r; });
  const create = async body => {
    const lane = laneOf(body);
    sent.push({ lane, body: structuredClone(body) });
    events.push(`start:${lane}`);
    if (gateBoth && (lane === 'numbers' || lane === 'people') && numbersTurn === 0) {
      started += 1;
      if (started >= 2) release();
      await Promise.race([both, new Promise((_, no) => setTimeout(() => no(new Error('lanes did not run in parallel')), 1000))]);
    }
    let out;
    // Lane 1 answers in the COACH-V2 answer format (a verdict and a cited why line); the router picks ABOUT.
    if (lane === 'route') out = text({ intent: 'ABOUT' });
    else if (lane === 'numbers') out = numbersTurn++ === 0 ? tool() : text({ verdict: { text: 'Send the served offer this week.', cites: [] }, stance: 'go',
      basis: 'title odds gain', basis_key: 'title_gain', why: [{ text: 'Fixture Receiver is the player in question.', cites: ['r1#0.name'] }], risks: [], refusals: [], as_of: null });
    else if (lane === 'people') out = text({ claims: [{ text: 'His profile lists P21 (WR) as a player he wants.', cites: ['r1#0.wants'] }], refusals: [], as_of: null });
    else out = text(synth);
    events.push(`end:${lane}`);
    return out;
  };
  return { sent, events, messages: { create } };
}

test('the no-chat-text guard keeps labels and drops speech', () => {
  assert.equal(safeSignal('P21 (WR)'), 'P21 (WR)');
  assert.equal(safeSignal(['P21 (WR)', 'P4 (WR)']), 'P21 (WR), P4 (WR)');
  assert.equal(safeSignal(SENTINEL), null);
  assert.equal(safeSignal('he said "no chance"'), null);
  assert.equal(safeSignal('x'.repeat(61)), null);
  assert.equal(safeSignal(0.4), 0.4);
});

test('lane 2 is Claude -> Jev: Jev reads lane 1 and leads; the reply compares them; no names or chat text reach Jev', async () => {
  clearLaneCache();
  const user = newUser();
  setAnthropicClientForTesting(lanesClient({ synth: {} }));
  await chatTurn({ userId: user, leagueId: 4, question: "What's my next move?", hasModel: true, context: { league: 4 } });
  const states = [];
  setJevAsk(async ({ state, questions }) => {
    states.push(state);
    assert.deepEqual(Object.keys(questions), ['p_accept', 'claude_call_right', 'better_stance', 'basis']);
    return { ok: true, costUsd: 0.0004, answers: {
      p_accept: { type: 'boolean', probability: 0.31 }, claude_call_right: { type: 'boolean', probability: 0.35 },
      better_stance: { type: 'choice', choice: 'wait', probabilities: { go: 0.2, wait: 0.6, avoid: 0.2 } },
      basis: { type: 'choice', choice: 'price', probabilities: { price: 0.7, willingness: 0.1, timing: 0.1, roster_fit: 0.05, risk: 0.05 } } } };
  });
  // COACH-V2 unit 4: Claude says go (title gain), Jev says wait (price): DIFFER, so the reconcile call writes the answer.
  const client = lanesClient({ synth: {
    verdict: { text: 'Send the served offer, but lead with his price.', cites: [] }, stance: 'go', basis: 'title odds gain', basis_key: 'title_gain',
    why: [{ text: 'Fixture Receiver is the player in question.', cites: ['r1#0.name'] }, { text: 'Jev puts his yes at 31% as sent (chat read).', cites: ['r2#0.p_accept'] }],
    risks: [], refusals: [], as_of: null,
    disagreement: 'Numbers say go; Jev reads wait because of his price.' } });
  setAnthropicClientForTesting(client);
  try {
    const events = [];
    const out = await chatTurn({ userId: user, leagueId: 4, question: 'is he likely to bite?', hasModel: true, context: { league: 4 }, onEvent: e => events.push(e) });
    assert.equal(states.length, 1);
    // COACH-V2 drawer: lane 1 goes out as a partial answer before Jev starts, and names the partner by team.
    const at = t => events.findIndex(e => e.t === t);
    assert.ok(at('lane1') >= 0 && at('lane1') < at('lane2_start'), 'lane 1 is sent before lane 2 starts');
    assert.ok(events[at('lane1')].answer.claims.length > 0, 'the partial has lane 1 lines');
    // League-mates are "they" in what Nick sees: the synthesis said "his yes" and "his price".
    const GENDERED_WORD = /\b(he|his|him|himself|he's)\b/i;
    for (const t of [...out.answer.claims.map(c => c.text), out.answer.shape.verdict.text, out.answer.shape.disagreement, out.numbers_people.people.why, out.lanes.disagreement, ...out.lanes.people.claims, ...(out.thread?.followups ?? [])]) {
      assert.doesNotMatch(t, GENDERED_WORD, t);
    }
    assert.equal(out.lanes.disagreement, 'Numbers say go; Jev reads wait because of their price.');
    assert.match(states[0], /Fixture Receiver is the player in question\./, "Jev reads lane 1's verified line");
    assert.match(states[0], /MANAGER M1/);
    for (const name of MANAGER_NAMES) assert.ok(!states[0].includes(name), 'no manager name in the Jev state');
    assert.doesNotMatch(states[0], /SENTINEL-CHAT-LINE|roster_id/, 'no chat text, no roster id');
    assert.equal(out.lanes.title, 'Claude + Jev');
    assert.equal(out.lanes.people.source, 'jev');
    assert.deepEqual(out.lanes.people.claims, ['Jev: 31% they take it as sent (from chat, unverified).',
      'Jev: wait, mainly on price (from chat, unverified).', "Jev doubts Claude's call: only 35% that it is right for them (from chat, unverified)."]);
    assert.equal(out.lanes.synthesis, 'model');
    assert.equal(out.lanes.verdict, 'differ');
    assert.match(out.lanes.disagreement, /^Numbers say .*; Jev reads /);
    assert.equal(out.answer.shape.disagreement, out.lanes.disagreement, 'the disagreement is in the answer itself');
    assert.equal(out.verification.ok, true);
    assert.equal(out.numbers_people.verdict, 'differ', 'the live Claude + Jev card rides with the answer');
    assert.deepEqual([out.numbers_people.numbers.stance, out.numbers_people.people.stance], ['go', 'wait']);
    assert.deepEqual([...new Set(client.sent.map(x => x.lane))].sort(), ['numbers', 'route', 'synth'], 'no Claude people call when Jev leads');
    const stored = rows(`SELECT payload_json FROM coach_messages WHERE role = 'coach' ORDER BY id DESC LIMIT 1`)[0];
    assert.equal(JSON.parse(stored.payload_json).lanes.people.source, 'jev', 'the lanes are kept with the reply');
  } finally { setJevAsk(null); }
});

test('Jev not wired on this build: the Claude read of the stored signals stands in, labelled, costs logged per lane', async () => {
  clearLaneCache();
  const user = newUser();
  setAnthropicClientForTesting(lanesClient({ synth: {} }));
  await chatTurn({ userId: user, leagueId: 4, question: "What's my next move?", hasModel: true, context: { league: 4 } });
  const client = lanesClient({ synth: {
    claims: [{ text: 'Fixture Receiver is the player in question.', cites: ['r1#0.name'], lane: 'numbers' },
      { text: 'His profile lists P21 (WR) as a want.', cites: ['r2#0.wants'], lane: 'people' }],
    refusals: [], as_of: null, disagreement: null, action: null } });
  setAnthropicClientForTesting(client);
  const out = await chatTurn({ userId: user, leagueId: 4, question: 'is he likely to bite?', hasModel: true, context: { league: 4 } });
  assert.equal(out.lanes.people.source, 'claude_people');
  assert.equal(out.lanes.people.jev, 'unavailable');
  assert.match(out.lanes.people.jev_reason, /Jev is not wired for Coach|Jev has no gateway key/);
  assert.equal(out.lanes.title, 'Numbers + People');
  for (const { body } of client.sent) assert.doesNotMatch(JSON.stringify(body), /SENTINEL-CHAT-LINE/, 'no chat text in any prompt');
  const logged = rows(`SELECT feature, model FROM ai_usage WHERE feature LIKE 'coach:%' ORDER BY id`).map(r => `${r.feature}|${r.model}`);
  assert.ok(logged.includes(`coach:lane_people|${LANE_MODELS.people}`));
  assert.ok(logged.some(l => l.startsWith('coach:lane_numbers|')));
  assert.ok(logged.includes(`coach:synth|${LANE_MODELS.synth}`));
});

test('a synthesis with an unsupported number is not shown: lane A plus the labelled people lines', async () => {
  clearLaneCache();
  const user = newUser();
  setAnthropicClientForTesting(lanesClient({ synth: {} }));
  await chatTurn({ userId: user, leagueId: 4, question: "What's my next move?", hasModel: true, context: { league: 4 } });
  setAnthropicClientForTesting(lanesClient({ synth: {
    claims: [{ text: 'He is 87% likely to accept.', cites: ['r1#0.name'], lane: 'numbers' }], refusals: [], as_of: null,
    disagreement: null, action: null } }));
  const out = await chatTurn({ userId: user, leagueId: 4, question: 'is he likely to bite?', hasModel: true, context: { league: 4 } });
  assert.equal(out.lanes.synthesis, 'fell_back');
  assert.doesNotMatch(out.answer.claims.map(c => c.text).join(' '), /87%/);
  assert.ok(out.answer.claims.some(c => /^From chat, unverified: /.test(c.text)));
  assert.ok(out.answer.claims.some(c => c.lane === 'numbers'));
});

test('nobody in focus: lane B and the synthesis are skipped', async () => {
  clearLaneCache();
  const client = lanesClient({ synth: {} });
  setAnthropicClientForTesting(client);
  const out = await chatTurn({ userId: newUser(), leagueId: 4, question: 'which manager has the deepest bench at running back right now?',
    hasModel: true, context: { league: 4 } });
  assert.deepEqual([...new Set(client.sent.map(s => s.lane))].filter(l => l !== 'route'), ['numbers']);
  assert.match(out.lanes.people.skipped, /nobody in focus/);
});

test('GRIDIRON_COACH_LANES=0 turns the lanes off: the old single answer', async () => {
  clearLaneCache();
  process.env.GRIDIRON_COACH_LANES = '0';
  try {
    const user = newUser();
    setAnthropicClientForTesting(lanesClient({ synth: {} }));
    await chatTurn({ userId: user, leagueId: 4, question: "What's my next move?", hasModel: true, context: { league: 4 } });
    const client = lanesClient({ synth: {} });
    setAnthropicClientForTesting(client);
    const out = await chatTurn({ userId: user, leagueId: 4, question: 'is he likely to bite?', hasModel: true, context: { league: 4 } });
    assert.equal(out.lanes, undefined);
    assert.deepEqual([...new Set(client.sent.map(s => s.lane))].filter(l => l !== 'route'), ['numbers']);
  } finally { delete process.env.GRIDIRON_COACH_LANES; }
});
