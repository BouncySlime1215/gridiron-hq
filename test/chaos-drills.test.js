/**
 * HEALTH-01d chaos drills: break things on purpose in a fixture database and
 * check the chain degrades gracefully instead of erroring or serving a broken
 * number as if it were fine.
 *
 * Four drills, each with a page side and a Coach side:
 *   1. the ESPN feed goes stale
 *   2. a projection's target shares are corrupted to sum to 1.3
 *   3. the season simulator throws
 *   4. the AI gateway times out
 *
 * The engine health layer these drills are written for (HEALTH-01a checks and
 * lineage, 01b labelled fallbacks, 01c Coach reading health) is NOT on main:
 * server/services/engine/ does not exist yet (it arrives with #216 / EA-00).
 * So each drill has two kinds of test:
 *   - BASELINE tests pin what main does today. They pass, and they are the
 *     floor: a later change that makes a fault silent, or turns a labelled
 *     stale row into an unlabelled one, fails here.
 *   - PENDING tests (`todo`) state the HEALTH-01 target as a real assertion.
 *     They run and currently fail; node:test reports them as TODO, not as a
 *     failure. Each one names the unit that turns it green. When that unit
 *     lands, drop the `todo` and it becomes an ordinary gate.
 *
 * No network, no spend: every Claude call is a stand-in client.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-chaos-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.GRIDIRON_ANTHROPIC_API_KEY = 'test-key-not-a-real-one';

const { run, row } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { seedFixture, FIXTURE_LEAGUE_ID } = await import('../scripts/lib/coach-canary-golden.mjs');
seedFixture(run);

/** Which fault is switched on. Every drill resets it. */
const chaos = { simThrows: false, toolThrows: false };
test.afterEach(() => { chaos.simThrows = false; chaos.toolThrows = false; });

// The two faults that live inside a module are injected by wrapping the real
// module: every export passes through, one function throws on demand.
const realSim = await import('../server/services/season-sim.js');
mock.module('../server/services/season-sim.js', { namedExports: { ...realSim,
  simulateSeason: (...args) => {
    if (chaos.simThrows) throw new Error('chaos: season simulator fault');
    return realSim.simulateSeason(...args);
  } } });
const realWhoPlays = await import('../server/services/who-plays.js');
mock.module('../server/services/who-plays.js', { namedExports: { ...realWhoPlays,
  whoPlays: (...args) => {
    if (chaos.toolThrows) throw new Error('chaos: availability service fault');
    return realWhoPlays.whoPlays(...args);
  } } });

const { setAnthropicClientForTesting } = await import('../server/services/claude.js');
const { budgetStatus } = await import('../server/services/llm-budget.js');
const { allSources } = await import('../server/services/source-registry.js');
const { VIOLATIONS } = await import('../server/services/coach/verify.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const { default: coachRouter } = await import('../server/routes/coach.js');
const { default: modelRouter } = await import('../server/routes/model.js');
const { requireAuthenticated } = await import('../server/platform/auth.js');

run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (9301, 'chaos-drill-user', 'Reader')`);
run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at)
     VALUES (9301, ?, datetime('now','+1 day'))`, hashSessionToken('chaos-token'));
run(`INSERT OR IGNORE INTO league_memberships(league_id, user_id, role) VALUES (?, 9301, 'member')`, FIXTURE_LEAGUE_ID);
run(`UPDATE leagues SET payload = '{}' WHERE id = ?`, FIXTURE_LEAGUE_ID);
const AUTH = { authorization: 'Bearer chaos-token' };

// Mounted as server/index.js mounts them, with its error handler.
const app = express();
app.use(express.json());
app.use('/api/coach', coachRouter);
app.use('/api/model', requireAuthenticated, modelRouter);
app.use((err, _req, res, _next) => {
  const status = Number.isInteger(err.status) ? err.status : 500;
  res.status(status).json({ error: err.message });
});
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
test.after(() => { server.close(); setAnthropicClientForTesting(null); fs.rmSync(temp, { recursive: true, force: true }); });

const usage = { input_tokens: 10, output_tokens: 5 };
const says = object => ({ content: [{ type: 'text', text: JSON.stringify(object) }], stop_reason: 'end_turn', usage });
const toolUse = (name, input) => ({ content: [{ type: 'tool_use', id: 'tu1', name, input }], stop_reason: 'tool_use', usage });
const scripted = (...replies) => {
  let turn = 0;
  return { messages: { create: async () => {
    const reply = replies[turn++] ?? says({ claims: [], refusals: ['out of script'] });
    if (reply instanceof Error) throw reply;
    return reply;
  } } };
};
const ask = (body, headers = {}) => fetch(`${base}/coach/ask`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...AUTH, ...headers }, body: JSON.stringify(body) });
const streamEvents = async response => (await response.text()).split('\n\n')
  .filter(chunk => chunk.startsWith('data: ')).map(chunk => JSON.parse(chunk.slice(6)));

const ENGINE_DIR = path.join(REPO, 'server/services/engine');
const ENGINE_PENDING = 'HEALTH-01a/b not on main: server/services/engine/ (health.js, state.js reader) arrives with #216 / EA-00';
const COACH_PENDING = 'HEALTH-01c not on main: coach/verify.js has no HEALTH_MISSING / DEGRADED_UNSTATED and ask.js rethrows tool and model faults';

// ---------------------------------------------------------------- drill 1: ESPN feed goes stale

test('drill 1 baseline: a stale ESPN feed is labelled stale with lowered confidence, not served as current', () => {
  run(`INSERT OR REPLACE INTO sync_log (job, last_run_at, last_status, last_detail, runs, consecutive_failures)
       VALUES ('espn_players', datetime('now', '-3 days'), 'ok', '{}', 1, 0)`);
  const espn = allSources().find(s => s.source === 'espn_players');
  assert.ok(espn, 'espn_players is a registered source');
  assert.equal(espn.stale, true, 'three days past a one-day budget must read stale');
  assert.ok(espn.age_minutes > espn.max_age_minutes);
  assert.ok(espn.confidence < 1 && espn.confidence >= 0.2, `confidence ${espn.confidence} should decay, not stay 1`);
  assert.equal(espn.last_status, 'ok', 'a job that ran fine long ago is stale, not failed');
});

test('drill 1 baseline: Coach still answers, verified, while the ESPN feed is stale', async () => {
  setAnthropicClientForTesting(scripted(
    toolUse('sql_select', { sql: "SELECT job, last_status FROM sync_log WHERE job = 'espn_players'" }),
    says({ claims: [{ text: 'The ESPN player feed last finished with status ok.', cites: ['r1#0.last_status'] }], refusals: [] })));
  const response = await ask({ question: 'is the ESPN feed current?' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.verification.ok, true, JSON.stringify(body.verification.violations));
  assert.equal(body.answer.claims.length, 1, 'the scripted claim shipped, not a retry');
});

test('drill 1 target: the served field carries health "stale" and the page gets a labelled fallback',
  { todo: ENGINE_PENDING }, () => {
    assert.ok(fs.existsSync(path.join(ENGINE_DIR, 'health.js')), 'no engine health module to label the field');
  });

test('drill 1 target: Coach cannot cite a stale number without saying it is stale', { todo: COACH_PENDING }, () => {
  assert.ok(Object.values(VIOLATIONS).includes('degraded_unstated'), 'verify.js has no DEGRADED_UNSTATED violation');
});

// ---------------------------------------------------------------- drill 2: shares sum to 1.3

const corruptShares = () => run(`UPDATE player_week_usage SET target_share = 0.60
  WHERE player_id = 9003 AND season = 2026 AND week = 3`);
const shareSum = () => row(`SELECT ROUND(SUM(target_share), 4) AS s FROM player_week_usage
  WHERE team = 'FXA' AND season = 2026 AND week = 3`).s;

test('drill 2 baseline: Coach answers without an error when the shares it reads are corrupt', async () => {
  corruptShares();
  assert.equal(shareSum(), 1.3, 'the corruption is in place');
  setAnthropicClientForTesting(scripted(
    toolUse('sql_select', { sql: `SELECT target_share FROM player_week_usage
      WHERE player_id = 9003 AND season = 2026 AND week = 3` }),
    says({ claims: [{ text: 'Fixture Receiver A had a 0.6 target share.', cites: ['r1#0.target_share'] }], refusals: [] })));
  const response = await ask({ question: "Fixture Receiver A's week 3 target share?" });
  assert.equal(response.status, 200);
  const body = await response.json();
  // Today this passes the grounding check and ships: the number is in the
  // row, and nothing knows the row breaks the shares-sum-to-1 invariant.
  assert.equal(body.verification.ok, true);
  assert.equal(body.verification.retried, false);
  assert.deepEqual(body.answer.claims.map(c => c.text), ['Fixture Receiver A had a 0.6 target share.']);
});

test('drill 2 target: a shares-sum-1.3 write is marked failed and the last good row is served',
  { todo: ENGINE_PENDING }, () => {
    assert.ok(fs.existsSync(path.join(ENGINE_DIR, 'health.js')), 'no invariant check runs on write');
  });

test('drill 2 target: Coach declines the failed number and says why', { todo: COACH_PENDING }, async () => {
  corruptShares();
  setAnthropicClientForTesting(scripted(
    toolUse('sql_select', { sql: `SELECT target_share FROM player_week_usage
      WHERE player_id = 9003 AND season = 2026 AND week = 3` }),
    says({ claims: [{ text: 'Fixture Receiver A had a 0.6 target share.', cites: ['r1#0.target_share'] }], refusals: [] })));
  const body = await (await ask({ question: "Fixture Receiver A's week 3 target share?" })).json();
  const text = body.answer.claims.map(c => c.text).join(' ');
  assert.ok(!/0\.6/.test(text), 'Coach repeated a number from a row that fails its invariant');
});

// ---------------------------------------------------------------- drill 3: the simulator throws

const simulate = () => fetch(`${base}/model/${FIXTURE_LEAGUE_ID}/simulate?runs=10&seed=1`, { headers: AUTH });

test('drill 3 baseline: a throwing simulator is a stated error, never a silent or empty page', async () => {
  chaos.simThrows = true;
  const response = await simulate();
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.match(body.error, /season simulator fault/, 'the page gets the reason, not a blank');
  assert.ok(!('teams' in body), 'no half-built simulation is served as if it ran');
});

test('drill 3 baseline: Coach is unaffected by a simulator fault (it has no simulator tool)', async () => {
  chaos.simThrows = true;
  setAnthropicClientForTesting(scripted(
    toolUse('sql_select', { sql: 'SELECT team_count FROM leagues WHERE id = 901' }),
    says({ claims: [{ text: 'The league has 10 teams.', cites: ['r1#0.team_count'] }], refusals: [] })));
  const response = await ask({ question: 'how many teams?' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.verification.ok, true);
  assert.deepEqual(body.answer.claims.map(c => c.text), ['The league has 10 teams.']);
});

test('drill 3 baseline: a Coach tool that throws is surfaced in the stream as a plain error event', async () => {
  chaos.toolThrows = true;
  setAnthropicClientForTesting(scripted(toolUse('who_plays', { season: 2026, week: 3, team: 'FXA' })));
  const response = await ask({ question: 'who plays for FXA?' }, { accept: 'text/event-stream' });
  assert.equal(response.status, 200, 'the stream opened before the fault');
  const events = await streamEvents(response);
  const error = events.find(e => e.t === 'error');
  assert.ok(error, 'the stream must end on an error event, not just stop');
  assert.match(error.error, /availability service fault/);
});

test('drill 3 target: the page serves the last good simulation, labelled fallback_used', { todo: ENGINE_PENDING }, async () => {
  chaos.simThrows = true;
  const response = await simulate();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).fallback_used, true);
});

test('drill 3 target: a thrown Coach tool becomes "I couldn\'t check X because Y", HTTP 200', { todo: COACH_PENDING }, async () => {
  chaos.toolThrows = true;
  setAnthropicClientForTesting(scripted(toolUse('who_plays', { season: 2026, week: 3, team: 'FXA' }),
    says({ claims: [], refusals: [] })));
  const response = await ask({ question: 'who plays for FXA?' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.answer.refusals.join(' '), /couldn.t check/i);
});

// ---------------------------------------------------------------- drill 4: AI gateway times out

const timeout = () => Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' });

test('drill 4 baseline: a model timeout is a stated error and releases its budget hold', async () => {
  setAnthropicClientForTesting(scripted(timeout()));
  const response = await ask({ question: 'anything' });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error, 'Request timed out.', 'the reason reaches the page as a plain sentence');
  assert.equal(budgetStatus('coach').reserved_usd, 0, 'a timed-out call must not keep holding budget');
});

test('drill 4 baseline: no server route imports the Vercel AI gateway, so a Jev timeout cannot reach a page', () => {
  const routes = path.join(REPO, 'server/routes');
  const importsAi = fs.readdirSync(routes).filter(f => f.endsWith('.js'))
    .filter(f => /from ['"]ai['"]/.test(fs.readFileSync(path.join(routes, f), 'utf8')));
  assert.deepEqual(importsAi, [], 'a route now calls the AI gateway; give it a timeout drill of its own');
});

test('drill 4 target: Coach answers a model timeout with a plain explanation, HTTP 200', { todo: COACH_PENDING }, async () => {
  setAnthropicClientForTesting(scripted(timeout()));
  const response = await ask({ question: 'anything' });
  assert.equal(response.status, 200);
  assert.match((await response.json()).answer.refusals.join(' '), /timed out/i);
});
