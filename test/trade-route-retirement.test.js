/**
 * G7 — the duplicate trade surfaces the inventory named are retired, and a
 * retired route says where to go instead rather than 404ing or, worse, quietly
 * answering with a second opinion.
 *
 * Retired here: Trade Lab GET /partners and POST /pitch, edge POST /trade, and
 * GET /trades/:id/brain/sell-high. `sellHigh` itself stays: it is the hype-window
 * input for the Trade Brain, so it is tested as a function, not as a route.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-trade-retire-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { default: tradelabRouter } = await import('../server/routes/tradelab.js');
const { default: tradesRouter } = await import('../server/routes/trades.js');
const { default: edgeRouter } = await import('../server/routes/edge.js');
await runMigrations();

const app = express();
app.use(express.json());
app.use('/api/tradelab', tradelabRouter);
app.use('/api/trades', tradesRouter);
app.use('/api/edge', edgeRouter);

const server = app.listen(0);
const port = server.address().port;
test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const call = async (method, url, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const RETIRED = [
  ['GET', '/api/tradelab/1/partners'],
  ['POST', '/api/tradelab/1/pitch'],
  ['POST', '/api/edge/trade'],
  ['GET', '/api/trades/1/brain/sell-high'],
  ['GET', '/api/trades/1/brain/plan'],
];

test('G7a: every retired trade route answers 410 with a pointer to its replacement', async () => {
  for (const [method, url] of RETIRED) {
    const { status, body } = await call(method, url, method === 'POST' ? {} : null);
    assert.equal(status, 410, `${method} ${url} returned ${status}`);
    assert.ok(body?.error, `${method} ${url} has no error message`);
    assert.ok(body?.use, `${method} ${url} does not say what to use instead`);
    assert.match(String(body.use), /\/api\/|trade-engine/,
      `${method} ${url} pointer is not an API path or module: ${body.use}`);
  }
});

test('G7a: a retired route is gone for every league id, not just the one tested', async () => {
  const { status } = await call('GET', '/api/tradelab/99/partners');
  assert.equal(status, 410);
});

test('G7b: league-brain no longer carries a second deal enumerator or acceptance curve', async () => {
  const brain = await import('../server/services/league-brain.js');
  assert.equal(brain.acceptProbability, undefined, 'acceptProbability is still exported');
  const src = fs.readFileSync(new URL('../server/services/league-brain.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /function enumerateDeals\b/, 'enumerateDeals is still defined');
  assert.doesNotMatch(src, /function acceptProbability\b/, 'acceptProbability is still defined');
});

test('G7c: sellHigh survives as an input — it is the hype-window signal, not a page', async () => {
  const { sellHigh } = await import('../server/services/waiver-brain.js');
  assert.equal(typeof sellHigh, 'function');
});

test('G7d: no client file calls a retired route', () => {
  const root = new URL('../client/src/', import.meta.url);
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = new URL(`${e.name}${e.isDirectory() ? '/' : ''}`, dir);
    return e.isDirectory() ? walk(p) : [p];
  });
  const offenders = [];
  for (const file of walk(root)) {
    if (!/\.(ts|tsx|js|jsx)$/.test(file.pathname)) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const pattern of [/\/partners\b/, /tradelab\/[^'"`]*\/pitch/, /edge\/trade\b/, /brain\/sell-high/]) {
      if (pattern.test(src)) offenders.push(`${file.pathname}: ${pattern}`);
    }
  }
  assert.deepEqual(offenders, []);
});
