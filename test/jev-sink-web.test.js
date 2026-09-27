/**
 * JEV-SINK-FIX: Coach's lane 2 (Claude -> Jev) runs in the web app.
 *
 * Found live on 2026-09-26: the Jev gateway logs every call as a `jev.call` engine event, and
 * engine/role.js refused every engine write from the web role, so with a gateway key set a
 * Coach turn with a partner in focus paid for Jev's answer and then threw it away (the turn
 * failed). Pinned here:
 *   - the web role may append ONLY jev.call events: not jev.runaway, not any other event, never state
 *   - a logging failure after a paid Jev call never loses the answer: it is returned, and the
 *     failure is written to that call's ai_usage.error
 *   - Coach's jevLane and the Numbers & People lane survive a throwing client
 *   - a full web-role Coach turn with a partner in focus, through the real gateway and engine
 *     sink (a stand-in evaluate; no network): lane 2 answers, the verdict is agree / differ /
 *     same_but, and the state Jev read carries no league-mate name, team name or roster id
 * Names are made up (public repo).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-jev-sink-web-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_ANTHROPIC_API_KEY = 'test-key-not-a-real-one';
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
delete process.env.GRIDIRON_COACH_LANES;
process.env.GRIDIRON_COACH_PRELOAD = '0';
process.env.GRIDIRON_COACH_BRIEF_ENABLED = '1';
process.env.GRIDIRON_WARROOM_ENABLED = '1';
const PLANS_FILE = path.join(temp, 'plans.json');
fs.copyFileSync(new URL('./fixtures/warroom-contract/producer-plans.json', import.meta.url), PLANS_FILE);
process.env.GRIDIRON_WARROOM_PLANS = PLANS_FILE;
const savedRole = process.env.GRIDIRON_PROCESS_ROLE;
test.after(() => { fs.rmSync(temp, { recursive: true, force: true }); if (savedRole === undefined) delete process.env.GRIDIRON_PROCESS_ROLE; else process.env.GRIDIRON_PROCESS_ROLE = savedRole; });

const { run, row, rows } = await import('../server/db/index.js');
process.env.GRIDIRON_PROCESS_ROLE = 'test';
await (await import('../server/db/migrate.js')).runMigrations();
const { setAnthropicClientForTesting } = await import('../server/services/claude.js');
const { chatTurn } = await import('../server/services/coach/chat.js');
const { setBrainSources } = await import('../server/services/coach/brain-tools.js');
const { clearLaneCache } = await import('../server/services/coach/lanes.js');
const { setJevAsk, jevLane, JEV_TAKE_QUESTIONS } = await import('../server/services/coach/jev-lane.js');
const { createJevGateway } = await import('../server/services/jev/gateway.js');
const { createEngineSink } = await import('../server/services/jev/engine-sink.js');
const { appendEvents } = await import('../server/services/engine/events.js');
const { writeState } = await import('../server/services/engine/state.js');
const { WEB_EVENT_TYPES } = await import('../server/services/engine/role.js');
const { createJevLane } = await import('../server/services/numbers-people/jev-lane.js');
await import('../server/routes/coach.js');
const web = () => { process.env.GRIDIRON_PROCESS_ROLE = 'web'; };

run(`INSERT OR IGNORE INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (4, 'espn', 'fx-4', 2026, 'Fixture', '1', 4, 1, '{}', '2026-09-23 01:00:00')`);
run(`INSERT OR IGNORE INTO players (id, name, position) VALUES (901, 'Fixture Receiver', 'WR')`);
const MANAGER_NAMES = ['Quincy Marlowe', 'Marlowe Mariners', 'Barnaby Finch', 'Finch Falcons'];
run(`INSERT OR REPLACE INTO league_member_identity (league_id, roster_id, espn_name, team_name, chat_name, match_method, confidence)
     VALUES (4, '3', 'Quincy Marlowe', 'Marlowe Mariners', NULL, 'fixture', 'confirmed')`);
run(`INSERT OR REPLACE INTO league_member_identity (league_id, roster_id, espn_name, team_name, chat_name, match_method, confidence)
     VALUES (4, '2', 'Barnaby Finch', 'Finch Falcons', NULL, 'fixture', 'confirmed')`);
setBrainSources({ profiles: () => ({ status: 'ok', reason: null, as_of: Date.now(), byRoster: new Map([['3', {
  roster_id: '3', status: 'ok', reason: null,
  negotiation: { status: 'ok', messages_read: 12, confidence: 'medium', values_talk: { status: 'ok', wants: [{ player: 'P21 (WR)' }], shopping: [], untouchable: [] } },
  override: { status: 'none', exclude: false, deprioritize: false, toughen: false }, chat: { status: 'unknown', reason: 'no chat-openness read' } }]]) }) });
test.after(() => setBrainSources({ profiles: null }));

const usage = { input_tokens: 100, output_tokens: 50 };
const text = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], stop_reason: 'end_turn', usage });
const tool = () => ({ content: [{ type: 'tool_use', id: 'tu1', name: 'sql_select', input: { sql: 'SELECT name FROM players WHERE id = 901' } }], stop_reason: 'tool_use', usage });
function client() {
  let numbersTurn = 0;
  const sent = [];
  return { sent, messages: { create: async body => {
    const sys = JSON.stringify(body.system ?? '');
    sent.push(sys.slice(0, 60));
    if (sys.includes('Classify a fantasy-football')) return text({ intent: 'ABOUT' });
    if (sys.includes("write Coach's one reply") || sys.includes("write Coach's one answer to Nick")) {
      return text({ verdict: { text: 'Send the served offer, leading with their need.', cites: [] }, stance: 'go', basis: 'title odds', basis_key: 'title_gain',
        why: [{ text: 'Fixture Receiver is the player in question.', cites: ['r1#0.name'] }], risks: [], refusals: [], as_of: null,
        disagreement: 'Numbers say go; Jev reads wait because of price.', claims: [], action: null });
    }
    // Lane 1 names the partner the way the plan labels them ("Quincy (Marlowe Mariners)"), as the live turn did.
    return numbersTurn++ === 0 ? tool() : text({ verdict: { text: 'Send Quincy (Marlowe Mariners) the served offer this week.', cites: [] }, stance: 'go', basis: 'title odds gain',
      basis_key: 'title_gain', why: [{ text: 'Fixture Receiver is the player in question; Quincy Marlowe asked about him.', cites: ['r1#0.name'] }], risks: [], refusals: [], as_of: null });
  } } };
}
const ANSWERS = { p_accept: { type: 'boolean', probability: 0.31 }, claude_call_right: { type: 'boolean', probability: 0.35 },
  better_stance: { type: 'choice', choice: 'wait', probabilities: { go: 0.2, wait: 0.6, avoid: 0.2 } },
  basis: { type: 'choice', choice: 'price', probabilities: { price: 0.7, willingness: 0.1, timing: 0.1, roster_fit: 0.05, risk: 0.05 } } };
/** The real gateway and the real engine sink; only `evaluate` (the network call) is a stand-in. */
function gatewayWith({ sink = createEngineSink(), seen = [] } = {}) {
  return createJevGateway({ sink, env: { AI_GATEWAY_API_KEY: 'stub-key-not-real' },
    evaluate: async ({ state }) => { seen.push(state); return { answers: ANSWERS, usage: { inputTokens: 900, outputTokens: 0 } }; } });
}

test('the web role may append jev.call events only: not jev.runaway, no other event, never state', () => {
  assert.deepEqual([...WEB_EVENT_TYPES], ['jev.call']);
  web();
  try {
    const ev = type => ({ event_type: type, source: 'jev', natural_key: `${type}:${Math.random()}`, as_of: new Date().toISOString(), provenance: 'derived',
      payload: { ok: 1 }, entities: [{ type: 'engine', id: 'jev', role: 'subject' }] });
    assert.equal(appendEvents([ev('jev.call')]).inserted, 1);
    assert.throws(() => appendEvents([ev('jev.runaway')]), /written only by roles/);
    assert.throws(() => appendEvents([ev('jev.call'), ev('jev.runaway')]), /written only by roles/, 'a mixed batch is refused whole');
    assert.throws(() => writeState({ entityType: 'engine', entityId: 'jev', field: 'jev.status', value: {}, asOf: new Date().toISOString() }), /written only by roles/);
    delete process.env.GRIDIRON_PROCESS_ROLE;
    assert.throws(() => appendEvents([ev('jev.call')]), /role is unset/, 'an unset role is still refused');
  } finally { process.env.GRIDIRON_PROCESS_ROLE = 'test'; }
});

test('a paid Jev answer is never lost to logging: the answer returns and ai_usage.error says why', async () => {
  web();
  try {
    const ok = await gatewayWith().ask({ qtype: 'coach_take', arm: 'a', state: 'S', questions: JEV_TAKE_QUESTIONS, asOf: new Date().toISOString() });
    assert.equal(ok.ok, true);
    assert.ok(Number.isInteger(ok.eventId), 'the web role logs the jev.call event');
    assert.equal(ok.logError, undefined);
    const broken = { appendEvent() { throw new Error('disk full'); } };
    const res = await gatewayWith({ sink: broken }).ask({ qtype: 'coach_take', arm: 'a', state: 'S2', questions: JEV_TAKE_QUESTIONS, asOf: new Date().toISOString() });
    assert.equal(res.ok, true, 'the paid answer comes back');
    assert.equal(res.answers.p_accept.probability, 0.31);
    assert.match(res.logError, /^jev_log_failed: disk full/);
    const u = row('SELECT feature, error, cost_usd FROM ai_usage WHERE id = ?', res.usageId);
    assert.equal(u.feature, 'jev:coach_take');
    assert.match(u.error, /^jev_log_failed: disk full/);
    assert.ok(u.cost_usd > 0, 'the cost is still recorded');
  } finally { process.env.GRIDIRON_PROCESS_ROLE = 'test'; }
});

test("Coach's jevLane and the Numbers & People lane survive a throwing client", async () => {
  const boom = async () => { throw new Error('socket hang up'); };
  const r = await jevLane({ question: 'q', laneOne: { claims: [] }, signals: { rows: [] }, focus: {} }, { ask: boom });
  assert.deepEqual([r.status, r.reason], ['failed', 'Jev call failed: socket hang up']);
  const np = await createJevLane({ ask: boom })({ item: { key: 'move:x', kind: 'move', move_id: 'x', players: [] }, facts: {}, claude: { stance: 'go', why: null }, signals: [] });
  assert.equal(np.skipped, 'jev_failed');
});

test('a full web-role Coach turn with a partner in focus: lane 2 answers, the verdict is agree/differ/same, the Jev state is pseudonymised', async () => {
  clearLaneCache();
  const seen = [];
  const gw = gatewayWith({ seen });
  setJevAsk(({ state, questions }) => gw.ask({ qtype: 'coach_take', arm: 'a', state, questions, asOf: new Date().toISOString() }));
  setAnthropicClientForTesting(client());
  const uid = 9951;
  run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (?, 'jev-sink-web', 'Reader')`, uid);
  web();
  try {
    // The served next move puts its partner (roster 3) in focus, as in the drawer; then the question about them.
    await chatTurn({ userId: uid, leagueId: 4, question: "What's my next move?", hasModel: true, context: { league: 4 } });
    const out = await chatTurn({ userId: uid, leagueId: 4, question: 'is he likely to take the offer?', hasModel: true, context: { league: 4 } });
    assert.equal(out.thread?.focus?.partner ?? '3', '3');
    assert.equal(seen.length, 1, 'Jev was asked once, through the real gateway');
    assert.equal(out.lanes.people.source, 'jev', 'lane 2 is Jev, not the stand-in');
    assert.ok(['agree', 'differ', 'same_but'].includes(out.lanes.verdict), `verdict ${out.lanes.verdict}`);
    assert.equal(out.lanes.verdict, 'differ', 'Claude go / Jev wait');
    assert.ok(out.answer.claims.length > 0 || out.answer.shape, 'an answer shipped');
    const event = row(`SELECT event_type, payload FROM engine_events WHERE event_type = 'jev.call' ORDER BY id DESC LIMIT 1`);
    assert.equal(JSON.parse(event.payload).ok, 1, 'the call is logged from the web role');
    // Pseudonymised: no league-mate or team name, and no roster id that maps back to one.
    const state = seen[0];
    for (const name of MANAGER_NAMES) {
      for (const part of [name, ...name.split(' ')]) assert.ok(!state.includes(part), `the Jev state names "${part}"`);
    }
    const ids = rows('SELECT roster_id FROM league_member_identity WHERE league_id = 4').map(r => String(r.roster_id));
    for (const id of ids) {
      assert.doesNotMatch(state, new RegExp(`roster[_ ]?(id)?\\W{0,3}${id}\\b|team ${id}\\b`, 'i'), `roster ${id} is not in the state`);
    }
    assert.doesNotMatch(state, /roster_id/);
    assert.match(state, /MANAGER M1/, 'the league-mate is the alias');
    assert.match(state, /MANAGER M1 asked about him/, "lane 1's line reaches Jev with the alias in place of the name");
  } finally {
    process.env.GRIDIRON_PROCESS_ROLE = 'test';
    setJevAsk(null);
    setAnthropicClientForTesting(null);
  }
});

test('pseudonymise: full names, team names and label-shaped first names go; a player who shares a first name stays', async () => {
  const { leagueMateMasks, pseudonymise } = await import('../server/services/people/pseudonymise.js');
  run(`INSERT OR IGNORE INTO players (id, name, position) VALUES (902, 'Barnaby Quill', 'QB')`);
  const masks = leagueMateMasks(4);
  const t = "Quincy (Marlowe Mariners) and Barnaby Finch's Finch Falcons; Barnaby's ask; Barnaby Quill starts; quincy marlowe typed lower.";
  assert.equal(pseudonymise(t, masks, { focusRoster: '3' }),
    "MANAGER M1 (MANAGER M1) and another manager's another manager; another manager's ask; Barnaby Quill starts; MANAGER M1 typed lower.");
  assert.equal(pseudonymise('no names here', masks), 'no names here');
});

