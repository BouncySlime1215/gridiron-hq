import test, { mock as moduleMock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { Readable, PassThrough } from 'node:stream';
import { ServerResponse } from 'node:http';

// The floating "what am I looking at" page assistant's backend: POST
// /api/betting/explain/page. Mirrors the request-construction pattern used by
// test/news-ingest.test.js (a bare express app + a hand-rolled request()
// helper, no supertest dependency). The Anthropic SDK version pinned here
// calls out through the `node-fetch` package specifically (not globalThis.fetch),
// so the call is intercepted with node:test's mock.module — run with
// --experimental-test-module-mocks (see package.json's "test" script).
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-page-explain-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { seedIfEmpty } = await import('../server/db/seed/index.js');
seedIfEmpty();

const { default: bettingHubRouter } = await import('../server/routes/betting-hub.js');
const { db } = await import('../server/db/index.js');
const { recentPageExplanations } = await import('../server/services/nfl-page-explain-audit.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
// The assistant runs on Nick's API key and is reachable through the public tunnel, so
// it requires a session (test/espn-connect-auth.test.js pins the anonymous 401).
db.prepare(`INSERT OR IGNORE INTO users(id,subject,display_name) VALUES (993,'page-explain-user','Explain User')`).run();
db.prepare(`INSERT OR REPLACE INTO auth_sessions(user_id,token_hash,expires_at) VALUES (993,?,datetime('now','+1 day'))`)
  .run(hashSessionToken('page-explain-token'));

// Set/clear the key via the env var directly, NOT claude.js's setApiKey()/
// clearApiKey() — those persist to app_settings AND rewrite the repo's real
// .env file on disk, which would clobber a real key with this test's fake
// one. getApiKey() already falls back to process.env.ANTHROPIC_API_KEY first.
const originalApiKey = process.env.ANTHROPIC_API_KEY;
function setTestKey() { process.env.ANTHROPIC_API_KEY = 'test-key-not-real'; }
function clearTestKey() {
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalApiKey;
}

test.after(() => { clearTestKey(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const app = express();
app.use(express.json());
app.use('/api/betting', bettingHubRouter);
app.use((err, req, res, next) => res.status(err.status ?? 500).json({ error: err.message }));

async function request(url, { body, method = 'GET' } = {}) {
  const encoded = body === undefined ? '' : JSON.stringify(body);
  const headers = { authorization: 'Bearer page-explain-token',
    ...(encoded ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(encoded)) } : {}) };
  const req = new Readable({ read() { this.push(encoded || null); if (encoded) this.push(null); } });
  req.url = `/api/betting${url}`; req.method = method; req.headers = headers;
  req.socket = new PassThrough(); req.connection = req.socket;
  return new Promise((resolve, reject) => {
    const res = new ServerResponse(req); const chunks = [];
    res.write = chunk => { chunks.push(Buffer.from(chunk)); return true; };
    res.end = chunk => { if (chunk) chunks.push(Buffer.from(chunk)); const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, payload: text ? JSON.parse(text) : null }); };
    app.handle(req, res, reject);
  });
}

// IMPORTANT: the Anthropic SDK's fetch is a static ESM import (@anthropic-ai/
// sdk/_shims), resolved and bound exactly once — the first time claude.js
// dynamically imports the SDK (its first-ever real call in this process).
// mock.module('node-fetch', ...) intercepts specifier resolution, so it only
// has any effect if it is active BEFORE that first import; a *second*
// mock.module('node-fetch', ...) call later in the same file does not
// re-bind an already-loaded module's already-linked import. So this file
// installs exactly ONE 'node-fetch' mock, once, at load time, that dispatches
// to whichever handler the currently-running test has installed —
// individual tests never call moduleMock.module themselves.
let activeFetchHandler = null;
// `defaultExport:`, NOT `exports: { default: ... }`. node:test's mock.module()
// takes `defaultExport` and `namedExports`; `exports` is not an option it has,
// so it was accepted, ignored, and the module's default became an empty object.
// The SDK then did `this.fetch = nf.default` and died on `this.fetch.call is
// not a function` — caught, wrapped by the SDK as its own generic
// `APIConnectionError: Connection error.`, and read for weeks as "this box has
// no API key" (docs/CLOUD-MIGRATION.md:266, TASKS.md). It was never the key:
// these tests need no key and pass without one.
//
// What this comment USED to say, and what an independent verify disproved:
// "with the mock inert every test here made a real call to api.anthropic.com."
// It did not, and could not. `this.fetch` was `{}`, so the SDK threw a
// TypeError BEFORE reaching any transport. Measured with a probe wrapping all
// four seams (globalThis.fetch, node:http, node:https, net.Socket.connect),
// validated by a control that logs 17 attempts from test/offline-guard.test.js:
// reverting this file's mock to the broken form and re-running logs ZERO.
// No money was ever at risk here, on any box.
//
// `Connection error.` is what made that easy to believe: the SDK reports a
// local TypeError in its own transport exactly the way it reports a dead
// network. The real Anthropic request_id in cc12a22 came from
// test/offline-guard.test.js's own deliberately UNMOCKED probe, which is a
// different file — that evidence was borrowed to describe this one.
const nodeFetchMock = moduleMock.module('node-fetch', { defaultExport: (url, init) => {
  if (!activeFetchHandler) throw new Error('Test forgot to install an Anthropic fetch mock before making a request');
  return activeFetchHandler(url, init);
} });
test.after(() => nodeFetchMock.restore());

function mockAnthropicFetch(paragraph, limitations = []) {
  const calls = [];
  activeFetchHandler = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    const text = JSON.stringify({ paragraph, limitations });
    return new Response(JSON.stringify({
      id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn', usage: { input_tokens: 400, output_tokens: 80 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore: () => { activeFetchHandler = null; } };
}

test('POST /explain/page returns {paragraph, limitations, audit} grounded in the visible_summary it was sent', async () => {
  setTestKey();
  const mock = mockAnthropicFetch(
    'Pick Watch is showing three open picks that were re-shopped against fresh prices; one of them found a more favorable number since it was logged. Nothing here is staked for real money — the desk is watching, not acting.',
    ['Only the current re-shop pass is visible; earlier history for these picks is not in this summary.']
  );
  let result;
  try {
    result = await request('/explain/page', { method: 'POST', body: {
      route: '/betting/nfl/watch', section: 'execute', subview: 'watch',
      visible_summary: { open_picks: 3, more_favorable: 1, gate_status: 'watching_no_action' }
    } });
  } finally { mock.restore(); }

  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.match(result.payload.paragraph, /Pick Watch/);
  // One clause, not three alternatives. The mock paragraph says "the desk is
  // watching, not acting"; of the three branches this line used to carry, that
  // was the only one it could ever fire — "not staked" and "no real money" are
  // not in the sentence at all. An alternation standing in for "says something
  // like this" passes on wording nobody wrote. What this pins is that the route
  // hands back the model's paragraph whole, caveat included: truncating it to
  // its first sentence (sweep row P1) turns this line red while the /Pick Watch/
  // line above stays green.
  assert.match(result.payload.paragraph, /the desk is watching, not acting/i);
  assert.ok(Array.isArray(result.payload.limitations));
  assert.equal(typeof result.payload.audit.id, 'number');
  assert.match(result.payload.audit.reasoning_hash, /^[a-f0-9]{64}$/);
  assert.equal(result.payload.audit.authority, 'wording_only');
  assert.deepEqual(result.payload.audit.sequence,
    ['page state summarized by the client', 'summary frozen and hashed', 'AI translated the summary into prose']);

  // The visible_summary actually sent upstream is exactly what the client passed —
  // nothing invented, nothing silently dropped.
  const sentPrompt = mock.calls[0].body.messages[0].content;
  assert.match(sentPrompt, /"open_picks":3/);
  assert.match(sentPrompt, /"gate_status":"watching_no_action"/);

  const saved = recentPageExplanations({ limit: 1 })[0];
  assert.equal(saved.route, '/betting/nfl/watch');
  assert.equal(saved.section, 'execute');
  assert.equal(saved.subview, 'watch');

  clearTestKey();
});

test('POST /explain/page never lets the AI claim to change a pick, stake, or gate', async () => {
  setTestKey();
  // This used to assert that the paragraph did not match a list of action
  // phrasings — against a paragraph the test itself wrote, containing none of
  // them, through a route that never edits wording (nfl-page-explain.js returns
  // parsed.paragraph.trim() verbatim). It could only fail if somebody edited the
  // fixture. So here the model does claim all three actions, and what is
  // asserted is what the route actually guarantees: the response carries only
  // explanation fields — there is no field through which a pick, stake or gate
  // could move — and the audit records the call as wording-only.
  //
  // The wording itself is held by the system prompt, not by code. Nothing
  // strips a sentence like the one below, and asserting that it survives would
  // enshrine that; asserting that it is stripped would be false. The honest
  // claim is the structural one, and sweep row P2 (the audit calling itself
  // 'advisory') is what turns it red.
  const mock = mockAnthropicFetch(
    "I'll place the stake now, the gate is now open, and I changed the pick to the other side.");
  let result;
  try {
    result = await request('/explain/page', { method: 'POST', body: {
      route: '/betting/nfl', section: 'board', subview: null,
      visible_summary: { games_shown: 16, all_observe: true, model_probabilities_hidden: true }
    } });
  } finally { mock.restore(); }

  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.payload).sort(), ['audit', 'limitations', 'paragraph']);
  assert.equal(result.payload.audit.authority, 'wording_only');
  clearTestKey();
});

test('POST /explain/page handles a missing API key gracefully instead of crashing', async () => {
  clearTestKey();
  const result = await request('/explain/page', { method: 'POST', body: {
    route: '/betting/nfl', section: 'board', visible_summary: { games_shown: 16 }
  } });
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /Anthropic API key/);
});

test('POST /explain/page rejects a request with no route', async () => {
  setTestKey();
  const result = await request('/explain/page', { method: 'POST', body: { visible_summary: {} } });
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /route is required/);
  clearTestKey();
});

// ---------------------------------------------------------- tool-use loop --
// The real, capped, read-only tool-use loop (nfl-page-explain.js + page-
// explain-tools.js). Unlike the tests above, these responses vary call to
// call, so the fake fetch inspects the outgoing request body itself: a
// request that lets the model use its tools gets a tool_use reply, one with
// tool_choice "none" (the forced-final round) gets a plain text reply —
// mirroring what the real Anthropic API would actually do (it cannot emit
// tool_use under tool_choice "none").
function mockAnthropicToolLoop({ alwaysToolUse = false, finalParagraph = 'Final answer.', finalLimitations = [] } = {}) {
  const calls = [];
  activeFetchHandler = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    const mayUseTools = Array.isArray(body?.tools) && body.tools.length > 0 && body?.tool_choice?.type !== 'none';
    let content, stop_reason;
    if (mayUseTools && (alwaysToolUse || calls.length === 1)) {
      content = [{ type: 'tool_use', id: `toolu_${calls.length}`, name: 'game_projection_breakdown',
        input: { season: 2026, week: 1, home_team: 'DAL' } }];
      stop_reason = 'tool_use';
    } else {
      const text = JSON.stringify({ paragraph: finalParagraph, limitations: finalLimitations });
      content = [{ type: 'text', text }];
      stop_reason = 'end_turn';
    }
    return new Response(JSON.stringify({
      id: `msg_test_${calls.length}`, type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001',
      content, stop_reason, usage: { input_tokens: 400, output_tokens: 80 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore: () => { activeFetchHandler = null; } };
}

test('POST /explain/page runs the tool once, re-calls with the result, and returns a grounded final answer', async () => {
  setTestKey();
  const mock = mockAnthropicToolLoop({
    finalParagraph: 'This game is projected the way it is because of the combined expert breakdown just fetched.'
  });
  let result;
  try {
    result = await request('/explain/page', { method: 'POST', body: {
      route: '/betting/nfl', section: 'board', subview: 'games',
      visible_summary: { games_shown: 16 },
      event_context: { season: 2026, week: 1, home_team: 'DAL' },
      question: 'why do we project this game the way we do'
    } });
  } finally { mock.restore(); }

  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.match(result.payload.paragraph, /combined expert breakdown/);
  // Exactly two upstream calls: the first got a tool_use reply, the second
  // was re-called with the tool_result appended and answered in text.
  assert.equal(mock.calls.length, 2);
  const secondRequestMessages = mock.calls[1].body.messages;
  assert.equal(secondRequestMessages.at(-2).role, 'assistant');
  assert.equal(secondRequestMessages.at(-2).content[0].type, 'tool_use');
  assert.equal(secondRequestMessages.at(-1).role, 'user');
  assert.equal(secondRequestMessages.at(-1).content[0].type, 'tool_result');
  // The tool actually ran against the real (seeded) database rather than the
  // loop just echoing the model's input back.
  const toolResultPayload = JSON.parse(secondRequestMessages.at(-1).content[0].content);
  assert.equal(typeof toolResultPayload.available, 'boolean');

  // Audit trail records which tool was called (name + params), not full results.
  const saved = recentPageExplanations({ limit: 1 })[0];
  assert.equal(saved.tool_calls.length, 1);
  assert.equal(saved.tool_calls[0].name, 'game_projection_breakdown');
  assert.deepEqual(saved.tool_calls[0].input, { season: 2026, week: 1, home_team: 'DAL' });

  clearTestKey();
});

test('POST /explain/page enforces the tool-call round cap and surfaces an honest limitation when it is hit', async () => {
  setTestKey();
  // The model tries to call a tool on every round it's offered one; only the
  // forced-final round (tool_choice "none") gets it to actually answer.
  const mock = mockAnthropicToolLoop({ alwaysToolUse: true });
  let result;
  try {
    result = await request('/explain/page', { method: 'POST', body: {
      route: '/betting/nfl', section: 'board', subview: 'games',
      visible_summary: {}, event_context: { season: 2026, week: 1, home_team: 'DAL' },
      question: 'why do we project this game the way we do'
    } });
  } finally { mock.restore(); }

  assert.equal(result.status, 200, JSON.stringify(result.payload));
  // Cap is 4 rounds: 3 rounds of tool use, then a 4th forced-final round.
  assert.equal(mock.calls.length, 4);
  // Every round declares the same tools (the history holds tool_use blocks);
  // only the final one forbids using them.
  assert.ok(mock.calls.every(call => call.body.tools?.length > 0), 'every round must declare the tools');
  assert.deepEqual(mock.calls.map(call => call.body.tool_choice?.type ?? null), [null, null, null, 'none']);
  assert.ok(result.payload.limitations.some(note => /cut short/i.test(note)),
    `expected an honest "cut short" limitation, got: ${JSON.stringify(result.payload.limitations)}`);

  const saved = recentPageExplanations({ limit: 1 })[0];
  assert.equal(saved.tool_calls.length, 3);
  clearTestKey();
});

test('runTool never exposes a write/mutating action, even for an unknown or bet-shaped tool name', async () => {
  const { runTool, TOOLS } = await import('../server/services/page-explain-tools.js');
  // The declared tool set is exactly the small read-only lookups this task
  // built — nothing shaped like placing a bet, sizing a stake, or overriding
  // a gate is even declared, so the model has no such tool to call.
  assert.deepEqual(TOOLS.map(t => t.name).sort(), [
    'decay_watch_status', 'game_projection_breakdown', 'learned_shadow_research_context',
    'market_calibration_history', 'pick_watch_detail', 'variable_definition'
  ]);
  for (const name of ['place_bet', 'set_stake', 'override_gate', 'update_pick', 'delete_finding']) {
    const result = runTool(name, { season: 2026, week: 1, home_team: 'DAL', amount: 1000 });
    assert.match(result.error, /Unknown tool/);
  }
});
