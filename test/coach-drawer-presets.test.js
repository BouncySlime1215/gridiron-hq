/**
 * COACH-PRESETS (#390): the War Room Coach drawer's six fixed questions
 * (CoachDrawer.tsx FIXED_QUESTIONS) never return 500.
 *
 * Pinned here:
 *   - with no model key, each of the six goes through the real POST
 *     /api/coach/ask route and comes back 200 with at least one grounded
 *     claim, verification ok, nothing dropped, cost_usd 0 and zero model calls,
 *     for every league in the producer fixture
 *   - no rendered line carries an engine label (receptiveness, basis:, a
 *     producer or migration id, key:value chat tags)
 *   - "Who should I work this week?" gives the edge in title odds only when
 *     the plan priced it in title odds
 *   - "Is it safe to send?" says when a gain sits inside the noise, and the
 *     confirm-dice card only when it matches the served move
 *   - the model path's people_read no longer throws (it called
 *     profile-reader.js#readProfiles, which does not exist): a model turn that
 *     reads people returns 200
 * Fixture plans only; no league or manager names.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-presets-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
delete process.env.GRIDIRON_ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
process.env.GRIDIRON_COACH_BRIEF_ENABLED = '1';
process.env.GRIDIRON_WARROOM_ENABLED = '1';

const FIXTURE = new URL('./fixtures/warroom-contract/producer-plans.json', import.meta.url);
const PLANS = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const PLANS_FILE = path.join(temp, 'plans.json');
const writePlans = file => fs.writeFileSync(PLANS_FILE, JSON.stringify(file));
process.env.GRIDIRON_WARROOM_PLANS = PLANS_FILE;
writePlans(PLANS);

// The drawer's questions, read from the client so this test follows the UI.
const DRAWER = fs.readFileSync(new URL('../client/src/components/warroom/coach/CoachDrawer.tsx', import.meta.url), 'utf8');
const block = DRAWER.slice(DRAWER.indexOf('export const FIXED_QUESTIONS'), DRAWER.indexOf('] as const'));
const FIXED = [...block.matchAll(/(["'])((?:(?!\1).)+)\1,/g)].map(m => m[2]);

const { run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { setAnthropicClientForTesting } = await import('../server/services/claude.js');
const { default: coachRouter } = await import('../server/routes/coach.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const { starterIntent, starterClaims } = await import('../server/services/coach/starter-answers.js');
const { newLedger } = await import('../server/services/coach/ledger.js');
const brain = await import('../server/services/coach/brain-tools.js');
const reader = await import('../server/services/people/profile-reader.js');

const READERS = 80;
for (let i = 0; i < READERS; i++) {
  run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (?, ?, 'Reader')`, 9501 + i, `coach-presets-${i}`);
  run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at)
       VALUES (?, ?, datetime('now','+1 day'))`, 9501 + i, hashSessionToken(`presets-token-${i}`));
}
let who = 0;

let modelCalls = 0;
const noModel = { messages: { create: async () => { modelCalls += 1; throw new Error('no model in this test'); } } };
setAnthropicClientForTesting(noModel);

const app = express();
app.use(express.json());
app.use('/api/coach', coachRouter);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/coach`;
test.after(() => { server.close(); setAnthropicClientForTesting(null); fs.rmSync(temp, { recursive: true, force: true }); });

const ask = (question, leagueId = 4) => fetch(`${base}/ask`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer presets-token-${who++ % READERS}` },
  body: JSON.stringify({ question, league_id: leagueId,
    context: { surface: 'war_room', route: '/trade-brain?view=war-room', league: leagueId } }) });

const ENGINE_LABEL = /receptiveness|\bbasis:|PULSE-\d|CRED-\d|migration \d|\b[a-z_]+:[a-z_]+\b|step\(s\)|\bM6\b/;

test('the drawer has six fixed questions and each maps to a $0 intent', () => {
  assert.equal(FIXED.length, 6, JSON.stringify(FIXED));
  for (const q of FIXED) assert.ok(starterIntent(q), `no $0 intent for "${q}"`);
});

test('no key: every fixed question answers 200 from the plan, grounded, $0, for every fixture league', async () => {
  const leagues = PLANS.leagues.map(l => l.league);
  let asked = 0;
  for (const league of leagues) {
    for (const q of FIXED) {
      const res = await ask(q, league);
      assert.equal(res.status, 200, `${q} (league ${league}) -> ${res.status}`);
      const body = await res.json();
      asked++;
      assert.equal(body.cost_usd, 0);
      assert.equal(body.verification.ok, true);
      assert.deepEqual(body.dropped ?? [], [], `${q} (league ${league}) dropped ${JSON.stringify(body.dropped)}`);
      assert.ok(body.answer.claims.length >= 1, `${q} (league ${league}) had no claim: ${JSON.stringify(body.answer.refusals)}`);
      for (const c of body.answer.claims) {
        assert.ok(c.cites.length, `uncited: ${c.text}`);
        assert.doesNotMatch(c.text, ENGINE_LABEL, `engine label in "${c.text}"`);
      }
    }
  }
  assert.equal(modelCalls, 0);
  console.log(`# METRIC ${JSON.stringify({ leagues: leagues.length, questions: FIXED.length, asked, status_200: asked, model_calls: modelCalls })}`);
});

test('who to work: the edge is said in title odds only when the plan priced it so', () => {
  const entry = structuredClone(PLANS.leagues.find(l => l.league === 4));
  const text = () => starterClaims('message_first', { entry, ledger: newLedger() })[0].text;
  assert.match(text(), /edge with him is \+\d+\.\d pts of title odds/);
  assert.match(text(), /based on how active he has been lately/);
  entry.partners.value[0].edge.unit = 'points';
  assert.doesNotMatch(text(), /edge/);
});

test('safe to send: a gain inside the noise says so; the confirm card only when it matches the served move', () => {
  const entry = structuredClone(PLANS.leagues.find(l => l.league === 4));
  const lines = () => starterClaims('safe_to_send', { entry, ledger: newLedger() }).map(c => c.text);
  assert.ok(lines().some(t => /past the noise bar/.test(t)));
  assert.ok(lines().some(t => /^Re-priced on fresh dice, it holds up/.test(t)));
  entry.next_move.value.steps[0].title_odds_delta.clears_2se = false;
  assert.ok(lines().some(t => /inside the noise/.test(t)));
  entry.next_move.value.expected.value += 0.01;
  assert.ok(!lines().some(t => /fresh dice/.test(t)), 'a card that does not match the served move is not quoted');
  entry.next_move = { status: 'unknown', source: 'plan.path', reason: 'no move clears your rules.' };
  assert.deepEqual(lines(), ['Nothing to send: no move clears your rules.']);
});

test('said lately: a pulse that never ran is said in plain words, never the producer id', () => {
  const entry = PLANS.leagues.find(l => l.league === 4);
  const said = { status: 'unknown', reason: 'PULSE-01 has not run for league 4: no people_pulse run is recorded' };
  const [c] = starterClaims('said_lately', { entry, ledger: newLedger(), said });
  assert.match(c.text, /hasn't been read for this league yet/);
  assert.doesNotMatch(c.text, ENGINE_LABEL);
});

// Runs before the adapter test, which swaps the profile source: this one reads the default source.
test('model path: a turn that reads people returns 200, not 500', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  process.env.GRIDIRON_COACH_BRAIN_TOOLS = '1';
  const usage = { input_tokens: 10, output_tokens: 5 };
  let turn = 0;
  setAnthropicClientForTesting({ messages: { create: async () => (turn++ === 0
    ? { content: [{ type: 'tool_use', id: 'tu1', name: 'people_read', input: { league_id: 4 } }], stop_reason: 'tool_use', usage }
    : { content: [{ type: 'text', text: JSON.stringify({ claims: [], refusals: ['No profile to read.'], as_of: null }) }],
      stop_reason: 'end_turn', usage }) } });
  try {
    const res = await ask('Which managers are shopping players right now?');
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(turn, 2);
    assert.ok(body.plan.some(e => e.t === 'query' && e.tool === 'people_read' && e.status === 'done'), JSON.stringify(body.plan));
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GRIDIRON_COACH_BRAIN_TOOLS;
    setAnthropicClientForTesting(noModel);
  }
});

test('people_read reads the one profile reader (readProfiles is gone), and maps its rows', () => {
  assert.equal(typeof reader.peopleProfileFromChat, 'function');
  assert.equal(reader.readProfiles, undefined, 'if readProfiles comes back, drop the adapter instead');
  const profile = { headline: 'h', says_no: { how: 'h', does_his_no_hold: 'yes', evidence: [] },
    praise_means: { reading: 'belief', why: 'w', evidence: [] }, techniques: [],
    calibration: { enthusiasm_scale: 'e', inflation: 'none' }, what_moves_him: [], how_to_approach: 'a',
    confidence: 'medium', caveats: [], roster_read: { really_untouchable: ['P2 (RB)'], quietly_available: ['P7 (WR)'] } };
  const read = reader.peopleProfileFromRows({ leagueId: 4, myTeam: '1',
    ids: new Map([['1', { chat_name: 'ME' }], ['3', { chat_name: 'mgr-a' }], ['4', { chat_name: 'mgr-b' }]]),
    profiles: [{ name: 'mgr-a', profile_json: JSON.stringify(profile), messages_read: 120 }],
    notes: [{ name: 'mgr-b', note: '{"contactable": false}', source: 'nick-test' }] });
  brain.setBrainSources({ profiles: () => brain.profilesFromReader(read, Date.parse('2026-09-25T00:00:00Z')) });
  try {
    const rows = brain.peopleRead({ league_id: 4 });
    const a = rows.find(r => r.roster_id === '3');
    const b = rows.find(r => r.roster_id === '4');
    assert.equal(a.status, 'ok');
    assert.equal(a.shopping, 'P7 (WR)');
    assert.equal(a.untouchable, 'P2 (RB)');
    assert.equal(a.in_market, true);
    assert.equal(a.p_open_to_trade, null);
    assert.equal(b.status, 'unknown');
    assert.equal(b.nick_override, 'exclude');
    assert.equal(b.in_market, false);
    assert.ok(!rows.some(r => r.roster_id === '1'), "Nick's own roster is never a counterpart");
  } finally { brain.setBrainSources({ profiles: null }); }
  assert.deepEqual(brain.profilesFromReader({ available: false, reason: 'chat DB not found' }),
    { status: 'unknown', reason: 'chat DB not found' });
});
