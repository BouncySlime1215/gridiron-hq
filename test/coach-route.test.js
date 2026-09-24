/**
 * The Coach endpoint.
 *
 * Nothing reaches the client that did not pass the grounding check, the ledger
 * behind every cite travels with the answer so the UI can show the row a
 * number came from, and the thinking sequence is a real trace of what
 * happened rather than a decorative spinner. The limits are the ones the
 * page-explain route already sets, for the same reason: this router is
 * reachable through the public tunnel and every call spends on Nick's key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-route-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_ANTHROPIC_API_KEY = 'test-key-not-a-real-one';

const { run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { setAnthropicClientForTesting } = await import('../server/services/claude.js');
const { default: coachRouter } = await import('../server/routes/coach.js');
const { hashSessionToken } = await import('../server/platform/auth.js');

run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES (1, 'PHI', 'Eagles', 'NFC', 'East')`);
run(`INSERT INTO players (id, name, position, team_id, depth_rank) VALUES (1, 'A Player', 'WR', 1, 1)`);

// Mounted exactly as server/index.js mounts a router of this kind: a bearer
// session and nothing more, so the route's own limits are what is under test.
run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (9101, 'coach-route-user', 'Reader')`);
run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at)
     VALUES (9101, ?, datetime('now','+1 day'))`, hashSessionToken('coach-token'));
const AUTH = { authorization: 'Bearer coach-token' };

const app = express();
app.use(express.json());
app.use('/api/coach', coachRouter);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/coach`;
test.after(() => { server.close(); setAnthropicClientForTesting(null); });

const usage = { input_tokens: 10, output_tokens: 5 };
const says = object => ({ content: [{ type: 'text', text: JSON.stringify(object) }], stop_reason: 'end_turn', usage });
const toolUse = (name, input) =>
  ({ content: [{ type: 'tool_use', id: 'tu1', name, input }], stop_reason: 'tool_use', usage });

function scripted(...replies) {
  let turn = 0;
  return { messages: { create: async () => replies[turn++] ?? says({ claims: [], refusals: ['out of script'] }) } };
}

const ask = (body, headers = {}) => fetch(`${base}/ask`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...AUTH, ...headers }, body: JSON.stringify(body) });
const get = url => fetch(url, { headers: AUTH });

test('a question comes back with the answer, the ledger it stands on and the trace', async () => {
  setAnthropicClientForTesting(scripted(
    toolUse('sql_select', { sql: 'SELECT name, depth_rank FROM players' }),
    says({ claims: [{ text: 'A Player is at depth 1.', cites: ['r1#0.name', 'r1#0.depth_rank'] }], refusals: [] })
  ));
  const response = await ask({ question: 'who is the top WR' });
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.verification.ok, true, JSON.stringify(body.verification.violations));
  assert.equal(body.answer.claims[0].cites[0], 'r1#0.name');
  assert.equal(body.ledger.queries[0].rows[0].name, 'A Player');
  assert.ok(body.plan.some(e => e.t === 'answer'));
  assert.ok(Number.isInteger(body.audit_id));
});

test('every cite in the answer resolves into the ledger that travels with it', async () => {
  setAnthropicClientForTesting(scripted(
    toolUse('sql_select', { sql: 'SELECT name FROM players' }),
    says({ claims: [{ text: 'A Player is on the roster.', cites: ['r1#0.name'] }], refusals: [] })
  ));
  const body = await (await ask({ question: 'roster?' })).json();
  const ids = new Set(body.ledger.queries.map(q => q.id));
  for (const claim of body.answer.claims) {
    for (const cite of claim.cites) {
      assert.ok(ids.has(cite.split('#')[0]) || body.ledger.derived.some(d => d.id === cite),
        `${cite} does not resolve into the ledger the client was given`);
    }
  }
});

test('an unverifiable claim never reaches the client', async () => {
  setAnthropicClientForTesting(scripted(
    says({ claims: [{ text: 'He scored 22.6 points.', cites: [] }], refusals: [] }),
    says({ claims: [{ text: 'He scored 22.6 points.', cites: [] }], refusals: [] })
  ));
  const body = await (await ask({ question: 'points?' })).json();
  assert.equal(body.answer.claims.length, 0);
  assert.equal(JSON.stringify(body.answer).includes('22.6'), false);
  assert.ok(body.answer.refusals.length >= 1);
});

test('a question that is missing, empty or not a string is refused with 400', async () => {
  for (const body of [{}, { question: '' }, { question: '   ' }, { question: 42 }]) {
    const response = await ask(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    // The route says so itself, in JSON. Letting this fall through to the
    // error handler produces the same status with an HTML body the client
    // cannot read; mutation M42 proved nothing noticed.
    assert.deepEqual(await response.json(), { error: 'question is required' });
  }
});

test('an over-long question or context is refused with 413 rather than sent to Claude', async () => {
  const long = await ask({ question: 'x'.repeat(2_001) });
  assert.equal(long.status, 413);
  const wide = await ask({ question: 'ok', context: { blob: 'y'.repeat(16_001) } });
  assert.equal(wide.status, 413);
});

test('an unauthenticated request is refused before anything is spent', async () => {
  const response = await fetch(`${base}/ask`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'who is the top WR' }) });
  assert.equal(response.status, 401);
});

test('the catalog is readable, so the UI can say what Coach can and cannot see', async () => {
  const body = await (await get(`${base}/catalog`)).json();
  assert.ok(body.tables.includes('players'));
  assert.ok(body.coverage.in_database >= body.coverage.catalogued);
  assert.ok(body.catalog.players.means.length > 10);
});

test('the audit is readable, and the grounding rate with it', async () => {
  const answers = await (await get(`${base}/answers?limit=5`)).json();
  assert.ok(Array.isArray(answers.answers));
  assert.ok(answers.answers.length >= 1);
  assert.equal(typeof answers.answers[0].verified, 'number');
  const rate = await (await get(`${base}/grounding`)).json();
  assert.ok(rate.answered >= 1);
  assert.ok(rate.refused_after_retry >= 1, 'the refused answer above should be counted');
});

test('asking for the event stream streams the trace and ends with the result', async () => {
  setAnthropicClientForTesting(scripted(
    toolUse('sql_select', { sql: 'SELECT name FROM players' }),
    says({ claims: [{ text: 'A Player is on the roster.', cites: ['r1#0.name'] }], refusals: [] })
  ));
  const response = await ask({ question: 'stream me' }, { accept: 'text/event-stream' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const text = await response.text();

  const events = text.split('\n\n').filter(Boolean).map(chunk => {
    const line = chunk.split('\n').find(l => l.startsWith('data: '));
    return JSON.parse(line.slice(6));
  });
  assert.ok(events.some(e => e.t === 'understood'));
  assert.ok(events.some(e => e.t === 'query' && e.status === 'done'));
  const last = events.at(-1);
  assert.equal(last.t, 'result');
  assert.equal(last.verification.ok, true);
  assert.equal(last.answer.claims.length, 1);
});

/* ----------------------------------------------------------- COACH-BRIEF */

const PLANS_FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures/warroom-contract/producer-plans.json');
run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id, connection_status)
     VALUES (4, 'espn', 'espn-coach-brief-4', 2026, 'Brief League', '{}', 10, '1', 'connected')`);
run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id, connection_status)
     VALUES (5, 'espn', 'espn-coach-brief-5', 2026, 'Other League', '{}', 10, '1', 'connected')`);
run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (4, 9101, 'member')`);

async function withBriefEnv(env, fn) {
  const keys = ['GRIDIRON_COACH_BRIEF_ENABLED', 'GRIDIRON_PREVIEW_UNCONFIRMED', 'GRIDIRON_WARROOM_PLANS'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  try { return await fn(); } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('brief: flag off answers off and reads nothing', async () => {
  await withBriefEnv({ GRIDIRON_WARROOM_PLANS: PLANS_FIXTURE }, async () => {
    const response = await get(`${base}/brief/4`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'off');
    assert.equal(body.text, undefined);
  });
});

test('brief: the morning brief and weekly check-in come back grounded, with the ledger behind every cite', async () => {
  await withBriefEnv({ GRIDIRON_COACH_BRIEF_ENABLED: '1', GRIDIRON_WARROOM_PLANS: PLANS_FIXTURE }, async () => {
    for (const [url, title] of [[`${base}/brief/4`, /^Morning brief, league 4/], [`${base}/brief/4?kind=weekly`, /^Weekly check-in, league 4/]]) {
      const response = await get(url);
      assert.equal(response.status, 200, url);
      const body = await response.json();
      assert.equal(body.status, 'ok', JSON.stringify(body).slice(0, 300));
      assert.match(body.text, title);
      assert.deepEqual(body.dropped, []);
      assert.ok(body.claims.length >= 5);
      const ids = new Set(body.ledger.queries.map(q => q.id));
      for (const c of body.claims) {
        for (const cite of c.cites) {
          assert.ok(ids.has(cite.split('#')[0]) || body.ledger.derived.some(d => d.id === cite), `${cite} is not in the ledger`);
        }
      }
    }
    const morning = await (await get(`${base}/brief/4`)).json();
    assert.match(morning.text, /Statements not read: the brief does not read chat labels yet: their producer, PULSE-01/);
    assert.match(morning.text, /Offer Team 3 P4 \(WR\) \+ P6 \(RB\) for P21 \(WR\)\./);
  });
});

test('brief: another league, a bad id or a push kind is refused; no plans file is said plainly', async () => {
  await withBriefEnv({ GRIDIRON_COACH_BRIEF_ENABLED: '1', GRIDIRON_WARROOM_PLANS: PLANS_FIXTURE }, async () => {
    assert.equal((await get(`${base}/brief/5`)).status, 403, 'not a member of league 5');
    assert.equal((await get(`${base}/brief/abc`)).status, 400);
    assert.equal((await get(`${base}/brief/4?kind=push`)).status, 400, 'the push is PUSH-01\'s');
    assert.equal((await fetch(`${base}/brief/4`)).status, 401);
  });
  await withBriefEnv({ GRIDIRON_COACH_BRIEF_ENABLED: '1', GRIDIRON_WARROOM_PLANS: path.join(temp, 'absent-plans.json') }, async () => {
    const body = await (await get(`${base}/brief/4`)).json();
    assert.equal(body.status, 'unknown');
    assert.match(body.reason, /No plans file has been written yet/);
  });
  const broken = path.join(temp, 'broken-plans.json');
  fs.writeFileSync(broken, '{ not json');
  await withBriefEnv({ GRIDIRON_COACH_BRIEF_ENABLED: '1', GRIDIRON_WARROOM_PLANS: broken }, async () => {
    const body = await (await get(`${base}/brief/4`)).json();
    assert.equal(body.status, 'failed');
    assert.match(body.reason, /could not be read \(SyntaxError\)/);
  });
});

// LAST ON PURPOSE. This exhausts the minute bucket for the session every test
// in this file uses, so anything after it would get a 429 it did not ask for.
test('the ask route is rate limited, and says so before it spends anything', async () => {
  const before = await ask({ question: 'still under the limit' });
  assert.equal(before.headers.get('RateLimit-Limit'), '12');

  // An empty question is rejected by the handler, but the limiter runs first,
  // so these count — which is the point: the ceiling is on requests, not on
  // requests that happened to be well formed.
  let last = before;
  for (let i = 0; i < 14 && last.status !== 429; i++) {
    last = await ask({ question: '' });
    await last.text();
  }
  assert.equal(last.status, 429, 'the thirteenth request in a minute must not reach the model');
  assert.match((await ask({ question: 'anything' }).then(r => r.json())).error, /rate limit/i);
});
