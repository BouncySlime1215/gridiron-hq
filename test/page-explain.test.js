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
  const headers = encoded ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(encoded)) } : {};
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

function mockAnthropicFetch(paragraph, limitations = []) {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    const text = JSON.stringify({ paragraph, limitations });
    return new Response(JSON.stringify({
      id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn', usage: { input_tokens: 400, output_tokens: 80 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const handle = moduleMock.module('node-fetch', { exports: { default: fakeFetch } });
  return { calls, restore: () => handle.restore() };
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
  assert.match(result.payload.paragraph, /not staked|not acting|no real money/i);
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
  // Even if the model tried to slip in an action claim, the route's contract only
  // ever surfaces paragraph/limitations/audit — there is no field through which a
  // pick, stake, or gate could be mutated, and the system prompt (nfl-page-explain.js)
  // explicitly forbids the AI from claiming to do so. This asserts the response
  // shape enforces that: only explanation fields are ever returned.
  const mock = mockAnthropicFetch('The Board shows all 16 games in observe mode; model probabilities are hidden because staking is not yet cleared.');
  let result;
  try {
    result = await request('/explain/page', { method: 'POST', body: {
      route: '/betting/nfl', section: 'board', subview: null,
      visible_summary: { games_shown: 16, all_observe: true, model_probabilities_hidden: true }
    } });
  } finally { mock.restore(); }

  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.payload).sort(), ['audit', 'limitations', 'paragraph']);
  assert.doesNotMatch(result.payload.paragraph, /I('|’)ll place|I placed|stake (has been|is now) (increased|set)|gate (is now|has been) (open|overridden)/i);
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
